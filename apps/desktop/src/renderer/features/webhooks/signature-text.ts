/**
 * Signature words and rules for the renderer (webhook-signatures §2, §4), restated because the
 * renderer imports no engine values (Global Constraints). `signature-text.test.ts` pins them to
 * the engine's.
 */
import type { CaptureSignatureWire, SignatureFailureWire, SignatureSchemeWire } from '../../../shared/wire-types.js';

export type SchemeKind = SignatureSchemeWire['kind'];

export const SCHEME_KINDS: readonly SchemeKind[] = ['hmac', 'timestamped', 'standard'];

export const SCHEME_LABELS: Readonly<Record<SchemeKind, string>> = {
  hmac: 'HMAC of body',
  timestamped: 'Timestamped HMAC',
  standard: 'Standard Webhooks',
};

/** In the engine's `SIGNATURE_FAILURES` order. */
export const REASON_TEXT: Readonly<Record<SignatureFailureWire, string>> = {
  'missing-header': 'missing header',
  'malformed-header': 'malformed header',
  mismatch: 'digest mismatch',
  'stale-timestamp': 'timestamp outside tolerance',
  'key-error': 'server key error',
};

export const SIGNATURE_LIMITS = {
  maxSecretLength: 512,
  maxHeaderLength: 100,
  maxPrefixLength: 32,
  minToleranceSec: 1,
  maxToleranceSec: 86_400,
  defaultToleranceSec: 300,
} as const;

/** An HTTP field name (RFC 9110 `token`), as the engine checks it. */
export const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** A prefix: visible ASCII, no spaces. */
export const PREFIX_PATTERN = /^[\x21-\x7e]*$/;

export function defaultScheme(kind: SchemeKind): SignatureSchemeWire {
  switch (kind) {
    case 'hmac':
      return { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' };
    case 'timestamped':
      return { kind: 'timestamped', header: 'X-Signature', toleranceSec: SIGNATURE_LIMITS.defaultToleranceSec };
    case 'standard':
      return { kind: 'standard', toleranceSec: SIGNATURE_LIMITS.defaultToleranceSec };
  }
}

const ALGORITHM_LABELS = { sha1: 'SHA-1', sha256: 'SHA-256', sha512: 'SHA-512' } as const;

/** One line for a list or a read-only row. */
export function schemeSummary(scheme: SignatureSchemeWire): string {
  switch (scheme.kind) {
    case 'hmac':
      return [
        SCHEME_LABELS.hmac,
        ALGORITHM_LABELS[scheme.algorithm],
        scheme.encoding,
        scheme.prefix !== undefined && scheme.prefix !== '' ? `${scheme.header} (${scheme.prefix}…)` : scheme.header,
      ].join(' · ');
    case 'timestamped':
      return [SCHEME_LABELS.timestamped, scheme.header, `±${String(scheme.toleranceSec)} s`].join(' · ');
    case 'standard':
      return [SCHEME_LABELS.standard, `±${String(scheme.toleranceSec)} s`].join(' · ');
  }
}

function headerProblem(header: string): string | undefined {
  if (header === '') return 'Name the header the signature travels in.';
  if (header.length > SIGNATURE_LIMITS.maxHeaderLength)
    return `The header name is at most ${String(SIGNATURE_LIMITS.maxHeaderLength)} characters.`;
  return HEADER_NAME_PATTERN.test(header) ? undefined : 'The header name has a character a header name cannot have.';
}

function toleranceProblem(seconds: number): string | undefined {
  return Number.isInteger(seconds) &&
    seconds >= SIGNATURE_LIMITS.minToleranceSec &&
    seconds <= SIGNATURE_LIMITS.maxToleranceSec
    ? undefined
    : `The tolerance is ${String(SIGNATURE_LIMITS.minToleranceSec)} to ${String(SIGNATURE_LIMITS.maxToleranceSec)} seconds.`;
}

/** What the engine's schema would refuse, in the dialog's words; `undefined` when it would accept. */
export function schemeProblemOf(scheme: SignatureSchemeWire): string | undefined {
  switch (scheme.kind) {
    case 'hmac': {
      const prefix = scheme.prefix ?? '';
      if (prefix.length > SIGNATURE_LIMITS.maxPrefixLength || !PREFIX_PATTERN.test(prefix))
        return `The prefix is up to ${String(SIGNATURE_LIMITS.maxPrefixLength)} visible characters, no spaces.`;
      return headerProblem(scheme.header);
    }
    case 'timestamped':
      return headerProblem(scheme.header) ?? toleranceProblem(scheme.toleranceSec);
    case 'standard':
      return toleranceProblem(scheme.toleranceSec);
  }
}

const STANDARD_HEADERS = new Set(['webhook-id', 'webhook-timestamp', 'webhook-signature']);

/**
 * The headers that carried a signature, in arrival order: the ones the current scheme reads, or,
 * with no scheme, any whose name holds `signature` or starts with `webhook-`.
 */
export function signatureHeadersOf(
  headers: readonly (readonly [string, string])[],
  scheme: SignatureSchemeWire | undefined,
): [string, string][] {
  const wanted = (name: string): boolean => {
    const lower = name.toLowerCase();
    if (scheme === undefined) return lower.includes('signature') || lower.startsWith('webhook-');
    return scheme.kind === 'standard' ? STANDARD_HEADERS.has(lower) : lower === scheme.header.toLowerCase();
  };
  return headers.filter(([name]) => wanted(name)).map(([name, value]) => [name, value]);
}

export function verdictText(signature: CaptureSignatureWire | null | undefined): string {
  if (signature === null || signature === undefined) return 'not checked';
  if (signature.verdict === 'verified') return '✓ verified';
  return `✗ ${REASON_TEXT[signature.reason ?? 'key-error']}`;
}
