/**
 * The subset of CBOR (RFC 8949) CTAP2 uses: unsigned and negative integers, byte and text strings, arrays,
 * maps and the simple values true, false and null. Maps keep their keys in the order given; CTAP2's
 * canonical order (integer keys ascending) is the caller's, and every request here is written in it.
 */

export type CborValue = number | string | boolean | null | Buffer | CborValue[] | CborMap;
export type CborMap = Map<number | string, CborValue>;

function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) {
    const out = Buffer.alloc(3);
    out[0] = (major << 5) | 25;
    out.writeUInt16BE(value, 1);
    return out;
  }
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(value, 1);
  return out;
}

export function encodeCbor(value: CborValue): Buffer {
  if (value === false) return Buffer.from([0xf4]);
  if (value === true) return Buffer.from([0xf5]);
  if (value === null) return Buffer.from([0xf6]);
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || Math.abs(value) > 0xffffffff) throw new Error('CBOR: unsupported number');
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encodeCbor)]);
  const parts: Buffer[] = [head(5, value.size)];
  for (const [key, item] of value) parts.push(encodeCbor(key), encodeCbor(item));
  return Buffer.concat(parts);
}

const MAX_DEPTH = 16;

/**
 * Decodes the CBOR item at the start of `data`; `end` is where it stopped (the COSE key inside
 * authenticator data is followed by more bytes).
 *
 * @throws Error on malformed input or a type outside the subset (floats, tags, indefinite lengths)
 */
export function decodeCborPrefix(data: Buffer): { value: CborValue; end: number } {
  let pos = 0;
  const fail = (): never => {
    throw new Error('CBOR: malformed');
  };
  const take = (length: number): Buffer => {
    if (pos + length > data.length) fail();
    const out = data.subarray(pos, pos + length);
    pos += length;
    return out;
  };
  const argument = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return take(1).readUInt8(0);
    if (info === 25) return take(2).readUInt16BE(0);
    if (info === 26) return take(4).readUInt32BE(0);
    if (info === 27) {
      const big = take(8).readBigUInt64BE(0);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail();
      return Number(big);
    }
    return fail();
  };
  const item = (depth: number): CborValue => {
    if (depth > MAX_DEPTH) fail();
    const first = take(1).readUInt8(0);
    const major = first >> 5;
    const info = first & 0x1f;
    switch (major) {
      case 0:
        return argument(info);
      case 1:
        return -1 - argument(info);
      case 2:
        return Buffer.from(take(argument(info)));
      case 3:
        return take(argument(info)).toString('utf8');
      case 4: {
        const count = argument(info);
        const out: CborValue[] = [];
        for (let i = 0; i < count; i++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const count = argument(info);
        const out: CborMap = new Map();
        for (let i = 0; i < count; i++) {
          const key = item(depth + 1);
          if (typeof key !== 'number' && typeof key !== 'string') return fail();
          out.set(key, item(depth + 1));
        }
        return out;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        return fail();
      default:
        return fail();
    }
  };
  const value = item(0);
  return { value, end: pos };
}

/** {@link decodeCborPrefix} for a buffer that holds exactly one item. */
export function decodeCbor(data: Buffer): CborValue {
  const { value, end } = decodeCborPrefix(data);
  if (end !== data.length) throw new Error('CBOR: trailing bytes');
  return value;
}

export const asCborMap = (value: CborValue | undefined): CborMap | undefined =>
  value instanceof Map ? value : undefined;
export const cborBytes = (map: CborMap, key: number | string): Buffer | undefined => {
  const value = map.get(key);
  return Buffer.isBuffer(value) ? value : undefined;
};
export const cborNumber = (map: CborMap, key: number | string): number | undefined => {
  const value = map.get(key);
  return typeof value === 'number' ? value : undefined;
};
