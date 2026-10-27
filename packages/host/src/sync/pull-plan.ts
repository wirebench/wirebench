/**
 * Pure helpers that turn a pull's changed tree paths into what `WorkspaceService` has to do about
 * them: which workspace-level files to reload, which projects' hosts to reload (with paths relative
 * to each project folder, as a host's own watcher reports them), how many entities changed, and
 * which project a conflicted path belongs to.
 *
 * No I/O, no Electron. Tree paths are always `/`-separated, exactly as git reports them.
 */

import { describeTreePath, WORKSPACE_PROJECTS_DIR } from '@wirebench/engine';
import { isWorkspaceManagedPath } from '../project-watch.js';
import type { SyncConflictWire } from './types.js';

/** What a pull changed, grouped the way the service applies it. */
export interface PullPlan {
  /** `workspace.yaml` and `environments/<name>.yaml` paths, in input order. */
  readonly workspacePaths: string[];
  /** Project slug → paths relative to `projects/<slug>/`, in first-seen order. */
  readonly projects: Map<string, string[]>;
  /** Distinct entities touched (a request's `.request.yaml` and `.xml` count once). */
  readonly entityCount: number;
}

const PROJECTS_PREFIX = `${WORKSPACE_PROJECTS_DIR}/`;

/** The slug of the project a tree path lies inside (`projects/<slug>/…`), or `undefined`. */
export function projectSlugOfTreePath(path: string): string | undefined {
  if (!path.startsWith(PROJECTS_PREFIX)) {
    return undefined;
  }
  const rest = path.slice(PROJECTS_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) {
    return undefined;
  }
  return rest.slice(0, slash);
}

/** Groups `changedPaths` (tree-relative) into workspace-level and per-project sets. */
export function planPull(changedPaths: readonly string[]): PullPlan {
  const workspacePaths: string[] = [];
  const projects = new Map<string, string[]>();
  const keys = new Set<string>();
  for (const path of changedPaths) {
    keys.add(describeTreePath(path).key);
    if (isWorkspaceManagedPath(path)) {
      workspacePaths.push(path);
      continue;
    }
    const slug = projectSlugOfTreePath(path);
    if (slug === undefined) {
      continue;
    }
    const relative = path.slice(PROJECTS_PREFIX.length + slug.length + 1);
    const list = projects.get(slug);
    if (list === undefined) {
      projects.set(slug, [relative]);
    } else {
      list.push(relative);
    }
  }
  return { workspacePaths, projects, entityCount: keys.size };
}

/**
 * Copies of `conflicts` with `projectId` filled from each path's `projects/<slug>/` prefix,
 * through `projectIdOfSlug` (the open workspace's entries). A path outside any project, or in a
 * slug the workspace does not know, is returned unchanged.
 */
export function fillConflictProjectIds(
  conflicts: readonly SyncConflictWire[],
  projectIdOfSlug: (slug: string) => string | undefined,
): SyncConflictWire[] {
  return conflicts.map((conflict) => {
    const slug = projectSlugOfTreePath(conflict.path);
    const projectId = slug === undefined ? undefined : projectIdOfSlug(slug);
    return projectId === undefined ? conflict : { ...conflict, projectId };
  });
}
