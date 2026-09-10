/**
 * Endpoint resolution on the renderer's mirror: which URL a request would be sent to, and why.
 * Split out of `project.ts` so the store file stays about state and actions.
 */

import type { EndpointSourceWire } from '../../shared/wire-types.js';
import type { ProjectSnapshot } from './project.js';

/** What {@link selectRequestEndpoint} answers: the URL, and which rule produced it. */
export interface ResolvedEndpoint {
  readonly url?: string;
  readonly source: EndpointSourceWire;
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

  if (iface !== undefined && state.activeEnvironmentId !== undefined) {
    const environment = state.environments.find((candidate) => candidate.id === state.activeEnvironmentId);
    const override = environment?.endpoints[iface.slug];
    if (override !== undefined) {
      return { url: override, source: 'environment' };
    }
  }

  if (request.endpointUrl !== undefined) {
    return { url: request.endpointUrl, source: 'request-custom' };
  }
  if (iface === undefined) {
    return { source: 'none' };
  }
  const byId = (id: string | undefined): string | undefined =>
    id === undefined ? undefined : iface.endpoints.find((endpoint) => endpoint.id === id)?.url;

  const chosen = byId(request.endpointId);
  if (chosen !== undefined) {
    return { url: chosen, source: 'request-endpoint' };
  }
  const fallback = byId(iface.defaultEndpointId) ?? iface.endpoints[0]?.url;
  return fallback === undefined ? { source: 'none' } : { url: fallback, source: 'interface-default' };
}

/**
 * Just the URL from {@link selectRequestEndpoint}. Returns a primitive, so it is safe to pass
 * straight to `useProjectStore(...)` without a custom equality function.
 */
export function selectRequestEndpointUrl(state: ProjectSnapshot, requestId: string): string | undefined {
  return selectRequestEndpoint(state, requestId).url;
}
