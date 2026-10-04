/**
 * Reads a project folder back into a {@link Project}.
 *
 * The folder is the source of truth for names and ordering: an interface is a
 * directory containing `interface.yaml`, a request is a `*.request.yaml` plus
 * its sibling `.xml`, and each entity's `slug` comes from its file name. Every
 * recoverable inconsistency (an orphaned envelope, an operation folder no
 * interface declares) becomes a {@link ProjectProblem} rather than an error, so
 * a slightly damaged project still opens.
 *
 * Core reads the manifest, environments, sequences, keystores, WS-Security references and the
 * webhook collection. A container is read by its protocol's `storage.load` (`soap/storage.ts`,
 * `rest/storage.ts`, `grpc/storage.ts`, `ws/storage.ts`), found through the registry.
 */

import { ProjectError } from '../errors.js';
import type { ContainerBase, LoadContext, ProtocolStorage } from '../protocol/module.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocols.js';
import { restRequestReader, signingOf } from '../rest/storage.js';
import { readSequences } from '../sequence/load.js';
import type { WebhookCollection, WebhookFolder } from '../webhooks/model.js';
import type { FsLike } from './fs.js';
import { nodeFs, readdirIfExists } from './fs.js';
import { abs, authConfig, byOrder, exact, loadFolderContents, optional, readYaml } from './load-helpers.js';
import { migrate } from './migrate.js';
import { FORMAT_VERSION } from './model.js';
import type { Environment, Project, ProjectSettings, UnsupportedContainer, WssRef } from './model.js';
import {
  API_FILE,
  APIS_DIR,
  ENVIRONMENTS_DIR,
  INTERFACES_DIR,
  REQUESTS_DIR,
  WEBHOOKS_DIR,
  WEBHOOKS_FEATURE,
  WEBHOOKS_FILE,
  WSS_DIR,
} from './paths.js';
import { parseFile } from './schema-parts.js';
import {
  environmentFileSchema,
  keystoresFileSchema,
  manifestSchema,
  webhookFolderFileSchema,
  webhooksFileSchema,
  wssIncomingFileSchema,
  wssOutgoingFileSchema,
} from './schema.js';
import { KEYSTORES_PATH, MANIFEST_PATH } from './serialize.js';

/** A recoverable inconsistency found while loading a project. */
export interface ProjectProblem {
  readonly code:
    | 'missing-envelope'
    | 'orphan-operation-folder'
    | 'orphan-request-file'
    | 'missing-interface-file'
    /** An `apis/<slug>/` directory with no `api.yaml`; the API is skipped. */
    | 'missing-api-file'
    /** A raw body whose sibling file is gone; the request loads with an empty body. */
    | 'missing-body'
    /**
     * A REST response example whose `file` is not `<slug>.examples/<id>.body.<ext>` of its own
     * request; the example loads without a body, and nothing outside that folder is read (#64).
     */
    | 'example-file-invalid'
    /** A folder nested deeper than {@link MAX_FOLDER_DEPTH}; it and everything below it is skipped. */
    | 'folder-too-deep'
    /** An API and an interface sharing a slug, which would make an endpoint override ambiguous. */
    | 'api-slug-conflict'
    /** A sequence file that is malformed, over a limit, or not a sequence; it is skipped and left as it is. */
    | 'sequence-file-invalid'
    /** A sequence file written by a newer build; it is skipped and left as it is. */
    | 'sequence-version-too-new'
    /** A sequence file whose id another file already has; it is skipped and left as it is. */
    | 'sequence-duplicate-id'
    /** A script the request names whose file is gone; the request refuses to send until it is back (#63). */
    | 'script-file-missing'
    /** A script file over the size limit; kept as it is, and the request refuses to send (#63). */
    | 'script-too-large'
    /** A container whose kind has no enabled module; it is a placeholder and is left as it is (spec §6). */
    | 'container-unsupported';
  readonly message: string;
  /** Path relative to the project root. */
  readonly file: string;
  /** For `container-unsupported`: `kind`, `reason`, `dir` and `slug`. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** The result of {@link loadProject}: the model plus anything odd about the folder. */
export interface LoadResult {
  readonly project: Project;
  readonly problems: readonly ProjectProblem[];
}

/** Options for {@link loadProject}. */
export interface LoadProjectOptions {
  readonly fs?: FsLike;
  /** The protocols the project may hold. Defaults to the built-in ones, all switched on. */
  readonly registry?: ProtocolRegistry;
}

async function loadEnvironments(fs: FsLike, root: string): Promise<Environment[]> {
  const environments: Environment[] = [];
  for (const entry of await readdirIfExists(fs, abs(root, ENVIRONMENTS_DIR))) {
    if (!entry.isFile || !entry.name.endsWith('.yaml')) {
      continue;
    }
    const relative = `${ENVIRONMENTS_DIR}/${entry.name}`;
    const parsed = parseFile(environmentFileSchema, await readYaml(fs, root, relative), relative);
    environments.push({
      id: parsed.id,
      name: parsed.name,
      slug: entry.name.slice(0, -'.yaml'.length),
      order: parsed.order,
      endpoints: parsed.endpoints,
      properties: parsed.properties,
      disabledProperties: parsed.disabled ?? [],
    });
  }
  return environments.sort(byOrder);
}

async function loadWssRefs(fs: FsLike, root: string, direction: 'outgoing' | 'incoming'): Promise<WssRef[]> {
  const dir = `${WSS_DIR}/${direction}`;
  const schema = direction === 'outgoing' ? wssOutgoingFileSchema : wssIncomingFileSchema;
  const refs: WssRef[] = [];
  for (const entry of await readdirIfExists(fs, abs(root, dir))) {
    if (!entry.isFile || !entry.name.endsWith('.yaml')) {
      continue;
    }
    const relative = `${dir}/${entry.name}`;
    const parsed = parseFile(schema, await readYaml(fs, root, relative), relative);
    refs.push({ id: parsed.id, name: parsed.name, file: relative, document: parsed });
  }
  return refs.sort((a, b) => a.name.localeCompare(b.name));
}

/** Loads `webhooks/`, or nothing when the project has no `webhooks.yaml`. */
async function loadWebhooks(
  fs: FsLike,
  root: string,
  problems: ProjectProblem[],
): Promise<WebhookCollection | undefined> {
  const relative = `${WEBHOOKS_DIR}/${WEBHOOKS_FILE}`;
  const document = await readYaml(fs, root, relative);
  if (document === undefined) return undefined;
  const parsed = parseFile(webhooksFileSchema, document, relative);
  const contents = await loadFolderContents(
    fs,
    root,
    `${WEBHOOKS_DIR}/${REQUESTS_DIR}`,
    0,
    problems,
    restRequestReader(fs, root, problems),
    (folderDocument, folderFile) => {
      if (folderDocument === undefined) return {};
      const folder = parseFile(webhookFolderFileSchema, folderDocument, folderFile);
      return {
        ...optional('target', folder.target),
        ...(folder.source !== undefined ? { source: { apiId: folder.source.apiId } } : {}),
        ...(folder.signing !== undefined ? { signing: signingOf(folder.signing) } : {}),
      };
    },
  );
  return {
    target: parsed.target,
    ...(parsed.auth !== undefined ? { auth: authConfig(parsed.auth) } : {}),
    ...(parsed.signing !== undefined ? { signing: signingOf(parsed.signing) } : {}),
    folders: contents.folders as unknown as WebhookFolder[],
    requests: contents.requests,
  };
}

/**
 * The two directories a project keeps containers in: each one's container file, the kind a file
 * without one has (the directory's first protocol), and the problem an empty directory is.
 */
const CONTAINER_DIRS = [
  { dir: INTERFACES_DIR, file: 'interface.yaml', defaultKind: 'soap', missing: 'missing-interface-file' },
  { dir: APIS_DIR, file: API_FILE, defaultKind: 'rest', missing: 'missing-api-file' },
] as const;

type ContainerLayout = (typeof CONTAINER_DIRS)[number];

/** A container file's `kind`, or `fallback` when it has none. */
function kindOf(document: unknown, fallback: string): string {
  const kind =
    typeof document === 'object' && document !== null ? (document as Record<string, unknown>)['kind'] : undefined;
  return typeof kind === 'string' ? kind : fallback;
}

/**
 * The storage that reads a container file found in `layout.dir`: the enabled module its `kind`
 * names, when that module keeps its containers in this directory. Undefined makes a placeholder.
 */
function storageFor(
  registry: ProtocolRegistry,
  layout: ContainerLayout,
  document: unknown,
): ProtocolStorage | undefined {
  const storage = registry.find(kindOf(document, layout.defaultKind))?.storage;
  return storage?.dir === layout.dir ? storage : undefined;
}

/**
 * What is kept of a container no enabled module reads (spec §6): where it is, its kind as written,
 * why it was not loaded, and its name and order when the file has them as a string and a number.
 */
function placeholderOf(
  registry: ProtocolRegistry,
  layout: ContainerLayout,
  slug: string,
  document: unknown,
): UnsupportedContainer {
  const kind = kindOf(document, layout.defaultKind);
  const fields = typeof document === 'object' && document !== null ? (document as Record<string, unknown>) : {};
  const name = fields['name'];
  const order = fields['order'];
  return {
    dir: layout.dir,
    slug,
    kind,
    // A kind the registry has a module for but in the other directory is unknown here.
    reason: registry.status(kind) === 'disabled' ? 'feature-disabled' : 'unknown-kind',
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof order === 'number' ? { order } : {}),
  };
}

/** The problem a placeholder is reported with. */
function unsupportedProblem(placeholder: UnsupportedContainer, file: string): ProjectProblem {
  const why =
    placeholder.reason === 'feature-disabled'
      ? 'that protocol is switched off'
      : `this build has no such protocol for ${placeholder.dir}/`;
  return {
    code: 'container-unsupported',
    message: `${file} is a "${placeholder.kind}" container, and ${why}; it was not loaded and is left as it is`,
    file,
    details: { kind: placeholder.kind, reason: placeholder.reason, dir: placeholder.dir, slug: placeholder.slug },
  };
}

/**
 * Loads the project stored in the directory `root`. Each container directory under `interfaces/`
 * and `apis/` is read by the protocol module its container file's `kind` names (spec §5.1). A
 * container whose kind has no enabled module in that directory becomes a placeholder in
 * `project.unsupported` and a `container-unsupported` problem; nothing below its directory is read
 * but its container file, and a save leaves all of it as it is (spec §6).
 *
 * @throws ProjectError `project-not-found` when there is no `wirebench.yaml`,
 * `project-format-too-new` for a newer format version, `project-file-invalid`
 * for malformed or schema-violating YAML (with the offending file in `details`),
 * `project-kind-not-supported` for a request file of a kind this build has no module for.
 */
export async function loadProject(root: string, options?: LoadProjectOptions): Promise<LoadResult> {
  const fs = options?.fs ?? nodeFs;
  const registry = options?.registry ?? defaultRegistry();
  const manifestDocument = await readYaml(fs, root, MANIFEST_PATH);
  if (manifestDocument === undefined) {
    throw new ProjectError('project-not-found', `No ${MANIFEST_PATH} in ${root}`, {
      details: { file: MANIFEST_PATH, root },
    });
  }
  const manifest = parseFile(manifestSchema, migrate(manifestDocument, MANIFEST_PATH), MANIFEST_PATH);

  const problems: ProjectProblem[] = [];
  const ctx: LoadContext = { fs, root, problems };
  const loaded = new Map<ProtocolStorage, ContainerBase[]>();
  const unsupported: UnsupportedContainer[] = [];
  const interfaceSlugs = new Set<string>();
  for (const layout of CONTAINER_DIRS) {
    for (const entry of await readdirIfExists(fs, abs(root, layout.dir))) {
      if (!entry.isDirectory) {
        continue;
      }
      const relative = `${layout.dir}/${entry.name}/${layout.file}`;
      const document = await readYaml(fs, root, relative);
      if (document === undefined) {
        problems.push({
          code: layout.missing,
          message: `Folder "${entry.name}" has no ${layout.file} and was skipped`,
          file: relative,
        });
        continue;
      }
      const storage = storageFor(registry, layout, document);
      if (storage === undefined) {
        // Kept whatever its slug: a placeholder that was skipped would not be live, and the next
        // save would delete the directory this build could not read.
        const placeholder = placeholderOf(registry, layout, entry.name, document);
        unsupported.push(placeholder);
        problems.push(unsupportedProblem(placeholder, relative));
        continue;
      }
      const container = await storage.load(ctx, entry.name, document);
      if (container === undefined) {
        continue;
      }
      if (layout.dir === INTERFACES_DIR) {
        interfaceSlugs.add(container.slug.toLowerCase());
      } else if (interfaceSlugs.has(container.slug.toLowerCase())) {
        // An environment's endpoint overrides are keyed by slug, so two entities sharing one would
        // make the override ambiguous. The folders never collide; the override key would. Every
        // kind of API shares one directory, so their slugs cannot collide with each other.
        problems.push({
          code: 'api-slug-conflict',
          message: `API "${container.name}" and an interface share the slug "${container.slug}"; the API was skipped`,
          file: `${APIS_DIR}/${container.slug}/${API_FILE}`,
        });
        continue;
      }
      const containers = loaded.get(storage) ?? [];
      containers.push(container);
      loaded.set(storage, containers);
    }
  }

  const keystoresDocument = await readYaml(fs, root, KEYSTORES_PATH);
  const keystores =
    keystoresDocument === undefined
      ? []
      : parseFile(keystoresFileSchema, keystoresDocument, KEYSTORES_PATH).keystores.map((k) => ({
          id: k.id,
          name: k.name,
          document: k,
        }));

  const sequenceFiles = await readSequences(fs, root);
  problems.push(...sequenceFiles.problems);

  // The collection is REST requests: with REST off it is not read, and a save leaves it alone.
  const webhooks = registry.features.isEnabled(WEBHOOKS_FEATURE) ? await loadWebhooks(fs, root, problems) : undefined;

  const core: Project = {
    formatVersion: FORMAT_VERSION,
    id: manifest.id,
    name: manifest.name,
    ...optional('description', manifest.description),
    settings: exact<ProjectSettings>(manifest.settings),
    properties: manifest.properties,
    disabledProperties: manifest.disabled ?? [],
    ...optional('activeEnvironmentId', manifest.activeEnvironmentId),
    interfaces: [],
    apis: [],
    grpcApis: [],
    wsApis: [],
    sequences: sequenceFiles.loaded.map((entry) => entry.sequence).sort(byOrder),
    ...(webhooks !== undefined ? { webhooks } : {}),
    environments: await loadEnvironments(fs, root),
    wss: {
      outgoing: await loadWssRefs(fs, root, 'outgoing'),
      incoming: await loadWssRefs(fs, root, 'incoming'),
      keystores,
    },
    // Absent when there is none, as every project written before placeholders is.
    ...(unsupported.length > 0
      ? { unsupported: unsupported.sort((a, b) => a.dir.localeCompare(b.dir) || a.slug.localeCompare(b.slug)) }
      : {}),
  };
  // A module that loaded nothing is not asked: the four built-in lists are already empty, and a
  // kind kept in `extraContainers` must not appear there when the project holds none of it.
  let project = core;
  for (const [storage, containers] of loaded) {
    project = storage.withContainers(project, containers.sort(byOrder));
  }
  return { project, problems };
}
