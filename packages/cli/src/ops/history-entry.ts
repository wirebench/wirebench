/**
 * A send as the desktop's History records it (R5): the same fields and the same redaction as the
 * desktop's `buildHistoryEntry` and `buildRestHistoryEntry`, and for a WebSocket session the very
 * builder the desktop uses, so the History panel shows an agent's send like its own. Tagged with
 * where it came from.
 */
import {
  buildWsHistoryEntry,
  generateHistoryId,
  redactHeaderPairs,
  redactHeaders,
  redactUrl,
  redactWsExchange,
  redactXml,
  wsEffectiveAuth,
} from '@wirebench/engine';
import type { HistoryEntry, HistoryHeader, SentExchange, WsExchange, WsHistoryMasks } from '@wirebench/engine';
import { cutText } from './cut.js';
import type { SendableItem } from './items.js';

/** How much of a body a History line keeps, as the desktop. */
export const MAX_STORED_CHARS = 256 * 1024;

/** A body as stored: masked, and cut with the desktop's marker when long. */
export function storedText(text: string, mask: (text: string) => string): string {
  const masked = mask(text);
  if (masked.length <= MAX_STORED_CHARS) {
    return masked;
  }
  const kept = cutText(masked, MAX_STORED_CHARS);
  return `${kept}\n… truncated, ${String(masked.length - kept.length)} more characters`;
}

/** The body of a reconstructed HTTP message: everything after the blank line. */
export function bodyOfRaw(raw: Uint8Array): string {
  const text = new TextDecoder().decode(raw);
  const at = text.indexOf('\r\n\r\n');
  return at === -1 ? '' : text.slice(at + 4);
}

function headerRows(headers: Readonly<Record<string, string>>, mask: (text: string) => string): HistoryHeader[] {
  return Object.entries(redactHeaders(headers, { show: false })).map(([name, value]) => ({ name, value: mask(value) }));
}

function headerPairs(
  pairs: readonly (readonly [string, string])[],
  mask: (text: string) => string,
): (readonly [string, string])[] {
  return redactHeaderPairs(pairs, { show: false }).map(([name, value]) => [name, mask(value)] as const);
}

export interface HistoryEntryInput {
  readonly item: SendableItem;
  readonly exchange: SentExchange;
  readonly projectId: string;
  readonly origin: 'cli' | 'mcp';
  readonly durationMs: number;
  /** Masks every secret value the send resolved. */
  readonly mask: (text: string) => string;
  /** The same over a base64 run of bytes: a binary WebSocket frame. */
  readonly maskBase64: (base64: string) => string;
}

type WsItem = Extract<SendableItem, { kind: 'websocket' }>;

/** The query parameter a WebSocket request's API key travels in, masked whatever it is called, as the desktop's. */
function wsKeyParams(item: WsItem): readonly string[] {
  const auth = wsEffectiveAuth(item);
  return auth.type === 'api-key' && auth.in === 'query' ? [auth.name] : [];
}

/** A WebSocket session redacted as History stores it, for the op's own result. */
export function redactedWsExchange(item: WsItem, exchange: WsExchange, masks: WsHistoryMasks): WsExchange {
  return redactWsExchange(exchange, masks, wsKeyParams(item));
}

export function historyEntryFor(input: HistoryEntryInput): HistoryEntry {
  const { item, exchange, mask } = input;
  if (exchange.kind === 'websocket' && item.kind === 'websocket') {
    // A run's session that got this far opened: one that never did fails the send.
    return buildWsHistoryEntry(
      input.projectId,
      {
        requestId: item.request.id,
        requestName: item.request.name,
        apiName: item.api.name,
        folderPath: item.chain.map((folder) => folder.name).join(' / '),
        exchange: exchange.ws,
        handshakeOpened: true,
        keyParams: wsKeyParams(item),
        tags: [input.origin],
      },
      { text: mask, base64: input.maskBase64 },
    );
  }
  const common = {
    id: generateHistoryId(),
    at: new Date().toISOString(),
    projectId: input.projectId,
    requestId: item.request.id,
    requestName: item.request.name,
    durationMs: input.durationMs,
    tags: [input.origin],
  };
  if (exchange.kind === 'soap' && item.kind === 'soap') {
    const { http } = exchange.soap;
    const fault = exchange.soap.response?.fault;
    const envelope = exchange.soap.response?.envelopeXml;
    return {
      ...common,
      kind: 'soap',
      interfaceName: item.iface.name,
      operationName: item.operation.name,
      endpoint: mask(redactUrl(http.request.url, { show: false })),
      soapVersion: item.request.soapVersion,
      ...(item.request.soapAction !== undefined ? { soapAction: item.request.soapAction } : {}),
      status: http.status,
      ok: http.status >= 200 && http.status < 300 && fault === undefined,
      ...(fault !== undefined ? { fault: { code: fault.code, reason: fault.reason } } : {}),
      request: {
        envelopeXml: storedText(redactXml(bodyOfRaw(http.rawRequest), { show: false }), mask),
        headers: headerRows(http.request.headers, mask),
      },
      response: {
        ...(envelope !== undefined ? { envelopeXml: storedText(redactXml(envelope, { show: false }), mask) } : {}),
        rawHeaders: headerPairs(http.rawHeaders, mask),
        status: http.status,
        statusText: http.statusText,
      },
      sizeBytes: http.rawResponse.byteLength,
    };
  }
  if (exchange.kind === 'rest' && item.kind === 'rest') {
    const { rest } = exchange;
    return {
      ...common,
      kind: 'rest',
      interfaceName: item.api.name,
      operationName: item.chain.map((folder) => folder.name).join(' / '),
      endpoint: mask(redactUrl(rest.request.url, { show: false })),
      method: rest.request.method,
      soapVersion: 'none',
      status: rest.status,
      // A 3xx that was not followed is a good answer, as the desktop counts it.
      ok: rest.status >= 200 && rest.status < 400,
      request: {
        // As the desktop: a body with no text form (form, multipart, binary) is stored as ''.
        envelopeXml: item.request.body.kind === 'raw' ? storedText(bodyOfRaw(rest.rawRequest), mask) : '',
        headers: headerRows(rest.request.headers, mask),
      },
      response: {
        envelopeXml: storedText(rest.text, mask),
        rawHeaders: headerPairs(rest.rawHeaders, mask),
        status: rest.status,
        statusText: rest.statusText,
      },
      sizeBytes: rest.rawResponse.byteLength,
    };
  }
  throw new Error(`a ${item.kind} request came back with a ${exchange.kind} exchange`);
}
