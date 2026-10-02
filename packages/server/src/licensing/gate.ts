// packages/server/src/licensing/gate.ts
/**
 * The feature gate (licensing spec §3.5). Registered after a route's role guard, so an unauthenticated
 * or forbidden caller hears the guard first. It reads the state at request time: an installed license
 * takes effect on the next request.
 */
import type { preHandlerAsyncHookHandler } from 'fastify';
import type { Feature, LicenseState } from '@wirebench/engine';
import { featureRequired } from './errors.js';

export function requireFeature(feature: Feature, state: () => Promise<LicenseState>): preHandlerAsyncHookHandler {
  return async () => {
    if (!(await state()).features.includes(feature)) throw featureRequired(feature);
  };
}
