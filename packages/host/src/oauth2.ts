/**
 * Obtaining OAuth2 access tokens: the stateful half the engine deliberately leaves out.
 *
 * Three things live here because nothing else can own them. A **token cache**, keyed by the
 * configuration that produced the token, so a request does not re-authenticate on every send and a
 * token never touches disk. A **loopback listener**, because the authorization-code grant answers to
 * a URL and only the host can open a port and a browser. And the **refresh** decision, which needs a
 * clock and the cache.
 *
 * Security, stated once because it is the point: the listener binds to `127.0.0.1` only, on a random
 * port unless the user pinned one, accepts exactly one callback and then closes, requires the `state`
 * it generated, and gives up after five minutes. Only one flow may be pending at a time. The access
 * token stays in this process's memory; a refresh token is written to the keychain only when the user
 * asked for it to be remembered (ADR-0004).
 */

import { createHash } from 'node:crypto';
import {
  WirebenchError,
  authorizationUrl,
  buildDeviceAuthorizationRequest,
  buildTokenRequest,
  clientAuthSecrets,
  needsRefresh,
  newState,
  parseDeviceAuthorizationResponse,
  parseTokenResponse,
  pkce,
  pollDeviceToken,
} from '@wirebench/engine';
import { sendHttp } from '@wirebench/engine';
import type {
  ClientIdentity,
  DeviceAuthorization,
  EgressPolicy,
  HttpExchange,
  HttpRequest,
  OAuth2Auth,
  OAuth2Secrets,
  ProxyOptions,
  TlsOptions,
  TokenGrantInput,
  TokenSet,
} from '@wirebench/engine';
import { startLoopbackCallback } from './loopback-callback.js';

/** How long a browser flow may stay pending before it is abandoned. */
export const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

/** What the renderer is told about a token, which never includes the token itself by default. */
export interface OAuth2Status {
  readonly state: 'none' | 'valid' | 'expired' | 'pending';
  /** ISO-8601, when the token said how long it lasts. */
  readonly expiresAt?: string;
  readonly scopes?: readonly string[];
  /** Only ever set when the session's show-secrets flag is on. */
  readonly token?: string;
  /** While a device-code sign-in waits: what the user types, and where. */
  readonly device?: {
    readonly userCode: string;
    readonly verificationUri: string;
    readonly verificationUriComplete?: string;
    readonly expiresAt: string;
  };
}

/** The credential values a configuration needs, resolved by the caller from the keychain. */
export interface OAuth2Credentials {
  readonly clientSecret?: string;
  /** A refresh token the user chose to remember; the cache's own is preferred over it. */
  readonly refreshToken?: string;
  /** The resource owner's password, for the password grant. */
  readonly password?: string;
}

/** Everything one token request needs beyond the configuration. */
export interface FetchTokenOptions {
  readonly credentials?: OAuth2Credentials;
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
  /** Called with a fresh refresh token when the configuration asks for one to be remembered. */
  readonly rememberRefreshToken?: (token: string) => Promise<void>;
  readonly signal?: AbortSignal;
  /** The keystore identity `private-key-jwt` signs with and `tls-client-auth` presents. */
  readonly identityFor?: (keystoreId: string) => Promise<ClientIdentity | undefined>;
}

/** The host services this module needs, injected so it is testable without Electron or a browser. */
export interface OAuth2Deps {
  /** Opens the authorization URL in the user's browser. `shell.openExternal` in the app. */
  readonly openExternal: (url: string) => Promise<void>;
  /** The fixed loopback port a provider demands, when the user configured one. */
  readonly callbackPort?: () => number | undefined;
  /** Sends the token request. The engine's `sendHttp` by default; a stub in tests. */
  readonly send?: (request: HttpRequest) => Promise<HttpExchange>;
  readonly now?: () => Date;
  /** Waits between device-code polls; the engine's timer by default, instant in tests. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The host's egress rule (`HostPlatform.network`): every request to a provider is held to it. Absent, none. */
  readonly egress?: EgressPolicy;
}

/** The key a token is cached under: the configuration that produced it, and nothing else. */
export function tokenCacheKey(config: OAuth2Auth): string {
  // Hashed rather than concatenated so the key cannot be read back into a client id or a URL if it
  // ever appears in a log line.
  const identity = [
    config.grant,
    config.tokenUrl,
    config.authorizationUrl ?? '',
    config.deviceAuthorizationUrl ?? '',
    config.clientId,
    config.clientAuth,
    config.username ?? '',
    config.audience ?? '',
    [...config.scopes].sort().join(' '),
  ].join('\u0000');
  return createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

/** The one sign-in waiting on the user: a browser callback, or a device code being polled for. */
interface PendingFlow {
  readonly cancel: () => void;
  readonly device?: DeviceAuthorization;
}

/**
 * Owns the token cache and the browser flow for the whole app.
 *
 * One instance per host, created in `host/create-host.ts`: the cache is per session by design (tokens are never
 * persisted), and only one flow may be pending because only one browser window can be answering.
 */
export class OAuth2Service {
  private readonly tokens = new Map<string, TokenSet>();
  private pending: PendingFlow | undefined;

  constructor(private readonly deps: OAuth2Deps) {}

  /** What is known about the token for `config`, without obtaining one. */
  status(config: OAuth2Auth, options: { readonly showSecrets?: boolean } = {}): OAuth2Status {
    if (this.pending !== undefined) {
      const device = this.pending.device;
      return device === undefined
        ? { state: 'pending' }
        : {
            state: 'pending',
            device: {
              userCode: device.userCode,
              verificationUri: device.verificationUri,
              ...(device.verificationUriComplete !== undefined
                ? { verificationUriComplete: device.verificationUriComplete }
                : {}),
              expiresAt: device.expiresAt,
            },
          };
    }
    const token = this.tokens.get(tokenCacheKey(config));
    if (token === undefined) {
      return { state: 'none' };
    }
    const expired = needsRefresh(token, this.now());
    return {
      state: expired ? 'expired' : 'valid',
      ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
      ...(token.scopes !== undefined ? { scopes: token.scopes } : {}),
      ...(options.showSecrets === true ? { token: token.accessToken } : {}),
    };
  }

  /** Forgets the token for `config`, so the next send obtains a new one. */
  clear(config: OAuth2Auth): void {
    this.tokens.delete(tokenCacheKey(config));
  }

  /** Abandons a pending browser flow, if there is one. */
  cancel(): { readonly cancelled: boolean } {
    if (this.pending === undefined) return { cancelled: false };
    this.pending.cancel();
    return { cancelled: true };
  }

  /**
   * The access token to send with a request, obtaining or refreshing one if needed.
   *
   * A cached token still comfortably inside its lifetime is returned as it is. One near expiry is
   * refreshed when a refresh token is available, and otherwise re-obtained — except for the
   * authorization-code and device-code grants, which never start a sign-in on their own: that would
   * mean a window appearing because a request was sent, so the send fails with
   * `oauth2-sign-in-required` and the user presses *Get new token*.
   */
  async accessToken(config: OAuth2Auth, options: FetchTokenOptions = {}): Promise<string> {
    const key = tokenCacheKey(config);
    const cached = this.tokens.get(key);
    if (cached !== undefined && !needsRefresh(cached, this.now())) {
      return cached.accessToken;
    }
    const refreshToken = cached?.refreshToken ?? options.credentials?.refreshToken;
    if (refreshToken !== undefined) {
      try {
        return (await this.runGrant(config, { grant: 'refresh', refreshToken }, options)).accessToken;
      } catch (error) {
        // A refresh token the provider has retired is not a dead end: fall through to the grant, so
        // a client-credentials or password configuration recovers on its own.
        if (needsPerson(config)) {
          this.tokens.delete(key);
          throw signInRequired(error);
        }
      }
    }
    if (needsPerson(config)) {
      throw signInRequired();
    }
    return (await this.runGrant(config, headlessGrant(config), options)).accessToken;
  }

  /**
   * Obtains a token as the user asked (the *Get new token* button): the browser flow for the
   * authorization-code grant, the device flow for device code, a plain token request otherwise.
   */
  async fetchToken(config: OAuth2Auth, options: FetchTokenOptions = {}): Promise<OAuth2Status> {
    if (config.grant === 'device-code') {
      await this.deviceFlow(config, options);
      return this.status(config);
    }
    if (config.grant !== 'authorization-code') {
      await this.runGrant(config, headlessGrant(config), options);
      return this.status(config);
    }
    const { code, redirectUri, verifier } = await this.authorize(config);
    await this.runGrant(
      config,
      { grant: 'authorization-code', code, redirectUri, ...(verifier !== undefined ? { verifier } : {}) },
      options,
    );
    return this.status(config);
  }

  /** The loopback redirect URI a provider must have registered, for the inspector to show. */
  redirectUri(): string {
    const port = this.deps.callbackPort?.();
    return port === undefined ? 'http://127.0.0.1:<random port>/callback' : `http://127.0.0.1:${String(port)}/callback`;
  }

  /** Runs one token request and caches what came back. */
  private async runGrant(config: OAuth2Auth, grant: TokenGrantInput, options: FetchTokenOptions): Promise<TokenSet> {
    const prepared = await this.prepare(config, options);
    const request = buildTokenRequest(config, await prepared.secrets(), grant, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    const exchange = await prepared.send(request);
    const parsed = parseTokenResponse({ status: exchange.status, body: exchange.body, now: () => this.now() });
    // RFC 6749 §6: a refresh may or may not rotate the refresh token; keep the old one if not.
    const token =
      parsed.refreshToken === undefined && grant.grant === 'refresh'
        ? { ...parsed, refreshToken: grant.refreshToken }
        : parsed;
    return this.keep(config, token, options);
  }

  /** Caches `token` for `config`, and remembers a new refresh token when the configuration asks to. */
  private async keep(config: OAuth2Auth, token: TokenSet, options: FetchTokenOptions): Promise<TokenSet> {
    this.tokens.set(tokenCacheKey(config), token);
    if (token.refreshToken !== undefined && config.refreshTokenRef !== undefined) {
      await options.rememberRefreshToken?.(token.refreshToken);
    }
    return token;
  }

  /**
   * What every request to the provider needs: the client's authentication, made afresh per request
   * since a JWT assertion is single-use, and the transport — the configuration's own certificate
   * for `tls-client-auth`, the caller's TLS and proxy otherwise.
   */
  private async prepare(
    config: OAuth2Auth,
    options: FetchTokenOptions,
  ): Promise<{
    readonly secrets: () => Promise<OAuth2Secrets>;
    readonly send: (request: HttpRequest) => Promise<HttpExchange>;
  }> {
    const keyBased = config.clientAuth === 'private-key-jwt' || config.clientAuth === 'tls-client-auth';
    const identity = keyBased ? await identityOf(config, options) : undefined;
    const { clientSecret, password } = options.credentials ?? {};
    const tls: TlsOptions | undefined =
      config.clientAuth === 'tls-client-auth' && identity !== undefined
        ? { ...options.tls, cert: identity.cert, key: identity.key }
        : options.tls;
    const send = this.deps.send ?? sendHttp;
    return {
      secrets: async () => ({
        ...(await clientAuthSecrets(config, {
          ...(clientSecret !== undefined ? { clientSecret } : {}),
          ...(identity !== undefined ? { identity } : {}),
          now: this.now(),
        })),
        ...(password !== undefined ? { password } : {}),
      }),
      send: (request) =>
        send({
          ...request,
          ...(tls !== undefined ? { tls } : {}),
          ...(options.proxy !== undefined ? { proxy: options.proxy } : {}),
          ...(this.deps.egress !== undefined ? { egress: this.deps.egress } : {}),
        }),
    };
  }

  /**
   * Runs the device-code grant (RFC 8628): asks for a code, opens the verification page, and polls
   * until the user approves it there — on this machine or another. The code and the page stay in
   * the status while it waits, so the renderer can show them; *Cancel* ends the poll.
   *
   * @throws WirebenchError `oauth2-flow-pending` when a sign-in is already waiting, `oauth2-timeout`
   * when the code expires, `oauth2-cancelled`, or the provider's refusal
   */
  private async deviceFlow(config: OAuth2Auth, options: FetchTokenOptions): Promise<void> {
    if (this.pending !== undefined) {
      throw new WirebenchError('oauth2-flow-pending', 'A sign-in is already waiting for the browser');
    }
    const controller = new AbortController();
    this.pending = { cancel: () => controller.abort() };
    try {
      const prepared = await this.prepare(config, options);
      const exchange = await prepared.send(
        buildDeviceAuthorizationRequest(config, await prepared.secrets(), { signal: controller.signal }),
      );
      const authorization = parseDeviceAuthorizationResponse({
        status: exchange.status,
        body: exchange.body,
        now: () => this.now(),
      });
      this.pending = { cancel: () => controller.abort(), device: authorization };
      // The page is opened for convenience; the code on screen is enough to finish on another device.
      void this.deps
        .openExternal(authorization.verificationUriComplete ?? authorization.verificationUri)
        .catch(() => undefined);
      const token = await pollDeviceToken({
        authorization,
        request: async () =>
          buildTokenRequest(
            config,
            await prepared.secrets(),
            { grant: 'device-code', deviceCode: authorization.deviceCode },
            { signal: controller.signal },
          ),
        send: prepared.send,
        now: () => this.now(),
        ...(this.deps.sleep !== undefined ? { sleep: this.deps.sleep } : {}),
        signal: controller.signal,
      });
      await this.keep(config, token, options);
    } catch (error) {
      throw controller.signal.aborted ? new WirebenchError('oauth2-cancelled', 'The sign-in was cancelled') : error;
    } finally {
      this.pending = undefined;
    }
  }

  /**
   * Runs the browser half of the authorization-code grant.
   *
   * @throws WirebenchError `oauth2-flow-pending` when one is already running, `oauth2-timeout` when
   * nobody comes back, `oauth2-state-mismatch` when the callback is not this flow's
   */
  private async authorize(
    config: OAuth2Auth,
  ): Promise<{ readonly code: string; readonly redirectUri: string; readonly verifier?: string }> {
    if (this.pending !== undefined) {
      throw new WirebenchError('oauth2-flow-pending', 'A sign-in is already waiting for the browser');
    }
    const pair = config.pkce ? pkce() : undefined;
    const state = newState();
    const port = this.deps.callbackPort?.();
    const listener = await startLoopbackCallback({
      expected: { name: 'state', value: () => state },
      ...(port !== undefined ? { port } : {}),
      timeoutMs: FLOW_TIMEOUT_MS,
      describe: (params) => {
        const error = params.get('error');
        return error === null && params.get('code') !== null
          ? { ok: true, message: 'Signed in. You can close this tab and go back to Wirebench.' }
          : { ok: false, message: `The provider refused the sign-in (${error ?? 'no code'}). You can close this tab.` };
      },
    });
    this.pending = { cancel: () => listener.cancel() };
    // Nothing awaits the result until the browser has been opened, and a provider that refuses
    // immediately can answer first: the no-op handler keeps that from surfacing as unhandled.
    void listener.result.catch(() => undefined);
    try {
      await this.deps.openExternal(
        authorizationUrl({
          config,
          redirectUri: listener.redirectUri,
          state,
          ...(pair !== undefined ? { challenge: pair.challenge } : {}),
        }),
      );
      const params = await listener.result;
      const code = params.get('code');
      const error = params.get('error');
      if (error !== null || code === null) {
        throw new WirebenchError(
          'oauth2-authorization-failed',
          `The provider refused the sign-in: ${error ?? 'no code'}`,
        );
      }
      return { code, redirectUri: listener.redirectUri, ...(pair !== undefined ? { verifier: pair.verifier } : {}) };
    } catch (error) {
      listener.cancel(); // a no-op once the listener has settled; frees the port when openExternal threw
      throw translateLoopbackError(error);
    } finally {
      this.pending = undefined;
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

/** The helper's codes, in this service's vocabulary — the renderer and its tests know only these. */
function translateLoopbackError(error: unknown): unknown {
  if (error instanceof WirebenchError && error.code === 'loopback-timeout') {
    return new WirebenchError('oauth2-timeout', 'The sign-in was not completed in time');
  }
  if (error instanceof WirebenchError && error.code === 'loopback-cancelled') {
    return new WirebenchError('oauth2-cancelled', 'The sign-in was cancelled');
  }
  return error;
}

/** The grants that need a person at a browser, which a send never starts on its own. */
function needsPerson(config: OAuth2Auth): boolean {
  return config.grant === 'authorization-code' || config.grant === 'device-code';
}

/** The token request for a grant that needs nobody: client credentials or password. */
function headlessGrant(config: OAuth2Auth): TokenGrantInput {
  return config.grant === 'password' ? { grant: 'password' } : { grant: 'client-credentials' };
}

/** The keystore identity a key-based client authenticates with; refused when there is none. */
async function identityOf(config: OAuth2Auth, options: FetchTokenOptions): Promise<ClientIdentity> {
  const keystoreId = config.clientKeystoreId;
  const identity = keystoreId === undefined || keystoreId === '' ? undefined : await options.identityFor?.(keystoreId);
  if (identity === undefined) {
    throw new WirebenchError(
      'oauth2-client-key-missing',
      `${config.clientAuth === 'tls-client-auth' ? 'tls_client_auth' : 'private_key_jwt'} needs a keystore with a private key; choose one for this configuration.`,
      { details: { clientId: config.clientId } },
    );
  }
  return identity;
}

/** The error a send raises rather than opening a browser window behind the user's back. */
function signInRequired(cause?: unknown): WirebenchError {
  return new WirebenchError('oauth2-sign-in-required', 'Sign in again to get a new access token', {
    ...(cause !== undefined ? { cause } : {}),
  });
}
