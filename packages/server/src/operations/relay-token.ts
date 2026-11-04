/**
 * The token one instance hands another with a relayed share viewer (hosted edition spec §20.6). HMAC-SHA-256 under a
 * key HKDF derives from `WIREBENCH_SERVER_SECRETS_KEY` with the info `wirebench/instance-relay/v1`, so the secrets
 * key itself never signs anything and no other use of it can produce a relay token.
 *
 * The token is `base64url(payload).base64url(mac)`; the MAC covers the payload's exact bytes, so every field is bound:
 * the tenant, the share and its workspace, the viewer's user and device-token ids, the target holder, an expiry
 * {@link RELAY_TOKEN_TTL_MS} ahead, and the viewer's name, token maximum age and audit source, which the holder admits
 * the viewer with. A token is refused when its MAC differs (compared in constant time), when it was made for another
 * holder or share, when it expired, or when it claims to live longer than {@link RELAY_TOKEN_TTL_MS}.
 *
 * Neither the key nor a token is ever logged.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AuditSource } from '../context.js';

/** How long a relay token is good for: long enough to dial, short enough that a copied one is soon useless. */
export const RELAY_TOKEN_TTL_MS = 30_000;
const INFO = 'wirebench/instance-relay/v1';
const VERSION = 1;
/** Far past any real token: a longer one is refused before it is decoded. */
const MAX_TOKEN_LENGTH = 4096;

/** What a relay token says: who the viewer is, which share in which tenant, and which instance it is for. */
export interface RelayClaims {
  readonly tenantId: string;
  readonly shareId: string;
  readonly workspaceId: string;
  /** The viewer's user id and device-token id, in the tenant. */
  readonly userId: string;
  readonly tokenId: string;
  /** The instance that holds the share, and only it accepts the token. */
  readonly holder: string;
  /** Epoch ms. */
  readonly expiresAt: number;
  /** What the holder's registry admits the viewer with. */
  readonly viewer: {
    readonly name: string;
    /** When the viewer's device token reaches its maximum age, in epoch ms. */
    readonly tokenExpiresAt: number;
    readonly source: AuditSource;
  };
}

const actorSchema = z.object({
  kind: z.literal('user'),
  userId: z.string(),
  email: z.string(),
  tokenId: z.string().optional(),
});

const payloadSchema = z.object({
  v: z.literal(VERSION),
  tenantId: z.string().min(1),
  shareId: z.string().min(1),
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  tokenId: z.string().min(1),
  holder: z.string().min(1),
  expiresAt: z.number().int(),
  viewer: z.object({
    name: z.string(),
    tokenExpiresAt: z.number(),
    source: z.object({ actor: actorSchema, ip: z.string().optional(), userAgent: z.string().optional() }),
  }),
});

/** The relay key, derived once at start-up from the secrets key. */
export function relayKey(secretsKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', secretsKey, Buffer.alloc(0), INFO, 32));
}

function mac(key: Buffer, body: string): Buffer {
  return createHmac('sha256', key).update(body).digest();
}

/** A token for `claims`, good until {@link RELAY_TOKEN_TTL_MS} after `now`. */
export function signRelayToken(key: Buffer, claims: Omit<RelayClaims, 'expiresAt'>, now: number): string {
  const payload = {
    v: VERSION,
    tenantId: claims.tenantId,
    shareId: claims.shareId,
    workspaceId: claims.workspaceId,
    userId: claims.userId,
    tokenId: claims.tokenId,
    holder: claims.holder,
    expiresAt: now + RELAY_TOKEN_TTL_MS,
    viewer: claims.viewer,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(key, body).toString('base64url')}`;
}

/**
 * The claims of a token made under `key` for this holder and share and still good at `now`; `undefined` for any
 * other token, with no reason, so a probe learns nothing.
 */
export function verifyRelayToken(
  key: Buffer,
  token: string,
  expected: { readonly holder: string; readonly shareId: string },
  now: number,
): RelayClaims | undefined {
  if (token.length > MAX_TOKEN_LENGTH) return undefined;
  const parts = token.split('.');
  if (parts.length !== 2) return undefined;
  const [body, sent] = parts as [string, string];
  const given = Buffer.from(sent, 'base64url');
  const wanted = mac(key, body);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const claims: RelayClaims = {
    tenantId: parsed.data.tenantId,
    shareId: parsed.data.shareId,
    workspaceId: parsed.data.workspaceId,
    userId: parsed.data.userId,
    tokenId: parsed.data.tokenId,
    holder: parsed.data.holder,
    expiresAt: parsed.data.expiresAt,
    // JSON has no `undefined`: an optional field is absent, never undefined, as `exactOptionalPropertyTypes` wants.
    viewer: parsed.data.viewer as RelayClaims['viewer'],
  };
  if (claims.holder !== expected.holder || claims.shareId !== expected.shareId) return undefined;
  if (now >= claims.expiresAt || claims.expiresAt > now + RELAY_TOKEN_TTL_MS) return undefined;
  return claims;
}
