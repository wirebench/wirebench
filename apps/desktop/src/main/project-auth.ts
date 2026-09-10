/**
 * Picks which `EndpointAuth` applies when sending a request: request-level overrides
 * endpoint-level overrides interface-level, and an explicit `{ type: 'none' }` at a more
 * specific level intentionally turns auth off rather than falling back further. Pure — no I/O —
 * so it is trivial to unit test the precedence rules in isolation from the engine/IPC plumbing.
 */

import type { EndpointAuth } from '@wirebench/engine';

/**
 * Returns the auth that should be used to send a request, given its own auth plus the auth of
 * its endpoint and its interface (both optional, most specific first). The first defined value
 * wins — `undefined` means "not configured at this level", so it falls through to the next.
 */
export function effectiveAuth(
  requestAuth: EndpointAuth | undefined,
  endpointAuth: EndpointAuth | undefined,
  interfaceAuth: EndpointAuth | undefined,
): EndpointAuth | undefined {
  return requestAuth ?? endpointAuth ?? interfaceAuth;
}
