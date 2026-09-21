/**
 * Caps on an SSE row list: the same head/tail/byte-budget shape as the WebSocket transcript's
 * `capFrames`, shared via `capByEnds`, plus an in-memory store for a live stream that keeps growing.
 */
import type { CapLimits } from '../ws/transcript.js';
import { capByEnds, WS_HISTORY_HEAD, WS_HISTORY_MAX_BYTES, WS_HISTORY_TAIL } from '../ws/transcript.js';
import type { SseRow } from './sse.js';

export const SSE_MEMORY_ROWS = 10_000;
export const SSE_MEMORY_BYTES = 33_554_432;

export const SSE_SUMMARY_LIMITS: CapLimits = { head: 400, tail: 4_600, maxBytes: SSE_MEMORY_BYTES };
export const SSE_HISTORY_LIMITS: CapLimits = {
  head: WS_HISTORY_HEAD,
  tail: WS_HISTORY_TAIL,
  maxBytes: WS_HISTORY_MAX_BYTES,
};

export interface SseTranscript {
  readonly rows: readonly SseRow[];
  readonly truncated: boolean;
  readonly omittedRows: number;
}

function stripRow(row: SseRow): SseRow | undefined {
  if (row.kind !== 'event') return undefined; // comment/retry rows keep their (small) text
  return { ...row, data: '', payloadTruncated: true };
}

export function capSseRows(rows: readonly SseRow[], limits: CapLimits): SseTranscript {
  const r = capByEnds(rows, limits, (row) => row.size, stripRow);
  return { rows: r.items, truncated: r.truncated, omittedRows: r.omitted };
}

export interface SseRowStore {
  add(row: SseRow): void;
  readonly rows: readonly SseRow[];
  readonly droppedRows: number;
}

const HEAD_CAP = 400;

/**
 * A FIFO queue backed by a circular array, so pushing and evicting the oldest element are both O(1)
 * (amortized for push, which occasionally doubles the backing array — never an O(n) shift). Used for
 * the store's tail, which can hold thousands of rows on a long-running stream.
 */
class RingBuffer<T> {
  private buf: (T | undefined)[] = new Array<T | undefined>(8).fill(undefined);
  private start = 0;
  private len = 0;

  get length(): number {
    return this.len;
  }

  push(item: T): void {
    if (this.len === this.buf.length) this.grow();
    this.buf[(this.start + this.len) % this.buf.length] = item;
    this.len++;
  }

  evictFront(): T | undefined {
    if (this.len === 0) return undefined;
    const item = this.buf[this.start];
    this.buf[this.start] = undefined;
    this.start = (this.start + 1) % this.buf.length;
    this.len--;
    return item;
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.len; i++) out.push(this.buf[(this.start + i) % this.buf.length] as T);
    return out;
  }

  private grow(): void {
    const next: (T | undefined)[] = new Array<T | undefined>(this.buf.length * 2).fill(undefined);
    for (let i = 0; i < this.len; i++) next[i] = this.buf[(this.start + i) % this.buf.length];
    this.buf = next;
    this.start = 0;
  }
}

export function createSseRowStore(
  limits: { rows: number; bytes: number } = { rows: SSE_MEMORY_ROWS, bytes: SSE_MEMORY_BYTES },
): SseRowStore {
  const head: SseRow[] = [];
  const tail = new RingBuffer<SseRow>();
  let headBytes = 0;
  let tailBytes = 0;
  let droppedRows = 0;
  const headCap = Math.min(HEAD_CAP, limits.rows);

  return {
    add(row: SseRow): void {
      if (head.length < headCap) {
        // The head is never evicted: a byte budget smaller than the head's own bytes leaves the
        // store permanently over budget rather than losing head rows (see the test that pins this).
        head.push(row);
        headBytes += row.size;
      } else {
        tail.push(row);
        tailBytes += row.size;
      }
      while (tail.length > 0 && (head.length + tail.length > limits.rows || headBytes + tailBytes > limits.bytes)) {
        const dropped = tail.evictFront();
        if (dropped === undefined) break;
        tailBytes -= dropped.size;
        droppedRows++;
      }
    },
    get rows(): readonly SseRow[] {
      return [...head, ...tail.toArray()];
    },
    get droppedRows(): number {
      return droppedRows;
    },
  };
}
