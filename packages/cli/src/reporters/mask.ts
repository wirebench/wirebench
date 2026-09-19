import { redactRawHttp } from '@wirebench/engine';
import type { RequestResult, RunResult } from '@wirebench/engine';
import type { Reporter } from './types.js';

type Mask = (text: string) => string;

/** Error details are free-form: every string inside them, at any depth, goes through the mask. */
function maskDeep(value: unknown, mask: Mask): unknown {
  if (typeof value === 'string') {
    return mask(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskDeep(item, mask));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskDeep(item, mask)]));
  }
  return value;
}

/**
 * Every string a report can show, passed through `mask`. The raw exchange goes through the HTTP
 * log's pattern rules first, so a credential the run never handed out (one typed into a header)
 * is hidden as the app's log hides it.
 */
export function maskRequestResult(result: RequestResult, mask: Mask): RequestResult {
  const { error, exchange } = result;
  return {
    ...result,
    assertions: result.assertions.map((assertion) => ({
      ...assertion,
      label: mask(assertion.label),
      ...(assertion.expected !== undefined ? { expected: mask(assertion.expected) } : {}),
      ...(assertion.actual !== undefined ? { actual: mask(assertion.actual) } : {}),
      ...(assertion.message !== undefined ? { message: mask(assertion.message) } : {}),
    })),
    ...(error !== undefined
      ? {
          error: {
            code: error.code,
            message: mask(error.message),
            ...(error.details !== undefined
              ? { details: maskDeep(error.details, mask) as Readonly<Record<string, unknown>> }
              : {}),
          },
        }
      : {}),
    ...(exchange !== undefined
      ? {
          exchange: {
            request: mask(redactRawHttp(exchange.request, { show: false })),
            response: mask(redactRawHttp(exchange.response, { show: false })),
          },
        }
      : {}),
  };
}

export function maskRunResult(result: RunResult, mask: Mask): RunResult {
  return { ...result, requests: result.requests.map((request) => maskRequestResult(request, mask)) };
}

/** What a run hands its results to: the only way from a raw result to a reporter. */
export interface MaskedReporters {
  onRequestDone(raw: RequestResult): void;
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
    async onRunDone(raw) {
      const masked = maskRunResult({ ...raw, requests: raw.requests.map(prepare) }, maskNow());
      for (const reporter of held) {
        await reporter.onRunDone(masked);
      }
    },
  };
}
