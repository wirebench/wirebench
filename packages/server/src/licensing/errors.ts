// packages/server/src/licensing/errors.ts
/** Every `licensing-*` problem (licensing spec §3.4–§3.6). None ever carries the license text. */
import type { Feature, LicenseState, WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

const LABEL = { community: 'Community', team: 'Team', enterprise: 'Enterprise' } as const;

/** Says how many seats are used and allowed, and which edition would lift the limit (§3.4). */
export const seatLimit = (state: LicenseState): WirebenchError =>
  problem(
    'licensing-seat-limit',
    `This server has ${state.seats.used} enabled accounts and its ${LABEL[state.edition]} edition allows ${String(state.seats.limit)}. ` +
      (state.edition === 'community'
        ? 'A Team or Enterprise license lifts the limit, or a server admin can disable an account.'
        : 'A license with more seats lifts the limit, or a server admin can disable an account.'),
    409,
  );

/** The host's problem body is `{ code, message }`, so the feature is named in the message (plan ruling 4). */
export const featureRequired = (feature: Feature): WirebenchError =>
  problem(
    'licensing-feature-required',
    `This needs a license that includes "${feature}", which the Enterprise edition does.`,
    403,
  );

export const licenseInvalid = (message: string): WirebenchError => problem('licensing-invalid', message, 400);
