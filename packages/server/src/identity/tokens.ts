/**
 * Random material and its hashes (identity spec §3.5, §6): device tokens, invitation secrets,
 * OIDC grants and states. The database only ever sees `sha256(value)`; the value goes to the
 * client exactly once. A token is `wbs_` + base64url(32 bytes) so a leaked one is recognisable
 * in a log or a scanner, and `bearerToken` accepts nothing else.
 */
import { createHash, randomBytes } from 'node:crypto';
import { DEVICE_TOKEN_PATTERN } from '@wirebench/engine';
import { ulid } from 'ulidx';

export const TOKEN_PREFIX = 'wbs_';

export function newId(): string {
  return ulid();
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function mintSecret(): { readonly secret: string; readonly hash: string } {
  const secret = randomBytes(32).toString('base64url');
  return { secret, hash: hashSecret(secret) };
}

export function hashToken(token: string): string {
  return hashSecret(token);
}

export function mintToken(): { readonly token: string; readonly hash: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token) };
}

/** The token in an `Authorization: Bearer wbs_…` header, or `undefined` for anything else. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  return token !== undefined && DEVICE_TOKEN_PATTERN.test(token) ? token : undefined;
}

/** RFC 7636 S256: what the desktop sends as `codeChallenge` and proves with the verifier later. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
