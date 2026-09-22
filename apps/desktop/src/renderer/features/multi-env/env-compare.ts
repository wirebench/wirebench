/**
 * The compare tab's model, pure: one column per environment of a multi-environment send, and a
 * one-word verdict per environment against the baseline. Bodies are compared after the same
 * pretty-printing the HTTP Log's compare uses, so formatting noise is not a difference.
 */
import { base64ByteLength, decodeBase64Text } from '../../lib/format-size.js';
import { comparableBodies } from '../console/log-compare.js';
import type { EnvSendResult } from '../../../shared/wire-types.js';

export interface CompareColumn {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly outcome: 'ok' | 'error';
  readonly kind?: 'soap' | 'rest';
  /** The URL the send went to. */
  readonly url?: string;
  readonly status?: number;
  readonly statusText?: string;
  /** SOAP only: whether the response was a fault. */
  readonly fault?: boolean;
  readonly durationMs?: number;
  readonly sizeBytes?: number;
  /** The response body, pretty-printed when it is JSON or XML. */
  readonly body: string;
  readonly language: 'json' | 'xml' | 'plaintext';
  readonly headers: Readonly<Record<string, string>>;
  /** Why the send failed, for an `error` column. */
  readonly error?: string;
}

export type CompareVerdict = 'same' | 'body-differs' | 'status-differs' | 'failed';

/** The raw response body of an `ok` result. */
function rawBodyOf(result: Extract<EnvSendResult, { outcome: 'ok' }>): string {
  if (result.rest !== undefined) {
    return result.rest.text;
  }
  return result.soap?.response?.envelopeXml ?? decodeBase64Text(result.soap?.http.bodyBase64 ?? '') ?? '';
}

function httpOf(result: Extract<EnvSendResult, { outcome: 'ok' }>) {
  return result.rest?.http ?? result.soap?.http;
}

/** One column per result, in the order the results came back. */
export function toCompareColumns(results: readonly EnvSendResult[]): CompareColumn[] {
  return results.map((result): CompareColumn => {
    const base = { environmentId: result.environmentId, environmentName: result.environmentName };
    if (result.outcome === 'error') {
      return { ...base, outcome: 'error', body: '', language: 'plaintext', headers: {}, error: result.message };
    }
    const http = httpOf(result);
    const raw = rawBodyOf(result);
    // Pretty-printed against itself: `comparableBodies` only formats a pair of the same kind.
    const pretty = comparableBodies(raw, raw);
    return {
      ...base,
      outcome: 'ok',
      kind: result.kind,
      ...(result.rest !== undefined ? { url: result.rest.url } : http !== undefined ? { url: http.request.url } : {}),
      ...(http !== undefined
        ? { status: http.status, statusText: http.statusText, sizeBytes: base64ByteLength(http.bodyBase64) }
        : {}),
      ...(result.kind === 'soap' ? { fault: result.soap?.response?.fault !== undefined } : {}),
      ...(result.rest !== undefined
        ? { durationMs: result.rest.durationMs }
        : result.soap !== undefined
          ? { durationMs: result.soap.durationMs }
          : {}),
      body: pretty.left,
      language: pretty.language,
      headers: http?.headers ?? {},
    };
  });
}

/**
 * How `other` compares with `baseline`: `failed` when either side did not complete, then
 * `status-differs` (HTTP status, or a SOAP fault on one side only), then the bodies.
 */
export function summarise(baseline: EnvSendResult, other: EnvSendResult): CompareVerdict {
  if (baseline.outcome === 'error' || other.outcome === 'error') {
    return 'failed';
  }
  const left = httpOf(baseline);
  const right = httpOf(other);
  const faulted = (result: typeof baseline): boolean => result.soap?.response?.fault !== undefined;
  if (left?.status !== right?.status || faulted(baseline) !== faulted(other)) {
    return 'status-differs';
  }
  const bodies = comparableBodies(rawBodyOf(baseline), rawBodyOf(other));
  return bodies.left === bodies.right ? 'same' : 'body-differs';
}
