import { describe, expect, it } from 'vitest';
import {
  createSseParser,
  eventStreamDocument,
  isEventStream,
  serializeEventStream,
  type SseRow,
} from '../../../src/rest/sse.js';

const enc = new TextEncoder();
function parse(...chunks: (string | Uint8Array)[]): SseRow[] {
  const rows: SseRow[] = [];
  const parser = createSseParser((row) => rows.push(row));
  chunks.forEach((chunk, i) => parser.push(typeof chunk === 'string' ? enc.encode(chunk) : chunk, i));
  parser.end();
  return rows;
}
const events = (rows: SseRow[]) => rows.filter((r) => r.kind === 'event');

describe('createSseParser', () => {
  it('dispatches on a blank line with the default type', () => {
    expect(events(parse('data: hi\n\n'))).toMatchObject([{ event: 'message', data: 'hi', lastEventId: '' }]);
  });
  it('joins multi-line data with LF and drops the trailing one', () => {
    expect(events(parse('data: a\ndata:b\ndata\n\n'))[0]).toMatchObject({ data: 'a\nb\n' });
  });
  it('strips exactly one space after the colon', () => {
    expect(events(parse('data:  two\n\n'))[0]).toMatchObject({ data: ' two' });
  });
  it('reads event, id and carries the last id to later events', () => {
    const rows = events(parse('event: tick\nid: 7\ndata: 1\n\ndata: 2\n\n'));
    expect(rows[0]).toMatchObject({ event: 'tick', id: '7', lastEventId: '7' });
    expect(rows[1]).toMatchObject({ event: 'message', lastEventId: '7' });
    expect(rows[1]).not.toHaveProperty('id');
  });
  it('ignores an id containing NUL', () => {
    expect(events(parse('id: a\u0000b\ndata: x\n\n'))[0]).toMatchObject({ lastEventId: '' });
  });
  it('turns comments and digit-only retry into rows, ignoring a bad retry and unknown fields', () => {
    const rows = parse(': keep-alive\nretry: 3000\nretry: 3s\nfoo: bar\ndata: x\n\n');
    expect(rows.map((r) => r.kind)).toEqual(['comment', 'retry', 'event']);
    expect(rows[0]).toMatchObject({ text: ' keep-alive' });
    expect(rows[1]).toMatchObject({ ms: 3000 });
  });
  it('does not dispatch an empty data buffer, and resets the type', () => {
    expect(events(parse('event: a\n\ndata: x\n\n'))[0]).toMatchObject({ event: 'message' });
  });
  it('accepts CRLF, LF and CR line ends, and a CR split from its LF across chunks', () => {
    expect(events(parse('data: a\r\n\r\ndata: b\r\rdata: c\r', '\n\r\n'))).toMatchObject([
      { data: 'a' },
      { data: 'b' },
      { data: 'c' },
    ]);
  });
  it('strips one leading BOM only', () => {
    expect(events(parse('\uFEFFdata: x\n\n'))[0]).toMatchObject({ data: 'x' });
  });
  it('decodes a multi-byte character split across chunks', () => {
    const bytes = enc.encode('data: é\n\n');
    expect(events(parse(bytes.subarray(0, 7), bytes.subarray(7)))[0]).toMatchObject({ data: 'é' });
  });
  it('gives the same rows however the input is chunked', () => {
    const text = ': c\nevent: e\nid: 1\ndata: {"a":1}\n\nretry: 10\ndata: z\r\n\r\n';
    const dropAt = (row: SseRow) => {
      const { at, ...rest } = row;
      void at;
      return rest;
    };
    const whole = parse(text).map(dropAt);
    const bytewise = parse(...[...enc.encode(text)].map((b) => Uint8Array.of(b))).map(dropAt);
    expect(bytewise).toEqual(whole);
  });
  it('discards an unterminated event at the end', () => {
    expect(events(parse('data: never\n'))).toEqual([]);
  });
  it('counts every line an event was built from — event:, id: and data: — in its size', () => {
    const text = 'event: tick\nid: 7\ndata: 1\n\n';
    const lines = ['event: tick', 'id: 7', 'data: 1'];
    expect(events(parse(text))[0]).toMatchObject({
      size: lines.reduce((sum, line) => sum + enc.encode(line).length + 1, 0),
    });
  });
  it('counts a CRLF variant the same way, one byte per terminator', () => {
    const text = 'event: tick\r\nid: 7\r\ndata: 1\r\n\r\n';
    const lines = ['event: tick', 'id: 7', 'data: 1'];
    expect(events(parse(text))[0]).toMatchObject({
      size: lines.reduce((sum, line) => sum + enc.encode(line).length + 1, 0),
    });
  });
  it('keeps size split-invariant along with the rest of the row', () => {
    const text = 'event: tick\nid: 7\ndata: 1\n\n';
    const whole = events(parse(text))[0];
    const bytewise = events(parse(...[...enc.encode(text)].map((b) => Uint8Array.of(b))))[0];
    expect(bytewise?.size).toBe(whole?.size);
  });
  it('numbers rows contiguously and stamps the push time', () => {
    const rows = parse(': a\n', 'data: b\n\n');
    expect(rows.map((r) => [r.index, r.at])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});

describe('isEventStream', () => {
  it.each([
    ['text/event-stream', true],
    ['Text/Event-Stream; charset=utf-8', true],
    ['application/json', false],
    [undefined, false],
  ])('%s → %s', (type, expected) => expect(isEventStream(type)).toBe(expected));
});

describe('eventStreamDocument / serializeEventStream', () => {
  const rows = parse(': hi\nretry: 5\nevent: t\nid: 1\ndata: {"n":1}\n\ndata: plain\n\n');
  it('builds a JSON array of events only, data parsed when it is JSON', () => {
    expect(JSON.parse(eventStreamDocument(rows))).toEqual([
      { event: 't', id: '1', data: { n: 1 }, at: 0 },
      { event: 'message', data: 'plain', at: 0 },
    ]);
  });
  it('re-serialises every row in event-stream form', () => {
    expect(serializeEventStream(rows)).toBe(': hi\n\nretry: 5\n\nevent: t\nid: 1\ndata: {"n":1}\n\ndata: plain\n\n');
  });
});
