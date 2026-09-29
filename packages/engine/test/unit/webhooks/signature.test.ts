// packages/engine/test/unit/webhooks/signature.test.ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIGNATURE_TOLERANCE_SEC,
  SIGNATURE_FAILURES,
  isCanonicalBase64,
  signWebhook,
  signatureHeaderNames,
  signatureSchemeSchema,
  toSignatureScheme,
  verifyWebhook,
} from '../../../src/index.js';
import type { SignatureScheme } from '../../../src/index.js';

const SECRET = 'abc123def456ghi789';
const OTHER = 'zzz999yyy888xxx777';
const BODY = new TextEncoder().encode('{"event":"order.created"}');
const T = 1_790_000_000;
const AT = new Date(T * 1000);
const STANDARD_SECRET = 'whsec_YWJjMTIzZGVmNDU2Z2hpNzg5';

const hmac = (patch: Partial<Extract<SignatureScheme, { kind: 'hmac' }>> = {}): SignatureScheme => ({
  kind: 'hmac',
  algorithm: 'sha256',
  encoding: 'hex',
  header: 'X-Signature',
  ...patch,
});
const timestamped: SignatureScheme = { kind: 'timestamped', header: 'X-Signature', toleranceSec: 300 };
const standard: SignatureScheme = { kind: 'standard', toleranceSec: 300 };
const at = (seconds: number): Date => new Date(seconds * 1000);
const tampered = new TextEncoder().encode('{"event":"order.created!"}');

describe('signWebhook — known answers', () => {
  it.each([
    ['sha1', 'hex', '6db609cce579e8456b98a94073445d14f37bd235'],
    ['sha1', 'base64', 'bbYJzOV56EVrmKlAc0RdFPN70jU='],
    ['sha256', 'hex', 'e4d262af7821275e8ec7f51f7999a4a239fa3ee155f413fd980c39c4ed5864ab'],
    ['sha256', 'base64', '5NJir3ghJ16Ox/UfeZmkojn6PuFV9BP9mAw5xO1YZKs='],
    [
      'sha512',
      'hex',
      'd7aaa909aea25c91725cf9a97133a35f5e3269896a93b70ca45c3889ec658e134cb17ae2575ef400f554296830edae207ba91cce331f6e3997465b84d6a20a09',
    ],
    ['sha512', 'base64', '16qpCa6iXJFyXPmpcTOjX14yaYlqk7cMpFw4iexljhNMsXriV170APVUKWgw7a4ge6kczjMfbjmXRluE1qIKCQ=='],
  ] as const)('hmac %s %s', (algorithm, encoding, digest) => {
    expect(signWebhook(hmac({ algorithm, encoding }), SECRET, BODY)).toEqual([['X-Signature', digest]]);
    expect(signWebhook(hmac({ algorithm, encoding, prefix: `${algorithm}=` }), SECRET, BODY)).toEqual([
      ['X-Signature', `${algorithm}=${digest}`],
    ]);
  });

  it('hmac over an empty body', () => {
    expect(signWebhook(hmac(), SECRET, new Uint8Array())).toEqual([
      ['X-Signature', '0651527d1590913395d9980a7ddfb12498b7a03d7641908edc2bf93fb11e600a'],
    ]);
  });

  it('timestamped', () => {
    expect(signWebhook(timestamped, SECRET, BODY, { now: AT })).toEqual([
      ['X-Signature', 't=1790000000,v1=7f95bd46a401bdcea761242f8434ccf8badf5a73346dffaa3186cc52873465e1'],
    ]);
  });

  it('standard, with a whsec_ secret and with a raw one of the same bytes', () => {
    const expected = [
      ['webhook-id', 'msg_abc123'],
      ['webhook-timestamp', '1790000000'],
      ['webhook-signature', 'v1,0X/18qlmjeuc20Np0qosSxkxGvEGn7q/oRzVkwtcFqc='],
    ];
    expect(signWebhook(standard, STANDARD_SECRET, BODY, { now: AT, id: 'msg_abc123' })).toEqual(expected);
    expect(signWebhook(standard, SECRET, BODY, { now: AT, id: 'msg_abc123' })).toEqual(expected);
  });

  it('standard makes a fresh msg_ id when none is given', () => {
    const first = signWebhook(standard, SECRET, BODY, { now: AT })[0]?.[1];
    const second = signWebhook(standard, SECRET, BODY, { now: AT })[0]?.[1];
    expect(first).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
  });

  it('refuses a whsec_ secret that is not base64', () => {
    expect(() => signWebhook(standard, 'whsec_not*base64', BODY, { now: AT })).toThrow(
      expect.objectContaining({ code: 'webhook-signing-secret' }),
    );
  });
});

describe('verifyWebhook', () => {
  it('round-trips every algorithm and encoding, with and without a prefix', () => {
    for (const algorithm of ['sha1', 'sha256', 'sha512'] as const) {
      for (const encoding of ['hex', 'base64'] as const) {
        for (const prefix of [undefined, `${algorithm}=`]) {
          const scheme = hmac({ algorithm, encoding, ...(prefix !== undefined ? { prefix } : {}) });
          const headers = signWebhook(scheme, SECRET, BODY);
          expect(verifyWebhook(scheme, SECRET, headers, BODY)).toEqual({ verdict: 'verified' });
          expect(verifyWebhook(scheme, SECRET, headers, tampered)).toEqual({ verdict: 'failed', reason: 'mismatch' });
        }
      }
    }
  });

  it('matches the header name and a hex digest without regard to case', () => {
    const upper = 'E4D262AF7821275E8EC7F51F7999A4A239FA3EE155F413FD980C39C4ED5864AB';
    expect(verifyWebhook(hmac(), SECRET, [['x-signature', upper]], BODY)).toEqual({ verdict: 'verified' });
  });

  it('fails an hmac header that is missing, unprefixed, undecodable or the wrong length', () => {
    const prefixed = hmac({ prefix: 'sha256=' });
    const digest = 'e4d262af7821275e8ec7f51f7999a4a239fa3ee155f413fd980c39c4ed5864ab';
    expect(verifyWebhook(hmac(), SECRET, [], BODY)).toEqual({ verdict: 'failed', reason: 'missing-header' });
    expect(verifyWebhook(prefixed, SECRET, [['X-Signature', digest]], BODY)).toEqual({
      verdict: 'failed',
      reason: 'malformed-header',
    });
    expect(verifyWebhook(hmac(), SECRET, [['X-Signature', 'zz']], BODY)).toEqual({
      verdict: 'failed',
      reason: 'malformed-header',
    });
    expect(verifyWebhook(hmac(), SECRET, [['X-Signature', digest.slice(2)]], BODY)).toEqual({
      verdict: 'failed',
      reason: 'malformed-header',
    });
    expect(verifyWebhook(hmac({ encoding: 'base64' }), SECRET, [['X-Signature', 'not base64!']], BODY)).toEqual({
      verdict: 'failed',
      reason: 'malformed-header',
    });
  });

  it('checks a timestamped header: tolerance edge, garbling, rotation, unknown keys', () => {
    const good = 't=1790000000,v1=7f95bd46a401bdcea761242f8434ccf8badf5a73346dffaa3186cc52873465e1';
    const verify = (value: string, now = AT) =>
      verifyWebhook(timestamped, SECRET, [['X-Signature', value]], BODY, { now });
    expect(verify(good, at(T + 300))).toEqual({ verdict: 'verified' });
    expect(verify(good, at(T - 300))).toEqual({ verdict: 'verified' });
    expect(verify(good, at(T + 301))).toEqual({ verdict: 'failed', reason: 'stale-timestamp' });
    expect(verify('t=soon,v1=7f95')).toEqual({ verdict: 'failed', reason: 'malformed-header' });
    expect(verify('t=1790000000')).toEqual({ verdict: 'failed', reason: 'malformed-header' });
    expect(verify('garbage')).toEqual({ verdict: 'failed', reason: 'malformed-header' });
    const rotated =
      't=1790000000,v1=10e27b534521eed0781c9a1d09553b287288df64359022fee53eb2bc5a17e997,' +
      'v1=7f95bd46a401bdcea761242f8434ccf8badf5a73346dffaa3186cc52873465e1,v0=ignored';
    expect(verify(rotated)).toEqual({ verdict: 'verified' });
    expect(verifyWebhook(timestamped, OTHER, [['X-Signature', good]], BODY, { now: AT })).toEqual({
      verdict: 'failed',
      reason: 'mismatch',
    });
    expect(verifyWebhook(timestamped, SECRET, [], BODY, { now: AT })).toEqual({
      verdict: 'failed',
      reason: 'missing-header',
    });
  });

  it('checks standard headers: any v1 in the list, tolerance, a bad whsec_ key', () => {
    const headers = (signature: string, timestamp = '1790000000'): [string, string][] => [
      ['Webhook-Id', 'msg_abc123'],
      ['Webhook-Timestamp', timestamp],
      ['Webhook-Signature', signature],
    ];
    const good = 'v1,0X/18qlmjeuc20Np0qosSxkxGvEGn7q/oRzVkwtcFqc=';
    const opts = { now: AT };
    expect(verifyWebhook(standard, STANDARD_SECRET, headers(good), BODY, opts)).toEqual({ verdict: 'verified' });
    expect(verifyWebhook(standard, STANDARD_SECRET, headers(`v1,AAAA ${good}`), BODY, opts)).toEqual({
      verdict: 'verified',
    });
    expect(verifyWebhook(standard, STANDARD_SECRET, headers(good), tampered, opts)).toEqual({
      verdict: 'failed',
      reason: 'mismatch',
    });
    expect(verifyWebhook(standard, STANDARD_SECRET, headers(good), BODY, { now: at(T + 301) })).toEqual({
      verdict: 'failed',
      reason: 'stale-timestamp',
    });
    expect(verifyWebhook(standard, STANDARD_SECRET, headers(good, 'later'), BODY, opts)).toEqual({
      verdict: 'failed',
      reason: 'malformed-header',
    });
    expect(verifyWebhook(standard, STANDARD_SECRET, headers('v2,abc'), BODY, opts)).toEqual({
      verdict: 'failed',
      reason: 'malformed-header',
    });
    expect(verifyWebhook(standard, STANDARD_SECRET, headers(good).slice(1), BODY, opts)).toEqual({
      verdict: 'failed',
      reason: 'missing-header',
    });
    expect(verifyWebhook(standard, 'whsec_not*base64', headers(good), BODY, opts)).toEqual({
      verdict: 'failed',
      reason: 'key-error',
    });
  });

  it('checks in order: header → parse → timestamp → digest', () => {
    // A stale timestamp with a garbled digest reports the parse, not the age.
    expect(verifyWebhook(timestamped, SECRET, [['X-Signature', 't=1,v1=zz']], BODY, { now: AT })).toEqual({
      verdict: 'failed',
      reason: 'malformed-header',
    });
    // A stale timestamp with a wrong digest reports the age.
    expect(verifyWebhook(timestamped, OTHER, [['X-Signature', `t=1,v1=${'0'.repeat(64)}`]], BODY, { now: AT })).toEqual(
      { verdict: 'failed', reason: 'stale-timestamp' },
    );
  });
});

describe('signatureSchemeSchema', () => {
  it('fills the tolerance, drops an empty prefix, and refuses bad names', () => {
    expect(toSignatureScheme(signatureSchemeSchema.parse({ kind: 'standard' }))).toEqual({
      kind: 'standard',
      toleranceSec: DEFAULT_SIGNATURE_TOLERANCE_SEC,
    });
    expect(
      toSignatureScheme(
        signatureSchemeSchema.parse({
          kind: 'hmac',
          algorithm: 'sha256',
          encoding: 'hex',
          header: 'X-Sig',
          prefix: '',
        }),
      ),
    ).toEqual({ kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Sig' });
    expect(signatureSchemeSchema.safeParse({ kind: 'timestamped', header: 'X Sig' }).success).toBe(false);
    expect(signatureSchemeSchema.safeParse({ kind: 'standard', toleranceSec: 0 }).success).toBe(false);
    expect(signatureSchemeSchema.safeParse({ kind: 'jwt' }).success).toBe(false);
    expect(SIGNATURE_FAILURES).toEqual([
      'missing-header',
      'malformed-header',
      'mismatch',
      'stale-timestamp',
      'key-error',
    ]);
  });
});

describe('isCanonicalBase64', () => {
  it('accepts padded canonical base64 and refuses everything else', () => {
    expect(isCanonicalBase64('YWJjMTIzZGVmNDU2Z2hpNzg5')).toBe(true);
    expect(isCanonicalBase64('YQ==')).toBe(true);
    expect(isCanonicalBase64('')).toBe(false);
    expect(isCanonicalBase64('YQ')).toBe(false);
    expect(isCanonicalBase64('not*base64')).toBe(false);
    expect(isCanonicalBase64('YQ== ')).toBe(false);
  });
});

describe('signatureHeaderNames', () => {
  it('names exactly the headers signWebhook writes, in order', () => {
    const schemes: SignatureScheme[] = [
      { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
      { kind: 'timestamped', header: 'X-Hook-Signature', toleranceSec: 300 },
      { kind: 'standard', toleranceSec: 300 },
    ];
    for (const scheme of schemes) {
      const secret = scheme.kind === 'standard' ? STANDARD_SECRET : SECRET;
      const written = signWebhook(scheme, secret, BODY, { now: AT }).map(([name]) => name);
      expect(signatureHeaderNames(scheme)).toEqual(written);
    }
  });
});
