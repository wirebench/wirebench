/**
 * The fetcher every OpenAPI and AsyncAPI read goes through.
 *
 * It sends through the engine's own HTTP client rather than the global `fetch`, so the proxy and CA
 * bundle the host resolves apply to a definition as they do to a request. It follows redirects
 * itself: `sendHttp` scopes only the three standard credential headers to an origin, and a
 * definition's credentials may also be a custom API-key header or a query key. On every hop, and for
 * every `$ref` document, credentials go only to the origin of the document the user named.
 */

import { HttpError, WirebenchError } from '../errors.js';
import { redactUrl } from '../redact/index.js';
import { applyAuth } from '../rest/auth.js';
import type { SendAuth } from '../types.js';
import { createDefaultFetchDocument, decodeXmlBytes } from '../wsdl/fetch.js';
import type { FetchDocument, FetchedDocument } from '../wsdl/resolver.js';
import { basicAuthorization } from './auth/basic.js';
import { sendHttp } from './client.js';
import type { ProxyOptions, TlsOptions } from './types.js';

const TIMEOUT_MS = 20_000;
const USER_AGENT = 'wirebench/0.1';
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const WEB_PROTOCOLS = new Set(['http:', 'https:']);

/** How {@link createHttpFetchDocument} reaches the network, and with what credentials. */
export interface DocumentFetchOptions {
  /** Resolved credentials: values, not references. Sent only to `authOrigin`. */
  readonly auth?: SendAuth;
  /**
   * Origin of the document the user named; absent means no auth is ever attached. Normalised as a URL
   * origin (a trailing slash, the host's case and a default port do not matter); it must be `http(s)`.
   */
  readonly authOrigin?: string;
  /** TLS and proxy for one URL, as the host resolves them. */
  readonly network?: (url: string) => Promise<{ readonly tls?: TlsOptions; readonly proxy?: ProxyOptions }>;
}

/** `url` without the query parameter `name`; `url` itself, unparsed and unchanged, when it has none. */
function withoutParam(url: string, name: string): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has(name)) {
    return url;
  }
  parsed.searchParams.delete(name);
  return parsed.toString();
}

/**
 * `authOrigin` as `URL.origin` writes it, so it compares equal to a hop's origin however the caller
 * spelled it.
 *
 * @throws HttpError `invalid-url` when it is not an `http(s)` URL: an opaque origin (`null`, from
 * `file:` or `data:`) must never match anything
 */
function normaliseAuthOrigin(authOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(authOrigin);
  } catch {
    throw new HttpError('invalid-url', `The origin credentials go to is not a URL: ${authOrigin}`, {
      details: { authOrigin },
    });
  }
  if (!WEB_PROTOCOLS.has(parsed.protocol)) {
    throw new HttpError('invalid-url', `The origin credentials go to is not http(s): ${authOrigin}`, {
      details: { authOrigin },
    });
  }
  return parsed.origin;
}

/** What one hop sends: its URL (with a query key, on the auth origin) and its credential headers. */
function credentialsFor(
  url: string,
  options: DocumentFetchOptions,
): { readonly url: string; readonly headers: Readonly<Record<string, string>> } {
  const { auth, authOrigin } = options;
  if (auth === undefined || authOrigin === undefined) {
    return { url, headers: {} };
  }
  const hop = new URL(url);
  if (!WEB_PROTOCOLS.has(hop.protocol) || hop.origin !== authOrigin) {
    return { url, headers: {} };
  }
  if (auth.type === 'basic') {
    // Always preemptive: a definition endpoint that answers 401 is refused, not challenged through.
    return { url, headers: { Authorization: basicAuthorization(auth.username, auth.password) } };
  }
  if (auth.type === 'api-key' && auth.in === 'query') {
    const keyed = new URL(url);
    keyed.searchParams.append(auth.name, auth.value);
    return { url: keyed.toString(), headers: {} };
  }
  return { url, headers: applyAuth(auth).headers };
}

/**
 * A transport failure from `sendHttp`, told without the credentials this hop carried.
 *
 * `details.request` always goes: it records the headers as sent, `Authorization` or an API-key header
 * included. Every other detail stays, and `details.location` names the hop without a query key. When
 * the hop carried a query key (`sent` differs from `bare`), the URL in the message is masked, any
 * detail that repeats it is replaced by `bare`, and the `cause` goes too, since its text may hold it.
 */
function sanitisedFailure(error: unknown, sent: string, bare: string, keyName: string | undefined): unknown {
  if (!(error instanceof WirebenchError)) {
    return error;
  }
  const keyed = keyName !== undefined && sent !== bare;
  const details: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(error.details ?? {})) {
    if (name !== 'request') {
      details[name] = keyed && value === sent ? bare : value;
    }
  }
  details['location'] = bare;
  const message = keyed ? error.message.split(sent).join(redactUrl(sent, { extraParams: [keyName] })) : error.message;
  const rebuilt = new HttpError(error.code, message, {
    details,
    ...(!keyed && error.cause !== undefined ? { cause: error.cause } : {}),
  });
  if (!keyed && error.stack !== undefined) {
    rebuilt.stack = error.stack;
  }
  return rebuilt;
}

/**
 * Where a redirect from `bare` to `target` leads.
 *
 * @throws HttpError `fetch-failed` when `target` is not a URL or not `http(s)`: a server must not
 * steer a definition read onto the local disk or anywhere else outside the web
 */
function redirectTarget(target: string, bare: string, status: number): string {
  let next: URL;
  try {
    next = new URL(target, bare);
  } catch {
    throw new HttpError('fetch-failed', `GET ${bare} redirected to a location that is not a URL`, {
      details: { location: bare, status },
    });
  }
  if (!WEB_PROTOCOLS.has(next.protocol)) {
    throw new HttpError(
      'fetch-failed',
      `GET ${bare} redirected to a ${next.protocol} location; a definition read follows http(s) redirects only`,
      { details: { location: bare, status } },
    );
  }
  return next.toString();
}

async function fetchHttp(
  location: string,
  signal: AbortSignal | undefined,
  options: DocumentFetchOptions,
): Promise<FetchedDocument> {
  const keyName = options.auth?.type === 'api-key' && options.auth.in === 'query' ? options.auth.name : undefined;
  // `bare` is the hop's URL as the resolver may see it: never with the key this fetcher adds, even
  // when a server echoed it into a redirect's `Location`.
  const start = keyName === undefined ? location : withoutParam(location, keyName);
  let bare = start;
  for (let hops = 0; ; hops += 1) {
    const { url, headers } = credentialsFor(bare, options);
    const credentialsSent = url !== bare || Object.keys(headers).length > 0;
    const network = (await options.network?.(bare)) ?? {};
    let exchange;
    try {
      exchange = await sendHttp({
        url,
        method: 'GET',
        headers: { 'user-agent': USER_AGENT, ...headers },
        timeoutMs: TIMEOUT_MS,
        followRedirects: false,
        ...(signal !== undefined ? { signal } : {}),
        ...(network.tls !== undefined ? { tls: network.tls } : {}),
        ...(network.proxy !== undefined ? { proxy: network.proxy } : {}),
      });
    } catch (error) {
      // A cancel stays a cancel: the resolver tells an `AbortError` from a document that failed.
      signal?.throwIfAborted();
      throw sanitisedFailure(error, url, bare, keyName);
    }

    const target = exchange.headers['location'];
    if (REDIRECT_STATUSES.has(exchange.status) && target !== undefined) {
      if (hops >= MAX_REDIRECTS) {
        throw new HttpError('too-many-redirects', `GET ${start} redirected more than ${String(MAX_REDIRECTS)} times`, {
          details: { location: start },
        });
      }
      const next = redirectTarget(target, bare, exchange.status);
      bare = keyName === undefined ? next : withoutParam(next, keyName);
      continue;
    }
    if (exchange.status === 401 || exchange.status === 403) {
      const status = String(exchange.status);
      throw new HttpError(
        'definition-auth-required',
        credentialsSent
          ? `The definition at ${bare} refused the credentials given (HTTP ${status}).`
          : `The definition at ${bare} needs authentication (HTTP ${status}).`,
        { details: { location: bare, status: exchange.status, authSent: credentialsSent } },
      );
    }
    if (exchange.status < 200 || exchange.status >= 300) {
      throw new HttpError('fetch-failed', `GET ${bare} failed with status ${String(exchange.status)}`, {
        details: { location: bare, status: exchange.status },
      });
    }
    return { location: bare, bytes: exchange.body, text: decodeXmlBytes(exchange.body) };
  }
}

/**
 * Creates the {@link FetchDocument} for OpenAPI and AsyncAPI reads: `file:` (and any other non-HTTP
 * location) as {@link createDefaultFetchDocument} reads it, and `http(s):` through `sendHttp` with
 * the host's TLS and proxy, following up to 5 redirects, with `options.auth` sent only to
 * `options.authOrigin`.
 *
 * The returned `location` never carries a query key this fetcher added, so `$ref` resolution,
 * progress messages, errors and a recorded source never do either.
 *
 * @throws HttpError `definition-auth-required` for a 401 or 403 (`details.authSent` says whether
 * credentials went with it), `fetch-failed` for any other non-2xx or a redirect off `http(s)`,
 * `too-many-redirects`, or a transport error from `sendHttp` (without `details.request`)
 * @throws HttpError `invalid-url`, at once, when `options.authOrigin` is not an `http(s)` URL
 */
export function createHttpFetchDocument(options: DocumentFetchOptions = {}): FetchDocument {
  const resolved: DocumentFetchOptions =
    options.authOrigin === undefined ? options : { ...options, authOrigin: normaliseAuthOrigin(options.authOrigin) };
  const fallback = createDefaultFetchDocument();
  return async (location, signal) => {
    if (!/^https?:\/\//i.test(location)) {
      return fallback(location, signal);
    }
    return fetchHttp(location, signal, resolved);
  };
}
