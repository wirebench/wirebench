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
import type {
  HttpCookieHook,
  HttpExchange,
  HttpRequest,
  HttpStreamSink,
  ProxyOptions,
  TlsOptions,
} from '../http/types.js';
import type { AuthSummary, SendAuth } from '../http/auth/send-auth.js';
import type { SignatureScheme } from '../http/webhook-signature.js';
import { signWebhook } from '../http/webhook-signature.js';
import { applyAuth } from '../http/auth/apply-auth.js';
import type { AppliedAuth } from '../http/auth/apply-auth.js';
import { encodeRestBody } from './body.js';
import type { FileResolver } from './body.js';
import type { CookieJarHost, CookieVerdict } from '../http/cookies.js';
import { mergeCookieHeader } from './cookie-jar.js';
import { cookieHeader } from './cookies.js';
import type { KeyValueEntry, RestBody, RestMethod } from './model.js';
import type { BodyLanguage, Cookie } from './response.js';
import { decodeResponseText, detectLanguage, parseSetCookie } from './response.js';
import { createSseParser, isEventStream } from './sse.js';
import type { SseRow } from './sse.js';
import { createSseRowStore } from './sse-transcript.js';
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
  /** Cookies to send back, already matched against the URL. Kept for the engine's API; a run sends through `jar`.
   * Exclusive with `jar`: when a jar is present this list is ignored. */
  readonly cookies?: readonly Cookie[];
  /**
   * The cookie jar this send stores into and, when `send` is set, reads from (cookie jar spec
   * §1.4). Each hop of a redirect is matched and stored against its own URL. A hand-set `Cookie`
   * header goes first and wins on the same name.
   */
  readonly jar?: { readonly host: CookieJarHost; readonly send: boolean };
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
  /** How a multipart file part or a binary body is read. */
  readonly resolveFile?: FileResolver;
  /** Fixed multipart boundary; tests inject it. */
  readonly boundary?: string;
  /**
   * A webhook item's signing (webhook-signatures §5.2), its secret already resolved. Applied last,
   * over the encoded body bytes and the merged headers, so the signature covers exactly what goes
   * on the wire. A signing header replaces a merged header of the same name.
   */
  readonly sign?: { readonly scheme: SignatureScheme; readonly secret: string };
  readonly signal?: AbortSignal;
  /**
   * Opt-in event-stream handling: when set and the response's `Content-Type` is `text/event-stream`,
   * the body is parsed row by row as it arrives instead of being buffered. A response of any other
   * content type is buffered exactly as without this — `onOpen`/`onRow` simply never fire.
   */
  readonly onStream?: {
    /** Called once the response's status and headers are in, before any row. */
    onOpen?(status: number, headers: Readonly<Record<string, string>>): void;
    /** Called once per row, in order, as the parser produces it. */
    onRow?(row: SseRow): void;
  };
}

/** The rows and outcome of an event-stream response, once the send resolves. */
export interface RestEventStream {
  readonly rows: readonly SseRow[];
  readonly counts: {
    readonly events: number;
    readonly comments: number;
    readonly retries: number;
    readonly bytes: number;
  };
  readonly lastEventId: string;
  readonly retryMs?: number;
  readonly endedBy: 'server' | 'client' | 'error';
  readonly error?: string;
  readonly droppedRows: number;
}

/** One REST exchange: everything the transport captured, plus what the body turned out to be. */
export interface RestExchange extends HttpExchange {
  /** Present only when `onStream` was given and the response was an event stream. */
  readonly stream?: RestEventStream;
  /** The response body decoded to text; empty for a body with no text form. */
  readonly text: string;
  readonly language: BodyLanguage;
  /** Set when the declared charset could not be honoured and UTF-8 was used instead. */
  readonly decodeNote?: string;
  readonly cookies: readonly Cookie[];
  /** The jar's verdict on each of `cookies`, in order; present when the send had a jar. */
  readonly cookieVerdicts?: readonly CookieVerdict[];
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

/** `headers` with the signing headers set over `body`, replacing any header of the same name. */
function withSignature(
  headers: Record<string, string>,
  sign: NonNullable<RestSendInput['sign']>,
  body: Uint8Array,
): Record<string, string> {
  const out = { ...headers };
  for (const [name, value] of signWebhook(sign.scheme, sign.secret, body)) {
    for (const key of Object.keys(out)) {
      if (key.toLowerCase() === name.toLowerCase()) delete out[key];
    }
    out[name] = value;
  }
  return out;
}

/**
 * The credentials `applyAuth` put on the request, for `sendHttp` to keep to the request's origin
 * across redirects. `Authorization` is dropped on a cross-origin hop anyway; an API key's custom
 * header or query parameter is only known here.
 */
function originCredentialsFor(applied: AppliedAuth): Pick<HttpRequest, 'originCredentials'> {
  const headers = Object.keys(applied.headers);
  const query = applied.query.map(({ name, value }) => ({ name, value }));
  if (headers.length === 0 && query.length === 0) {
    return {};
  }
  return { originCredentials: { headers, query } };
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
 * @throws WirebenchError `webhook-signing-secret` when a `standard` signing secret cannot be decoded
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

  const cookies = input.jar === undefined ? cookieHeader(input.cookies ?? []) : undefined;
  const merged = mergeRequestHeaders({
    defaults: input.defaultHeaders ?? {},
    computed: {
      ...applied.headers,
      ...(encoded.contentType !== undefined ? { 'Content-Type': encoded.contentType } : {}),
      ...(cookies !== undefined ? { Cookie: cookies } : {}),
    },
    typed: request.headers,
  });
  // Signing runs last (§5.2): after auth, encoding and merging, so it signs the bytes that go out.
  const headers =
    input.sign === undefined ? merged : withSignature(merged, input.sign, encoded.bytes ?? new Uint8Array());

  const onStream = input.onStream;
  const sseState = onStream !== undefined ? createSseState() : undefined;

  // The jar stores every hop's cookies whatever the setting; it is read only when `send` is on.
  const jar = input.jar;
  const received: { verdicts?: readonly CookieVerdict[] } = {};
  const cookieHook: HttpCookieHook | undefined =
    jar === undefined
      ? undefined
      : {
          header: (url, handSet) => (jar.send ? mergeCookieHeader(jar.host.cookiesFor(url), handSet) : handSet),
          received: (url, rawHeaders) => {
            received.verdicts = jar.host.remember(url, parseSetCookie(rawHeaders));
          },
        };

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
    ...originCredentialsFor(applied),
    ...(settings.localAddress !== undefined ? { localAddress: settings.localAddress } : {}),
    ...(settings.allowH2 === true ? { allowH2: true } : {}),
    ...(settings.decompress !== undefined ? { decompress: settings.decompress } : {}),
    ...(input.tls !== undefined ? { tls: input.tls } : {}),
    ...(input.proxy !== undefined ? { proxy: input.proxy } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(sseState !== undefined && onStream !== undefined ? { stream: sseState.hook(onStream) } : {}),
    ...(cookieHook !== undefined ? { cookies: cookieHook } : {}),
  };

  // Basic, NTLM and Kerberos may need a round trip of their own; every other scheme is already in `headers`.
  const authenticated = await sendWithAuth(httpRequest, applied.transportAuth);
  return {
    ...decodeRestResponse(authenticated.http, methodFor(request.method), sseState),
    ...(authenticated.auth !== undefined ? { auth: authenticated.auth } : {}),
    // The last hop reported is the final response, whose cookies `cookies` lists.
    ...(received.verdicts !== undefined ? { cookieVerdicts: received.verdicts } : {}),
    durationMs: authenticated.durationMs,
  };
}

/** Mutable state a streamed send accumulates as rows arrive, shared between the hook and decoding. */
interface SseState {
  hook(onStream: NonNullable<RestSendInput['onStream']>): {
    accept(status: number, headers: Readonly<Record<string, string>>): HttpStreamSink | undefined;
  };
  readonly store: ReturnType<typeof createSseRowStore>;
  readonly counts: { events: number; comments: number; retries: number; bytes: number };
  lastEventId: string;
  retryMs?: number;
  /** Set once the response was accepted as an event stream; `decodeRestResponse` finalizes it. */
  parser?: ReturnType<typeof createSseParser>;
}

function createSseState(): SseState {
  const store = createSseRowStore();
  const counts = { events: 0, comments: 0, retries: 0, bytes: 0 };
  const state: SseState = {
    store,
    counts,
    lastEventId: '',
    hook(onStream) {
      return {
        accept(status, headers) {
          if (!isEventStream(headers['content-type'])) return undefined;
          onStream.onOpen?.(status, headers);
          const headersAt = performance.now();
          const parser = createSseParser((row) => {
            store.add(row);
            counts.bytes += row.size;
            if (row.kind === 'event') {
              counts.events++;
              state.lastEventId = row.lastEventId;
            } else if (row.kind === 'comment') {
              counts.comments++;
            } else {
              counts.retries++;
              state.retryMs = row.ms;
            }
            onStream.onRow?.(row);
          });
          state.parser = parser;
          return {
            onChunk(bytes: Uint8Array): void {
              parser.push(bytes, performance.now() - headersAt);
            },
          };
        },
      };
    },
  };
  return state;
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
export function decodeRestResponse(
  exchange: HttpExchange,
  sentMethod: HttpRequest['method'],
  sse?: SseState,
): RestExchange {
  const stream = buildEventStream(exchange, sse);
  // Worked out once, for a streamed exchange and a buffered one alike: the redirect chain is the same.
  const methodChanged =
    sentMethod !== 'GET' &&
    exchange.redirects.some(
      (hop) => hop.status === 303 || ((hop.status === 301 || hop.status === 302) && sentMethod === 'POST'),
    );
  if (stream !== undefined) {
    // A streamed response has an empty body and no text form of its own; the rows are the content.
    return {
      ...exchange,
      durationMs: exchange.timings.totalMs,
      text: '',
      language: 'text',
      cookies: parseSetCookie(exchange.rawHeaders),
      methodChanged,
      stream,
    };
  }
  const contentType = exchange.headers['content-type'];
  const language = detectLanguage(contentType, exchange.body);
  const decoded =
    language === 'image' || language === 'binary' ? { text: '' } : decodeResponseText(exchange.body, contentType);
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

/** Finalizes the parser and builds the `RestEventStream`, when the response was accepted as one. */
function buildEventStream(exchange: HttpExchange, sse: SseState | undefined): RestEventStream | undefined {
  if (sse?.parser === undefined || exchange.streamEnd === undefined) return undefined;
  sse.parser.end();
  return {
    rows: sse.store.rows,
    counts: { ...sse.counts },
    lastEventId: sse.lastEventId,
    ...(sse.retryMs !== undefined ? { retryMs: sse.retryMs } : {}),
    endedBy: exchange.streamEnd.by,
    ...(exchange.streamEnd.error !== undefined ? { error: exchange.streamEnd.error } : {}),
    droppedRows: sse.store.droppedRows,
  };
}
