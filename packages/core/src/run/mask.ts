/**
 * Masking a run's results before they leave the host that ran them: the CLI's reporters and a
 * server's stored run history both go through these, so neither can be handed a secret value.
 */
import { redactRawHttp } from '../redact/index.js';
import type { RequestResult, RunResult } from './run.js';

type Mask = (text: string) => string;

/** Error details are free-form: every string inside them, at any depth, goes through the mask. */
export function maskDeep(value: unknown, mask: Mask): unknown {
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
  const { error, exchange, transfers, scriptLog, baseline } = result;
  return {
    ...result,
    ...(scriptLog !== undefined ? { scriptLog: scriptLog.map((line) => mask(line)) } : {}),
    // A secret transfer carries no value at all; this catches a plain one that happens to hold a credential.
    ...(transfers !== undefined
      ? {
          transfers: transfers.map((transfer) => ({
            ...transfer,
            ...(transfer.value !== undefined ? { value: mask(transfer.value) } : {}),
            ...(transfer.message !== undefined ? { message: mask(transfer.message) } : {}),
          })),
        }
      : {}),
    assertions: result.assertions.map((assertion) => ({
      ...assertion,
      label: mask(assertion.label),
      ...(assertion.expected !== undefined ? { expected: mask(assertion.expected) } : {}),
      ...(assertion.actual !== undefined ? { actual: mask(assertion.actual) } : {}),
      ...(assertion.message !== undefined ? { message: mask(assertion.message) } : {}),
    })),
    ...(baseline !== undefined
      ? {
          baseline: {
            ...baseline,
            // The parse note quotes a snippet of the body, so it is masked whether or not changes exist.
            ...(baseline.error !== undefined ? { error: mask(baseline.error) } : {}),
            ...(baseline.changes !== undefined
              ? {
                  changes: baseline.changes.map((change) => ({
                    ...change,
                    path: mask(change.path),
                    ...(change.expected !== undefined ? { expected: mask(change.expected) } : {}),
                    ...(change.actual !== undefined ? { actual: mask(change.actual) } : {}),
                  })),
                }
              : {}),
          },
        }
      : {}),
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
