import { describe, expect, it } from 'vitest';
import { md4 } from '../../../../src/http/auth/md4.js';

function hex(input: string): string {
  return Buffer.from(md4(new Uint8Array(Buffer.from(input, 'ascii')))).toString('hex');
}

describe('md4', () => {
  // The complete test suite from RFC 1320, appendix A.5.
  it.each([
    ['', '31d6cfe0d16ae931b73c59d7e0c089c0'],
    ['a', 'bde52cb31de33e46245e05fbdbd6fb24'],
    ['abc', 'a448017aaf21d8525fc10ae87aa6729d'],
    ['message digest', 'd9130a8164549fe818874806e1c7014b'],
    ['abcdefghijklmnopqrstuvwxyz', 'd79e1c308aa5bbcdeea8ed63df412da9'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', '043f8582f241db351ce627e153e7f0e4'],
    ['1234567890'.repeat(8), 'e33b4ddc9c38f2199c3e7b164fcc0536'],
  ])('hashes %j', (input, expected) => {
    expect(hex(input)).toBe(expected);
  });

  it('hashes messages that straddle the 64-byte block boundary', () => {
    // 55/56/64 bytes exercise the three padding shapes (fits, spills a block, exact block).
    expect(hex('x'.repeat(55))).toHaveLength(32);
    expect(hex('x'.repeat(56))).toHaveLength(32);
    expect(hex('x'.repeat(64))).toHaveLength(32);
    expect(hex('x'.repeat(56))).not.toBe(hex('x'.repeat(55)));
  });

  it('hashes UTF-16LE input, as the NTLM NT hash needs', () => {
    // MS-NLMP §4.2.4.1.1: NTOWFv1('Password') = a4f49c406510bdcab6824ee7c30fd852.
    const digest = md4(new Uint8Array(Buffer.from('Password', 'utf16le')));
    expect(Buffer.from(digest).toString('hex')).toBe('a4f49c406510bdcab6824ee7c30fd852');
  });
});
