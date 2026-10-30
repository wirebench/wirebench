// packages/server/src/licensing/gate.ts
/**
 * The feature gate (licensing spec §3.5). Registered after a route's role guard, so an unauthenticated
 * or forbidden caller hears the guard first. It reads the state at request time: an installed license
 * takes effect on the next request.
 */
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Feature, LicenseState } from '@wirebench/engine';
import { featureRequired } from './errors.js';

/** `state` is the request's tenant's: a license installed in one tenant unlocks nothing in another. */
export function requireFeature(
  feature: Feature,
  state: (request: FastifyRequest) => Promise<LicenseState>,
): preHandlerAsyncHookHandler {
  return async (request) => {
    if (!(await state(request)).features.includes(feature)) throw featureRequired(feature);
  };
}
