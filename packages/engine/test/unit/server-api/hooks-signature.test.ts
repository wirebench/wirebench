import { describe, expect, it } from 'vitest';
import {
  CATCH_URL_DEFAULT_RESPONSE,
  captureSummarySchema,
  catchUrlSchema,
  catchUrlUpdateRequestSchema,
  SIGNATURE_SECRET_MAX_LENGTH,
} from '../../../src/index.js';

const OLD_SERVER = {
  id: '01J8ZC5Q0V7R3T9XK2M4N6P8QB',
  workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QA',
  name: 'Payments',
  url: 'https://wirebench.test/hooks/3ZC5Q0V7R3T9XK2M4N6P8QAB7Y',
  enabled: true,
  response: CATCH_URL_DEFAULT_RESPONSE,
  captureCount: 0,
  newestCaptureId: null,
  createdAt: '2026-09-29T10:00:00.000Z',
};

describe('server-api hooks: signature fields (§3.4)', () => {
  it('still parses a catch URL from a server without signatures', () => {
    expect(catchUrlSchema.parse(OLD_SERVER)).toEqual(OLD_SERVER);
  });

  it('parses the scheme with a write-only secret, filling the tolerance', () => {
    const parsed = catchUrlSchema.parse({
      ...OLD_SERVER,
      signature: { scheme: { kind: 'standard' }, secret: { set: true, hint: 'i789' } },
      rejectUnverified: true,
      signatureAvailable: true,
    });
    expect(parsed.signature).toEqual({
      scheme: { kind: 'standard', toleranceSec: 300 },
      secret: { set: true, hint: 'i789' },
    });
    expect(
      catchUrlSchema.safeParse({
        ...OLD_SERVER,
        signature: { scheme: { kind: 'standard' }, secret: { set: false, hint: null } },
      }).success,
    ).toBe(false);
  });

  it('bounds the secret in an update, and lets null clear', () => {
    const scheme = { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' };
    expect(SIGNATURE_SECRET_MAX_LENGTH).toBe(512);
    expect(catchUrlUpdateRequestSchema.safeParse({ signature: null }).success).toBe(true);
    expect(catchUrlUpdateRequestSchema.safeParse({ signature: { scheme } }).success).toBe(true);
    expect(catchUrlUpdateRequestSchema.safeParse({ signature: { scheme, secret: 'x'.repeat(512) } }).success).toBe(
      true,
    );
    expect(catchUrlUpdateRequestSchema.safeParse({ signature: { scheme, secret: 'x'.repeat(513) } }).success).toBe(
      false,
    );
    expect(catchUrlUpdateRequestSchema.safeParse({ signature: { scheme, secret: '' } }).success).toBe(false);
    expect(catchUrlUpdateRequestSchema.safeParse({ rejectUnverified: true }).success).toBe(true);
  });

  it('carries a verdict and a rejection on a capture summary', () => {
    const summary = {
      id: '01J8ZC5Q0V7R3T9XK2M4N6P8QC',
      receivedAt: '2026-09-29T10:00:01.000Z',
      method: 'POST',
      subpath: '',
      bodySize: 2,
      truncated: false,
      sourceIp: '203.0.113.9',
    };
    expect(captureSummarySchema.parse(summary)).toEqual(summary);
    expect(
      captureSummarySchema.parse({ ...summary, signature: { verdict: 'failed', reason: 'mismatch' }, rejected: true }),
    ).toMatchObject({ signature: { verdict: 'failed', reason: 'mismatch' }, rejected: true });
    expect(
      captureSummarySchema.safeParse({ ...summary, signature: { verdict: 'failed', reason: 'late' } }).success,
    ).toBe(false);
  });
});
