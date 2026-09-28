import { CATCH_SECRET_PATTERN } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { crockford128, mintCatchSecret } from '../../../src/hooks/secret.js';

describe('catch URL secrets (webhook-capture §3.2, §5)', () => {
  it('encodes 128 bits as 26 Crockford characters, most significant first', () => {
    expect(crockford128(new Uint8Array(16))).toBe('0'.repeat(26));
    expect(crockford128(new Uint8Array(16).fill(0xff))).toBe(`7${'Z'.repeat(25)}`);
    const one = new Uint8Array(16);
    one[15] = 1;
    expect(crockford128(one)).toBe(`${'0'.repeat(25)}1`);
    const thirtyTwo = new Uint8Array(16);
    thirtyTwo[15] = 32;
    expect(crockford128(thirtyTwo)).toBe(`${'0'.repeat(24)}10`);
  });

  it('refuses anything but 16 bytes', () => {
    expect(() => crockford128(new Uint8Array(15))).toThrow(RangeError);
    expect(() => crockford128(new Uint8Array(17))).toThrow(RangeError);
  });

  it('mints from 16 random bytes, always on the pattern the public route checks', () => {
    const sizes: number[] = [];
    expect(
      mintCatchSecret((size) => {
        sizes.push(size);
        return new Uint8Array(size).fill(0xab);
      }),
    ).toMatch(CATCH_SECRET_PATTERN);
    expect(sizes).toEqual([16]);
    const minted = new Set(Array.from({ length: 200 }, () => mintCatchSecret()));
    expect(minted.size).toBe(200);
    for (const secret of minted) expect(secret).toMatch(CATCH_SECRET_PATTERN);
  });
});
