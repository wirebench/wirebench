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

/** How {@link createHttpFetchDocument} reaches the network, and with what credentials. */
export interface DocumentFetchOptions {
  /** Resolved credentials: values, not references. Sent only to `authOrigin`. */
  readonly auth?: SendAuth;
  /** Origin of the document the user named; absent means no auth is ever attached. */
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

/** What one hop sends: its URL (with a query key, on the auth origin) and its credential headers. */
function credentialsFor(
  url: string,
  options: DocumentFetchOptions,
): { readonly url: string; readonly headers: Readonly<Record<string, string>> } {
  const { auth, authOrigin } = options;
  if (auth === undefined || authOrigin === undefined || new URL(url).origin !== authOrigin) {
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
 * A transport failure on a hop that carried a query key, told without the key: the URL in its text is
 * masked, and its details name the location without the key.
 */
function maskedFailure(error: unknown, sent: string, bare: string, keyName: string): unknown {
  if (!(error instanceof WirebenchError)) {
    return error;
  }
  const masked = redactUrl(sent, { extraParams: [keyName] });
  return new HttpError(error.code, error.message.split(sent).join(masked), { details: { location: bare } });
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
      throw keyName === undefined || url === bare ? error : maskedFailure(error, url, bare, keyName);
    }

    const target = exchange.headers['location'];
    if (REDIRECT_STATUSES.has(exchange.status) && target !== undefined) {
      if (hops >= MAX_REDIRECTS) {
        throw new HttpError('too-many-redirects', `GET ${start} redirected more than ${String(MAX_REDIRECTS)} times`, {
          details: { location: start },
        });
      }
      const next = new URL(target, bare).toString();
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
 * credentials went with it), `fetch-failed` for any other non-2xx, `too-many-redirects`, or a
 * transport error from `sendHttp`
 */
export function createHttpFetchDocument(options: DocumentFetchOptions = {}): FetchDocument {
  const fallback = createDefaultFetchDocument();
  return async (location, signal) => {
    if (!/^https?:\/\//i.test(location)) {
      return fallback(location, signal);
    }
    return fetchHttp(location, signal, options);
  };
}
