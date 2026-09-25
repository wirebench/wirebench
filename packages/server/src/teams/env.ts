import type { ServerContext } from '../context.js';
import type { InvitationEnv } from '../identity/env.js';

/** Everything a teams route file needs; built once by `module.ts` and passed to each route group. */
export interface TeamsEnv {
  readonly ctx: ServerContext;
  readonly now: () => Date;
  /** What identity's `createInvitation` and `revokeOpenInvitation` need, from the same context. */
  readonly invitations: InvitationEnv;
}
