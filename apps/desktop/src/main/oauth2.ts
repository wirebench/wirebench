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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  WirebenchError,
  authorizationUrl,
  buildTokenRequest,
  needsRefresh,
  newState,
  parseTokenResponse,
  pkce,
} from '@wirebench/engine';
import { sendHttp } from '@wirebench/engine';
import type { HttpExchange, HttpRequest, OAuth2Auth, ProxyOptions, TlsOptions, TokenSet } from '@wirebench/engine';

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
}

/** The credential values a configuration needs, resolved by the caller from the keychain. */
export interface OAuth2Credentials {
  readonly clientSecret?: string;
  /** A refresh token the user chose to remember; the cache's own is preferred over it. */
  readonly refreshToken?: string;
}

/** Everything one token request needs beyond the configuration. */
export interface FetchTokenOptions {
  readonly credentials?: OAuth2Credentials;
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
  /** Called with a fresh refresh token when the configuration asks for one to be remembered. */
  readonly rememberRefreshToken?: (token: string) => Promise<void>;
  readonly signal?: AbortSignal;
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
}

/** The key a token is cached under: the configuration that produced it, and nothing else. */
export function tokenCacheKey(config: OAuth2Auth): string {
  // Hashed rather than concatenated so the key cannot be read back into a client id or a URL if it
  // ever appears in a log line.
  const identity = [
    config.grant,
    config.tokenUrl,
    config.authorizationUrl ?? '',
    config.clientId,
    config.audience ?? '',
    [...config.scopes].sort().join(' '),
  ].join('\u0000');
  return createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

/** The page the browser lands on after the callback. Plain, self-contained, no network of its own. */
/** The five characters that can break out of HTML text or an attribute. */
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes `text` for interpolation into HTML element content. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * The one-page response the loopback listener returns to the browser.
 *
 * `message` is **escaped**, not trusted. One caller interpolates the provider's own `error` query
 * parameter into it, and that string is chosen by whoever the user pointed the flow at: an
 * authorization server (or anyone who can drive the redirect, since it carries the matching
 * `state`) could otherwise close the paragraph and run script on the `http://127.0.0.1:<port>`
 * origin in the user's own browser. Escaping here rather than at the call site keeps a later caller
 * from reintroducing it.
 */
function callbackPage(message: string): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<title>Wirebench</title>',
    '<style>body{font:14px system-ui;margin:3rem;color:#222}</style>',
    '</head><body><h1>Wirebench</h1><p>',
    escapeHtml(message),
    '</p></body></html>',
  ].join('');
}

/** One pending authorization-code flow. */
interface PendingFlow {
  readonly server: Server;
  readonly state: string;
  readonly verifier?: string;
  readonly timer: NodeJS.Timeout;
  resolve: (code: string) => void;
  reject: (error: Error) => void;
}

/**
 * Owns the token cache and the browser flow for the whole app.
 *
 * One instance, created in `index.ts`: the cache is per session by design (tokens are never
 * persisted), and only one flow may be pending because only one browser window can be answering.
 */
export class OAuth2Service {
  private readonly tokens = new Map<string, TokenSet>();
  private pending: PendingFlow | undefined;

  constructor(private readonly deps: OAuth2Deps) {}

  /** What is known about the token for `config`, without obtaining one. */
  status(config: OAuth2Auth, options: { readonly showSecrets?: boolean } = {}): OAuth2Status {
    if (this.pending !== undefined) {
      return { state: 'pending' };
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
    if (this.pending === undefined) {
      return { cancelled: false };
    }
    this.abandon(new WirebenchError('oauth2-cancelled', 'The sign-in was cancelled'));
    return { cancelled: true };
  }

  /**
   * The access token to send with a request, obtaining or refreshing one if needed.
   *
   * A cached token still comfortably inside its lifetime is returned as it is. One near expiry is
   * refreshed when a refresh token is available, and otherwise re-obtained — except for the
   * authorization-code grant, which never re-opens the browser on its own: that would mean a window
   * appearing because a request was sent, so the send fails with `oauth2-sign-in-required` and the
   * user presses *Get new token*.
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
        // a client-credentials configuration recovers on its own.
        if (config.grant === 'authorization-code') {
          this.tokens.delete(key);
          throw signInRequired(error);
        }
      }
    }
    if (config.grant === 'authorization-code') {
      throw signInRequired();
    }
    return (await this.runGrant(config, { grant: 'client-credentials' }, options)).accessToken;
  }

  /**
   * Obtains a token as the user asked (the *Get new token* button): the browser flow for the
   * authorization-code grant, a plain token request for client credentials.
   */
  async fetchToken(config: OAuth2Auth, options: FetchTokenOptions = {}): Promise<OAuth2Status> {
    if (config.grant === 'client-credentials') {
      await this.runGrant(config, { grant: 'client-credentials' }, options);
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
  private async runGrant(
    config: OAuth2Auth,
    grant: Parameters<typeof buildTokenRequest>[2],
    options: FetchTokenOptions,
  ): Promise<TokenSet> {
    const request = buildTokenRequest(config, options.credentials ?? {}, grant, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    const send = this.deps.send ?? sendHttp;
    const exchange = await send({
      ...request,
      ...(options.tls !== undefined ? { tls: options.tls } : {}),
      ...(options.proxy !== undefined ? { proxy: options.proxy } : {}),
    });
    const token = parseTokenResponse({ status: exchange.status, body: exchange.body, now: () => this.now() });
    this.tokens.set(tokenCacheKey(config), token);
    if (token.refreshToken !== undefined && config.refreshTokenRef !== undefined) {
      await options.rememberRefreshToken?.(token.refreshToken);
    }
    return token;
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

    const server = createServer();
    const code = new Promise<string>((resolve, reject) => {
      server.on('request', (request: IncomingMessage, response: ServerResponse) => {
        this.handleCallback(request, response);
      });
      const timer = setTimeout(() => {
        this.abandon(new WirebenchError('oauth2-timeout', 'The sign-in was not completed in time'));
      }, FLOW_TIMEOUT_MS);
      timer.unref?.();
      this.pending = {
        server,
        state,
        timer,
        resolve,
        reject,
        ...(pair !== undefined ? { verifier: pair.verifier } : {}),
      };
    });

    // Nothing awaits this promise until the browser has been opened, and a provider that refuses
    // immediately can answer the callback first: a no-op handler keeps that early rejection from
    // surfacing as an unhandled one. `await code` below still throws it.
    void code.catch(() => undefined);

    // 127.0.0.1 and nothing else: a callback listener reachable from the network is a way to hand
    // someone else's authorization code to this app (RFC 8252 §8.3).
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port ?? 0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo | null;
    const redirectUri = `http://127.0.0.1:${String(address?.port ?? 0)}/callback`;

    await this.deps.openExternal(
      authorizationUrl({
        config,
        redirectUri,
        state,
        ...(pair !== undefined ? { challenge: pair.challenge } : {}),
      }),
    );

    const received = await code;
    return { code: received, redirectUri, ...(pair !== undefined ? { verifier: pair.verifier } : {}) };
  }

  /** Answers the one callback this flow accepts, then closes the listener. */
  private handleCallback(request: IncomingMessage, response: ServerResponse): void {
    const flow = this.pending;
    if (flow === undefined) {
      response.writeHead(410).end();
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (state !== flow.state) {
      // Not this flow's callback: answered, but neither accepted nor allowed to end the flow, which
      // stays pending until the real one arrives or the timeout fires.
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      response.end(callbackPage('This sign-in response did not match the request. You can close this tab.'));
      return;
    }
    response.writeHead(error === null && code !== null ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      callbackPage(
        error === null && code !== null
          ? 'Signed in. You can close this tab and go back to Wirebench.'
          : `The provider refused the sign-in (${error ?? 'no code'}). You can close this tab.`,
      ),
    );

    if (error !== null || code === null) {
      this.abandon(
        new WirebenchError('oauth2-authorization-failed', `The provider refused the sign-in: ${error ?? 'no code'}`),
      );
      return;
    }
    this.finish(code);
  }

  /** Ends the pending flow successfully. */
  private finish(code: string): void {
    const flow = this.pending;
    if (flow === undefined) {
      return;
    }
    this.pending = undefined;
    clearTimeout(flow.timer);
    flow.server.close();
    flow.resolve(code);
  }

  /** Ends the pending flow with an error, closing the listener either way. */
  private abandon(error: Error): void {
    const flow = this.pending;
    if (flow === undefined) {
      return;
    }
    this.pending = undefined;
    clearTimeout(flow.timer);
    flow.server.close();
    flow.reject(error);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

/** The error a send raises rather than opening a browser window behind the user's back. */
function signInRequired(cause?: unknown): WirebenchError {
  return new WirebenchError('oauth2-sign-in-required', 'Sign in again to get a new access token', {
    ...(cause !== undefined ? { cause } : {}),
  });
}
