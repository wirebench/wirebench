/**
 * Endpoint resolution on the renderer's mirror: which URL a request would be sent to, and why.
 * Split out of `project.ts` so the store file stays about state and actions.
 */

import type { EndpointSourceWire, EndpointWire, WorkspaceWire } from '../../shared/wire-types.js';
import type { ProjectSnapshot } from './project.js';
import { resolveEndpointOverride } from './endpoint-override.js';

/** What {@link selectRequestEndpoint} answers: the URL, and which rule produced it. */
export interface ResolvedEndpoint {
  readonly url?: string;
  readonly source: EndpointSourceWire;
  /**
   * True when the endpoint object behind the URL has `trustInvalid`. An environment override
   * and a request's custom URL name no endpoint, so they never carry it — which is correct:
   * the flag belongs to the endpoint, not to the address that happens to be in the field.
   */
  readonly trustInvalid?: boolean;
}

/**
 * The URL a request is actually sent to, and where it came from. Mirrors the engine's
 * `resolveWorkspaceEndpoint` precedence on the wire model: a linked project's own environment
 * (matched to the active workspace environment by slug) beats everything, then the active
 * workspace environment's override for `<projectSlug>/<interfaceSlug>`, then the request's own
 * custom URL, then its chosen endpoint, then the interface default, then its first endpoint.
 *
 * Advisory only — `request.preflight` (and the send itself) resolve this in the main process,
 * against the authoritative model.
 *
 * `workspace` is an argument rather than read from the workspace store here so a component's
 * selector depends on it visibly: a consumer subscribes to both stores and passes it in, and an
 * environment switch (which only raises `workspace.changed`) rerenders the URL it shows.
 */
export function selectRequestEndpoint(
  state: ProjectSnapshot,
  workspace: WorkspaceWire | null,
  requestId: string,
): ResolvedEndpoint {
  const request = state.requests[requestId];
  if (request === undefined) {
    return { source: 'none' };
  }
  const iface = state.interfaces[request.interfaceId];

  // The active environment is the *workspace's*, and its endpoint keys are
  // `<projectSlug>/<interfaceSlug>`. A linked project's own environment (matched to the active
  // workspace environment by slug) beats the workspace environment's override — same precedence
  // as the engine's `resolveWorkspaceEndpoint`.
  if (iface !== undefined && workspace !== null) {
    const active = workspace.environments.find((candidate) => candidate.id === workspace.activeEnvironmentId);
    const projectId = state.projectOf[iface.id];
    const projectSlug = workspace.projects.find((project) => project.id === projectId)?.slug;
    const workspaceOverride = projectSlug === undefined ? undefined : active?.endpoints[`${projectSlug}/${iface.slug}`];
    const linkedEnvironment = (projectId === undefined ? undefined : state.projects[projectId])?.environments.find(
      (candidate) => candidate.slug === active?.slug,
    );
    const projectOverride = linkedEnvironment?.endpoints[iface.slug];
    const override = resolveEndpointOverride({
      ...(projectOverride !== undefined ? { projectOverride } : {}),
      ...(workspaceOverride !== undefined ? { workspaceOverride } : {}),
    });
    if (override !== undefined) {
      return { url: override.url, source: override.source === 'project' ? 'environment' : 'workspace-environment' };
    }
  }

  if (request.endpointUrl !== undefined) {
    return { url: request.endpointUrl, source: 'request-custom' };
  }
  if (iface === undefined) {
    return { source: 'none' };
  }
  const byId = (id: string | undefined): EndpointWire | undefined =>
    id === undefined ? undefined : iface.endpoints.find((endpoint) => endpoint.id === id);

  const chosen = byId(request.endpointId);
  if (chosen !== undefined) {
    return {
      url: chosen.url,
      source: 'request-endpoint',
      ...(chosen.trustInvalid === true ? { trustInvalid: true } : {}),
    };
  }
  const fallback = byId(iface.defaultEndpointId) ?? iface.endpoints[0];
  return fallback === undefined
    ? { source: 'none' }
    : {
        url: fallback.url,
        source: 'interface-default',
        ...(fallback.trustInvalid === true ? { trustInvalid: true } : {}),
      };
}

/**
 * Whether the endpoint this request resolves to has certificate verification turned off.
 * A primitive, so it is safe inside a `useProjectStore(...)` selector; it drives the red badge
 * in the request toolbar and the status bar.
 */
export function selectRequestTrustsInvalid(
  state: ProjectSnapshot,
  workspace: WorkspaceWire | null,
  requestId: string,
): boolean {
  return selectRequestEndpoint(state, workspace, requestId).trustInvalid === true;
}

/**
 * Just the URL from {@link selectRequestEndpoint}. Returns a primitive, so it is safe to pass
 * straight to `useProjectStore(...)` without a custom equality function.
 */
export function selectRequestEndpointUrl(
  state: ProjectSnapshot,
  workspace: WorkspaceWire | null,
  requestId: string,
): string | undefined {
  return selectRequestEndpoint(state, workspace, requestId).url;
}

/**
 * Just the source from {@link selectRequestEndpoint}. Like {@link selectRequestEndpointUrl},
 * it returns a primitive so it is safe inside a `useProjectStore(...)` selector.
 */
export function selectRequestEndpointSource(
  state: ProjectSnapshot,
  workspace: WorkspaceWire | null,
  requestId: string,
): EndpointSourceWire {
  return selectRequestEndpoint(state, workspace, requestId).source;
}
