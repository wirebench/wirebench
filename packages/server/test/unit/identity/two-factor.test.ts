import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openTotpSecret, sealTotpSecret } from '../../../src/identity/two-factor/keys.js';
import {
  newRecoveryCodes,
  normaliseRecoveryCode,
  recoveryCodeHash,
  RECOVERY_CODE_COUNT,
} from '../../../src/identity/two-factor/recovery.js';
import { base32, otpauthUri, stepAt, totpAt, verifyTotp } from '../../../src/identity/two-factor/totp.js';

/** RFC 6238 appendix B's SHA-1 seed and its eight-digit answers. */
const RFC_SEED = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: readonly (readonly [number, string])[] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('authenticator codes (two-step sign-in spec §3.4)', () => {
  it('matches the RFC 6238 SHA-1 vectors', () => {
    for (const [seconds, expected] of RFC_VECTORS) {
      expect(totpAt(RFC_SEED, stepAt(seconds * 1000), 8)).toBe(expected);
      expect(totpAt(RFC_SEED, stepAt(seconds * 1000))).toBe(expected.slice(2));
    }
  });

  it('accepts one step either side, refuses two, and refuses a step at or before lastStep', () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    const at = (offset: number) => totpAt(RFC_SEED, step + offset);
    expect(verifyTotp(RFC_SEED, at(0), now, 0)).toEqual({ ok: true, step });
    expect(verifyTotp(RFC_SEED, at(-1), now, 0)).toEqual({ ok: true, step: step - 1 });
    expect(verifyTotp(RFC_SEED, at(1), now, 0)).toEqual({ ok: true, step: step + 1 });
    expect(verifyTotp(RFC_SEED, at(2), now, 0)).toEqual({ ok: false });
    expect(verifyTotp(RFC_SEED, at(-2), now, 0)).toEqual({ ok: false });
    expect(verifyTotp(RFC_SEED, at(0), now, step)).toEqual({ ok: false });
    expect(verifyTotp(RFC_SEED, at(0), now, step - 1)).toEqual({ ok: true, step });
    expect(verifyTotp(RFC_SEED, `${at(0).slice(0, 3)} ${at(0).slice(3)}`, now, 0)).toEqual({ ok: true, step });
    expect(verifyTotp(RFC_SEED, 'abcdef', now, 0)).toEqual({ ok: false });
  });

  it('writes RFC 4648 base32 and an otpauth URI the apps read', () => {
    expect(base32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    const text = otpauthUri({ secret: RFC_SEED, label: 'Wirebench (wb.example):a@b.c', issuer: 'Wirebench' });
    expect(text.startsWith(`otpauth://totp/${encodeURIComponent('Wirebench (wb.example):a@b.c')}?`)).toBe(true);
    const uri = new URL(text);
    expect(uri.searchParams.get('secret')).toBe(base32(RFC_SEED));
    expect(uri.searchParams.get('issuer')).toBe('Wirebench');
  });
});

describe('recovery codes (two-step sign-in spec §3.4)', () => {
  it('recovery codes: ten, unique, the alphabet, and normalising ignores case, spaces and dashes', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) expect(code).toMatch(/^[0-9a-hjkmnp-tv-z]{5}-[0-9a-hjkmnp-tv-z]{5}$/);
    const code = codes[0]!;
    expect(normaliseRecoveryCode(` ${code.toUpperCase().replace('-', ' - ')} `)).toBe(code.replace('-', ''));
    expect(normaliseRecoveryCode('abcde-fghio')).toBe('abcdefgh10');
    expect(normaliseRecoveryCode('short')).toBeUndefined();
    expect(normaliseRecoveryCode('abcde-fghi!')).toBeUndefined();
    const key = randomBytes(32);
    expect(recoveryCodeHash(key, code)).toBe(recoveryCodeHash(key, code.toUpperCase()));
    expect(recoveryCodeHash(key, code)).not.toBe(recoveryCodeHash(randomBytes(32), code));
  });
});

describe('sealed authenticator secrets (two-step sign-in spec §7)', () => {
  it('a sealed secret opens for its person only', () => {
    const dataKey = randomBytes(32);
    const secret = randomBytes(20);
    const sealed = sealTotpSecret(dataKey, 'user-a', secret);
    expect(openTotpSecret(dataKey, 'user-a', sealed).equals(secret)).toBe(true);
    expect(() => openTotpSecret(dataKey, 'user-b', sealed)).toThrow();
    expect(() => openTotpSecret(randomBytes(32), 'user-a', sealed)).toThrow();
  });
});
