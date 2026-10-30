/**
 * `license.installed` and `license.removed` (audit-log spec §3.2, plan ruling 5): the one kind written
 * after the commit, from the `licenseChanged` announcement. The actor is looked up by id. The command
 * line never announces (ruling 2) and records its own installs.
 */
import type { FastifyBaseLogger } from 'fastify';
import { recordAudit, type AuditActorInput, type LicenseChangedEvent, type ServerHooks } from '../context.js';
import { findUserById } from '../identity/repo.js';
import type { Tenancy } from '../tenancy/tenancy.js';

/** The actor and the event are read and written in one unit of the tenant the license changed in. */
export function licenseListener(env: {
  readonly tenancy: Pick<Tenancy, 'db'>;
  readonly hooks: ServerHooks;
  readonly log: FastifyBaseLogger;
}): (event: LicenseChangedEvent) => void {
  return (event) => {
    env.tenancy
      .db(event.tenant)
      .transaction(async (tx) => {
        const user = event.actorUserId === null ? undefined : await findUserById(tx, event.actorUserId);
        const actor: AuditActorInput =
          user === undefined ? { kind: 'system' } : { kind: 'user', userId: user.id, email: user.email };
        await recordAudit(env.hooks, tx, {
          actor,
          action: event.action === 'installed' ? 'license.installed' : 'license.removed',
          target: { kind: 'license', ...(event.licenseId !== undefined ? { id: event.licenseId } : {}) },
          details: { edition: event.edition ?? null },
        });
      })
      .catch((error: unknown) => env.log.warn({ err: error }, 'audit: license change not recorded'));
  };
}
