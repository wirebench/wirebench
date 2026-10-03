/**
 * `license.installed` and `license.removed` (audit-log spec §3.2, plan ruling 5): the one kind written
 * after the commit, from the `licenseChanged` announcement. The actor is looked up by id. The command
 * line never announces (ruling 2) and records its own installs.
 */
import type { FastifyBaseLogger } from 'fastify';
import { recordAudit, type AuditActorInput, type LicenseChanged, type Querier, type ServerHooks } from '../context.js';
import { findUserById } from '../identity/repo.js';

export function licenseListener(env: {
  readonly db: Querier;
  readonly hooks: ServerHooks;
  readonly log: FastifyBaseLogger;
}): (event: LicenseChanged) => void {
  return (event) => {
    void (async () => {
      const user = event.actorUserId === null ? undefined : await findUserById(env.db, event.actorUserId);
      const actor: AuditActorInput =
        user === undefined ? { kind: 'system' } : { kind: 'user', userId: user.id, email: user.email };
      await recordAudit(env.hooks, env.db, {
        actor,
        action: event.action === 'installed' ? 'license.installed' : 'license.removed',
        target: { kind: 'license', ...(event.licenseId !== undefined ? { id: event.licenseId } : {}) },
        details: { edition: event.edition ?? null },
      });
    })().catch((error: unknown) => env.log.warn({ err: error }, 'audit: license change not recorded'));
  };
}
