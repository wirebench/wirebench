/**
 * The one place the renderer decides which of a linked project's own environment override and
 * the workspace environment's override for an interface wins, when both exist. Mirrors the
 * engine's `resolveWorkspaceEndpoint` precedence (`packages/engine/src/workspace/environments.ts`):
 * the linked project's own environment beats the workspace environment, unconditionally — a
 * project opened inside a workspace still owns its own deployment story.
 *
 * Shared by `environment-grid.tsx` (`effectiveEndpointSource`, for the source label) and
 * `project-endpoint.ts` (`selectRequestEndpoint`, for the URL a request is actually sent to) so
 * there is exactly one precedence implementation in the renderer.
 */

/** Which layer an endpoint override came from. */
export type EndpointOverrideSource = 'project' | 'workspace';

/** An endpoint override and which layer produced it. */
export interface EndpointOverride {
  readonly url: string;
  readonly source: EndpointOverrideSource;
}

/**
 * Picks the winning override between a linked project's own environment (matched to the active
 * workspace environment by slug) and the workspace environment itself. `undefined` when neither
 * has one — the caller falls through to its own next layer (the interface's declared address).
 */
export function resolveEndpointOverride(input: {
  readonly projectOverride?: string;
  readonly workspaceOverride?: string;
}): EndpointOverride | undefined {
  if (input.projectOverride !== undefined) {
    return { url: input.projectOverride, source: 'project' };
  }
  if (input.workspaceOverride !== undefined) {
    return { url: input.workspaceOverride, source: 'workspace' };
  }
  return undefined;
}
