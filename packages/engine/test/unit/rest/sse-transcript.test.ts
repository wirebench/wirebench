import { describe, expect, it } from 'vitest';
import type { SseRow } from '../../../src/rest/sse.js';
import { SSE_HISTORY_LIMITS, capSseRows, createSseRowStore } from '../../../src/rest/sse-transcript.js';

const ev = (index: number, size = 10): SseRow => ({
  kind: 'event',
  index,
  at: index,
  size,
  event: 'message',
  data: 'x'.repeat(size),
  lastEventId: '',
});

describe('capSseRows', () => {
  it('keeps a short stream whole', () => {
    expect(capSseRows([ev(0)], SSE_HISTORY_LIMITS)).toEqual({ rows: [ev(0)], truncated: false, omittedRows: 0 });
  });
  it('keeps the first 400 and the last 100', () => {
    const r = capSseRows(
      Array.from({ length: 1000 }, (_, i) => ev(i)),
      SSE_HISTORY_LIMITS,
    );
    expect(r.rows).toHaveLength(500);
    expect(r.rows[400]?.index).toBe(900);
    expect(r).toMatchObject({ truncated: true, omittedRows: 500 });
  });
  it('past 1 MB an event keeps its row and loses its data', () => {
    const r = capSseRows([ev(0, 700_000), ev(1, 700_000), ev(2, 5)], SSE_HISTORY_LIMITS);
    expect(r.rows[1]).toMatchObject({ kind: 'event', size: 700_000, data: '', payloadTruncated: true });
    expect(r.rows[2]).toMatchObject({ data: 'xxxxx' });
  });
});

describe('createSseRowStore', () => {
  it('keeps the head and drops the oldest after it past the row limit', () => {
    const store = createSseRowStore({ rows: 500, bytes: 1e9 });
    for (let i = 0; i < 600; i++) store.add(ev(i));
    expect(store.rows).toHaveLength(500);
    expect(store.rows[399]?.index).toBe(399);
    expect(store.rows[400]?.index).toBe(500);
    expect(store.droppedRows).toBe(100);
  });
  it('drops by bytes too', () => {
    const store = createSseRowStore({ rows: 1e9, bytes: 4_500 });
    for (let i = 0; i < 1000; i++) store.add(ev(i));
    expect(store.droppedRows).toBeGreaterThan(0);
    expect(store.rows[0]?.index).toBe(0);
  });
});
