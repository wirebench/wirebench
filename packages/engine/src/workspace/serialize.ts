/**
 * Turns a {@link Workspace} into the exact set of files it occupies on disk.
 *
 * Mirrors `project/serialize.ts`: pure (workspace in, `relative path -> file
 * content` out), so `saveWorkspace` only has to diff two maps and tests can
 * assert on the layout without touching a file system. `compact` and
 * `stringifyYaml` are the same format-agnostic helpers `project/serialize.ts`
 * uses (sorted keys, no line wrapping, `undefined` fields dropped).
 */

import type { PropertyMap } from '../project/model.js';
import type { Workspace, WorkspaceProjectRef } from './model.js';
import { assertPathSegment, WORKSPACE_ENVIRONMENTS_DIR, WORKSPACE_MANIFEST } from './paths.js';
import { compact, stringifyYaml } from '../project/yaml.js';

/** A workspace's files, keyed by path relative to the workspace root (always `/`-separated). */
export type WorkspaceFiles = ReadonlyMap<string, string>;

function projectRefDocument(ref: WorkspaceProjectRef): Record<string, unknown> {
  return compact({ id: ref.id, slug: ref.slug, source: ref.source, path: ref.path });
}

/**
 * The `disabled` list as written: sorted, deduplicated, and dropped entirely once it would be
 * empty — a name with no entry left in `properties` never outlives its map. Mirrors
 * `project/serialize.ts`'s helper of the same purpose.
 */
function disabledList(disabled: readonly string[], properties: PropertyMap): readonly string[] | undefined {
  const known = new Set(Object.keys(properties));
  const kept = [...new Set(disabled.filter((name) => known.has(name)))].sort();
  return kept.length > 0 ? kept : undefined;
}

/**
 * Builds the complete `relative path -> content` map for a workspace.
 *
 * Every environment slug is validated with {@link assertPathSegment} before
 * any path is built, so a corrupted slug throws
 * `WorkspaceError('workspace-path-invalid')` here — before `saveWorkspace`
 * ever touches the file system.
 *
 * `activeEnvironmentId` (machine-local, see `model.ts`) and `writtenBy` (dropped outright) never
 * appear in the written manifest — see `local-state.ts` for where the former actually lives.
 */
export function workspaceFiles(workspace: Workspace): WorkspaceFiles {
  const files = new Map<string, string>();

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
        disabled: disabledList(workspace.disabledProperties, workspace.properties),
        projects: workspace.projects.map((ref) => projectRefDocument(ref)),
      }),
    ),
  );

  for (const environment of workspace.environments) {
    assertPathSegment(environment.slug);
    files.set(
      `${WORKSPACE_ENVIRONMENTS_DIR}/${environment.slug}.yaml`,
      stringifyYaml(
        compact({
          id: environment.id,
          name: environment.name,
          order: environment.order,
          properties: { ...environment.properties },
          endpoints: { ...environment.endpoints },
          disabled: disabledList(environment.disabledProperties, environment.properties),
        }),
      ),
    );
  }

  return files;
}
