/**
 * Issued SAML tokens, cached in memory for their lifetime (owner ruling 3). A run creates one per
 * run; the desktop creates one for the whole session. A token with no lifetime is used once; a
 * failure is never cached; two sends that need the same token share one STS call.
 */
import { createHash } from 'node:crypto';
import { requestIssuedToken } from './client.js';
import type { IssuedTokenTarget, TrustDeps } from './client.js';
import type { IssuedKeyType, IssuedToken, SamlVersion, WssIssuedTokenEntry } from '../model.js';

/** A token this close to expiry counts as expired, as OAuth2's `needsRefresh` does. */
export const ISSUED_TOKEN_REFRESH_MARGIN_MS = 60_000;

export interface IssuedTokenStatus {
  readonly state: 'none' | 'valid' | 'expired';
  readonly expiresAt?: string;
  readonly samlVersion?: SamlVersion;
  readonly keyType?: IssuedKeyType;
  readonly stsHost?: string;
  /** The last failure's message for this key, until a fetch succeeds. */
  readonly lastError?: string;
  /**
   * With `state: 'none'`: the last fetch succeeded, but the token service gave no expiry, so its
   * token was used once and not kept. Cleared by Clear, a failure, or a later token that is kept.
   */
  readonly singleUse?: true;
}

export interface IssuedTokenSource {
  get(entry: WssIssuedTokenEntry, target: IssuedTokenTarget, deps: TrustDeps): Promise<IssuedToken>;
  peek(entry: WssIssuedTokenEntry, target: IssuedTokenTarget): IssuedToken | undefined;
  /** Drops `token` after the service refused it. Never re-sends. */
  reject(token: IssuedToken): void;
  status(entry: WssIssuedTokenEntry, target: IssuedTokenTarget): IssuedTokenStatus;
  clear(entry: WssIssuedTokenEntry, target: IssuedTokenTarget): void;
}

export interface IssuedTokenSourceOptions {
  readonly now?: () => Date;
  readonly request?: typeof requestIssuedToken;
  readonly onSecretValue?: (value: string) => void;
}

function credentialIdentity(entry: WssIssuedTokenEntry): string {
  const credential = entry.credential;
  if (credential.kind === 'username') return `u:${credential.username}`;
  if (credential.kind === 'certificate') return `c:${credential.keystoreRef}:${credential.alias ?? ''}`;
  return `k:${credential.spn}:${credential.principal ?? ''}:${credential.username ?? ''}${
    credential.domain !== undefined && credential.domain !== '' ? `:${credential.domain}` : ''
  }`;
}

/**
 * The key a token is cached under (spec §3.5, plan amendment 8). URLs are expanded, so switching
 * environments gets a different token. No secret goes in; a changed password is what Clear is for.
 */
export function issuedCacheKey(entry: WssIssuedTokenEntry, target: IssuedTokenTarget): string {
  const appliesTo =
    entry.appliesTo !== undefined && entry.appliesTo !== '' ? target.expand(entry.appliesTo) : target.endpointUrl;
  const identity = [
    target.expand(entry.stsUrl),
    entry.trustVersion,
    entry.soapVersion,
    entry.tokenType,
    entry.keyType,
    appliesTo,
    `${entry.proofKeystoreRef ?? ''}:${entry.proofAlias ?? ''}`,
    credentialIdentity(entry),
    createHash('sha256')
      .update(entry.claims !== undefined ? target.expand(entry.claims) : '')
      .digest('hex'),
  ].join('\u0000');
  return createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

export function createIssuedTokenSource(options: IssuedTokenSourceOptions = {}): IssuedTokenSource {
  const now = options.now ?? ((): Date => new Date());
  const request = options.request ?? requestIssuedToken;
  const tokens = new Map<string, IssuedToken>();
  const inFlight = new Map<string, Promise<IssuedToken>>();
  const errors = new Map<string, string>();
  /** The last token fetched for a key that had no expiry, so was used once and never cached. */
  const singleUse = new Map<string, IssuedToken>();
  /** Bumped by clear and reject, so a fetch already under way cannot cache after one. */
  const generations = new Map<string, number>();
  const generationOf = (key: string): number => generations.get(key) ?? 0;
  const bump = (key: string): void => {
    generations.set(key, generationOf(key) + 1);
  };
  const fresh = (token: IssuedToken | undefined): token is IssuedToken =>
    token?.expiresAt !== undefined && token.expiresAt.getTime() - ISSUED_TOKEN_REFRESH_MARGIN_MS > now().getTime();

  return {
    async get(entry, target, deps) {
      const key = issuedCacheKey(entry, target);
      const cached = tokens.get(key);
      if (fresh(cached)) return cached;
      const pending = inFlight.get(key);
      if (pending !== undefined) return await pending;
      const startedAt = generationOf(key);
      const fetching = (async () => {
        try {
          // Deferred a tick, so a synchronous throw cannot clear inFlight before it is set.
          const fetched = await Promise.resolve().then(() => request(entry, target, deps));
          const token: IssuedToken = { ...fetched, cacheKey: key };
          options.onSecretValue?.(token.assertionXml);
          if (generationOf(key) !== startedAt) return token;
          errors.delete(key);
          if (token.expiresAt !== undefined) {
            tokens.set(key, token);
            singleUse.delete(key);
          } else {
            tokens.delete(key);
            singleUse.set(key, token);
          }
          return token;
        } catch (error) {
          if (generationOf(key) === startedAt) {
            errors.set(key, error instanceof Error ? error.message : String(error));
            tokens.delete(key);
            singleUse.delete(key);
          }
          throw error;
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, fetching);
      return await fetching;
    },
    peek(entry, target) {
      const cached = tokens.get(issuedCacheKey(entry, target));
      return fresh(cached) ? cached : undefined;
    },
    reject(token) {
      bump(token.cacheKey);
      if (tokens.get(token.cacheKey)?.assertionXml === token.assertionXml) tokens.delete(token.cacheKey);
    },
    status(entry, target) {
      const key = issuedCacheKey(entry, target);
      const token = tokens.get(key);
      const lastError = errors.get(key);
      if (token === undefined) {
        const once = singleUse.get(key);
        // What the single-use token was, without the assertion itself; there is no expiry to show.
        return once === undefined
          ? { state: 'none', ...(lastError !== undefined ? { lastError } : {}) }
          : {
              state: 'none',
              singleUse: true,
              samlVersion: once.samlVersion,
              keyType: once.keyType,
              stsHost: once.stsHost,
            };
      }
      return {
        state: fresh(token) ? 'valid' : 'expired',
        ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt.toISOString() } : {}),
        samlVersion: token.samlVersion,
        keyType: token.keyType,
        stsHost: token.stsHost,
      };
    },
    clear(entry, target) {
      const key = issuedCacheKey(entry, target);
      bump(key);
      tokens.delete(key);
      errors.delete(key);
      singleUse.delete(key);
    },
  };
}
