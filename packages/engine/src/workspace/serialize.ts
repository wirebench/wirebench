/**
 * Turns a {@link Workspace} into the exact set of files it occupies on disk.
 *
 * Mirrors `project/serialize.ts`: pure (workspace in, `relative path -> file
 * content` out), so `saveWorkspace` only has to diff two maps and tests can
 * assert on the layout without touching a file system. `compact` and
 * `stringifyYaml` are the same format-agnostic helpers `project/serialize.ts`
 * uses (sorted keys, no line wrapping, `undefined` fields dropped).
 */

import type { Workspace, WorkspaceProjectRef } from './model.js';
import { assertPathSegment, WORKSPACE_ENVIRONMENTS_DIR, WORKSPACE_MANIFEST } from './paths.js';
import { compact, stringifyYaml } from '../project/yaml.js';

/** A workspace's files, keyed by path relative to the workspace root (always `/`-separated). */
export type WorkspaceFiles = ReadonlyMap<string, string>;

/** Options for {@link workspaceFiles}. */
export interface WorkspaceFilesOptions {
  /** Recorded in the manifest as `writtenBy`. Defaults to `'wirebench'`. */
  readonly writer?: string;
}

function projectRefDocument(ref: WorkspaceProjectRef): Record<string, unknown> {
  return compact({ id: ref.id, slug: ref.slug, source: ref.source, path: ref.path });
}

/**
 * Builds the complete `relative path -> content` map for a workspace.
 *
 * Every environment slug is validated with {@link assertPathSegment} before
 * any path is built, so a corrupted slug throws
 * `WorkspaceError('workspace-path-invalid')` here — before `saveWorkspace`
 * ever touches the file system.
 */
export function workspaceFiles(workspace: Workspace, options?: WorkspaceFilesOptions): WorkspaceFiles {
  const files = new Map<string, string>();
  const writer = options?.writer ?? 'wirebench';

  files.set(
    WORKSPACE_MANIFEST,
    stringifyYaml(
      compact({
        formatVersion: workspace.formatVersion,
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        createdAt: workspace.createdAt,
        properties: { ...workspace.properties },
        activeEnvironmentId: workspace.activeEnvironmentId,
        projects: workspace.projects.map((ref) => projectRefDocument(ref)),
        writtenBy: writer,
      }),
    ),
  );

  for (const environment of workspace.environments) {
    assertPathSegment(environment.slug);
    files.set(
      `${WORKSPACE_ENVIRONMENTS_DIR}/${environment.slug}.yaml`,
      stringifyYaml({
        id: environment.id,
        name: environment.name,
        order: environment.order,
        properties: { ...environment.properties },
        endpoints: { ...environment.endpoints },
      }),
    );
  }

  return files;
}
