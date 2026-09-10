/**
 * A bounded, in-memory cache of the **unredacted** `ExchangeSummary` for every recent send,
 * keyed by `sendId`. It never leaves main: `exchanges.get` re-renders an entry through
 * `redact.ts` using the show-secrets flag as it stands *at that moment*, which is what makes
 * toggling the flag reveal (or re-hide) an exchange that was already logged — without the
 * renderer ever holding the unredacted bytes.
 *
 * Oldest entries are evicted first (insertion order, `Map` semantics), matching the renderer's
 * own HTTP-log cap so a log entry the user can still see is still resolvable here.
 */

import type { ExchangeSummary } from '../shared/wire-types.js';

/** How many exchanges are retained; mirrors the renderer HTTP log's own cap. */
export const EXCHANGE_CACHE_CAP = 500;

/** Keeps the last {@link EXCHANGE_CACHE_CAP} unredacted exchange summaries. */
export class ExchangeCache {
  private readonly entries = new Map<string, ExchangeSummary>();
  private readonly cap: number;

  constructor(cap: number = EXCHANGE_CACHE_CAP) {
    this.cap = cap;
  }

  /** Stores (or replaces) the unredacted summary for `sendId`, evicting the oldest over cap. */
  put(sendId: string, summary: ExchangeSummary): void {
    this.entries.delete(sendId);
    this.entries.set(sendId, summary);
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.entries.delete(oldest.value);
    }
  }

  /** The unredacted summary for `sendId`, or `undefined` once it has been evicted. */
  get(sendId: string): ExchangeSummary | undefined {
    return this.entries.get(sendId);
  }

  /** How many exchanges are currently retained. */
  get size(): number {
    return this.entries.size;
  }

  /** Drops every entry (used when a project closes, and by tests). */
  clear(): void {
    this.entries.clear();
  }
}
