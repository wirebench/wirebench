import { describe, expect, it } from 'vitest';
import { CatchBuckets, IDLE_DROP_MS, SWEEP_EVERY_MS } from '../../../src/hooks/rate-limit.js';

function clock(start = 0) {
  let now = start;
  return {
    now: (): number => now,
    advance: (ms: number): void => {
      now += ms;
    },
  };
}

describe('CatchBuckets (webhook-capture §3.3 step 3)', () => {
  it('allows a full burst at once, then refuses without spending', () => {
    const c = clock();
    const buckets = new CatchBuckets({ ratePerSecond: 1, burst: 3, now: c.now });
    expect([buckets.take('a'), buckets.take('a'), buckets.take('a')]).toEqual([true, true, true]);
    expect(buckets.take('a')).toBe(false);
    expect(buckets.take('a')).toBe(false);
    expect(buckets.take('b')).toBe(true); // one bucket per catch URL
  });

  it('refills at the configured rate, never above the burst', () => {
    const c = clock();
    const buckets = new CatchBuckets({ ratePerSecond: 10, burst: 2, now: c.now });
    expect([buckets.take('a'), buckets.take('a'), buckets.take('a')]).toEqual([true, true, false]);
    c.advance(99);
    expect(buckets.take('a')).toBe(false);
    c.advance(1); // 100 ms at 10/s is one token
    expect(buckets.take('a')).toBe(true);
    expect(buckets.take('a')).toBe(false);
    c.advance(60_000); // a minute idle refills to the burst, not to 600
    expect([buckets.take('a'), buckets.take('a'), buckets.take('a')]).toEqual([true, true, false]);
  });

  it('drops a bucket once it has been full for ten minutes, checked at most once a minute', () => {
    const c = clock();
    const buckets = new CatchBuckets({ ratePerSecond: 1, burst: 1, now: c.now });
    buckets.take('a'); // empty now; full again at 1 000 ms
    expect(buckets.size).toBe(1);
    c.advance(1_000 + IDLE_DROP_MS - 1);
    buckets.take('b'); // a has been full for 1 ms short of ten minutes: kept
    expect(buckets.size).toBe(2);
    c.advance(SWEEP_EVERY_MS - 1);
    buckets.take('c'); // past ten minutes, but the last look was under a minute ago
    expect(buckets.size).toBe(3);
    c.advance(1);
    buckets.take('c'); // a minute since the last look: a goes, b and c are recent
    expect(buckets.size).toBe(2);
    // A dropped bucket comes back full, so dropping it never gives a sender less than the burst.
    expect(buckets.take('a')).toBe(true);
  });

  it('never drops a bucket that is still refilling', () => {
    const c = clock();
    const buckets = new CatchBuckets({ ratePerSecond: 1, burst: 10_000, now: c.now });
    for (let i = 0; i < 10_000; i += 1) buckets.take('a');
    c.advance(IDLE_DROP_MS + SWEEP_EVERY_MS); // 660 tokens back of 10 000
    buckets.take('b');
    expect(buckets.size).toBe(2);
  });
});
