/**
 * One send, whoever sends it (spec §3.2): the desktop, a run, a sequence step. A protocol's run facet
 * builds its handle with `exchangeController`; `openExchange` (run/open.ts) hands an item to its
 * facet. Core code: it names no protocol.
 */
import { WirebenchError } from '../errors.js';
import type { RunScope, ScriptedSend } from '../protocol/module.js';
import { EventQueue } from './event-queue.js';
import type { SentRequest } from './run.js';

export interface LiveEventBase {
  readonly protocol: string;
  readonly kind: string;
}

/** A message pushed on an open exchange: text (expanded when `expand`), or binary as base64. */
export type PushMessage = { readonly text: string; readonly expand?: boolean } | { readonly base64: string };

export interface ExchangeOptions {
  readonly scope: RunScope;
  readonly scripts?: ScriptedSend;
  /** The host drives push, halfClose and close; otherwise the saved messages are sent (spec §5.2). */
  readonly interactive: boolean;
  /** True when the caller reads `events`. By default nothing is buffered. */
  readonly live?: boolean;
}

export interface StreamingSide {
  /** Resolves with what was sent: a gRPC message's canonical JSON, a WebSocket frame. */
  push(message: PushMessage): Promise<unknown>;
  halfClose(): void;
  close(code?: number, reason?: string): void;
}

export interface ExchangeHandle<E extends LiveEventBase = LiveEventBase> extends StreamingSide {
  readonly events: AsyncIterable<E>;
  /** Aborts this send only. False when it has already settled or been cancelled. */
  cancel(): boolean;
  /** Rejects with the send's error; `events` has ended by then. */
  readonly result: Promise<SentRequest>;
}

export interface ExchangeController<E extends LiveEventBase> {
  /** This exchange's own signal, which also follows the run's. */
  readonly signal: AbortSignal;
  readonly queue: EventQueue<E>;
  /** The handle: its result is `run`'s, and its events end when `run` settles. */
  handle(run: () => Promise<SentRequest>, streaming?: StreamingSide): ExchangeHandle<E>;
}

/** The refusal of a push, half-close or close on an exchange that takes no messages. */
export function notStreaming(kind: string): WirebenchError {
  return new WirebenchError('exchange-not-streaming', `This ${kind} request takes no messages once it is sent`, {
    details: { protocol: kind },
  });
}

export function exchangeController<E extends LiveEventBase>(
  kind: string,
  options: ExchangeOptions,
): ExchangeController<E> {
  const abort = new AbortController();
  const outer = options.scope.context.signal;
  const follow = (): void => abort.abort(outer?.reason);
  if (outer !== undefined) {
    if (outer.aborted) abort.abort(outer.reason);
    else outer.addEventListener('abort', follow, { once: true });
  }
  const queue = new EventQueue<E>(options.live === true);
  let settled = false;
  return {
    signal: abort.signal,
    queue,
    handle(run, streaming) {
      const result = (async () => {
        try {
          return await run();
        } finally {
          settled = true;
          outer?.removeEventListener('abort', follow);
          queue.end();
        }
      })();
      // Observed here, so a rejection nobody awaits yet is never reported as unhandled.
      result.catch(() => undefined);
      return {
        events: queue,
        result,
        push: (message) => (streaming !== undefined ? streaming.push(message) : Promise.reject(notStreaming(kind))),
        halfClose: () => {
          if (streaming === undefined) throw notStreaming(kind);
          streaming.halfClose();
        },
        close: (code, reason) => {
          if (streaming === undefined) throw notStreaming(kind);
          streaming.close(code, reason);
        },
        cancel: () => {
          if (settled || abort.signal.aborted) return false;
          abort.abort();
          return true;
        },
      };
    },
  };
}
