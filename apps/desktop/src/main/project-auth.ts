/**
 * Picks which `EndpointAuth` applies when sending a request. The precedence rules themselves
 * (endpoint `override` vs `complement`, then the interface fallback) live in the engine's
 * `project/endpoints.ts`; this module is the main process's thin, dependency-free door onto
 * them so the IPC layer does not have to reach into the engine's project internals.
 */

import { effectiveAuth as engineEffectiveAuth } from '@wirebench/engine';
import type { EndpointAuth } from '@wirebench/engine';

/**
 * Returns the auth that should be used to send a request, given its own auth, the auth of the
 * endpoint it targets (combined per that endpoint's `authMode`) and the interface's fallback.
 *
 * @param requestAuth the request's own credentials, if any
 * @param endpointAuth the target endpoint's credentials, if any
 * @param authMode how the endpoint's credentials combine with the request's
 * @param interfaceAuth the interface-wide fallback, if any
 */
export function effectiveAuth(
  requestAuth: EndpointAuth | undefined,
  endpointAuth: EndpointAuth | undefined,
  authMode: 'override' | 'complement',
  interfaceAuth?: EndpointAuth,
): EndpointAuth | undefined {
  return engineEffectiveAuth(requestAuth, endpointAuth, authMode, interfaceAuth);
}
