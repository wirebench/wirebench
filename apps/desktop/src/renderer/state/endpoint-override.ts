/**
 * The one place the renderer decides which of a linked project's own environment override and
 * the workspace environment's override for an interface wins, when both exist. Mirrors the
 * engine's `resolveWorkspaceEndpoint` precedence (`packages/engine/src/workspace/environments.ts`):
 * the linked project's own environment beats the workspace environment, unconditionally — a
 * project opened inside a workspace still owns its own deployment story.
 *
 * `effectiveEndpointSource` below turns the same precedence into a label rather than a URL —
 * `features/environments/endpoints-table.tsx` uses it for the endpoints table's source column.
 * `project-endpoint.ts` (`selectRequestEndpoint`) uses `resolveEndpointOverride` directly for
 * the URL a request is actually sent to. Either way there is exactly one precedence
 * implementation in the renderer.
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

/** Where the URL a request would actually be sent to comes from, for one interface + environment. */
export type EffectiveEndpointSource = 'project' | 'workspace' | 'interface' | 'none';

/**
 * Which layer wins for one interface under one environment, as a label rather than a URL.
 * Mirrors {@link resolveEndpointOverride}'s precedence, falling through to the interface's own
 * declared address (or `'none'`, when there is neither an override nor a declared address).
 */
export function effectiveEndpointSource(input: {
  readonly projectOverride?: string;
  readonly workspaceOverride?: string;
  readonly interfaceDefault?: string;
}): EffectiveEndpointSource {
  const override = resolveEndpointOverride(input);
  if (override !== undefined) {
    return override.source;
  }
  return input.interfaceDefault !== undefined ? 'interface' : 'none';
}
