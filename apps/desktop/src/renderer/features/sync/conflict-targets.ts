/**
 * Maps the open workspace's unresolved sync conflicts to the projects and requests they touch,
 * so the explorer can badge a conflicted row and the request editor can go read-only. Pure — no
 * store access — so it stays trivially unit-testable; `use-conflict-targets.ts` is the hook that
 * feeds it the live store state and memoises the result.
 *
 * Matching is by tree path, using on-disk slugs — never a display name, and never `slugify`'d on
 * the fly. `uniqueSlug` can suffix a request's on-disk slug (`add`, `add-2`, …) to keep it unique
 * within its operation folder, so re-deriving a slug from the live `name` would silently miss (or
 * misattribute) a renamed or duplicately-named request. `RequestWire.slug`/`operationSlug` and
 * `InterfaceWire.slug` carry the real on-disk names instead.
 */

import type { SyncConflictWire } from '@shared/wire-base.js';

/** The slice of a project the matcher needs: its id and on-disk folder slug. */
export interface ConflictTargetProject {
  readonly id: string;
  readonly slug: string;
}

/** The slice of a request the matcher needs: its id, its project, and its three on-disk slugs. */
export interface ConflictTargetRequest {
  readonly id: string;
  readonly projectId: string;
  readonly interfaceSlug: string;
  readonly operationSlug: string;
  readonly slug: string;
}

/** The projects and requests at least one unresolved conflict touches. */
export interface ConflictTargets {
  readonly projectIds: ReadonlySet<string>;
  readonly requestIds: ReadonlySet<string>;
}

/** The tree-relative path of `request`'s metadata (`.request.yaml`) or envelope (`.xml`) file. */
function requestPaths(project: ConflictTargetProject, request: ConflictTargetRequest): readonly [string, string] {
  const base = `projects/${project.slug}/interfaces/${request.interfaceSlug}/operations/${request.operationSlug}/${request.slug}`;
  return [`${base}.request.yaml`, `${base}.xml`];
}

/**
 * Every project a conflict touches — by `path` starting with `projects/<projectSlug>/` when a
 * known project's slug matches, falling back to `SyncConflictWire.projectId` (filled in by main)
 * when no loaded project's slug matches that prefix — plus every request whose own on-disk path
 * (`.request.yaml` or `.xml`) is exactly the conflict's `path`.
 */
export function conflictTargets(
  conflicts: readonly SyncConflictWire[],
  projects: readonly ConflictTargetProject[],
  requests: readonly ConflictTargetRequest[],
): ConflictTargets {
  const projectIds = new Set<string>();
  const requestIds = new Set<string>();

  const projectById = new Map(projects.map((project) => [project.id, project] as const));

  for (const conflict of conflicts) {
    const byPrefix = projects.find((project) => conflict.path.startsWith(`projects/${project.slug}/`));
    if (byPrefix !== undefined) {
      projectIds.add(byPrefix.id);
    } else if (conflict.projectId !== undefined) {
      projectIds.add(conflict.projectId);
    }

    for (const request of requests) {
      const project = projectById.get(request.projectId);
      if (project === undefined) {
        continue;
      }
      if (requestPaths(project, request).includes(conflict.path)) {
        requestIds.add(request.id);
      }
    }
  }

  return { projectIds, requestIds };
}
