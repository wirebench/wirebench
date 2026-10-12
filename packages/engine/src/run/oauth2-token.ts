/**
 * OAuth2 access tokens for a run, which has no browser, no keychain and no token cache of its own
 * beyond the run itself. Client credentials and password run headless; authorization code and
 * device code need a person, so a run serves them only from a refresh token it was given
 * (`refreshTokenRef`, in CI `WIREBENCH_SECRET_<refreshTokenEnv>`) and refuses them otherwise.
 *
 * One token per configuration per run: two requests behind the same configuration share one token
 * request. A token about to lapse (`needsRefresh`) is refreshed when a refresh token is known and
 * re-obtained by its grant when not, or when the refresh fails; one a server rejected (`reject`) is
 * dropped. A failed fetch is never cached, so the next request behind the configuration tries again.
 */
import { WirebenchError } from '../errors.js';
import { sendHttp } from '../http/client.js';
import type { HttpExchange, HttpRequest, ProxyOptions, TlsOptions } from '../http/types.js';
import type { OAuth2Auth } from '../project/model.js';
import { expand } from '../project/properties.js';
import type { PropertyScopes, UnresolvedRef } from '../project/properties.js';
import { buildTokenRequest, clientAuthSecrets, needsRefresh, parseTokenResponse } from '../http/auth/oauth2.js';
import type { TokenGrantInput, TokenSet } from '../http/auth/oauth2.js';
import type { GetSecret } from '../secrets/resolve.js';
import { envVariablesFor } from '../secrets/env-names.js';
import type { ClientIdentity } from './host.js';

export interface RunTokenSourceOptions {
  readonly getSecret: GetSecret;
  /** Sends the token request. The engine's `sendHttp` by default; a stub in tests. */
  readonly send?: (request: HttpRequest) => Promise<HttpExchange>;
  readonly now?: () => Date;
  /** Told every access token obtained, so a host can keep it out of everything it prints. */
  readonly onSecretValue?: (value: string) => void;
}

/** What one token request needs beyond the configuration: the requesting send's own surroundings. */
export interface TokenRequestContext {
  /** The request's property scopes: token URL, client id, scopes and audience expand against them. */
  readonly scopes: PropertyScopes;
  readonly tls?: TlsOptions;
  /** The proxy for the token URL, chosen after it is expanded. */
  readonly proxy?: (tokenUrl: string) => Promise<ProxyOptions | undefined>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * The client identity a keystore entry stands for: what `private-key-jwt` signs with and
   * `tls-client-auth` presents. Absent, a key-based configuration is refused.
   */
  readonly identityFor?: (keystoreId: string) => Promise<ClientIdentity | undefined>;
}

export interface RunTokenSource {
  /**
   * The cached token for the configuration, or a new one when there is none, it is about to lapse,
   * or it was rejected.
   *
   * @throws WirebenchError `unresolved-properties` | `secret-missing` | `oauth2-no-token-url` |
   * `oauth2-token-error` | `oauth2-token-malformed`, or the send's own error
   */
  accessTokenFor(config: OAuth2Auth, request: TokenRequestContext): Promise<string>;
  /**
   * Drops `accessToken` from the cache after a server refused it (a REST or SOAP `401`, a gRPC
   * `UNAUTHENTICATED`), so the next request behind its configuration fetches a new one. It never
   * re-sends the refused request: that one may already have done something. A token the cache no
   * longer holds is ignored.
   */
  reject(accessToken: string): void;
}

/** The configuration with its property references expanded; unresolved ones refuse the fetch. */
function expandConfig(config: OAuth2Auth, scopes: PropertyScopes): OAuth2Auth {
  const unresolved: UnresolvedRef[] = [];
  const one = (text: string): string => {
    const result = expand(text, scopes);
    unresolved.push(...result.unresolved);
    return result.text;
  };
  const expanded: OAuth2Auth = {
    ...config,
    tokenUrl: one(config.tokenUrl),
    clientId: one(config.clientId),
    scopes: config.scopes.map(one),
    ...(config.audience !== undefined ? { audience: one(config.audience) } : {}),
    ...(config.username !== undefined ? { username: one(config.username) } : {}),
    ...(config.deviceAuthorizationUrl !== undefined
      ? { deviceAuthorizationUrl: one(config.deviceAuthorizationUrl) }
      : {}),
  };
  if (unresolved.length > 0) {
    const exprs = unresolved.map((ref) => ref.expr);
    throw new WirebenchError(
      'unresolved-properties',
      `The OAuth2 configuration has property references nothing resolves: ${exprs.join(', ')}`,
      { details: { unresolved: exprs } },
    );
  }
  return expanded;
}

/** The expanded fields a token belongs to. Kept in memory only, never printed. */
function cacheKey(config: OAuth2Auth): string {
  return [
    config.grant,
    config.tokenUrl,
    config.clientId,
    config.clientAuth,
    config.username ?? '',
    [...config.scopes].sort().join(' '),
    config.audience ?? '',
  ].join('\u0000');
}

/** The grants a run can perform without a person present. */
function headless(config: OAuth2Auth): boolean {
  return config.grant === 'client-credentials' || config.grant === 'password';
}

/** A browser grant with no refresh token to start from: refused, with the variable that would fix it. */
function browserGrantRefused(config: OAuth2Auth): WirebenchError {
  const how =
    config.grant === 'device-code' ? 'a device sign-in (OAuth2 device code)' : 'a browser (OAuth2 authorization code)';
  const variable =
    config.refreshTokenRef !== undefined && config.refreshTokenRef !== ''
      ? envVariablesFor({
          ref: config.refreshTokenRef,
          ...(config.refreshTokenEnv !== undefined ? { envName: config.refreshTokenEnv } : {}),
        })[0]
      : undefined;
  return new WirebenchError(
    'auth-grant-unsupported',
    variable !== undefined
      ? `This request signs in through ${how}, which a pipeline cannot do. Supply a refresh token in ${variable}.`
      : `This request signs in through ${how}, which a pipeline cannot do. Remember its refresh token in the app and set refreshTokenEnv to supply it.`,
    { details: { grant: config.grant } },
  );
}

export function createRunTokenSource(options: RunTokenSourceOptions): RunTokenSource {
  const tokens = new Map<string, TokenSet>();
  const now = options.now ?? ((): Date => new Date());
  const send = options.send ?? ((request: HttpRequest): Promise<HttpExchange> => sendHttp(request));

  const optionalSecret = async (ref: string | undefined): Promise<string | undefined> => {
    if (ref === undefined || ref === '') return undefined;
    const value = await options.getSecret(ref);
    return value === undefined || value === '' ? undefined : value;
  };

  /** One token request for `config` (already expanded): its client authentication, TLS and proxy. */
  const fetchToken = async (
    config: OAuth2Auth,
    grant: TokenGrantInput,
    request: TokenRequestContext,
  ): Promise<TokenSet> => {
    const keyBased = config.clientAuth === 'private-key-jwt' || config.clientAuth === 'tls-client-auth';
    const clientSecret = keyBased ? undefined : await clientSecretOf(config, options.getSecret);
    const identity = keyBased ? await identityOf(config, request) : undefined;
    const password =
      grant.grant === 'password' && config.passwordRef !== undefined && config.passwordRef !== ''
        ? await requiredSecret(config.passwordRef, options.getSecret)
        : undefined;
    const built = buildTokenRequest(
      config,
      {
        ...(await clientAuthSecrets(config, {
          ...(clientSecret !== undefined ? { clientSecret } : {}),
          ...(identity !== undefined ? { identity } : {}),
          now: now(),
        })),
        ...(password !== undefined ? { password } : {}),
      },
      grant,
      {
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      },
    );
    // `tls_client_auth` presents the configuration's own certificate, whatever the request's is.
    const tls =
      config.clientAuth === 'tls-client-auth' && identity !== undefined
        ? { ...request.tls, cert: identity.cert, key: identity.key }
        : request.tls;
    const proxy = await request.proxy?.(config.tokenUrl);
    const exchange = await send({
      ...built,
      ...(tls !== undefined ? { tls } : {}),
      ...(proxy !== undefined ? { proxy } : {}),
    });
    const token = parseTokenResponse({ status: exchange.status, body: exchange.body, now });
    options.onSecretValue?.(token.accessToken);
    if (token.refreshToken !== undefined) options.onSecretValue?.(token.refreshToken);
    return token;
  };

  return {
    async accessTokenFor(config, request) {
      const expanded = expandConfig(config, request.scopes);
      const key = cacheKey(expanded);
      const cached = tokens.get(key);
      if (cached !== undefined && !needsRefresh(cached, now())) {
        return cached.accessToken;
      }
      const obtain = async (grant: TokenGrantInput): Promise<string> => {
        const token = await fetchToken(expanded, grant, request);
        // RFC 6749 §6: a refresh may or may not rotate the refresh token; keep the old one if not.
        const kept =
          token.refreshToken === undefined && grant.grant === 'refresh'
            ? { ...token, refreshToken: grant.refreshToken }
            : token;
        tokens.set(key, kept);
        return kept.accessToken;
      };
      const refreshToken = cached?.refreshToken ?? (await optionalSecret(expanded.refreshTokenRef));
      if (refreshToken !== undefined) {
        try {
          return await obtain({ grant: 'refresh', refreshToken });
        } catch (error) {
          // A retired refresh token is not a dead end for a grant that can sign in again on its own.
          tokens.delete(key);
          if (!headless(expanded)) throw error;
        }
      }
      if (!headless(expanded)) {
        throw browserGrantRefused(expanded);
      }
      return obtain(expanded.grant === 'password' ? { grant: 'password' } : { grant: 'client-credentials' });
    },
    reject(accessToken) {
      for (const [key, token] of tokens) {
        if (token.accessToken === accessToken) {
          tokens.delete(key);
        }
      }
    },
  };
}

/** A secret the project names but the run was not given: refused, never sent without. */
export async function requiredSecret(ref: string, getSecret: GetSecret): Promise<string> {
  const value = await getSecret(ref);
  if (value === undefined) {
    throw new WirebenchError('secret-missing', `Secret ${ref} was not supplied to this run.`, { details: { ref } });
  }
  return value;
}

/** A configured client secret the run was not given is refused, never sent as a public client. */
async function clientSecretOf(config: OAuth2Auth, getSecret: GetSecret): Promise<string | undefined> {
  const ref = config.clientSecretRef;
  return ref === undefined || ref === '' ? undefined : requiredSecret(ref, getSecret);
}

/** The keystore identity a key-based client authenticates with; refused when there is none. */
async function identityOf(config: OAuth2Auth, request: TokenRequestContext): Promise<ClientIdentity> {
  const keystoreId = config.clientKeystoreId;
  const identity = keystoreId === undefined || keystoreId === '' ? undefined : await request.identityFor?.(keystoreId);
  if (identity === undefined) {
    throw new WirebenchError(
      'oauth2-client-key-missing',
      `${config.clientAuth === 'tls-client-auth' ? 'tls_client_auth' : 'private_key_jwt'} needs a keystore with a private key; choose one for this configuration.`,
      { details: { clientId: config.clientId, ...(keystoreId !== undefined ? { keystoreId } : {}) } },
    );
  }
  return identity;
}
