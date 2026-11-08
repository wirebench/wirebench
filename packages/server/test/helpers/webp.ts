/**
 * Hand-made WebP files for the image checks (user profile ruling 2): only the headers the server reads, followed by
 * filler bytes. None of them decodes to a picture; the server never decodes one.
 */

const u32le = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u24le = (n: number): Buffer => u32le(n).subarray(0, 3);

/** One RIFF chunk: its id, its size, the payload, and the padding byte an odd payload takes. */
export function chunk(id: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(id, 'latin1'),
    u32le(payload.length),
    payload,
    payload.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0),
  ]);
}

/** The RIFF/WEBP container around `chunks`. */
export function riff(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), u32le(body.length), body]);
}

/** A lossy bitstream's header: a key frame tag, the start code, the 14-bit sizes, then `filler` bytes. */
export function vp8(width: number, height: number, filler = 16): Buffer {
  const head = Buffer.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0, 0, 0, 0]);
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  return chunk('VP8 ', Buffer.concat([head, Buffer.alloc(filler, 0x55)]));
}

/** A lossless bitstream's header: the signature, then width − 1 and height − 1 in 14 bits each, version 0. */
export function vp8l(width: number, height: number, filler = 16): Buffer {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return chunk('VP8L', Buffer.concat([Buffer.from([0x2f]), u32le(bits), Buffer.alloc(filler, 0x55)]));
}

/** The extended header: flags, three reserved bytes, the canvas size less one in 24 bits each. */
export function vp8x(width: number, height: number, flags = 0): Buffer {
  return chunk('VP8X', Buffer.concat([Buffer.from([flags, 0, 0, 0]), u24le(width - 1), u24le(height - 1)]));
}

/** A WebP the server takes for `kind`: lossy, the exact size, a little filler. */
export function webpFor(kind: 'photo' | 'cover', filler = 64): Buffer {
  return kind === 'photo' ? riff(vp8(256, 256, filler)) : riff(vp8(1500, 500, filler));
}
