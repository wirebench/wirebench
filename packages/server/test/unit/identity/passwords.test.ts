import { describe, expect, it } from 'vitest';
import { hashPassword, parseStoredHash, SCRYPT_PARAMS, verifyPassword } from '../../../src/identity/passwords.js';

describe('passwords (§3.4)', () => {
  it('stores scrypt$N$r$p$salt$hash with the documented parameters and a fresh 16-byte salt', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
    expect(a).not.toBe(b);
    expect(parseStoredHash(a)?.params).toEqual(SCRYPT_PARAMS);
  });
  it('verifies the right password, refuses a wrong one, and never throws on garbage', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', stored)).toEqual({ ok: true, rehash: false });
    expect(await verifyPassword('correct horse batter', stored)).toEqual({ ok: false, rehash: false });
    expect(await verifyPassword('x', 'not-a-hash')).toEqual({ ok: false, rehash: false });
    expect(await verifyPassword('x', 'scrypt$abc$8$1$AA$AA')).toEqual({ ok: false, rehash: false });
  });
  it('asks for a rehash when the stored parameters are older than the current set', async () => {
    const old = await hashPassword('correct horse battery', { N: 2 ** 14, r: 8, p: 1, keylen: 32 });
    expect(await verifyPassword('correct horse battery', old)).toEqual({ ok: true, rehash: true });
  });
});
