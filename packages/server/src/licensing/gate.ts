// packages/server/src/licensing/gate.ts
/**
 * The feature gate (licensing spec §3.5). Registered after a route's role guard, so an unauthenticated
 * or forbidden caller hears the guard first. It reads the state at request time: an installed license
 * takes effect on the next request.
 */
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Feature } from '@wirebench/engine';
import { featureRequired } from './errors.js';

/**
 * `features` are the request's tenant's: a license installed in one tenant unlocks nothing in another. Only the
 * features: a gate never needs the rest of the license's state, nor its seat count.
 */
export function requireFeature(
  feature: Feature,
  features: (request: FastifyRequest) => Promise<readonly string[]>,
): preHandlerAsyncHookHandler {
  return async (request) => {
    if (!(await features(request)).includes(feature)) throw featureRequired(feature);
  };
}
