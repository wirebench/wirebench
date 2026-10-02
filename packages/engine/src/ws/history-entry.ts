/**
 * One WebSocket session as History records it, for every host that writes History: the desktop on
 * a session's close, the command line's `send`. Redaction is History's, whatever was shown live.
 */
import { generateHistoryId, historyWsOf } from '../project/history.js';
import type { HistoryEntry, HistoryHeader } from '../project/history.js';
import { redactHeaders, redactUrl } from '../redact/index.js';
import type { WsExchange } from './model.js';

/** What {@link buildWsHistoryEntry} needs to build one WebSocket entry. */
export interface WsHistoryInput {
  readonly requestId: string;
  readonly requestName: string;
  /** The API the request belongs to, in the interface name's slot. */
  readonly apiName: string;
  readonly folderPath: string;
  readonly exchange: WsExchange;
  /**
   * Whether the session's handshake actually opened. `ok` follows it rather than
   * `exchange.handshake.status === 101`: that status is optional (e.g. absent through a proxy
   * tunnel) and so cannot itself tell an opened session from a refused one.
   */
  readonly handshakeOpened: boolean;
  /** Query parameters an API key travels in, masked in the URL whatever they are called. */
  readonly keyParams?: readonly string[];
  /** Where the entry came from, or the run it belongs to: `cli`, `sequence:<id>`. */
  readonly tags?: readonly string[];
}

/** The secret values the host knows of, masked wherever no pattern rule looks. */
export interface WsHistoryMasks {
  /** Masks each value in a text: a header, the URL, a frame's text, a close reason. */
  readonly text: (text: string) => string;
  /** Masks each value's bytes in a base64 run: a binary frame's payload. */
  readonly base64: (base64: string) => string;
}

/**
 * A session as History stores it: the headers and the URL redacted by pattern with `show: false`
 * (an API key's own `keyParams` too), then masked; a frame's text, a binary payload's bytes and a
 * close reason masked the same way. `size` stays the size on the wire, though a masked payload's own
 * length can differ from it. A host that shows the session where History's rules apply (the command
 * line's `send` result) reads it from here too.
 */
export function redactWsExchange(
  exchange: WsExchange,
  masks: WsHistoryMasks,
  keyParams: readonly string[] = [],
): WsExchange {
  const url = (value: string): string => masks.text(redactUrl(value, { show: false, extraParams: keyParams }));
  const headers = (values: Readonly<Record<string, string>>): Record<string, string> => {
    const out = redactHeaders(values, { show: false });
    for (const [name, value] of Object.entries(out)) {
      out[name] = masks.text(value);
    }
    return out;
  };
  return {
    kind: 'websocket',
    url: url(exchange.url),
    handshake: {
      ...exchange.handshake,
      url: url(exchange.handshake.url),
      requestHeaders: headers(exchange.handshake.requestHeaders),
      ...(exchange.handshake.responseHeaders !== undefined
        ? { responseHeaders: headers(exchange.handshake.responseHeaders) }
        : {}),
    },
    frames: exchange.frames.map((frame) => ({
      ...frame,
      ...(frame.text !== undefined ? { text: masks.text(frame.text) } : {}),
      ...(frame.base64 !== undefined ? { base64: masks.base64(frame.base64) } : {}),
      ...(frame.close !== undefined
        ? { close: { code: frame.close.code, reason: masks.text(frame.close.reason) } }
        : {}),
    })),
    // `historyWsOf` copies the reason into the entry's `closeReason`.
    closed: { ...exchange.closed, reason: masks.text(exchange.closed.reason) },
    counts: exchange.counts,
    durationMs: exchange.durationMs,
  };
}

/**
 * Builds one redacted WebSocket `HistoryEntry` from a finished session, whether it closed cleanly or
 * the handshake never got past `error`/a non-101 status. The SOAP-shaped fields carry what they can,
 * as a gRPC entry's do: the API's name as the interface, the folder path as the operation, the
 * handshake's status as the status; `ws` is the multi-message record ADR-0007 left room for, capped
 * by {@link historyWsOf}'s own `capFrames`. Redacted by {@link redactWsExchange}.
 */
export function buildWsHistoryEntry(projectId: string, record: WsHistoryInput, masks: WsHistoryMasks): HistoryEntry {
  const { exchange } = record;
  const redacted = redactWsExchange(exchange, masks, record.keyParams);
  const ws = historyWsOf(redacted);
  const requestHeaders: HistoryHeader[] = Object.entries(redacted.handshake.requestHeaders).map(([name, value]) => ({
    name,
    value,
  }));
  return {
    id: generateHistoryId(),
    kind: 'websocket',
    at: new Date().toISOString(),
    projectId,
    requestId: record.requestId,
    requestName: record.requestName,
    interfaceName: record.apiName,
    operationName: record.folderPath,
    endpoint: ws.url,
    soapVersion: 'none',
    method: 'GET',
    ...(ws.status !== undefined ? { status: ws.status } : {}),
    durationMs: exchange.durationMs,
    ok: record.handshakeOpened && ws.closedBy !== 'error',
    request: { envelopeXml: '', headers: requestHeaders },
    ...(ws.status !== undefined
      ? {
          response: {
            rawHeaders: Object.entries(redacted.handshake.responseHeaders ?? {}),
            status: ws.status,
            statusText: exchange.handshake.statusText ?? '',
          },
        }
      : {}),
    ...(ws.error !== undefined ? { error: { code: 'ws-handshake-failed', message: ws.error } } : {}),
    ws,
    sizeBytes: exchange.counts.bytesSent + exchange.counts.bytesReceived,
    ...(record.tags !== undefined ? { tags: record.tags } : {}),
  };
}
