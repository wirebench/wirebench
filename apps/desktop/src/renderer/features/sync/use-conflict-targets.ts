import { useMemo } from 'react';
import { useProjectStore } from '../../state/project.js';
import { useSyncStore } from '../../state/sync.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { ConflictTargetProject, ConflictTargetRequest, ConflictTargets } from './conflict-targets.js';
import { conflictTargets } from './conflict-targets.js';

/**
 * The derived set of conflicted project and request ids for the open workspace — the explorer's
 * conflict badges and the request editor's read-only note both read this instead of keeping a
 * copy of their own, so they can never drift from `useSyncStore.conflicts`. Builds
 * {@link conflictTargets}'s inputs from three stores: the workspace's own project list (for the
 * `projects/<slug>/` prefix), the project store's `interfaces` (for each request's interface
 * slug) and `projectOf` (the entity-id index, Task 21) plus `requests` (each request's own
 * `slug`/`operationSlug`, Task 11 fix round 1) for the exact on-disk path per request.
 */
export function useConflictTargets(): ConflictTargets {
  const conflicts = useSyncStore((state) => state.conflicts);
  const requests = useProjectStore((state) => state.requests);
  const interfaces = useProjectStore((state) => state.interfaces);
  const projectOf = useProjectStore((state) => state.projectOf);
  const workspaceProjects = useWorkspaceStore((state) => state.workspace?.projects);

  return useMemo(() => {
    const projects: ConflictTargetProject[] = (workspaceProjects ?? []).map((project) => ({
      id: project.id,
      slug: project.slug,
    }));

    const targets: ConflictTargetRequest[] = [];
    for (const request of Object.values(requests)) {
      const projectId = projectOf[request.id];
      const interfaceSlug = interfaces[request.interfaceId]?.slug;
      if (projectId === undefined || interfaceSlug === undefined) {
        continue;
      }
      targets.push({
        id: request.id,
        projectId,
        interfaceSlug,
        operationSlug: request.operationSlug,
        slug: request.slug,
      });
    }
    return conflictTargets(conflicts, projects, targets);
  }, [conflicts, requests, interfaces, projectOf, workspaceProjects]);
}
