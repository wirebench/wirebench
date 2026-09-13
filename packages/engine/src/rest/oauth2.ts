/**
 * The OAuth2 pieces that are pure: what a token request looks like, what a token response means,
 * and the PKCE maths (RFC 6749, RFC 7636, RFC 8252).
 *
 * Everything stateful stays out of the engine on purpose. Opening a browser, listening on a
 * loopback port, caching a token for the session, deciding when to refresh — those belong to the
 * host, which owns windows, ports and the keychain. This module only builds and reads messages, so
 * both the desktop app and the planned CLI runner authenticate the same way.
 *
 * No access token is ever written to a project file or returned to a renderer by this module; it
 * hands back a {@link TokenSet} and the host decides where it lives (ADR-0004).
 */

import { createHash, randomBytes } from 'node:crypto';
import { WirebenchError } from '../errors.js';
import type { OAuth2Auth } from '../project/model.js';
import type { HttpRequest } from '../http/types.js';

/** The credential values the host resolved for one OAuth2 configuration. */
export interface OAuth2Secrets {
  /** The client secret, when the configuration references one. */
  readonly clientSecret?: string;
  /** A refresh token, from the session cache or the keychain. */
  readonly refreshToken?: string;
}

/** A token as obtained, with its expiry already turned into an absolute moment. */
export interface TokenSet {
  readonly accessToken: string;
  readonly tokenType: string;
  /** ISO-8601; absent when the server did not say how long the token lasts. */
  readonly expiresAt?: string;
  readonly refreshToken?: string;
  /** The scopes actually granted, when the server named them. */
  readonly scopes?: readonly string[];
}

/** A PKCE verifier and the challenge derived from it (RFC 7636, S256). */
export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: 'S256';
}

/** Base64url without padding, the encoding every OAuth2 extension uses. */
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A fresh PKCE pair.
 *
 * 32 random bytes give a 43-character verifier, the shortest RFC 7636 §4.1 allows and the length
 * every provider tests against. `plain` is not offered: a challenge equal to its verifier protects
 * nothing, and every provider worth supporting takes S256.
 */
export function pkce(random: (size: number) => Uint8Array = randomBytes): PkcePair {
  const verifier = base64url(random(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

/** A random `state` value, which is what makes a callback attributable to this flow. */
export function newState(random: (size: number) => Uint8Array = randomBytes): string {
  return base64url(random(16));
}

/** Options for {@link authorizationUrl}. */
export interface AuthorizationUrlInput {
  readonly config: OAuth2Auth;
  readonly redirectUri: string;
  readonly state: string;
  /** Omit for a configuration with PKCE switched off. */
  readonly challenge?: string;
}

/**
 * The URL the user's browser is sent to for an authorization-code flow.
 *
 * @throws WirebenchError `oauth2-no-authorization-url` when the configuration has no endpoint to
 * send them to, which is a configuration error rather than something to guess at.
 */
export function authorizationUrl(input: AuthorizationUrlInput): string {
  const { config } = input;
  if (config.authorizationUrl === undefined || config.authorizationUrl === '') {
    throw new WirebenchError('oauth2-no-authorization-url', 'This configuration has no authorization URL', {
      details: { clientId: config.clientId },
    });
  }
  const url = new URL(config.authorizationUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  if (config.scopes.length > 0) {
    url.searchParams.set('scope', config.scopes.join(' '));
  }
  if (config.audience !== undefined && config.audience !== '') {
    url.searchParams.set('audience', config.audience);
  }
  if (config.pkce && input.challenge !== undefined) {
    url.searchParams.set('code_challenge', input.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

/** Which token request to build. */
export type TokenGrantInput =
  | { readonly grant: 'client-credentials' }
  | {
      readonly grant: 'authorization-code';
      readonly code: string;
      readonly redirectUri: string;
      readonly verifier?: string;
    }
  | { readonly grant: 'refresh'; readonly refreshToken: string };

/** Options for {@link buildTokenRequest} beyond the configuration and the grant. */
export interface TokenRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Builds the `POST` to the token endpoint.
 *
 * `clientAuth` decides where the client credentials go: `basic` puts them in an `Authorization`
 * header (RFC 6749 §2.3.1, which providers overwhelmingly prefer), `body` puts `client_secret` in
 * the form. A public client — no secret at all — sends `client_id` in the body and no header, which
 * is what RFC 8252 §8.4 expects of a native app.
 *
 * @throws WirebenchError `oauth2-no-token-url` when the configuration has no token endpoint
 */
export function buildTokenRequest(
  config: OAuth2Auth,
  secrets: OAuth2Secrets,
  grantInput: TokenGrantInput,
  options: TokenRequestOptions = {},
): HttpRequest {
  if (config.tokenUrl === '') {
    throw new WirebenchError('oauth2-no-token-url', 'This configuration has no token URL', {
      details: { clientId: config.clientId },
    });
  }
  const form = new URLSearchParams();
  switch (grantInput.grant) {
    case 'client-credentials':
      form.set('grant_type', 'client_credentials');
      if (config.scopes.length > 0) {
        form.set('scope', config.scopes.join(' '));
      }
      break;
    case 'authorization-code':
      form.set('grant_type', 'authorization_code');
      form.set('code', grantInput.code);
      form.set('redirect_uri', grantInput.redirectUri);
      if (grantInput.verifier !== undefined) {
        form.set('code_verifier', grantInput.verifier);
      }
      break;
    case 'refresh':
      form.set('grant_type', 'refresh_token');
      form.set('refresh_token', grantInput.refreshToken);
      if (config.scopes.length > 0) {
        form.set('scope', config.scopes.join(' '));
      }
      break;
  }
  if (config.audience !== undefined && config.audience !== '') {
    form.set('audience', config.audience);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  const secret = secrets.clientSecret;
  if (config.clientAuth === 'basic' && secret !== undefined && secret !== '') {
    // RFC 6749 §2.3.1: both halves are form-urlencoded before being base64'd, which matters for a
    // secret containing a `+` or a space.
    const encoded = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(secret)}`;
    headers.Authorization = `Basic ${Buffer.from(encoded).toString('base64')}`;
  } else {
    form.set('client_id', config.clientId);
    if (secret !== undefined && secret !== '') {
      form.set('client_secret', secret);
    }
  }

  return {
    url: config.tokenUrl,
    method: 'POST',
    headers,
    body: new TextEncoder().encode(form.toString()),
    timeoutMs: options.timeoutMs ?? 30_000,
    followRedirects: false,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
}

/** What the token endpoint answered with, as far as reading it goes. */
export interface TokenResponseInput {
  readonly status: number;
  readonly body: Uint8Array;
  /** Clock for turning `expires_in` into an absolute moment; injected so tests are deterministic. */
  readonly now?: () => Date;
}

/**
 * Reads a token response (RFC 6749 §5.1) or raises the error it describes (§5.2).
 *
 * A provider that answers 200 with an `error` field, or 400 with a perfectly good token, is not
 * unheard of, so the body decides and the status only breaks ties. `expires_in` is turned into an
 * absolute `expiresAt` immediately: a duration is meaningless once it has been cached.
 *
 * @throws WirebenchError `oauth2-token-error` with the provider's own `error`/`error_description`,
 * or `oauth2-token-malformed` when the body is not a token response at all
 */
export function parseTokenResponse(input: TokenResponseInput): TokenSet {
  const text = Buffer.from(input.body).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WirebenchError('oauth2-token-malformed', 'The token endpoint did not answer with JSON', {
      details: { status: input.status, body: text.slice(0, 200) },
    });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new WirebenchError('oauth2-token-malformed', 'The token endpoint did not answer with a JSON object', {
      details: { status: input.status },
    });
  }
  const body = parsed as Record<string, unknown>;

  const error = typeof body['error'] === 'string' ? body['error'] : undefined;
  if (error !== undefined) {
    const description = typeof body['error_description'] === 'string' ? body['error_description'] : undefined;
    throw new WirebenchError('oauth2-token-error', description ?? `The token endpoint refused the request: ${error}`, {
      details: { status: input.status, error, ...(description !== undefined ? { description } : {}) },
    });
  }

  const accessToken = body['access_token'];
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new WirebenchError('oauth2-token-malformed', 'The token response carried no access token', {
      details: { status: input.status, keys: Object.keys(body) },
    });
  }

  // `expires_in` is a number per RFC 6749 §5.1, but providers do send it as a string; anything
  // else is ignored rather than coerced into a nonsense expiry.
  const expiresIn = body['expires_in'];
  const seconds =
    typeof expiresIn === 'number'
      ? expiresIn
      : typeof expiresIn === 'string'
        ? Number.parseInt(expiresIn, 10)
        : Number.NaN;
  const now = (input.now ?? (() => new Date()))();
  const scope = body['scope'];
  const refreshToken = body['refresh_token'];
  const tokenType = body['token_type'];

  return {
    accessToken,
    tokenType: typeof tokenType === 'string' && tokenType !== '' ? tokenType : 'Bearer',
    ...(Number.isFinite(seconds) && seconds > 0
      ? { expiresAt: new Date(now.getTime() + seconds * 1000).toISOString() }
      : {}),
    ...(typeof refreshToken === 'string' && refreshToken !== '' ? { refreshToken } : {}),
    ...(typeof scope === 'string' && scope.trim() !== '' ? { scopes: scope.trim().split(/\s+/) } : {}),
  };
}

/** How close to its expiry a token is refreshed rather than used. */
export const TOKEN_REFRESH_MARGIN_MS = 30_000;

/**
 * Whether `token` should be replaced before the next send.
 *
 * A token with no stated expiry is used until it fails, which is all a client can do; one with an
 * expiry is refreshed while it still has {@link TOKEN_REFRESH_MARGIN_MS} left, so a slow request
 * does not arrive just after it lapsed.
 */
export function needsRefresh(token: TokenSet, now: Date = new Date()): boolean {
  if (token.expiresAt === undefined) {
    return false;
  }
  const expires = new Date(token.expiresAt).getTime();
  return Number.isNaN(expires) ? false : expires - now.getTime() <= TOKEN_REFRESH_MARGIN_MS;
}
