/** Minting a session for a user who just proved who they are, and the sweep that ends stale ones. */
import { MAX_DEVICE_NAME_LENGTH, type ServerUser, type SignInResponse } from '@wirebench/engine';
import { recordAudit, type AuditSource } from '../context.js';
import type { TenantScope } from '../tenancy/scope.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import type { IdentityEnv } from './env.js';
import * as repo from './repo.js';
import { mintToken, newId } from './tokens.js';

export const emailLower = (email: string): string => email.trim().toLowerCase();

export function publicUser(user: repo.UserRow): ServerUser {
  return { id: user.id, email: user.email, displayName: user.displayName, serverAdmin: user.serverAdmin };
}

/**
 * The token is returned here and nowhere else (§3.5); the row keeps only its hash. `kind` is
 * `browser` for a session the browser keeps in its cookie (hosted spec §17.2), which the guard
 * accepts only from the cookie.
 */
export async function issueToken(
  env: Pick<IdentityEnv, 'now'>,
  db: TenantQuerier,
  user: repo.UserRow,
  deviceName: string,
  kind: repo.TokenKind,
): Promise<{ response: SignInResponse; tokenId: string }> {
  const { token, hash } = mintToken();
  const id = newId();
  await repo.insertToken(db, {
    id,
    userId: user.id,
    tokenHash: hash,
    deviceName: deviceLabel(deviceName),
    kind,
    at: env.now(),
  });
  return { response: { token, user: publicUser(user) }, tokenId: id };
}

const deviceLabel = (name: string): string => name.trim().slice(0, MAX_DEVICE_NAME_LENGTH) || 'device';

/** The token and its `auth.signed_in` event (audit-log §3.2), committed together in `scope`'s unit. */
export async function signIn(
  env: Pick<IdentityEnv, 'ctx' | 'now'>,
  scope: TenantScope,
  user: repo.UserRow,
  method: 'local' | 'oidc' | 'saml',
  deviceName: string,
  source: AuditSource,
  kind: repo.TokenKind = 'device',
): Promise<SignInResponse> {
  return env.ctx.tenancy.db(scope).transaction(async (tx) => {
    const issued = await issueToken(env, tx, user, deviceName, kind);
    await recordAudit(env.ctx.hooks, tx, {
      ...source,
      actor: { kind: 'user', userId: user.id, email: user.email, tokenId: issued.tokenId },
      action: 'auth.signed_in',
      target: { kind: 'user', id: user.id },
      details: { method, device: deviceLabel(deviceName), tokenId: issued.tokenId },
    });
    return issued.response;
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const SWEEP_JOB = 'identity-sweep';

/**
 * The daily sweep (§3.5): what lazy expiry never touched because nobody used it again, and stale sign-in
 * flows. One unit per tenant (hosted edition spec §19.8 guard 6), so one tenant's failure, logged with the
 * tenant id, leaves the others swept.
 */
export async function sweepExpired(env: Pick<IdentityEnv, 'ctx' | 'settings' | 'now'>): Promise<void> {
  const now = env.now().getTime();
  await env.ctx.tenancy.forEachTenant(
    SWEEP_JOB,
    async (tx) => {
      await repo.deleteExpiredTokens(tx, {
        idleBefore: new Date(now - env.settings.tokenIdleMs),
        createdBefore: new Date(now - env.settings.tokenMaxMs),
        revokedBefore: new Date(now - DAY_MS),
      });
      await repo.deleteExpiredFlows(tx, new Date(now));
      await repo.deleteExpiredBrowserFlows(tx, new Date(now));
    },
    env.ctx.log,
  );
}
