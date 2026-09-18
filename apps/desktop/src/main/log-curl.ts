/**
 * cURL for one HTTP Log row: what was sent, not what the editor holds now. Shares `toCurl` with
 * `request.curl`; only the input differs — the logged request (raw request when the row has one).
 */
import { toCurl, type CurlHeader } from '@wirebench/engine';
import type { LogEntryWire, RequestCurlResponse } from '../shared/wire-types.js';
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

/** The request a row records: from its raw request when it has one (body included), else its summary. */
export function loggedRequestOf(entry: LogEntryWire): LoggedRequest {
  const summary = entry.kind === 'exchange' ? entry.exchange.http.request : entry.failure.request;
  const rawBase64 = entry.kind === 'exchange' ? entry.exchange.http.rawRequestBase64 : entry.failure.rawRequestBase64;
  const truncated = entry.kind === 'exchange' ? entry.exchange.http.truncated : false;
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
  const command = toCurl(
    {
      method: logged.method,
      url: show ? logged.url : redactUrl(logged.url, { show: false }),
      headers: curlHeaders,
      ...(body !== undefined ? { body: { kind: 'raw' as const, text: body } } : {}),
    },
    { shell: options.shell },
  );
  const notes = [...(logged.bodyTruncated ? [TRUNCATED_NOTE] : []), ...(isGrpc ? [GRPC_NOTE] : [])];
  return { command, ...(notes.length > 0 ? { notes } : {}) };
}
