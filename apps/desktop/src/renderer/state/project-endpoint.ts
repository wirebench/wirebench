/**
 * Endpoint resolution on the renderer's mirror: which URL a request would be sent to, and why.
 * Split out of `project.ts` so the store file stays about state and actions.
 */

import type { EndpointSourceWire, EndpointWire } from '../../shared/wire-types.js';
import type { ProjectSnapshot } from './project.js';
import { useWorkspaceStore } from './workspace.js';

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
 * `resolveEndpoint` precedence on the wire model: the active environment's override for the
 * interface's slug (an explicit deployment choice) beats everything, then the request's own
 * custom URL, then its chosen endpoint, then the interface default, then its first endpoint.
 *
 * Advisory only — `request.preflight` (and the send itself) resolve this in the main process,
 * against the authoritative model.
 */
export function selectRequestEndpoint(state: ProjectSnapshot, requestId: string): ResolvedEndpoint {
  const request = state.requests[requestId];
  if (request === undefined) {
    return { source: 'none' };
  }
  const iface = state.interfaces[request.interfaceId];

  // The active environment is the *workspace's*, and its endpoint keys are
  // `<projectSlug>/<interfaceSlug>` — read straight from the workspace store rather than
  // threaded through every caller, since this whole module is an advisory mirror of what main
  // will decide anyway (`request.preflight` is the authority).
  if (iface !== undefined) {
    const workspace = useWorkspaceStore.getState().workspace;
    const active = workspace?.environments.find((candidate) => candidate.id === workspace.activeEnvironmentId);
    const projectId = state.projectOf[iface.id];
    const projectSlug = workspace?.projects.find((project) => project.id === projectId)?.slug;
    const override = projectSlug === undefined ? undefined : active?.endpoints[`${projectSlug}/${iface.slug}`];
    if (override !== undefined) {
      return { url: override, source: 'workspace-environment' };
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
export function selectRequestTrustsInvalid(state: ProjectSnapshot, requestId: string): boolean {
  return selectRequestEndpoint(state, requestId).trustInvalid === true;
}

/**
 * Just the URL from {@link selectRequestEndpoint}. Returns a primitive, so it is safe to pass
 * straight to `useProjectStore(...)` without a custom equality function.
 */
export function selectRequestEndpointUrl(state: ProjectSnapshot, requestId: string): string | undefined {
  return selectRequestEndpoint(state, requestId).url;
}

/**
 * Just the source from {@link selectRequestEndpoint}. Like {@link selectRequestEndpointUrl},
 * it returns a primitive so it is safe inside a `useProjectStore(...)` selector.
 */
export function selectRequestEndpointSource(state: ProjectSnapshot, requestId: string): EndpointSourceWire {
  return selectRequestEndpoint(state, requestId).source;
}
