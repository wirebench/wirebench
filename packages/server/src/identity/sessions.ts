/** Minting a session for a user who just proved who they are, and the sweep that ends stale ones. */
import { MAX_DEVICE_NAME_LENGTH, type ServerUser, type SignInResponse } from '@wirebench/engine';
import type { IdentityEnv } from './env.js';
import * as repo from './repo.js';
import { mintToken, newId } from './tokens.js';

export const emailLower = (email: string): string => email.trim().toLowerCase();

export function publicUser(user: repo.UserRow): ServerUser {
  return { id: user.id, email: user.email, displayName: user.displayName, serverAdmin: user.serverAdmin };
}

/** The token is returned here and nowhere else (§3.5); the row keeps only its hash. */
export async function issueToken(env: IdentityEnv, user: repo.UserRow, deviceName: string): Promise<SignInResponse> {
  const { token, hash } = mintToken();
  await repo.insertToken(env.ctx.db, {
    id: newId(),
    userId: user.id,
    tokenHash: hash,
    deviceName: deviceName.trim().slice(0, MAX_DEVICE_NAME_LENGTH) || 'device',
    at: env.now(),
  });
  return { token, user: publicUser(user) };
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
