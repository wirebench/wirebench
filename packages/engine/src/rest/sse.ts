/**
 * An in-house parser for the `text/event-stream` format (the WHATWG event-stream rules), browser-safe
 * and dependency-free so it can be shared between the desktop send path and the renderer's own
 * decoding needs. Re-exported from `rest/browser.ts`, so this module must not import from `node:*`.
 *
 * A stream arrives as arbitrary byte chunks — a line, a field, even a single UTF-8 code point can be
 * split across chunk boundaries — and the parser has to produce the same rows regardless of how the
 * bytes were sliced. `createSseParser` does the incremental decode; `isEventStream` decides whether a
 * response should go through it at all; `eventStreamDocument` and `serializeEventStream` turn a row
 * list back into, respectively, the JSON document the Query view runs over and the event-stream text
 * used for HAR export.
 */

export type SseRow =
  | {
      readonly kind: 'event';
      readonly index: number;
      readonly at: number;
      readonly size: number;
      readonly event: string;
      readonly data: string;
      readonly id?: string;
      readonly lastEventId: string;
      readonly payloadTruncated?: true;
    }
  | {
      readonly kind: 'comment';
      readonly index: number;
      readonly at: number;
      readonly size: number;
      readonly text: string;
    }
  | { readonly kind: 'retry'; readonly index: number; readonly at: number; readonly size: number; readonly ms: number };

export interface SseParser {
  push(chunk: Uint8Array, at: number): void;
  end(): void;
}

const enc = new TextEncoder();

/** UTF-8 byte length of a row's lines, each counted with its trailing LF (spec decision 4). */
function lineSize(...lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + enc.encode(line).length + 1, 0);
}

export function createSseParser(onRow: (row: SseRow) => void): SseParser {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let carry = '';
  let sawText = false;
  let pendingCr = false;
  let index = 0;
  /** The arrival time of the last chunk pushed, which is when anything `end()` flushes arrived. */
  let lastAt = 0;

  let eventType = '';
  let dataLines: string[] = [];
  let eventId: string | undefined;
  let eventLines: string[] = [];
  let lastEventId = '';
  let hasData = false;

  function resetEvent(): void {
    eventType = '';
    dataLines = [];
    eventLines = [];
    eventId = undefined;
    hasData = false;
  }
  resetEvent();

  function handleField(line: string, at: number): void {
    if (line === '') {
      if (hasData) {
        const data = dataLines.join('\n');
        onRow({
          kind: 'event',
          index: index++,
          at,
          size: lineSize(...eventLines),
          event: eventType === '' ? 'message' : eventType,
          data,
          ...(eventId !== undefined ? { id: eventId } : {}),
          lastEventId,
        });
      }
      resetEvent();
      return;
    }
    if (line.startsWith(':')) {
      const text = line.slice(1);
      onRow({ kind: 'comment', index: index++, at, size: lineSize(line), text });
      return;
    }
    const colon = line.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    switch (field) {
      case 'event':
        eventType = value;
        eventLines.push(line);
        break;
      case 'data':
        dataLines.push(value);
        eventLines.push(line);
        hasData = true;
        break;
      case 'id':
        if (!value.includes('\u0000')) {
          eventId = value;
          lastEventId = value;
        }
        eventLines.push(line);
        break;
      case 'retry':
        if (/^[0-9]+$/.test(value)) {
          onRow({ kind: 'retry', index: index++, at, size: lineSize(line), ms: Number(value) });
        }
        break;
      default:
        // unknown field: not dispatched, but its bytes still belong to the event they arrived in
        eventLines.push(line);
        break;
    }
  }

  function consumeText(text: string, at: number): void {
    if (!sawText) {
      sawText = true;
      if (text.startsWith('\uFEFF')) text = text.slice(1);
    }
    let buf = carry + text;
    carry = '';
    if (pendingCr) {
      pendingCr = false;
      if (buf.startsWith('\n')) buf = buf.slice(1);
    }
    // Normalize CR/CRLF to LF, but hold back a trailing CR in case it's split from its LF: it already
    // ends the line it closes, so a synthetic LF stands in for it once split.
    let endsWithCr = false;
    if (buf.endsWith('\r')) {
      endsWithCr = true;
      buf = buf.slice(0, -1);
    }
    let normalized = buf.replace(/\r\n|\r/g, '\n');
    if (endsWithCr) {
      pendingCr = true;
      normalized += '\n';
    }
    const lines = normalized.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) handleField(line, at);
  }

  return {
    push(chunk: Uint8Array, at: number): void {
      lastAt = at;
      const text = decoder.decode(chunk, { stream: true });
      consumeText(text, at);
    },
    end(): void {
      const text = decoder.decode();
      if (text !== '') consumeText(text, lastAt);
      // An unterminated event at end of stream is discarded per spec.
    },
  };
}

export function isEventStream(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'text/event-stream';
}

export function eventStreamDocument(rows: readonly SseRow[]): string {
  const entries = rows
    .filter((row): row is Extract<SseRow, { kind: 'event' }> => row.kind === 'event')
    .map((row) => {
      let data: unknown = row.data;
      try {
        data = JSON.parse(row.data);
      } catch {
        data = row.data;
      }
      return {
        event: row.event,
        ...(row.id !== undefined ? { id: row.id } : {}),
        data,
        at: row.at,
      };
    });
  return JSON.stringify(entries);
}

export function serializeEventStream(rows: readonly SseRow[]): string {
  let out = '';
  for (const row of rows) {
    if (row.kind === 'comment') {
      out += `:${row.text}\n\n`;
    } else if (row.kind === 'retry') {
      out += `retry: ${row.ms}\n\n`;
    } else {
      if (row.event !== 'message') out += `event: ${row.event}\n`;
      if (row.id !== undefined) out += `id: ${row.id}\n`;
      const dataLines = row.data.split('\n');
      for (const line of dataLines) out += `data: ${line}\n`;
      out += '\n';
    }
  }
  return out;
}
