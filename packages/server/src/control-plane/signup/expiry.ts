/**
 * The control loop's signup step (hosted edition spec §22.6, §22.15): removes the signups that will never complete,
 * so their slugs are free again. See `deleteExpiredSignups` for which: a pending one at its expiry, a verified one a
 * week later, since the webhook may still complete it.
 */
import type { LoopStep } from '../loop.js';
import { deleteExpiredSignups } from './repo.js';

export function signupExpiryStep(): LoopStep {
  return {
    name: 'signup-expiry',
    run: async ({ tx, now }) => {
      await deleteExpiredSignups(tx, now);
    },
  };
}
