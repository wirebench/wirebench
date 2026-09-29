// apps/desktop/test/renderer/signature-text.test.ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIGNATURE_TOLERANCE_SEC,
  SIGNATURE_FAILURES,
  SIGNATURE_SECRET_MAX_LENGTH,
  signatureSchemeSchema,
} from '@wirebench/engine';
import {
  defaultScheme,
  HEADER_NAME_PATTERN,
  REASON_TEXT,
  SCHEME_KINDS,
  schemeProblemOf,
  schemeSummary,
  SIGNATURE_LIMITS,
  signatureHeadersOf,
  verdictText,
} from '../../src/renderer/features/webhooks/signature-text.js';

describe('the renderer restates the signature rules (webhook-signatures §2, §4)', () => {
  it('matches the engine', () => {
    expect(Object.keys(REASON_TEXT)).toEqual([...SIGNATURE_FAILURES]);
    expect(SIGNATURE_LIMITS.maxSecretLength).toBe(SIGNATURE_SECRET_MAX_LENGTH);
    expect(SIGNATURE_LIMITS.defaultToleranceSec).toBe(DEFAULT_SIGNATURE_TOLERANCE_SEC);
    for (const kind of SCHEME_KINDS) {
      expect(signatureSchemeSchema.parse(defaultScheme(kind))).toEqual(defaultScheme(kind));
    }
    for (const header of ['X-Signature', 'x_sig.1', 'X Sig', 'X:Sig', '']) {
      const engine = signatureSchemeSchema.safeParse({ kind: 'timestamped', header, toleranceSec: 300 }).success;
      expect(schemeProblemOf({ kind: 'timestamped', header, toleranceSec: 300 }) === undefined).toBe(engine);
      expect(HEADER_NAME_PATTERN.test(header)).toBe(engine);
    }
    for (const toleranceSec of [0, 1, 86_400, 86_401]) {
      const engine = signatureSchemeSchema.safeParse({ kind: 'standard', toleranceSec }).success;
      expect(schemeProblemOf({ kind: 'standard', toleranceSec }) === undefined).toBe(engine);
    }
  });

  it('describes schemes, verdicts and the headers that carried them', () => {
    expect(schemeSummary(defaultScheme('hmac'))).toBe('HMAC of body · SHA-256 · hex · X-Signature');
    expect(schemeSummary({ kind: 'standard', toleranceSec: 300 })).toBe('Standard Webhooks · ±300 s');
    expect(verdictText({ verdict: 'verified' })).toBe('✓ verified');
    expect(verdictText({ verdict: 'failed', reason: 'mismatch' })).toBe('✗ digest mismatch');
    expect(verdictText(null)).toBe('not checked');
    const headers: [string, string][] = [
      ['Content-Type', 'application/json'],
      ['webhook-id', 'msg_1'],
      ['X-Signature', 'abc'],
      ['webhook-signature', 'v1,xyz'],
    ];
    expect(signatureHeadersOf(headers, defaultScheme('hmac'))).toEqual([['X-Signature', 'abc']]);
    expect(signatureHeadersOf(headers, { kind: 'standard', toleranceSec: 300 })).toEqual([
      ['webhook-id', 'msg_1'],
      ['webhook-signature', 'v1,xyz'],
    ]);
    expect(signatureHeadersOf(headers, undefined)).toEqual([
      ['webhook-id', 'msg_1'],
      ['X-Signature', 'abc'],
      ['webhook-signature', 'v1,xyz'],
    ]);
  });
});
