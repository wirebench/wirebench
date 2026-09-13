/**
 * Sending one REST request.
 *
 * Everything is already resolved by the time it gets here: the base URL (environment overrides
 * applied), every `${…}` property expanded, credentials turned from `secretRef`s into values, TLS
 * and proxy settled. This function composes the wire request, hands it to the one HTTP transport
 * the SOAP path also uses, and decodes what came back — so the desktop app and the planned CLI
 * runner send identically, and there is one implementation of redirects, timings and raw capture
 * rather than two.
 */

import { WirebenchError } from '../errors.js';
import { sendWithAuth } from '../http/auth/apply.js';
import type { HttpExchange, HttpRequest, ProxyOptions, TlsOptions } from '../http/types.js';
import type { AuthSummary, SendAuth } from '../types.js';
import { applyAuth } from './auth.js';
import { encodeRestBody } from './body.js';
import type { FileResolver } from './body.js';
import { cookieHeader } from './cookies.js';
import type { KeyValueEntry, RestBody, RestMethod } from './model.js';
import type { BodyLanguage, Cookie } from './response.js';
import { decodeResponseText, detectLanguage, parseSetCookie } from './response.js';
import { composeUrl } from './url.js';
import type { UrlProblem } from './url.js';

/** The parts of a saved request a send reads, with every property already expanded. */
export interface RestSendRequest {
  readonly method: RestMethod;
  readonly url: string;
  readonly pathParams: readonly KeyValueEntry[];
  readonly query: readonly KeyValueEntry[];
  readonly headers: readonly KeyValueEntry[];
  readonly body: RestBody;
}

/** Transport settings for one send, every value already resolved from request, API and preference. */
export interface RestSendSettings {
  readonly timeoutMs: number;
  readonly followRedirects: boolean;
  readonly maxRedirects?: number;
  readonly keepBodyOnRedirect?: boolean;
  readonly encodeUrl?: boolean;
  readonly maxSizeBytes?: number;
  readonly localAddress?: string;
  readonly allowH2?: boolean;
  readonly decompress?: boolean;
  /** Charset for a raw or form body, and for the `Content-Type` that declares it. */
  readonly charset?: string;
}

/** Everything {@link sendRest} needs. */
export interface RestSendInput {
  /** The API's effective base URL, already expanded. Empty when the request's URL is absolute. */
  readonly baseUrl: string;
  readonly request: RestSendRequest;
  readonly settings: RestSendSettings;
  /**
   * Headers the host adds on the request's behalf — `User-Agent`, `Accept-Encoding`, `Connection`,
   * a default `Accept` — which a header the request sets itself overrides.
   */
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  /** Credentials, already resolved to values. */
  readonly auth?: SendAuth;
  /** Cookies to send back, already matched against the URL (`rest/cookies.ts`). */
  readonly cookies?: readonly Cookie[];
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
  /** How a multipart file part or a binary body is read. */
  readonly resolveFile?: FileResolver;
  /** Fixed multipart boundary; tests inject it. */
  readonly boundary?: string;
  readonly signal?: AbortSignal;
}

/** One REST exchange: everything the transport captured, plus what the body turned out to be. */
export interface RestExchange extends HttpExchange {
  /** The response body decoded to text; empty for a body with no text form. */
  readonly text: string;
  readonly language: BodyLanguage;
  /** Set when the declared charset could not be honoured and UTF-8 was used instead. */
  readonly decodeNote?: string;
  readonly cookies: readonly Cookie[];
  /** True when a redirect turned the request into a `GET`, which the HTTP log calls out. */
  readonly methodChanged: boolean;
  /** What authentication did, when credentials needed a round trip of their own. */
  readonly auth?: AuthSummary;
  /**
   * Total time across every leg of the send, including a Basic challenge retry or an NTLM
   * handshake — `timings.totalMs` describes the final leg alone.
   */
  readonly durationMs: number;
}

/**
 * Merges the header sources in precedence order, lowest first: host defaults, then what the body
 * and credentials imply, then the request's own typed headers.
 *
 * The request always wins — a user who typed a `Content-Type` meant it, even when the body kind
 * implies another — which is the same rule the SOAP path applies to its computed headers.
 */
function mergeRequestHeaders(input: {
  readonly defaults: Readonly<Record<string, string>>;
  readonly computed: Readonly<Record<string, string>>;
  readonly typed: readonly KeyValueEntry[];
}): Record<string, string> {
  const merged = new Map<string, [string, string]>();
  const put = (name: string, value: string): void => {
    merged.set(name.toLowerCase(), [name, value]);
  };
  for (const [name, value] of Object.entries(input.defaults)) {
    put(name, value);
  }
  for (const [name, value] of Object.entries(input.computed)) {
    put(name, value);
  }
  // A repeated header name in the request's own table is joined with `, `, which is what RFC 9110
  // §5.3 says a recipient must treat as equivalent to two headers; undici takes one value per name.
  const typedSeen = new Set<string>();
  for (const header of input.typed) {
    if (!header.enabled || header.name === '') {
      continue;
    }
    const key = header.name.toLowerCase();
    const previous = typedSeen.has(key) ? merged.get(key)?.[1] : undefined;
    put(header.name, previous === undefined ? header.value : `${previous}, ${header.value}`);
    typedSeen.add(key);
  }
  return Object.fromEntries([...merged.values()]);
}

/** The methods this transport will send. A custom method is passed through as given. */
function methodFor(method: RestMethod): HttpRequest['method'] {
  return method.toUpperCase() as HttpRequest['method'];
}

/**
 * Sends one REST request and decodes the response.
 *
 * Order of work: credentials are applied first (an API key in the query has to be part of the URL),
 * then the URL is composed, then the body encoded, then headers merged. A URL that is still
 * incomplete — an unfilled `{param}`, an unexpanded property, no host at all — is refused here
 * rather than sent: those are the problems the preflight surfaces, and sending anyway would put a
 * literal `{id}` on someone's wire.
 *
 * HTTP-level failures (timeout, DNS, TLS, too many redirects) propagate as `HttpError`. A non-2xx
 * status is not a failure: it is a response, and the caller inspects it.
 *
 * @throws WirebenchError `rest-url-incomplete` when the URL could not be completed
 */
export async function sendRest(input: RestSendInput): Promise<RestExchange> {
  const { request, settings } = input;
  const applied = applyAuth(input.auth);

  const composed = composeUrl(input.baseUrl, request.url, request.pathParams, [...request.query, ...applied.query], {
    encode: settings.encodeUrl ?? true,
  });
  if (composed.problems.length > 0) {
    throw urlIncomplete(composed.problems, composed.url);
  }

  const encoded = await encodeRestBody(request.body, {
    ...(input.resolveFile !== undefined ? { resolveFile: input.resolveFile } : {}),
    ...(settings.charset !== undefined ? { charset: settings.charset } : {}),
    ...(input.boundary !== undefined ? { boundary: input.boundary } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const cookies = cookieHeader(input.cookies ?? []);
  const headers = mergeRequestHeaders({
    defaults: input.defaultHeaders ?? {},
    computed: {
      ...applied.headers,
      ...(encoded.contentType !== undefined ? { 'Content-Type': encoded.contentType } : {}),
      ...(cookies !== undefined ? { Cookie: cookies } : {}),
    },
    typed: request.headers,
  });

  const httpRequest: HttpRequest = {
    url: composed.url,
    method: methodFor(request.method),
    headers,
    ...(encoded.bytes !== undefined ? { body: encoded.bytes } : {}),
    timeoutMs: settings.timeoutMs,
    followRedirects: settings.followRedirects,
    ...(settings.maxRedirects !== undefined ? { maxRedirects: settings.maxRedirects } : {}),
    ...(settings.keepBodyOnRedirect === true ? { preserveMethodOnRedirect: true } : {}),
    ...(settings.maxSizeBytes !== undefined ? { maxSizeBytes: settings.maxSizeBytes } : {}),
    ...(settings.localAddress !== undefined ? { localAddress: settings.localAddress } : {}),
    ...(settings.allowH2 === true ? { allowH2: true } : {}),
    ...(settings.decompress !== undefined ? { decompress: settings.decompress } : {}),
    ...(input.tls !== undefined ? { tls: input.tls } : {}),
    ...(input.proxy !== undefined ? { proxy: input.proxy } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };

  // Basic and NTLM may need a round trip of their own; every other scheme is already in `headers`.
  const authenticated = await sendWithAuth(httpRequest, applied.transportAuth);
  return {
    ...decodeRestResponse(authenticated.http, methodFor(request.method)),
    ...(authenticated.auth !== undefined ? { auth: authenticated.auth } : {}),
    durationMs: authenticated.durationMs,
  };
}

/** The error a URL that cannot be completed raises, naming every problem at once. */
function urlIncomplete(problems: readonly UrlProblem[], url: string): WirebenchError {
  const missing = problems.filter((problem) => problem.code === 'missing-path-param').map((problem) => problem.name);
  const message =
    missing.length > 0
      ? `The URL still needs a value for ${missing.map((name) => `{${name}}`).join(', ')}`
      : `The URL is not a complete address: ${url}`;
  return new WirebenchError('rest-url-incomplete', message, { details: { url, problems } });
}

/**
 * Turns a finished HTTP exchange into a REST one: body decoded to text, language detected, cookies
 * parsed, and a note when a redirect changed the method.
 *
 * Split out so a response replayed from history or from the exchange cache is presented exactly as
 * a live one.
 */
export function decodeRestResponse(exchange: HttpExchange, sentMethod: HttpRequest['method']): RestExchange {
  const contentType = exchange.headers['content-type'];
  const language = detectLanguage(contentType, exchange.body);
  const decoded =
    language === 'image' || language === 'binary' ? { text: '' } : decodeResponseText(exchange.body, contentType);
  const methodChanged =
    sentMethod !== 'GET' &&
    exchange.redirects.some(
      (hop) => hop.status === 303 || ((hop.status === 301 || hop.status === 302) && sentMethod === 'POST'),
    );
  return {
    ...exchange,
    durationMs: exchange.timings.totalMs,
    text: decoded.text,
    language,
    ...(decoded.problem !== undefined ? { decodeNote: decoded.problem } : {}),
    cookies: parseSetCookie(exchange.rawHeaders),
    methodChanged,
  };
}
