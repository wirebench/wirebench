/**
 * Paddle's webhook signature (hosted edition spec §22.5, ADR-0039): the `Paddle-Signature` header is
 * `ts=<unix seconds>;h1=<hex>`, with more than one `h1` while a secret rotates. The signed payload is
 * `<ts>:<raw body>`, HMAC-SHA256 under the notification destination's secret key; any `h1` that matches, compared in
 * constant time, passes. `ts` must be within {@link SIGNATURE_TOLERANCE_S} of now: wider than Paddle's own 5 s,
 * because replays are stopped by the event id, and a clock some seconds off must not drop billing.
 *
 * A failure is a reason code, never the header or the body: the caller logs the code and answers `401`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far `ts` may be from now, either way. */
export const SIGNATURE_TOLERANCE_S = 300;

/** A header longer than this is not one Paddle sends, even mid-rotation. */
const MAX_HEADER = 2048;

/** Why a signature did not pass: the only thing logged. */
export type SignatureFailure =
  | 'billing-signature-missing'
  | 'billing-signature-malformed'
  | 'billing-signature-stale'
  | 'billing-signature-mismatch';

export type SignatureCheck =
  { readonly ok: true; readonly ts: number } | { readonly ok: false; readonly reason: SignatureFailure };

interface ParsedHeader {
  readonly ts: number;
  readonly h1: readonly Buffer[];
}

const TS = /^\d{1,12}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/** `ts` and every `h1`; `undefined` when the header is not in Paddle's form. Other keys are skipped. */
export function parseSignatureHeader(header: string): ParsedHeader | undefined {
  if (header.length > MAX_HEADER) return undefined;
  let ts: number | undefined;
  const h1: Buffer[] = [];
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at <= 0) return undefined;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === 'ts') {
      if (ts !== undefined || !TS.test(value)) return undefined;
      ts = Number(value);
    } else if (key === 'h1') {
      if (!HEX_SHA256.test(value)) return undefined;
      h1.push(Buffer.from(value, 'hex'));
    }
  }
  if (ts === undefined || h1.length === 0) return undefined;
  return { ts, h1 };
}

/** The `h1` Paddle computes for `body` at `ts` under `secret`. Exported for tests that sign their own fixtures. */
export function paddleSignature(secret: string, ts: number, body: Buffer | string): string {
  return createHmac('sha256', secret)
    .update(`${String(ts)}:`)
    .update(body)
    .digest('hex');
}

/**
 * Checks `header` against `body`, byte for byte as received, at `nowMs`.
 */
export function verifyPaddleSignature(
  header: string | readonly string[] | undefined,
  body: Buffer,
  secret: string,
  nowMs: number,
): SignatureCheck {
  if (header === undefined || header === '') return { ok: false, reason: 'billing-signature-missing' };
  if (typeof header !== 'string') return { ok: false, reason: 'billing-signature-malformed' };
  const parsed = parseSignatureHeader(header);
  if (parsed === undefined) return { ok: false, reason: 'billing-signature-malformed' };
  if (Math.abs(nowMs / 1000 - parsed.ts) > SIGNATURE_TOLERANCE_S)
    return { ok: false, reason: 'billing-signature-stale' };
  const expected = Buffer.from(paddleSignature(secret, parsed.ts, body), 'hex');
  // Every h1 is compared, a match or not, so the time taken says nothing about which one matched.
  let matched = false;
  for (const candidate of parsed.h1) {
    if (timingSafeEqual(candidate, expected)) matched = true;
  }
  return matched ? { ok: true, ts: parsed.ts } : { ok: false, reason: 'billing-signature-mismatch' };
}
