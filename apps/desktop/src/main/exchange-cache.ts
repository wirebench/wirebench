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

import type { ResponseAttachment, SoapExchange } from '@wirebench/engine';
import type { ExchangeSummary, RestExchangeSummary } from '../shared/wire-types.js';

/** How many exchanges are retained; mirrors the renderer HTTP log's own cap. */
export const EXCHANGE_CACHE_CAP = 500;

/** One cached send: its unredacted summary, plus the response attachment bytes it arrived with. */
interface CachedExchange {
  readonly summary: ExchangeSummary;
  /**
   * The engine's `ResponseAttachment`s, bytes included. Held here rather than on the summary
   * because the summary is the wire shape — the renderer only ever sees the metadata list, and
   * asks `attachments.saveResponse`/`openResponse` to move the bytes by `sendId` + index.
   */
  readonly attachments: readonly ResponseAttachment[];
  /** The engine exchange behind the summary, when the send went through `EngineService.send`. */
  readonly engine?: CachedEngineExchange;
}

/**
 * The engine's own view of one send, kept so a later analysis (`wsi.checkExchange`) can work on
 * the wire bytes rather than on the wire *shape*: the `ExchangeSummary` is a projection built for
 * the renderer, and re-deriving an envelope from it would mean re-splitting an HTTP frame.
 */
export interface CachedEngineExchange {
  readonly exchange: SoapExchange;
  /** The saved request the send came from; absent for an ad-hoc or raw send. */
  readonly requestId?: string;
  /** The request envelope as sent — `SoapExchange` keeps the request only as raw bytes. */
  readonly requestEnvelopeXml?: string;
  /** The query parameter an API key travelled in, so a later re-render masks it as the send did. */
  readonly keyParams?: readonly string[];
}

/**
 * One cached REST send: its unredacted summary and the response body's bytes.
 *
 * The bytes are held for the same reason a SOAP send's attachments are — the renderer is shown text
 * and metadata, and asks for the bytes by `sendId` when it needs them (to render an image preview,
 * or to save the response to a file) — so a binary body never crosses the bridge as base64 twice.
 */
interface CachedRestExchange {
  readonly summary: RestExchangeSummary;
  readonly body: Uint8Array;
  /**
   * Rebuilds the summary redacted (or not) for the show-secrets flag as it stands. A REST summary
   * cannot be re-redacted from its unredacted copy alone — its URL is masked against the request's
   * own API-key parameter names — so the send that cached it leaves the projection behind instead.
   */
  readonly view?: (show: boolean) => RestExchangeSummary;
}

/** Keeps the last {@link EXCHANGE_CACHE_CAP} unredacted exchange summaries. */
export class ExchangeCache {
  private readonly entries = new Map<string, CachedExchange>();
  private readonly restEntries = new Map<string, CachedRestExchange>();
  private readonly cap: number;

  constructor(cap: number = EXCHANGE_CACHE_CAP) {
    this.cap = cap;
  }

  /** Stores (or replaces) the unredacted summary for `sendId`, evicting the oldest over cap. */
  put(
    sendId: string,
    summary: ExchangeSummary,
    attachments: readonly ResponseAttachment[] = [],
    engine?: CachedEngineExchange,
  ): void {
    this.entries.delete(sendId);
    this.entries.set(sendId, { summary, attachments, ...(engine !== undefined ? { engine } : {}) });
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.entries.delete(oldest.value);
    }
  }

  /** Stores (or replaces) the unredacted REST summary for `sendId`, evicting the oldest over cap. */
  putRest(
    sendId: string,
    summary: RestExchangeSummary,
    body: Uint8Array,
    view?: (show: boolean) => RestExchangeSummary,
  ): void {
    this.restEntries.delete(sendId);
    this.restEntries.set(sendId, view === undefined ? { summary, body } : { summary, body, view });
    while (this.restEntries.size > this.cap) {
      const oldest = this.restEntries.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.restEntries.delete(oldest.value);
    }
  }

  /** The unredacted REST summary for `sendId`, or `undefined` once it has been evicted. */
  getRest(sendId: string): RestExchangeSummary | undefined {
    return this.restEntries.get(sendId)?.summary;
  }

  /**
   * A REST exchange rendered for the show-secrets flag `show`. Undefined when it was cached without
   * a view: answering with the unredacted summary instead would be the one wrong answer.
   */
  getRestView(sendId: string, show: boolean): RestExchangeSummary | undefined {
    return this.restEntries.get(sendId)?.view?.(show);
  }

  /** A REST response's bytes, for an image preview or a save-to-file. */
  getRestBody(sendId: string): Uint8Array | undefined {
    return this.restEntries.get(sendId)?.body;
  }

  /** The unredacted summary for `sendId`, or `undefined` once it has been evicted. */
  get(sendId: string): ExchangeSummary | undefined {
    return this.entries.get(sendId)?.summary;
  }

  /** The engine exchange for `sendId`, or `undefined` once it has been evicted (or never stored). */
  getExchange(sendId: string): CachedEngineExchange | undefined {
    return this.entries.get(sendId)?.engine;
  }

  /** One response attachment's bytes and metadata, or `undefined` when the send or index is unknown. */
  getAttachment(sendId: string, index: number): ResponseAttachment | undefined {
    return this.entries.get(sendId)?.attachments[index];
  }

  /** How many exchanges are currently retained, of either protocol. */
  get size(): number {
    return this.entries.size + this.restEntries.size;
  }

  /** Drops every entry (used when a project closes, and by tests). */
  clear(): void {
    this.entries.clear();
    this.restEntries.clear();
  }
}
