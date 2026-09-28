/**
 * One in-memory token bucket per catch URL (webhook-capture spec §3.3 step 3): `ratePerSecond`
 * tokens a second, up to `burst`. Like the live hub, it is per process: the server runs as a single
 * instance (ADR-0013). A bucket that has been full for ten minutes is dropped, so a server with many
 * quiet catch URLs holds nothing for them; a dropped bucket comes back full, which is what it was.
 */

/** A bucket full for this long is dropped. */
export const IDLE_DROP_MS = 10 * 60 * 1000;
/** How often `take` looks for such buckets, so the look costs nothing per request. */
export const SWEEP_EVERY_MS = 60 * 1000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class CatchBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perMs: number;
  private readonly burst: number;
  private readonly now: () => number;
  private lastSweep = Number.NEGATIVE_INFINITY;

  constructor(options: { readonly ratePerSecond: number; readonly burst: number; readonly now: () => number }) {
    this.perMs = options.ratePerSecond / 1000;
    this.burst = options.burst;
    this.now = options.now;
  }

  /** Buckets held; tests read it to see the idle drop. */
  get size(): number {
    return this.buckets.size;
  }

  /** Spends one token of `key`'s bucket. `false` when it is empty; nothing is spent then. */
  take(key: string): boolean {
    const now = this.now();
    this.sweep(now);
    const bucket = this.buckets.get(key);
    const tokens =
      bucket === undefined
        ? this.burst
        : Math.min(this.burst, bucket.tokens + Math.max(0, now - bucket.updatedAt) * this.perMs);
    // A refusal changes nothing: the bucket keeps refilling from its last spend, so the arithmetic
    // never accumulates rounding from repeated refusals.
    if (tokens < 1) return false;
    this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return true;
  }

  /** The moment `bucket` reached the burst again, refilling from its last update. */
  private fullSince(bucket: Bucket): number {
    return bucket.updatedAt + (this.burst - bucket.tokens) / this.perMs;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (now - this.fullSince(bucket) >= IDLE_DROP_MS) this.buckets.delete(key);
    }
  }
}
