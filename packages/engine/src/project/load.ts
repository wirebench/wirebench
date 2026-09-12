/**
 * Reads a project folder back into a {@link Project}.
 *
 * The folder is the source of truth for names and ordering: an interface is a
 * directory containing `interface.yaml`, a request is a `*.request.yaml` plus
 * its sibling `.xml`, and each entity's `slug` comes from its file name. Every
 * recoverable inconsistency (an orphaned envelope, an operation folder no
 * interface declares) becomes a {@link ProjectProblem} rather than an error, so
 * a slightly damaged project still opens.
 */

import { join } from 'node:path';
import { ProjectError } from '../errors.js';
import type {
  Attachment,
  Endpoint,
  Environment,
  Interface,
  OperationDef,
  Project,
  ProjectSettings,
  RequestDef,
  RequestProperties,
  WssRef,
} from './model.js';
import { FORMAT_VERSION } from './model.js';
import type { FsLike } from './fs.js';
import { nodeFs, readFileIfExists, readdirIfExists } from './fs.js';
import { migrate } from './migrate.js';
import { normalizeWsa } from '../wsa/model.js';
import { ENVIRONMENTS_DIR, INTERFACES_DIR, OPERATIONS_DIR, REQUEST_SUFFIX, WSS_DIR } from './paths.js';
import {
  environmentFileSchema,
  interfaceFileSchema,
  keystoresFileSchema,
  manifestSchema,
  parseFile,
  requestFileSchema,
  wssIncomingFileSchema,
  wssOutgoingFileSchema,
} from './schema.js';
import { KEYSTORES_PATH, MANIFEST_PATH } from './serialize.js';
import { parseYaml } from './yaml.js';

/** A recoverable inconsistency found while loading a project. */
export interface ProjectProblem {
  readonly code: 'missing-envelope' | 'orphan-operation-folder' | 'orphan-request-file' | 'missing-interface-file';
  readonly message: string;
  /** Path relative to the project root. */
  readonly file: string;
}

/** The result of {@link loadProject}: the model plus anything odd about the folder. */
export interface LoadResult {
  readonly project: Project;
  readonly problems: readonly ProjectProblem[];
}

/** Options for {@link loadProject}. */
export interface LoadProjectOptions {
  readonly fs?: FsLike;
}

function abs(root: string, relative: string): string {
  return join(root, ...relative.split('/'));
}

async function readYaml(fs: FsLike, root: string, relative: string): Promise<unknown> {
  const buffer = await readFileIfExists(fs, abs(root, relative));
  return buffer === undefined ? undefined : parseYaml(buffer.toString('utf8'), relative);
}

/** Orders entities by their persisted `order`, falling back to a stable name comparison. */
function byOrder<T extends { readonly order: number; readonly name: string }>(a: T, b: T): number {
  return a.order - b.order || a.name.localeCompare(b.name);
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

/**
 * Drops `undefined`-valued keys from a zod result, so an absent optional field
 * is truly absent rather than present-and-undefined (`exactOptionalPropertyTypes`).
 */
function exact<T extends object>(value: { readonly [K in keyof T]: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) {
      out[key] = entry;
    }
  }
  return out as T;
}

async function loadRequests(fs: FsLike, root: string, dir: string, problems: ProjectProblem[]): Promise<RequestDef[]> {
  const requests: RequestDef[] = [];
  const entries = await readdirIfExists(fs, abs(root, dir));
  const names = new Set(entries.filter((e) => e.isFile).map((e) => e.name));
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile || !entry.name.endsWith(REQUEST_SUFFIX)) {
      continue;
    }
    const slug = entry.name.slice(0, -REQUEST_SUFFIX.length);
    const relative = `${dir}/${entry.name}`;
    const parsed = parseFile(requestFileSchema, await readYaml(fs, root, relative), relative);
    const xmlRelative = `${dir}/${slug}.xml`;
    const envelope = await readFileIfExists(fs, abs(root, xmlRelative));
    if (envelope === undefined) {
      problems.push({
        code: 'missing-envelope',
        message: `Request "${parsed.name}" has no envelope file; loaded with an empty body`,
        file: xmlRelative,
      });
    }
    names.delete(entry.name);
    names.delete(`${slug}.xml`);
    requests.push({
      kind: 'soap',
      id: parsed.id,
      name: parsed.name,
      slug,
      order: parsed.order,
      ...optional('description', parsed.description),
      ...optional('endpointId', parsed.endpointId),
      ...optional('endpointUrl', parsed.endpointUrl),
      soapVersion: parsed.soapVersion,
      ...optional('soapAction', parsed.soapAction),
      headers: parsed.headers,
      attachments: parsed.attachments.map((a) => exact<Attachment>(a)),
      ...optional('auth', parsed.auth),
      ...(parsed.wsa !== undefined ? { wsa: normalizeWsa(parsed.wsa) } : {}),
      ...optional('wssOutgoingRef', parsed.wssOutgoingRef),
      ...optional('wssIncomingRef', parsed.wssIncomingRef),
      properties: exact<RequestProperties>(parsed.properties),
      ...(parsed.orphaned === true ? { orphaned: true } : {}),
      envelopeXml: envelope === undefined ? '' : envelope.toString('utf8'),
    });
  }
  for (const orphan of [...names].sort()) {
    problems.push({
      code: 'orphan-request-file',
      message: `"${orphan}" does not belong to any request`,
      file: `${dir}/${orphan}`,
    });
  }
  return requests.sort(byOrder);
}

async function loadInterface(
  fs: FsLike,
  root: string,
  slug: string,
  problems: ProjectProblem[],
): Promise<Interface | undefined> {
  const relative = `${INTERFACES_DIR}/${slug}/interface.yaml`;
  const document = await readYaml(fs, root, relative);
  if (document === undefined) {
    problems.push({
      code: 'missing-interface-file',
      message: `Folder "${slug}" has no interface.yaml and was skipped`,
      file: relative,
    });
    return undefined;
  }
  const parsed = parseFile(interfaceFileSchema, document, relative);
  const operationsDir = `${INTERFACES_DIR}/${slug}/${OPERATIONS_DIR}`;
  const folders = new Set(
    (await readdirIfExists(fs, abs(root, operationsDir))).filter((e) => e.isDirectory).map((e) => e.name),
  );
  const operations: OperationDef[] = [];
  for (const entry of parsed.operations) {
    folders.delete(entry.slug);
    operations.push({
      name: entry.name,
      bindingName: entry.bindingName,
      slug: entry.slug,
      order: entry.order,
      requests: await loadRequests(fs, root, `${operationsDir}/${entry.slug}`, problems),
    });
  }
  for (const orphan of [...folders].sort()) {
    problems.push({
      code: 'orphan-operation-folder',
      message: `Operation folder "${orphan}" is not listed in interface.yaml`,
      file: `${operationsDir}/${orphan}`,
    });
  }
  const endpoints: readonly Endpoint[] = parsed.endpoints.map((e) => ({
    id: e.id,
    name: e.name,
    url: e.url,
    ...optional('auth', e.auth),
    authMode: e.authMode,
  }));
  return {
    kind: 'soap',
    id: parsed.id,
    name: parsed.name,
    slug,
    order: parsed.order,
    definitionUrl: parsed.definitionUrl,
    cacheDefinition: parsed.cacheDefinition,
    ...optional('targetNamespace', parsed.targetNamespace),
    endpoints,
    ...optional('defaultEndpointId', parsed.defaultEndpointId),
    wsa: normalizeWsa(parsed.wsa),
    ...optional('auth', parsed.auth),
    operations: operations.sort(byOrder),
  };
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

/**
 * Loads the project stored in the directory `root`.
 *
 * @throws ProjectError `project-not-found` when there is no `wirebench.yaml`,
 * `project-format-too-new` for a newer format version, `project-file-invalid`
 * for malformed or schema-violating YAML (with the offending file in `details`).
 */
export async function loadProject(root: string, options?: LoadProjectOptions): Promise<LoadResult> {
  const fs = options?.fs ?? nodeFs;
  const manifestDocument = await readYaml(fs, root, MANIFEST_PATH);
  if (manifestDocument === undefined) {
    throw new ProjectError('project-not-found', `No ${MANIFEST_PATH} in ${root}`, {
      details: { file: MANIFEST_PATH, root },
    });
  }
  const manifest = parseFile(manifestSchema, migrate(manifestDocument, MANIFEST_PATH), MANIFEST_PATH);

  const problems: ProjectProblem[] = [];
  const interfaces: Interface[] = [];
  for (const entry of await readdirIfExists(fs, abs(root, INTERFACES_DIR))) {
    if (!entry.isDirectory) {
      continue;
    }
    const iface = await loadInterface(fs, root, entry.name, problems);
    if (iface !== undefined) {
      interfaces.push(iface);
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

  const project: Project = {
    formatVersion: FORMAT_VERSION,
    id: manifest.id,
    name: manifest.name,
    ...optional('description', manifest.description),
    settings: exact<ProjectSettings>(manifest.settings),
    properties: manifest.properties,
    disabledProperties: manifest.disabled ?? [],
    ...optional('activeEnvironmentId', manifest.activeEnvironmentId),
    interfaces: interfaces.sort(byOrder),
    environments: await loadEnvironments(fs, root),
    wss: {
      outgoing: await loadWssRefs(fs, root, 'outgoing'),
      incoming: await loadWssRefs(fs, root, 'incoming'),
      keystores,
    },
  };
  return { project, problems };
}
