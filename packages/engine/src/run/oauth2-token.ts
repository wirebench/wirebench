/**
 * OAuth2 access tokens for a run, which has no browser, no keychain and no token cache of its own
 * beyond the run itself. Only the client-credentials grant can work headless; the caller refuses
 * authorization-code before it gets here.
 *
 * One token per configuration per run: two requests behind the same configuration share one token
 * request, and a token is fetched again only when `needsRefresh` says it is about to lapse. A
 * failed fetch is never cached, so the next request behind the configuration tries again.
 */
import { WirebenchError } from '../errors.js';
import { sendHttp } from '../http/client.js';
import type { HttpExchange, HttpRequest, ProxyOptions, TlsOptions } from '../http/types.js';
import type { OAuth2Auth } from '../project/model.js';
import { expand } from '../project/properties.js';
import type { PropertyScopes, UnresolvedRef } from '../project/properties.js';
import { buildTokenRequest, needsRefresh, parseTokenResponse } from '../rest/oauth2.js';
import type { TokenSet } from '../rest/oauth2.js';
import type { GetSecret } from '../secrets/resolve.js';

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
  readonly proxy?: (tokenUrl: string) => ProxyOptions | undefined;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface RunTokenSource {
  /**
   * A token the server later rejects mid-run (e.g. a 401 on the request that carried it) is not
   * re-fetched here: only `needsRefresh` against the cached expiry triggers a new fetch, on the
   * next call for the same configuration.
   *
   * @throws WirebenchError `unresolved-properties` | `secret-missing` | `oauth2-no-token-url` |
   * `oauth2-token-error` | `oauth2-token-malformed`, or the send's own error
   */
  accessTokenFor(config: OAuth2Auth, request: TokenRequestContext): Promise<string>;
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
  return [config.tokenUrl, config.clientId, [...config.scopes].sort().join(' '), config.audience ?? ''].join('\u0000');
}

export function createRunTokenSource(options: RunTokenSourceOptions): RunTokenSource {
  const tokens = new Map<string, TokenSet>();
  const now = options.now ?? ((): Date => new Date());
  const send = options.send ?? ((request: HttpRequest): Promise<HttpExchange> => sendHttp(request));
  return {
    async accessTokenFor(config, request) {
      const expanded = expandConfig(config, request.scopes);
      const key = cacheKey(expanded);
      const cached = tokens.get(key);
      if (cached !== undefined && !needsRefresh(cached, now())) {
        return cached.accessToken;
      }
      const clientSecret = await clientSecretOf(expanded, options.getSecret);
      const built = buildTokenRequest(
        expanded,
        clientSecret !== undefined ? { clientSecret } : {},
        { grant: 'client-credentials' },
        {
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        },
      );
      const proxy = request.proxy?.(expanded.tokenUrl);
      const exchange = await send({
        ...built,
        ...(request.tls !== undefined ? { tls: request.tls } : {}),
        ...(proxy !== undefined ? { proxy } : {}),
      });
      const token = parseTokenResponse({ status: exchange.status, body: exchange.body, now });
      options.onSecretValue?.(token.accessToken);
      tokens.set(key, token);
      return token.accessToken;
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
