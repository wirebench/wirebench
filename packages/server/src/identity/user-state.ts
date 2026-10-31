/**
 * The disable/enable transition (saml-scim plan ruling 4): one path for an admin's `PATCH /users/:id` and
 * for SCIM deprovisioning, so the two can never drift. Disabling revokes every device token (§3.1);
 * restoring a disabled account takes a seat (licensing §3.4). It runs inside the caller's transaction,
 * re-reads the user there, and answers whether anything changed; the caller announces `sessionEnded`
 * after commit.
 */
import { recordAudit, type AuditSource } from '../context.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import type { IdentityEnv } from './env.js';
import * as repo from './repo.js';

export async function setUserDisabled(
  env: Pick<IdentityEnv, 'ctx' | 'now'>,
  tx: TenantQuerier,
  userId: string,
  disabled: boolean,
  source: AuditSource,
): Promise<boolean> {
  const current = await repo.findUserById(tx, userId);
  if (current === undefined || (current.disabledAt !== null) === disabled) return false;
  const now = env.now();
  if (disabled) {
    await repo.setDisabled(tx, userId, now);
    await repo.revokeTokensOfUser(tx, userId, now);
  } else {
    await env.ctx.license.assertSeatAvailable(tx);
    await repo.setDisabled(tx, userId, null);
  }
  await recordAudit(env.ctx.hooks, tx, {
    ...source,
    action: disabled ? 'user.disabled' : 'user.enabled',
    target: { kind: 'user', id: userId },
  });
  return true;
}
