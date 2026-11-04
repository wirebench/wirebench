/**
 * Paddle's webhook signature (hosted edition spec §22.5; slice 7 Task 12): `ts=<unix>;h1=<hex>`, HMAC-SHA256 of
 * `<ts>:<raw body>`, any matching `h1` in constant time, `ts` within 300 s. Every secret here is a placeholder.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  paddleSignature,
  parseSignatureHeader,
  SIGNATURE_TOLERANCE_S,
  verifyPaddleSignature,
} from '../../../../src/control-plane/billing/signature.js';

const SECRET = 'pdl_ntfset_test_01gkpjp8bkm3tm53kdgkx6sms7_placeholderplaceholder';
// The `ts` of Paddle's documented example; the body and the h1 are our own, computed the documented way.
const TS = 1671552777;
const BODY = Buffer.from('{"event_id":"evt_test_01","event_type":"subscription.updated","data":{}}');
const AT = TS * 1000;

/** The documented computation, spelled out without the module's helper. */
const h1 = (secret: string, ts: number, body: Buffer): string =>
  createHmac('sha256', secret)
    .update(`${String(ts)}:${body.toString('utf8')}`)
    .digest('hex');

describe("Paddle's signature (spec §22.5)", () => {
  it('passes a signature made the documented way', () => {
    const header = `ts=${String(TS)};h1=${h1(SECRET, TS, BODY)}`;
    expect(paddleSignature(SECRET, TS, BODY)).toBe(h1(SECRET, TS, BODY));
    expect(verifyPaddleSignature(header, BODY, SECRET, AT)).toEqual({ ok: true, ts: TS });
  });

  it('passes when one of two h1 matches, as during a secret rotation', () => {
    const wrong = h1('pdl_ntfset_test_the_old_secret_placeholder', TS, BODY);
    const header = `ts=${String(TS)};h1=${wrong};h1=${h1(SECRET, TS, BODY)}`;
    expect(verifyPaddleSignature(header, BODY, SECRET, AT).ok).toBe(true);
    expect(parseSignatureHeader(header)?.h1).toHaveLength(2);
  });

  it('refuses a ts more than 300 s away, either way', () => {
    const header = `ts=${String(TS)};h1=${h1(SECRET, TS, BODY)}`;
    expect(verifyPaddleSignature(header, BODY, SECRET, AT + SIGNATURE_TOLERANCE_S * 1000).ok).toBe(true);
    expect(verifyPaddleSignature(header, BODY, SECRET, AT + (SIGNATURE_TOLERANCE_S + 1) * 1000)).toEqual({
      ok: false,
      reason: 'billing-signature-stale',
    });
    expect(verifyPaddleSignature(header, BODY, SECRET, AT - (SIGNATURE_TOLERANCE_S + 1) * 1000)).toEqual({
      ok: false,
      reason: 'billing-signature-stale',
    });
  });

  it('refuses a body with one byte changed', () => {
    const header = `ts=${String(TS)};h1=${h1(SECRET, TS, BODY)}`;
    const changed = Buffer.from(BODY);
    changed[10] = changed[10]! ^ 1;
    expect(verifyPaddleSignature(header, changed, SECRET, AT)).toEqual({
      ok: false,
      reason: 'billing-signature-mismatch',
    });
    expect(verifyPaddleSignature(header, BODY, `${SECRET}x`, AT).ok).toBe(false);
  });

  it('refuses a missing or malformed header with a code, never echoing it', () => {
    const good = h1(SECRET, TS, BODY);
    expect(verifyPaddleSignature(undefined, BODY, SECRET, AT)).toEqual({
      ok: false,
      reason: 'billing-signature-missing',
    });
    for (const header of [
      'garbage',
      `h1=${good}`,
      `ts=${String(TS)}`,
      `ts=abc;h1=${good}`,
      `ts=${String(TS)};ts=${String(TS)};h1=${good}`,
      `ts=${String(TS)};h1=${good.slice(2)}`,
      `ts=${String(TS)};h1=${good};;`,
      `ts=${String(TS)};h1=${'z'.repeat(64)}`,
      `ts=${String(TS)};h1=${good};x=${'a'.repeat(4096)}`,
    ]) {
      const result = verifyPaddleSignature(header, BODY, SECRET, AT);
      expect(result, header.slice(0, 40)).toEqual({ ok: false, reason: 'billing-signature-malformed' });
      expect(JSON.stringify(result)).not.toContain(good);
    }
    expect(verifyPaddleSignature(['a', 'b'], BODY, SECRET, AT)).toEqual({
      ok: false,
      reason: 'billing-signature-malformed',
    });
  });

  it('skips keys it does not know, so a later scheme beside h1 still verifies', () => {
    const header = `ts=${String(TS)};h2=whatever;h1=${h1(SECRET, TS, BODY)}`;
    expect(verifyPaddleSignature(header, BODY, SECRET, AT).ok).toBe(true);
  });
});
