import { useMemo } from 'react';
import { useProjectStore } from '../../state/project.js';
import { useSyncStore } from '../../state/sync.js';
import type { ConflictTargetRequest, ConflictTargets } from './conflict-targets.js';
import { conflictTargets } from './conflict-targets.js';

/**
 * The derived set of conflicted project and request ids for the open workspace — the explorer's
 * conflict badges and the request editor's read-only note both read this instead of keeping a
 * copy of their own, so they can never drift from `useSyncStore.conflicts`. `projectOf` (the
 * project store's entity-id index, Task 21) already maps a request id to its project, so no
 * project-slug parsing is needed here beyond what {@link conflictTargets} does.
 */
export function useConflictTargets(): ConflictTargets {
  const conflicts = useSyncStore((state) => state.conflicts);
  const requests = useProjectStore((state) => state.requests);
  const projectOf = useProjectStore((state) => state.projectOf);

  return useMemo(() => {
    const targets: ConflictTargetRequest[] = [];
    for (const request of Object.values(requests)) {
      const projectId = projectOf[request.id];
      if (projectId !== undefined) {
        targets.push({ id: request.id, projectId, name: request.name });
      }
    }
    return conflictTargets(conflicts, targets);
  }, [conflicts, requests, projectOf]);
}
