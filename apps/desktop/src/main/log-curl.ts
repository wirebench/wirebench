/**
 * cURL for one HTTP Log row: what was sent, not what the editor holds now. Shares `toCurl` with
 * `request.curl`; only the input differs — the logged request (raw request when the row has one).
 */
import { toCurl, wsToCommand, type CurlHeader } from '@wirebench/engine';
import type { LogEntryWire, RequestCurlResponse, WsHandshakeExchangeSummary } from '../shared/wire-types.js';
import { redactHeaders, redactStructuredBody, redactUrl, redactXml } from './redact.js';

const TRANSPORT_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);
const TRUNCATED_NOTE = 'The request body was truncated in the log and is not included.';
const GRPC_NOTE =
  'gRPC message bodies are binary-framed and are not included; use Copy as grpcurl from the request’s code panel.';

export interface LoggedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly bodyTruncated: boolean;
}

function parseRaw(base64: string): { headers: Record<string, string>; body: string } {
  const text = Buffer.from(base64, 'base64').toString('utf8');
  const split = text.search(/\r?\n\r?\n/);
  const head = split < 0 ? text : text.slice(0, split);
  const body = split < 0 ? '' : text.slice(split).replace(/^\r?\n\r?\n/, '');
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  return { headers, body };
}

function withoutTransport(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !TRANSPORT_HEADERS.has(name.toLowerCase())));
}

/** `true` for a WebSocket row: no `.http`, since the log holds the handshake, not an HTTP exchange. */
export function isWsExchange(entry: LogEntryWire): boolean {
  return entry.kind === 'exchange' && 'protocol' in entry.exchange && entry.exchange.protocol === 'websocket';
}

/** The request a row records: from its raw request when it has one (body included), else its summary. */
export function loggedRequestOf(entry: LogEntryWire): LoggedRequest {
  if (isWsExchange(entry)) {
    const exchange = (entry as Extract<LogEntryWire, { kind: 'exchange' }>).exchange as WsHandshakeExchangeSummary;
    return {
      method: exchange.method,
      url: exchange.url,
      headers: withoutTransport(exchange.requestHeaders),
      bodyTruncated: false,
    };
  }
  if (entry.kind === 'failure') {
    const { failure } = entry;
    const summary = failure.request;
    const rawBase64 = failure.rawRequestBase64;
    if (rawBase64 === undefined || rawBase64 === '') {
      return {
        method: summary.method,
        url: summary.url,
        headers: withoutTransport(summary.headers),
        bodyTruncated: false,
      };
    }
    const { headers, body } = parseRaw(rawBase64);
    return {
      method: summary.method,
      url: summary.url,
      headers: withoutTransport(headers),
      ...(body !== '' ? { body } : {}),
      bodyTruncated: false,
    };
  }
  const httpExchange = entry.exchange as Exclude<typeof entry.exchange, WsHandshakeExchangeSummary>;
  const summary = httpExchange.http.request;
  const rawBase64 = httpExchange.http.rawRequestBase64;
  const truncated = httpExchange.http.truncated;
  if (rawBase64 === undefined || rawBase64 === '') {
    return {
      method: summary.method,
      url: summary.url,
      headers: withoutTransport(summary.headers),
      bodyTruncated: truncated,
    };
  }
  const { headers, body } = parseRaw(rawBase64);
  return {
    method: summary.method,
    url: summary.url,
    headers: withoutTransport(headers),
    ...(body !== '' && !truncated ? { body } : {}),
    bodyTruncated: truncated,
  };
}

function contentTypeOf(headers: Readonly<Record<string, string>>): string | undefined {
  return Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
}

/**
 * The cURL command for a row. With `show` off — and always for a failure row, whose request was
 * redacted at emit — URL, headers and body are masked here, whatever the renderer handed over.
 */
export function curlForLogEntry(
  entry: LogEntryWire,
  options: { shell: 'posix' | 'powershell'; show: boolean },
): RequestCurlResponse {
  const show = options.show && entry.kind === 'exchange';
  const isWsFailure = entry.kind === 'failure' && entry.failure.protocol === 'websocket';
  if (isWsExchange(entry) || isWsFailure) {
    // A failure row's request is already redacted for good at emit (see `failed-exchange.ts`), so
    // `show` never applies to it, exactly as `toCurl`'s own generic path treats one.
    const wsExchange = entry.kind === 'exchange' ? (entry.exchange as WsHandshakeExchangeSummary) : undefined;
    const wsUrl =
      wsExchange !== undefined
        ? wsExchange.wsUrl
        : (entry as Extract<LogEntryWire, { kind: 'failure' }>).failure.request.url;
    const requestHeaders =
      wsExchange !== undefined
        ? wsExchange.requestHeaders
        : (entry as Extract<LogEntryWire, { kind: 'failure' }>).failure.request.headers;
    const headers = show ? requestHeaders : redactHeaders(withoutTransport(requestHeaders), { show: false });
    const command = wsToCommand(
      { url: show ? wsUrl : redactUrl(wsUrl, { show: false }), headers },
      { shell: options.shell },
    );
    return { command };
  }
  const logged = loggedRequestOf(entry);
  const isGrpc = entry.kind === 'exchange' ? 'statusName' in entry.exchange : entry.failure.protocol === 'grpc';
  const headers = show ? logged.headers : redactHeaders(logged.headers, { show: false });
  const contentType = contentTypeOf(logged.headers);
  const body =
    logged.body === undefined || isGrpc
      ? undefined
      : show
        ? logged.body
        : redactStructuredBody(redactXml(logged.body), contentType);
  const curlHeaders: CurlHeader[] = Object.entries(headers).map(([name, value]) => ({ name, value }));
  const acceptsEventStream = Object.entries(logged.headers).some(
    ([name, value]) => name.toLowerCase() === 'accept' && value.toLowerCase().includes('text/event-stream'),
  );
  const command = toCurl(
    {
      method: logged.method,
      url: show ? logged.url : redactUrl(logged.url, { show: false }),
      headers: curlHeaders,
      ...(body !== undefined ? { body: { kind: 'raw' as const, text: body } } : {}),
      ...(acceptsEventStream ? { noBuffer: true } : {}),
    },
    { shell: options.shell },
  );
  const notes = [...(logged.bodyTruncated ? [TRUNCATED_NOTE] : []), ...(isGrpc ? [GRPC_NOTE] : [])];
  return { command, ...(notes.length > 0 ? { notes } : {}) };
}
