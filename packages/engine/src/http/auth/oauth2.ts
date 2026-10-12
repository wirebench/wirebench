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

import { X509Certificate, createHash, randomBytes } from 'node:crypto';
import { WirebenchError } from '../../errors.js';
import type { OAuth2Auth } from '../../project/model.js';
import type { HttpExchange, HttpRequest } from '../types.js';
import { defaultAlgFor, privateKeyOf, signJwt } from './jwt.js';
import type { JwtAlgorithm } from './jwt.js';
import type { ClientIdentity } from '../../run/host.js';

/** The credential values the host resolved for one OAuth2 configuration. */
export interface OAuth2Secrets {
  /** The client secret, when the configuration references one. */
  readonly clientSecret?: string;
  /** A refresh token, from the session cache or the keychain. */
  readonly refreshToken?: string;
  /** The resource owner's password, for the password grant. */
  readonly password?: string;
  /** A signed client assertion for the JWT client authentication methods; see {@link clientAuthSecrets}. */
  readonly clientAssertion?: string;
}

/** RFC 7523 §2.2: the `client_assertion_type` a signed client assertion travels under. */
export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** RFC 8628 §3.4: the device-code grant's `grant_type`. */
export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

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
  | { readonly grant: 'refresh'; readonly refreshToken: string }
  | { readonly grant: 'password' }
  | { readonly grant: 'device-code'; readonly deviceCode: string };

/** Options for {@link buildTokenRequest} beyond the configuration and the grant. */
export interface TokenRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Builds the `POST` to the token endpoint, with the client authenticated as `clientAuth` says
 * (see `authenticateClient`).
 *
 * @throws WirebenchError `oauth2-no-token-url` when the configuration has no token endpoint,
 * `oauth2-password-missing` for a password grant without its username or password, or
 * `oauth2-assertion-missing` for a JWT client without its assertion
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
    case 'password': {
      // RFC 6749 §4.3.2. An empty password is a real one; an absent one means the secret was never
      // resolved, and sending without it would only earn a confusing invalid_grant.
      const username = config.username ?? '';
      if (username === '' || secrets.password === undefined) {
        throw new WirebenchError(
          'oauth2-password-missing',
          username === ''
            ? 'The password grant needs a username.'
            : 'The password grant needs the resource owner password, and none was available.',
          { details: { clientId: config.clientId } },
        );
      }
      form.set('grant_type', 'password');
      form.set('username', username);
      form.set('password', secrets.password);
      if (config.scopes.length > 0) {
        form.set('scope', config.scopes.join(' '));
      }
      break;
    }
    case 'device-code':
      form.set('grant_type', DEVICE_CODE_GRANT_TYPE);
      form.set('device_code', grantInput.deviceCode);
      break;
  }
  if (config.audience !== undefined && config.audience !== '') {
    form.set('audience', config.audience);
  }

  return formPost(config.tokenUrl, form, authenticateClient(config, secrets, form), options);
}

/**
 * Adds the client's authentication to a token-endpoint (or device-endpoint) form, returning the
 * headers to send with it.
 *
 * `basic` puts the secret in an `Authorization` header (RFC 6749 §2.3.1, which providers
 * overwhelmingly prefer), `body` puts `client_secret` in the form. A public client — no secret at
 * all — sends `client_id` in the body and no header, which is what RFC 8252 §8.4 expects of a
 * native app. The JWT methods send the assertion in the body (RFC 7523 §2.2), and `tls-client-auth`
 * sends only `client_id`: the certificate on the connection is the credential (RFC 8705 §2.1).
 */
function authenticateClient(config: OAuth2Auth, secrets: OAuth2Secrets, form: URLSearchParams): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  const secret = secrets.clientSecret;
  switch (config.clientAuth) {
    case 'client-secret-jwt':
    case 'private-key-jwt':
      if (secrets.clientAssertion === undefined || secrets.clientAssertion === '') {
        throw new WirebenchError(
          'oauth2-assertion-missing',
          'The client assertion for this token request was not made.',
          {
            details: { clientId: config.clientId, clientAuth: config.clientAuth },
          },
        );
      }
      form.set('client_id', config.clientId);
      form.set('client_assertion_type', CLIENT_ASSERTION_TYPE);
      form.set('client_assertion', secrets.clientAssertion);
      return headers;
    case 'tls-client-auth':
      form.set('client_id', config.clientId);
      return headers;
    case 'basic':
    case 'body':
      break;
  }
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
  return headers;
}

/** A form `POST` to an OAuth2 endpoint, which never follows a redirect. */
function formPost(
  url: string,
  form: URLSearchParams,
  headers: Record<string, string>,
  options: TokenRequestOptions,
): HttpRequest {
  return {
    url,
    method: 'POST',
    headers,
    body: new TextEncoder().encode(form.toString()),
    timeoutMs: options.timeoutMs ?? 30_000,
    followRedirects: false,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
}

/**
 * An OAuth2 endpoint's JSON answer as an object, or the error it describes (RFC 6749 §5.2, RFC 8628
 * §3.2 share the shape). The body decides and the status only breaks ties.
 */
function providerJson(input: TokenResponseInput, endpoint: 'token' | 'device authorization'): Record<string, unknown> {
  const text = Buffer.from(input.body).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WirebenchError('oauth2-token-malformed', `The ${endpoint} endpoint did not answer with JSON`, {
      details: { status: input.status, body: text.slice(0, 200) },
    });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new WirebenchError('oauth2-token-malformed', `The ${endpoint} endpoint did not answer with a JSON object`, {
      details: { status: input.status },
    });
  }
  const body = parsed as Record<string, unknown>;
  const error = typeof body['error'] === 'string' ? body['error'] : undefined;
  if (error !== undefined) {
    const description = typeof body['error_description'] === 'string' ? body['error_description'] : undefined;
    throw new WirebenchError(
      'oauth2-token-error',
      description ?? `The ${endpoint} endpoint refused the request: ${error}`,
      {
        details: { status: input.status, error, ...(description !== undefined ? { description } : {}) },
      },
    );
  }
  return body;
}

/**
 * A duration in seconds: a number per RFC 6749 §5.1, but providers do send it as a string; anything
 * else is NaN rather than coerced into a nonsense value.
 */
function numberField(value: unknown): number {
  return typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
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
  const body = providerJson(input, 'token');
  const accessToken = body['access_token'];
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new WirebenchError('oauth2-token-malformed', 'The token response carried no access token', {
      details: { status: input.status, keys: Object.keys(body) },
    });
  }

  const seconds = numberField(body['expires_in']);
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

/** Options for {@link clientAssertion}. */
export interface ClientAssertionInput {
  /** The configuration with its properties expanded: its client id and token URL go in the claims. */
  readonly config: OAuth2Auth;
  /** The client secret, which `client-secret-jwt` signs with. */
  readonly secret?: string;
  /** The keystore identity whose key `private-key-jwt` signs with; its certificate names the key. */
  readonly identity?: ClientIdentity;
  readonly now?: Date;
  /** The assertion's unique id; random by default, fixed in tests. */
  readonly jti?: string;
}

/** How long a client assertion is valid: long enough for one token request and nothing more. */
const ASSERTION_LIFETIME_S = 60;

/**
 * A client assertion (RFC 7523 §2.2, OpenID Connect Core §9): `iss` and `sub` are the client id,
 * `aud` the token endpoint, valid for a minute, with a fresh `jti` so it cannot be replayed.
 *
 * `client-secret-jwt` signs with the client secret, HS256 unless `assertionAlg` picks another HS
 * size. `private-key-jwt` signs with the keystore identity's key, the algorithm following the key
 * unless overridden, and puts the certificate's SHA-256 thumbprint in `kid` so a provider holding
 * several keys for the client can tell which one signed.
 *
 * @throws WirebenchError `oauth2-client-secret-missing` | `oauth2-client-key-missing` |
 * `oauth2-assertion-alg`, or the signer's own `jwt-*` errors for a key it cannot use
 */
export async function clientAssertion(input: ClientAssertionInput): Promise<string> {
  const { config } = input;
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const claims = {
    iss: config.clientId,
    sub: config.clientId,
    aud: config.tokenUrl,
    iat,
    exp: iat + ASSERTION_LIFETIME_S,
    jti: input.jti ?? base64url(randomBytes(16)),
  };
  if (config.clientAuth === 'private-key-jwt') {
    if (input.identity === undefined) {
      throw new WirebenchError(
        'oauth2-client-key-missing',
        'private_key_jwt needs a keystore with a private key; choose one for this configuration.',
        { details: { clientId: config.clientId } },
      );
    }
    const alg = config.assertionAlg ?? defaultAlgFor(input.identity.key);
    refuseAlg(
      alg.startsWith('HS'),
      alg,
      'private_key_jwt signs with the keystore key, so it cannot use an HMAC algorithm.',
    );
    const kid = createHash('sha256').update(new X509Certificate(input.identity.cert).raw).digest('base64url');
    return signJwt({ algorithm: alg, key: privateKeyOf(input.identity.key, alg), header: { kid }, claims });
  }
  if (input.secret === undefined || input.secret === '') {
    throw new WirebenchError(
      'oauth2-client-secret-missing',
      'client_secret_jwt signs with the client secret, and none was available.',
      {
        details: { clientId: config.clientId },
      },
    );
  }
  const alg = config.assertionAlg ?? 'HS256';
  refuseAlg(
    !alg.startsWith('HS'),
    alg,
    'client_secret_jwt signs with the client secret, so it needs an HMAC algorithm.',
  );
  return signJwt({ algorithm: alg, key: new TextEncoder().encode(input.secret), claims });
}

function refuseAlg(refused: boolean, alg: JwtAlgorithm, message: string): void {
  if (refused) {
    throw new WirebenchError('oauth2-assertion-alg', message, { details: { alg } });
  }
}

/** What {@link clientAuthSecrets} needs: the resolved client secret and, for key-based methods, the identity. */
export interface ClientAuthMaterial {
  readonly clientSecret?: string;
  readonly identity?: ClientIdentity;
  readonly now?: Date;
}

/**
 * The client-authentication part of {@link OAuth2Secrets} for one request: the secret itself for
 * `basic`/`body`, a freshly signed assertion for the JWT methods (one per request, since each
 * carries its own `jti`), nothing for `tls-client-auth`.
 */
export async function clientAuthSecrets(
  config: OAuth2Auth,
  material: ClientAuthMaterial,
): Promise<Pick<OAuth2Secrets, 'clientSecret' | 'clientAssertion'>> {
  switch (config.clientAuth) {
    case 'client-secret-jwt':
    case 'private-key-jwt':
      return {
        clientAssertion: await clientAssertion({
          config,
          ...(material.clientSecret !== undefined ? { secret: material.clientSecret } : {}),
          ...(material.identity !== undefined ? { identity: material.identity } : {}),
          ...(material.now !== undefined ? { now: material.now } : {}),
        }),
      };
    case 'tls-client-auth':
      return {};
    default:
      return material.clientSecret !== undefined ? { clientSecret: material.clientSecret } : {};
  }
}

/**
 * The device authorization request (RFC 8628 §3.1): the client, its scopes and audience, with the
 * same client authentication as the token request.
 *
 * @throws WirebenchError `oauth2-no-device-authorization-url`
 */
export function buildDeviceAuthorizationRequest(
  config: OAuth2Auth,
  secrets: OAuth2Secrets,
  options: TokenRequestOptions = {},
): HttpRequest {
  const url = config.deviceAuthorizationUrl ?? '';
  if (url === '') {
    throw new WirebenchError(
      'oauth2-no-device-authorization-url',
      'This configuration has no device authorization URL',
      {
        details: { clientId: config.clientId },
      },
    );
  }
  const form = new URLSearchParams();
  if (config.scopes.length > 0) {
    form.set('scope', config.scopes.join(' '));
  }
  if (config.audience !== undefined && config.audience !== '') {
    form.set('audience', config.audience);
  }
  return formPost(url, form, authenticateClient(config, secrets, form), options);
}

/** What the device authorization endpoint granted (RFC 8628 §3.2), with durations made absolute. */
export interface DeviceAuthorization {
  readonly deviceCode: string;
  /** What the user types at the verification URI. */
  readonly userCode: string;
  readonly verificationUri: string;
  /** The verification URI with the code already in it, when the provider offers one. */
  readonly verificationUriComplete?: string;
  /** ISO-8601: when the device code stops being worth polling for. */
  readonly expiresAt: string;
  /** How long to wait between polls; RFC 8628 §3.5's 5 s when the provider does not say. */
  readonly intervalMs: number;
}

/** The device code's lifetime when a provider omits `expires_in`, which the RFC requires but some do. */
const DEFAULT_DEVICE_LIFETIME_S = 600;

/**
 * Reads a device authorization response, or raises the error it describes.
 *
 * @throws WirebenchError `oauth2-token-error` | `oauth2-token-malformed`
 */
export function parseDeviceAuthorizationResponse(input: TokenResponseInput): DeviceAuthorization {
  const body = providerJson(input, 'device authorization');
  const text = (key: string): string | undefined => {
    const value = body[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const deviceCode = text('device_code');
  const userCode = text('user_code');
  // `verification_url` is the spelling of an earlier draft that some large providers still send.
  const verificationUri = text('verification_uri') ?? text('verification_url');
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
    throw new WirebenchError('oauth2-token-malformed', 'The device authorization response is missing a code or a URL', {
      details: { status: input.status, keys: Object.keys(body) },
    });
  }
  const now = (input.now ?? (() => new Date()))();
  const lifetime = numberField(body['expires_in']);
  const interval = numberField(body['interval']);
  const complete = text('verification_uri_complete');
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(complete !== undefined ? { verificationUriComplete: complete } : {}),
    expiresAt: new Date(
      now.getTime() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : DEFAULT_DEVICE_LIFETIME_S) * 1000,
    ).toISOString(),
    intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 5) * 1000,
  };
}

/** Options for {@link pollDeviceToken}. */
export interface PollDeviceTokenInput {
  readonly authorization: DeviceAuthorization;
  /** Builds each poll's token request: a JWT client authenticates afresh every time. */
  readonly request: () => HttpRequest | Promise<HttpRequest>;
  readonly send: (request: HttpRequest) => Promise<HttpExchange>;
  readonly now?: () => Date;
  /** Waits between polls; a timer by default, instant in tests. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
}

/** RFC 8628 §3.5: how much longer to wait after each `slow_down`. */
const SLOW_DOWN_STEP_MS = 5000;

/** Read through a call, so the check after an `await` is not narrowed away by the one before it. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Polls the token endpoint until the user approves the device (RFC 8628 §3.4–3.5).
 *
 * `authorization_pending` waits another interval, `slow_down` lengthens it by five seconds for the
 * rest of the flow; anything else the provider says, such as `access_denied` or `expired_token`,
 * ends the flow with its own code.
 *
 * @throws WirebenchError `oauth2-timeout` once the device code has expired, `oauth2-cancelled` on
 * abort, `oauth2-token-error` for a refusal, or the send's own error
 */
export async function pollDeviceToken(input: PollDeviceTokenInput): Promise<TokenSet> {
  const now = input.now ?? ((): Date => new Date());
  const sleep = input.sleep ?? abortableSleep;
  const expiresAt = new Date(input.authorization.expiresAt).getTime();
  let interval = input.authorization.intervalMs;
  for (;;) {
    if (input.signal?.aborted === true) {
      throw new WirebenchError('oauth2-cancelled', 'The sign-in was cancelled');
    }
    if (now().getTime() >= expiresAt) {
      throw new WirebenchError('oauth2-timeout', 'The device code expired before the sign-in was approved');
    }
    await sleep(interval, input.signal);
    if (isAborted(input.signal)) {
      throw new WirebenchError('oauth2-cancelled', 'The sign-in was cancelled');
    }
    const exchange = await input.send(await input.request());
    try {
      return parseTokenResponse({ status: exchange.status, body: exchange.body, now });
    } catch (error) {
      const code =
        error instanceof WirebenchError && error.code === 'oauth2-token-error' ? error.details?.['error'] : undefined;
      if (code === 'authorization_pending') continue;
      if (code === 'slow_down') {
        interval += SLOW_DOWN_STEP_MS;
        continue;
      }
      throw error;
    }
  }
}
