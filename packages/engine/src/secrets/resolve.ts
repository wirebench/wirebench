/**
 * Resolves an `EndpointAuth` (which only ever carries a `passwordRef`) into the plaintext shape
 * the engine's `importDefinition`/send path expects. Kept pure — the secret getter is injected —
 * so it needs no Electron and is trivially testable without a real `SecretStore`.
 */

import { WirebenchError } from '../errors.js';
import type { AuthConfig, EndpointAuth } from '../project/model.js';
import type { SendAuth } from '../types.js';

/** Turns a `secretRef` into its value. The one seam every host fills in: a keychain, or `process.env`. */
export type GetSecret = (ref: string) => Promise<string | undefined>;

/**
 * The message for a `secret-missing` error: in a shared workspace, secret refs travel with the
 * project but values stay in each member's local keychain-backed store, so a teammate who joins
 * sees a ref with nothing behind it on their machine. Named by username when one is known,
 * otherwise a generic fallback — either way it tells the user where to act instead of merely
 * naming the dangling ref.
 */
export function secretMissingMessage(username: string | undefined): string {
  return username !== undefined
    ? `The password for "${username}" is not on this machine — enter it in the authentication settings.`
    : 'A saved password is not on this machine — enter it in the authentication settings.';
}

/** The engine-facing shape: a resolved password in place of a `passwordRef`. */
export interface ResolvedAuth {
  readonly type: EndpointAuth['type'];
  readonly username?: string;
  readonly password?: string;
  readonly domain?: string;
  readonly workstation?: string;
  readonly preemptive?: boolean;
}

/**
 * Looks up `auth.passwordRef` via `getSecret` and returns the resolved auth. Returns `undefined`
 * when `auth` itself is `undefined` (nothing to resolve). Throws a `secret-missing`
 * `WirebenchError` when a `passwordRef` is set but the store has no value for it — a dangling
 * reference must fail loudly rather than silently sending no credentials.
 */
export async function resolveEndpointAuth(
  auth: EndpointAuth | undefined,
  getSecret: GetSecret,
): Promise<ResolvedAuth | undefined> {
  if (!auth) {
    return undefined;
  }
  const resolved: ResolvedAuth = {
    type: auth.type,
    ...(auth.username !== undefined ? { username: auth.username } : {}),
    ...(auth.domain !== undefined ? { domain: auth.domain } : {}),
    ...(auth.workstation !== undefined ? { workstation: auth.workstation } : {}),
    ...(auth.preemptive !== undefined ? { preemptive: auth.preemptive } : {}),
  };
  if (auth.passwordRef === undefined) {
    return resolved;
  }
  const password = await getSecret(auth.passwordRef);
  if (password === undefined) {
    throw new WirebenchError('secret-missing', secretMissingMessage(auth.username), {
      details: { ref: auth.passwordRef },
    });
  }
  return { ...resolved, password };
}

/**
 * Resolves any {@link AuthConfig} into the engine's `SendAuth` — the shape that carries values
 * rather than references.
 *
 * The token-bearing schemes are resolved here; OAuth2 is not, because obtaining a token is a
 * network exchange with its own cache and its own browser flow. The caller passes `accessToken`
 * for an OAuth2 configuration, having got it from `oauth2.ts`.
 *
 * `inherit` and `none` resolve to no credentials at all: `inherit` should already have been
 * resolved by `resolveAuthChain` before this is called, and reaching here means nothing in the
 * chain configured anything.
 *
 * @throws WirebenchError `secret-missing` when a reference is set but the store has no value for
 * it — a dangling reference must fail loudly rather than quietly sending no credentials.
 */
export async function resolveAuthConfig(
  auth: AuthConfig | undefined,
  getSecret: GetSecret,
  options: { readonly accessToken?: string } = {},
): Promise<SendAuth | undefined> {
  if (auth === undefined) {
    return undefined;
  }
  switch (auth.type) {
    case 'basic':
    case 'ntlm': {
      const resolved = await resolveEndpointAuth(auth, getSecret);
      if (resolved === undefined || resolved.type === 'none') {
        return undefined;
      }
      const password = resolved.password ?? '';
      return resolved.type === 'basic'
        ? { type: 'basic', username: resolved.username ?? '', password, preemptive: resolved.preemptive ?? true }
        : {
            type: 'ntlm',
            username: resolved.username ?? '',
            password,
            ...(resolved.domain !== undefined ? { domain: resolved.domain } : {}),
            ...(resolved.workstation !== undefined ? { workstation: resolved.workstation } : {}),
          };
    }
    case 'bearer': {
      const token = await requireSecret(auth.tokenRef, getSecret);
      return token === undefined
        ? undefined
        : { type: 'bearer', token, ...(auth.scheme !== undefined ? { scheme: auth.scheme } : {}) };
    }
    case 'api-key': {
      const value = await requireSecret(auth.valueRef, getSecret);
      return value === undefined ? undefined : { type: 'api-key', name: auth.name, value, in: auth.in };
    }
    case 'oauth2':
      return options.accessToken === undefined ? undefined : { type: 'oauth2', accessToken: options.accessToken };
    default:
      return undefined;
  }
}

/** One reference resolved, or `undefined` when the scheme has none configured yet. */
async function requireSecret(ref: string | undefined, getSecret: GetSecret): Promise<string | undefined> {
  if (ref === undefined || ref === '') {
    return undefined;
  }
  const value = await getSecret(ref);
  if (value === undefined) {
    throw new WirebenchError('secret-missing', `Secret ${ref} was not found in the secret store.`, {
      details: { ref },
    });
  }
  return value;
}
