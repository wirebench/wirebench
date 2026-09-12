/**
 * Serialises the read-modify-write edits a workspace environment's maps need.
 *
 * `update-workspace-environment` REPLACES `endpoints` and `properties` wholesale, so every edit
 * has to read the current map, change one key and send the result. Two edits fired before the
 * first round trip resolves would both read the same "current" map and the second would drop
 * the first. Rather than debounce (which only narrows the window), each environment gets a
 * promise chain: a patch is built from the store *after* the previous patch for that
 * environment has resolved — and by then the store holds what main just wrote back, because
 * `useWorkspaceStore.mutate` applies the fresh snapshot before it resolves.
 */

import type { WorkspaceEnvironmentPatchWire, WorkspaceEnvironmentWire } from '../../../shared/wire-types.js';
import { useWorkspaceStore } from '../../state/workspace.js';

/** The tail of each environment's chain, keyed by environment id. */
const queues = new Map<string, Promise<void>>();

/**
 * Queues one patch for a workspace environment. `build` is called with the environment as it
 * stands when the patch's turn comes up, and returns the patch to send — or `undefined` to send
 * nothing (the edit was a no-op, or the environment has since been deleted).
 *
 * @returns a promise that settles when this patch has been applied (or skipped). Rejections are
 * swallowed here: the store already surfaces the error, and one failed edit must not wedge the
 * queue for the rest of the session.
 */
export function queueEnvironmentPatch(
  environmentId: string,
  build: (environment: WorkspaceEnvironmentWire) => WorkspaceEnvironmentPatchWire | undefined,
): Promise<void> {
  const run = (queues.get(environmentId) ?? Promise.resolve())
    .then(async () => {
      const environment = useWorkspaceStore
        .getState()
        .workspace?.environments.find((candidate) => candidate.id === environmentId);
      if (environment === undefined) {
        return;
      }
      const patch = build(environment);
      if (patch === undefined) {
        return;
      }
      await useWorkspaceStore.getState().mutate({ kind: 'update-workspace-environment', environmentId, patch });
    })
    .catch(() => undefined)
    .finally(() => {
      // Only the tail may clear the entry: a later patch may already have chained onto it.
      if (queues.get(environmentId) === run) {
        queues.delete(environmentId);
      }
    });
  queues.set(environmentId, run);
  return run;
}

/**
 * Queues an endpoint override edit: sets `key` to `url`, or drops the key when `url` is blank.
 * A value equal to what is already stored sends nothing.
 */
export function queueEndpointOverride(environmentId: string, key: string, url: string): Promise<void> {
  return queueEnvironmentPatch(environmentId, (environment) => {
    const next: Record<string, string> = { ...environment.endpoints };
    const trimmed = url.trim();
    if (trimmed.length === 0) {
      delete next[key];
    } else {
      next[key] = trimmed;
    }
    return next[key] === environment.endpoints[key] ? undefined : { endpoints: next };
  });
}
