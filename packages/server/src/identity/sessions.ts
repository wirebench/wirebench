/** Minting a session for a user who just proved who they are, and the sweep that ends stale ones. */
import { MAX_DEVICE_NAME_LENGTH, type ServerUser, type SignInResponse } from '@wirebench/engine';
import { recordAudit, type AuditSource, type Querier } from '../context.js';
import type { IdentityEnv } from './env.js';
import * as repo from './repo.js';
import { mintToken, newId } from './tokens.js';

export const emailLower = (email: string): string => email.trim().toLowerCase();

export function publicUser(user: repo.UserRow): ServerUser {
  return { id: user.id, email: user.email, displayName: user.displayName, serverAdmin: user.serverAdmin };
}

/** The token is returned here and nowhere else (§3.5); the row keeps only its hash. */
export async function issueToken(
  env: IdentityEnv,
  user: repo.UserRow,
  deviceName: string,
  db: Querier = env.ctx.db,
): Promise<{ response: SignInResponse; tokenId: string }> {
  const { token, hash } = mintToken();
  const id = newId();
  await repo.insertToken(db, {
    id,
    userId: user.id,
    tokenHash: hash,
    deviceName: deviceLabel(deviceName),
    at: env.now(),
  });
  return { response: { token, user: publicUser(user) }, tokenId: id };
}

const deviceLabel = (name: string): string => name.trim().slice(0, MAX_DEVICE_NAME_LENGTH) || 'device';

/** The token and its `auth.signed_in` event (audit-log §3.2), committed together. */
export async function signIn(
  env: IdentityEnv,
  user: repo.UserRow,
  method: 'local' | 'oidc',
  deviceName: string,
  source: AuditSource,
): Promise<SignInResponse> {
  return env.ctx.db.transaction(async (tx) => {
    const issued = await issueToken(env, user, deviceName, tx);
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

/** The daily sweep (§3.5): what lazy expiry never touched because nobody used it again. */
export async function sweepExpired(env: IdentityEnv): Promise<void> {
  const now = env.now().getTime();
  await repo.deleteExpiredTokens(env.ctx.db, {
    idleBefore: new Date(now - env.settings.tokenIdleMs),
    createdBefore: new Date(now - env.settings.tokenMaxMs),
    revokedBefore: new Date(now - DAY_MS),
  });
  await repo.deleteExpiredFlows(env.ctx.db, new Date(now));
}
