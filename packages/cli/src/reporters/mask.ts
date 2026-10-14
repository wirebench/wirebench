import { maskRequestResult, maskRunResult } from '@wirebench/engine';
import type { CallbackWaiting, RequestResult, RunResult } from '@wirebench/engine';
import type { Reporter } from './types.js';

type Mask = (text: string) => string;

// The masking itself is the engine's, shared with a server that stores run history (#343).
export { maskDeep, maskRequestResult, maskRunResult } from '@wirebench/engine';

/** What a run hands its results to: the only way from a raw result to a reporter. */
export interface MaskedReporters {
  onRequestDone(raw: RequestResult): void;
  onCallbackWaiting(path: string, waiting: readonly CallbackWaiting[]): void;
  onRunDone(raw: RunResult): Promise<void>;
}

/**
 * Wraps the run's reporters so none of them can be handed a raw result: the reporters are closed
 * over here and never returned, and every result is masked on its way in. `maskNow` is asked
 * afresh each time because secrets are handed out as requests are prepared, not all up front.
 * `prepare` runs before the mask, for rewrites that must themselves be masked.
 */
export function createMaskedReporters(
  reporters: readonly Reporter[],
  maskNow: () => Mask,
  prepare: (raw: RequestResult) => RequestResult = (raw) => raw,
): MaskedReporters {
  const held = [...reporters];
  return {
    onRequestDone(raw) {
      const masked = maskRequestResult(prepare(raw), maskNow());
      for (const reporter of held) {
        reporter.onRequestDone?.(masked);
      }
    },
    onCallbackWaiting(path, waiting) {
      const mask = maskNow();
      const masked = waiting.map((one) => ({ ...one, label: mask(one.label), catchUrl: mask(one.catchUrl) }));
      for (const reporter of held) {
        reporter.onCallbackWaiting?.(mask(path), masked);
      }
    },
    async onRunDone(raw) {
      const masked = maskRunResult({ ...raw, requests: raw.requests.map(prepare) }, maskNow());
      for (const reporter of held) {
        await reporter.onRunDone(masked);
      }
    },
  };
}
