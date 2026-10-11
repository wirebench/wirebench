/**
 * Turns a {@link Project} into the exact set of files it occupies on disk.
 *
 * Keeping this pure (project in, `relative path -> file content` out) means the
 * saver only has to diff two maps, and tests can assert on the layout without
 * touching a file system.
 */

import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocols.js';
import { mockFiles } from '../mock/file.js';
import { sequenceDocument, sequenceFilePath } from '../sequence/file.js';
import type { Project, PropertyMap } from './model.js';
import { assertPathSegment, ENVIRONMENTS_DIR, WSS_DIR } from './paths.js';
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

/** Options for {@link projectFiles}. */
export interface ProjectFilesOptions {
  /** Recorded in the manifest as `writtenBy`. Defaults to `'wirebench'`. */
  readonly writer?: string;
  /** The protocols whose containers are written. Defaults to the built-in ones, all switched on. */
  readonly registry?: ProtocolRegistry;
}

/**
 * Builds the complete `relative path -> content` map for a project: core's own files, every enabled
 * module's `storage.files` for each of its containers (spec §5.2), and its `projectFiles.files`.
 *
 * Every slug is validated with {@link assertPathSegment} (and every WS-Security
 * `WssRef.file` with `assertWssRelativePath`) before any path is built,
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
          color: environment.color,
          protected: environment.protected === true ? true : undefined,
        }),
      ),
    );
  }

  // In registration order, which is the order these files always had: interfaces, then each kind
  // of API.
  for (const { storage } of registry.modules) {
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
  for (const mock of project.mocks) {
    for (const [relative, content] of mockFiles(mock)) {
      files.set(relative, content);
    }
  }
  // What a protocol keeps for the whole project, in registry order; a disabled module's is not written.
  for (const { projectFiles: facet } of registry.modules) {
    if (facet === undefined) continue;
    for (const [relative, content] of facet.files(project)) {
      files.set(relative, content);
    }
  }
  if (project.keystores.length > 0) {
    files.set(KEYSTORES_PATH, stringifyYaml({ keystores: project.keystores.map((k) => k.document) }));
  }

  return files;
}
