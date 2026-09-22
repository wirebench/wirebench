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
  it('stays over budget forever when the protected head alone exceeds it', () => {
    // Documented tradeoff: the head is never evicted, so a byte budget smaller than the head's own
    // bytes cannot be honored — the store simply stays over budget rather than losing head rows.
    const store = createSseRowStore({ rows: 500, bytes: 1 });
    for (let i = 0; i < 10; i++) store.add(ev(i));
    expect(store.rows).toHaveLength(10);
    expect(store.droppedRows).toBe(0);
  });
  it('evicts in constant time at scale: 50000 adds past a small head, default row limit', () => {
    const store = createSseRowStore();
    const total = 50_000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < total; i++) store.add(ev(i));
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(elapsedMs).toBeLessThan(1000); // no timing assertion beyond a generous sanity bound

    const headCap = 400;
    const tailCap = 10_000 - headCap;
    expect(store.rows).toHaveLength(10_000);
    expect(store.rows[0]?.index).toBe(0);
    expect(store.rows[headCap - 1]?.index).toBe(headCap - 1);
    expect(store.rows[headCap]?.index).toBe(total - tailCap);
    expect(store.rows.at(-1)?.index).toBe(total - 1);
    expect(store.droppedRows).toBe(total - 10_000);
  });
});
