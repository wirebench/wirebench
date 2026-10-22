/**
 * MD4 (RFC 1320), implemented here because NTLM's NT hash is `MD4(UTF-16LE(password))`
 * and Node's `crypto` only exposes MD4 through the OpenSSL legacy provider, which is
 * disabled in the Node builds we ship on. MD4 is used *only* as NTLM's key-derivation
 * primitive; it is not a security primitive anywhere else in Wirebench.
 */

/** Left-rotates a 32-bit word, staying inside the 32-bit range. */
function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function f(x: number, y: number, z: number): number {
  return (x & y) | (~x & z);
}

function g(x: number, y: number, z: number): number {
  return (x & y) | (x & z) | (y & z);
}

function h(x: number, y: number, z: number): number {
  return x ^ y ^ z;
}

/** Round-1 order is 0..15; rounds 2 and 3 permute the block words per RFC 1320 §3.4. */
const ROUND2_ORDER = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15] as const;
const ROUND3_ORDER = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15] as const;
const SHIFTS_1 = [3, 7, 11, 19] as const;
const SHIFTS_2 = [3, 5, 9, 13] as const;
const SHIFTS_3 = [3, 9, 11, 15] as const;

/**
 * Computes the MD4 digest of `bytes`.
 *
 * @param bytes the message to hash
 * @returns the 16-byte digest
 */
export function md4(bytes: Uint8Array): Uint8Array {
  // Pad to a multiple of 64 bytes: 0x80, zeroes, then the bit length as 64-bit little-endian.
  const bitLength = BigInt(bytes.length) * 8n;
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const message = new Uint8Array(paddedLength);
  message.set(bytes, 0);
  message[bytes.length] = 0x80;
  const view = new DataView(message.buffer);
  view.setBigUint64(paddedLength - 8, bitLength & 0xffffffffffffffffn, true);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  const words = new Array<number>(16);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      words[i] = view.getUint32(offset + i * 4, true);
    }
    const [aa, bb, cc, dd] = [a, b, c, d];

    for (let i = 0; i < 16; i++) {
      const shift = SHIFTS_1[i % 4] ?? 0;
      const word = words[i] ?? 0;
      const value = (a + f(b, c, d) + word) >>> 0;
      [a, b, c, d] = [d, rotl(value, shift), b, c];
    }
    for (let i = 0; i < 16; i++) {
      const shift = SHIFTS_2[i % 4] ?? 0;
      const word = words[ROUND2_ORDER[i] ?? 0] ?? 0;
      const value = (a + g(b, c, d) + word + 0x5a827999) >>> 0;
      [a, b, c, d] = [d, rotl(value, shift), b, c];
    }
    for (let i = 0; i < 16; i++) {
      const shift = SHIFTS_3[i % 4] ?? 0;
      const word = words[ROUND3_ORDER[i] ?? 0] ?? 0;
      const value = (a + h(b, c, d) + word + 0x6ed9eba1) >>> 0;
      [a, b, c, d] = [d, rotl(value, shift), b, c];
    }

    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }

  const digest = new Uint8Array(16);
  const out = new DataView(digest.buffer);
  out.setUint32(0, a, true);
  out.setUint32(4, b, true);
  out.setUint32(8, c, true);
  out.setUint32(12, d, true);
  return digest;
}
