/**
 * Turns a {@link Project} into the exact set of files it occupies on disk.
 *
 * Keeping this pure (project in, `relative path -> file content` out) means the
 * saver only has to diff two maps, and tests can assert on the layout without
 * touching a file system.
 */

import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocols.js';
import type { RestRequestDef } from '../rest/model.js';
import { signingDocument, writeRestRequest } from '../rest/storage.js';
import { sequenceDocument, sequenceFilePath } from '../sequence/file.js';
import type { WebhookCollection, WebhookFolder } from '../webhooks/model.js';
import type { Project, PropertyMap, WssRef } from './model.js';
import {
  assertPathSegment,
  assertWssRelativePath,
  ENVIRONMENTS_DIR,
  REQUESTS_DIR,
  slugify,
  WEBHOOKS_DIR,
  WEBHOOKS_FEATURE,
  WEBHOOKS_FILE,
  WSS_DIR,
} from './paths.js';
import { addFolderFiles, authDocument } from './serialize-helpers.js';
import { compact, stringifyYaml } from './yaml.js';

export { authDocument } from './serialize-helpers.js';

/** A project's files, keyed by path relative to the project root (always `/`-separated). */
export type ProjectFiles = ReadonlyMap<string, string>;

/** Relative path of the manifest. */
export const MANIFEST_PATH = 'wirebench.yaml';

/** Relative path of the keystore registry. */
export const KEYSTORES_PATH = `${WSS_DIR}/keystores.yaml`;

/**
 * The `disabled` list as written: sorted, deduplicated, and dropped entirely once it would be
 * empty — a name with no entry left in `properties` never outlives its map, so it is filtered
 * out here rather than merely sorted.
 */
function disabledList(disabled: readonly string[], properties: PropertyMap): readonly string[] | undefined {
  const known = new Set(Object.keys(properties));
  const kept = [...new Set(disabled.filter((name) => known.has(name)))].sort();
  return kept.length > 0 ? kept : undefined;
}

/** The webhook collection's files: `webhooks/webhooks.yaml` and the request tree under it. */
function addWebhookFiles(files: Map<string, string>, webhooks: WebhookCollection): void {
  files.set(
    `${WEBHOOKS_DIR}/${WEBHOOKS_FILE}`,
    stringifyYaml(
      compact({
        target: webhooks.target,
        auth: webhooks.auth === undefined ? undefined : authDocument(webhooks.auth),
        signing: signingDocument(webhooks.signing),
      }),
    ),
  );
  addFolderFiles<RestRequestDef>(files, `${WEBHOOKS_DIR}/${REQUESTS_DIR}`, webhooks, 0, writeRestRequest, (folder) => {
    const hook = folder as Partial<WebhookFolder>;
    return {
      target: hook.target,
      source: hook.source === undefined ? undefined : { apiId: hook.source.apiId },
      signing: signingDocument(hook.signing),
    };
  });
}

function wssDocument(ref: WssRef): string {
  return stringifyYaml(ref.document);
}

/**
 * Relative path of a WS-Security configuration file.
 *
 * @throws ProjectError `project-path-invalid` when `ref.file` is not a
 * relative path rooted at `wss/` with only safe segments.
 */
export function wssRefPath(direction: 'outgoing' | 'incoming', ref: WssRef): string {
  if (ref.file !== undefined) {
    assertWssRelativePath(ref.file);
    return ref.file;
  }
  return `${WSS_DIR}/${direction}/${slugify(ref.name)}.yaml`;
}

/** Options for {@link projectFiles}. */
export interface ProjectFilesOptions {
  /** Recorded in the manifest as `writtenBy`. Defaults to `'wirebench'`. */
  readonly writer?: string;
  /** The protocols whose containers are written. Defaults to the built-in ones, all switched on. */
  readonly registry?: ProtocolRegistry;
}

/**
 * Builds the complete `relative path -> content` map for a project: core's own files, and every
 * enabled module's `storage.files` for each of its containers (spec §5.2).
 *
 * Every slug is validated with {@link assertPathSegment} (and every
 * `WssRef.file` with {@link assertWssRelativePath}) before any path is built,
 * so a corrupted slug or an unvalidated file reference throws
 * `ProjectError('project-path-invalid')` here — before `saveProject` ever
 * touches the file system.
 */
export function projectFiles(project: Project, options?: ProjectFilesOptions): ProjectFiles {
  const files = new Map<string, string>();
  const writer = options?.writer ?? 'wirebench';
  const registry = options?.registry ?? defaultRegistry();

  files.set(
    MANIFEST_PATH,
    stringifyYaml(
      compact({
        formatVersion: project.formatVersion,
        id: project.id,
        name: project.name,
        description: project.description,
        settings: compact({ ...project.settings }),
        properties: { ...project.properties },
        disabled: disabledList(project.disabledProperties, project.properties),
        activeEnvironmentId: project.activeEnvironmentId,
        writtenBy: writer,
      }),
    ),
  );

  for (const environment of project.environments) {
    assertPathSegment(environment.slug);
    files.set(
      `${ENVIRONMENTS_DIR}/${environment.slug}.yaml`,
      stringifyYaml(
        compact({
          id: environment.id,
          name: environment.name,
          order: environment.order,
          endpoints: { ...environment.endpoints },
          properties: { ...environment.properties },
          disabled: disabledList(environment.disabledProperties, environment.properties),
        }),
      ),
    );
  }

  // In registration order, which is the order these files always had: interfaces, then each kind
  // of API.
  for (const module of registry.modules) {
    const storage = module.storage;
    if (storage === undefined) {
      continue;
    }
    for (const container of storage.containers(project)) {
      for (const [relative, content] of storage.files(container)) {
        files.set(relative, content);
      }
    }
  }

  for (const sequence of project.sequences) {
    assertPathSegment(sequence.slug);
    files.set(sequenceFilePath(sequence.slug), sequenceDocument(sequence));
  }
  // REST requests in a tree of their own: written only while REST is on (spec §3.2).
  if (project.webhooks !== undefined && registry.features.isEnabled(WEBHOOKS_FEATURE)) {
    addWebhookFiles(files, project.webhooks);
  }

  for (const [direction, refs] of [
    ['outgoing', project.wss.outgoing],
    ['incoming', project.wss.incoming],
  ] as const) {
    for (const ref of refs) {
      files.set(wssRefPath(direction, ref), wssDocument(ref));
    }
  }
  if (project.wss.keystores.length > 0) {
    files.set(KEYSTORES_PATH, stringifyYaml({ keystores: project.wss.keystores.map((k) => k.document) }));
  }

  return files;
}
