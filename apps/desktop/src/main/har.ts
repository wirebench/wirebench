/**
 * HAR 1.2 from HTTP Log rows. Everything written here is redacted with `show: false` — headers,
 * URL parameters, WS-Security passwords and JSON/form secrets — whatever the show-secrets toggle
 * says: a HAR file is made to be shared.
 */
import { serializeEventStream } from '@wirebench/engine';
import type { SseRow } from '@wirebench/engine';
import type {
  LogEntryWire,
  RestExchangeSummary,
  SseRowWire,
  WsHandshakeExchangeSummary,
} from '../shared/wire-types.js';
import { keyNamesOf, loggedRequestOf } from './log-curl.js';
import { redactHeaderPairs, redactStructuredBody, redactUrl, redactXml } from './redact.js';

export interface HarCreator {
  readonly name: 'Wirebench';
  readonly version: string;
}

export interface HarNameValue {
  readonly name: string;
  readonly value: string;
}

export interface HarRequest {
  readonly method: string;
  readonly url: string;
  readonly httpVersion: string;
  readonly cookies: readonly never[];
  readonly headers: readonly HarNameValue[];
  readonly queryString: readonly HarNameValue[];
  readonly postData?: { readonly mimeType: string; readonly text: string };
  readonly headersSize: -1;
  readonly bodySize: number;
}

export interface HarContent {
  readonly size: number;
  readonly mimeType: string;
  readonly text?: string;
  readonly encoding?: 'base64';
}

export interface HarResponse {
  readonly status: number;
  readonly statusText: string;
  readonly httpVersion: string;
  readonly cookies: readonly never[];
  readonly headers: readonly HarNameValue[];
  readonly content: HarContent;
  readonly redirectURL: string;
  readonly headersSize: -1;
  readonly bodySize: number;
}

export interface HarTimings {
  readonly blocked: -1;
  readonly dns: -1;
  readonly connect: number;
  readonly ssl: number;
  readonly send: number;
  readonly wait: number;
  readonly receive: number;
}

export interface HarEntry {
  readonly startedDateTime: string;
  readonly time: number;
  readonly request: HarRequest;
  readonly response: HarResponse;
  readonly cache: Record<string, never>;
  readonly timings: HarTimings;
  readonly _error?: { readonly code: string; readonly message: string; readonly stage: 'prepare' | 'send' };
  readonly _truncated?: true;
  /** Set only for a WebSocket row: the `GET`/`101` pair that opened the session. */
  readonly _resourceType?: 'websocket';
  /** Set only for a REST row whose event stream was capped before this summary was built. */
  readonly _sseTruncated?: true;
  /** How many event-stream rows are missing from `response.content.text`, when `_sseTruncated`. */
  readonly _sseOmittedRows?: number;
}

export interface Har {
  readonly log: { readonly version: '1.2'; readonly creator: HarCreator; readonly entries: readonly HarEntry[] };
}

/** Headers whose value is a URL, so a secret query parameter can ride in them. */
const URL_HEADERS = new Set(['location', 'content-location', 'referer']);

/**
 * Sensitive headers masked, and a URL-valued header's secret parameters masked too. `keyNames` are
 * the names the row's API key travelled under, masked in a header and in a URL-valued header alike.
 */
function harHeaders(
  pairs: readonly (readonly [string, string])[],
  keyNames: { readonly params: readonly string[]; readonly headers: readonly string[] } = { params: [], headers: [] },
): HarNameValue[] {
  return redactHeaderPairs(pairs, { show: false, extraHeaders: keyNames.headers }).map(([name, value]) => ({
    name,
    value: URL_HEADERS.has(name.toLowerCase())
      ? redactUrl(value, { show: false, extraParams: keyNames.params })
      : value,
  }));
}

const TEXT_TYPE = /^text\/|json|xml|javascript|x-www-form-urlencoded/i;

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

/** Both body passes, always masked: WS-Security elements, then JSON/form secret keys. */
function redactBody(text: string, contentType: string | undefined): string {
  return redactStructuredBody(redactXml(text, { show: false }), contentType, { show: false });
}

/**
 * An event stream's rows, each event's `data` masked exactly as any other REST response body is
 * masked in HAR: structured (secret JSON keys) when it parses as JSON, otherwise left alone. Same
 * `exactOptionalPropertyTypes` gap `historySseOf`'s own cast papers over: the wire's
 * `id?: string | undefined` vs. the engine's plain `id?: string`.
 */
function redactedSseRows(rows: readonly SseRowWire[]): readonly SseRow[] {
  return rows.map(
    (row) => (row.kind === 'event' ? { ...row, data: redactBody(row.data, 'application/json') } : row) as SseRow,
  );
}

function queryStringOf(url: string): HarNameValue[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function harVersion(version: '1.1' | '2'): string {
  return version === '2' ? 'HTTP/2' : 'HTTP/1.1';
}

function requestOf(entry: LogEntryWire, httpVersion: string, isGrpc: boolean): HarRequest {
  const logged = loggedRequestOf(entry);
  const keyNames = keyNamesOf(entry);
  const url = redactUrl(logged.url, { show: false, extraParams: keyNames.params });
  const contentType = headerValue(logged.headers, 'content-type');
  const headers = harHeaders(Object.entries(logged.headers), keyNames);
  // gRPC bodies are binary-framed: no text to give, as with the cURL export.
  const body = isGrpc ? undefined : logged.body;
  return {
    method: logged.method,
    url,
    httpVersion,
    cookies: [],
    headers,
    queryString: queryStringOf(url),
    ...(body !== undefined
      ? { postData: { mimeType: contentType ?? 'application/octet-stream', text: redactBody(body, contentType) } }
      : {}),
    headersSize: -1,
    bodySize: logged.bodyTruncated ? -1 : Buffer.byteLength(logged.body ?? '', 'utf8'),
  };
}

/**
 * A WebSocket row's HAR entry: the handshake as an ordinary `GET`/`101` pair, `_resourceType:
 * 'websocket'` so a reader knows it opened a session — never `_webSocketMessages`; the log holds
 * only the handshake, History the frames.
 */
function wsExchangeEntry(entry: Extract<LogEntryWire, { kind: 'exchange' }>): HarEntry {
  const exchange = entry.exchange as WsHandshakeExchangeSummary;
  const httpVersion = 'HTTP/1.1';
  return {
    startedDateTime: exchange.startedAt,
    time: exchange.durationMs,
    request: requestOf(entry, httpVersion, false),
    response: {
      status: exchange.status,
      statusText: '',
      httpVersion,
      cookies: [],
      headers: harHeaders(Object.entries(exchange.responseHeaders)),
      content: { size: 0, mimeType: 'x-unknown' },
      redirectURL: '',
      headersSize: -1,
      bodySize: 0,
    },
    cache: {},
    timings: {
      blocked: -1,
      dns: -1,
      connect: -1,
      ssl: exchange.tls !== undefined ? exchange.durationMs : -1,
      send: 0,
      wait: exchange.durationMs,
      receive: 0,
    },
    _resourceType: 'websocket',
  };
}

function exchangeEntry(entry: Extract<LogEntryWire, { kind: 'exchange' }>): HarEntry {
  if ('protocol' in entry.exchange && entry.exchange.protocol === 'websocket') {
    return wsExchangeEntry(entry);
  }
  const exchange = entry.exchange as Exclude<typeof entry.exchange, WsHandshakeExchangeSummary>;
  const { http } = exchange;
  const isGrpc = 'statusName' in exchange;
  const stream = !isGrpc ? (exchange as RestExchangeSummary).stream : undefined;
  const httpVersion = harVersion(http.httpVersion);
  const bytes = Buffer.from(http.bodyBase64, 'base64');
  const mimeType = headerValue(http.headers, 'content-type') ?? 'x-unknown';
  const textual = !isGrpc && TEXT_TYPE.test(mimeType);
  const content: HarContent =
    stream !== undefined
      ? {
          size: bytes.length,
          mimeType: 'text/event-stream',
          text: serializeEventStream(redactedSseRows(stream.rows)),
        }
      : http.truncated
        ? { size: bytes.length, mimeType }
        : textual
          ? { size: bytes.length, mimeType, text: redactBody(bytes.toString('utf8'), mimeType) }
          : bytes.length === 0
            ? { size: 0, mimeType }
            : { size: bytes.length, mimeType, text: http.bodyBase64, encoding: 'base64' };
  const location = headerValue(http.headers, 'location');
  const { timings } = http;
  return {
    startedDateTime: timings.startedAt,
    time: exchange.durationMs,
    request: requestOf(entry, httpVersion, isGrpc),
    response: {
      status: http.status,
      statusText: http.statusText,
      httpVersion,
      cookies: [],
      headers: harHeaders(http.rawHeaders),
      content,
      redirectURL: location === undefined ? '' : redactUrl(location, { show: false }),
      headersSize: -1,
      bodySize: http.truncated ? -1 : Buffer.from(http.rawBodyBase64, 'base64').length,
    },
    cache: {},
    // The engine measures TLS from the same start as connect, which is what HAR asks for
    // (`ssl` included in `connect`), so both are written as measured.
    timings: {
      blocked: -1,
      dns: -1,
      connect: timings.connectMs ?? -1,
      ssl: timings.tlsMs ?? -1,
      send: 0,
      wait: timings.ttfbMs ?? exchange.durationMs,
      receive: timings.downloadMs ?? 0,
    },
    ...(http.truncated ? { _truncated: true as const } : {}),
    ...sseTruncationOf(stream),
  };
}

/**
 * `_sseTruncated`/`_sseOmittedRows`, when a stream is missing rows for any reason: the summary's
 * own cap (`stream.truncated`) or rows the live in-memory store had already evicted before the
 * summary was built (`stream.droppedRows`) — the same "either can make it incomplete" rule
 * `historySseOf` applies to `HistorySse.truncated`.
 */
function sseTruncationOf(stream: RestExchangeSummary['stream']): Pick<HarEntry, '_sseTruncated' | '_sseOmittedRows'> {
  if (stream === undefined) {
    return {};
  }
  const omittedRows = stream.droppedRows + stream.omittedRows;
  if (!stream.truncated && omittedRows === 0) {
    return {};
  }
  return { _sseTruncated: true, ...(omittedRows > 0 ? { _sseOmittedRows: omittedRows } : {}) };
}

function failureEntry(entry: Extract<LogEntryWire, { kind: 'failure' }>): HarEntry {
  const { failure } = entry;
  return {
    startedDateTime: failure.startedAt,
    time: failure.durationMs,
    request: requestOf(entry, 'HTTP/1.1', failure.protocol === 'grpc'),
    response: {
      status: 0,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      content: { size: 0, mimeType: 'x-unknown' },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: failure.durationMs, receive: 0 },
    _error: { code: failure.error.code, message: failure.error.message, stage: failure.stage ?? 'send' },
  };
}

/** The HAR 1.2 document for `entries`, in the order given. */
export function harOf(entries: readonly LogEntryWire[], creator: HarCreator): Har {
  return {
    log: {
      version: '1.2',
      creator: { name: creator.name, version: creator.version },
      entries: entries.map((entry) => (entry.kind === 'exchange' ? exchangeEntry(entry) : failureEntry(entry))),
    },
  };
}

/** `wirebench-yyyyMMdd-HHmmss.har`, in local time. */
export function harFileName(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `wirebench-${date}-${time}.har`;
}
