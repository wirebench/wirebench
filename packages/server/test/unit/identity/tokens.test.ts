import { describe, expect, it } from 'vitest';
import { DEVICE_TOKEN_PATTERN, SECRET_PATTERN } from '@wirebench/engine';
import {
  bearerToken,
  hashSecret,
  hashToken,
  mintSecret,
  mintToken,
  newId,
  pkceChallenge,
} from '../../../src/identity/tokens.js';

describe('tokens and secrets (§3.5, §6)', () => {
  it('mints wbs_ + 43 base64url characters and stores only a sha256 hex', () => {
    const { token, hash } = mintToken();
    expect(token).toMatch(DEVICE_TOKEN_PATTERN);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hash);
    expect(hash).not.toContain(token.slice(4, 20));
  });
  it('mints invitation secrets and grants in the shared shape', () => {
    const { secret, hash } = mintSecret();
    expect(secret).toMatch(SECRET_PATTERN);
    expect(hashSecret(secret)).toBe(hash);
    expect(mintSecret().secret).not.toBe(secret);
  });
  it('parses a Bearer header case-insensitively and rejects everything else', () => {
    const { token } = mintToken();
    expect(bearerToken(`Bearer ${token}`)).toBe(token);
    expect(bearerToken(`bearer ${token}`)).toBe(token);
    expect(bearerToken(`Basic ${token}`)).toBeUndefined();
    expect(bearerToken('Bearer nope')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
  it('derives the S256 challenge the desktop sends (RFC 7636 appendix B)', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
  it('mints 26-character ULIDs', () => {
    expect(newId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
