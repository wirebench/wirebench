/**
 * The server's own check of an uploaded profile image (user profile spec §9, ruling 2). The app always re-encodes to
 * WebP, so this reads one format and trusts nothing the app did: a RIFF/WEBP header whose size matches the file, then
 * each chunk in turn, the dimensions from the `VP8 `, `VP8L` or `VP8X` chunk. Metadata (`EXIF`, `XMP `, `ICCP`) and
 * animation (`ANIM`, `ANMF`) are refused, and so is any chunk this does not know: the app writes none of them, so
 * their presence means a hand-made file. No image library: the bytes are never decoded, only measured.
 */

export type WebpCheck =
  | { readonly ok: true; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly reason: string };

const fourcc = (bytes: Uint8Array, at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));
const u16 = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8);
const u24 = (bytes: Uint8Array, at: number): number => u16(bytes, at) | (bytes[at + 2]! << 16);
const u32 = (bytes: Uint8Array, at: number): number => (u24(bytes, at) | (bytes[at + 3]! << 24)) >>> 0;

const refused = (reason: string): WebpCheck => ({ ok: false, reason });

/** VP8X's flag bits that name what this check refuses. */
const VP8X_ICC = 0x20;
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;
const VP8X_ANIMATION = 0x02;
const REFUSED_CHUNKS = new Set(['EXIF', 'XMP ', 'ICCP', 'ANIM', 'ANMF']);

/** The frame size of a lossy bitstream: a key frame's tag, the start code, then 14-bit width and height. */
function vp8Size(payload: Uint8Array): { width: number; height: number } | undefined {
  if (payload.length < 10) return undefined;
  // Bit 0 of the frame tag is 0 for a key frame, the only kind a still image has.
  if ((payload[0]! & 0x01) !== 0) return undefined;
  if (payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) return undefined;
  return { width: u16(payload, 6) & 0x3fff, height: u16(payload, 8) & 0x3fff };
}

/** The image size of a lossless bitstream: the 0x2f signature, then 14 bits each of width − 1 and height − 1. */
function vp8lSize(payload: Uint8Array): { width: number; height: number } | undefined {
  if (payload.length < 5 || payload[0] !== 0x2f) return undefined;
  const bits = u32(payload, 1);
  // The top three bits are the version, which is 0.
  if (bits >>> 29 !== 0) return undefined;
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

/** Reads `bytes` as a still WebP image with no metadata, and answers its size, or why it is refused. */
export function checkWebp(bytes: Uint8Array): WebpCheck {
  if (bytes.length < 12 || fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WEBP') {
    return refused('not a WebP file');
  }
  if (u32(bytes, 4) + 8 !== bytes.length) return refused('the RIFF size does not match the file');
  let canvas: { width: number; height: number } | undefined;
  let frame: { width: number; height: number } | undefined;
  let first = true;
  let at = 12;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) return refused('a chunk header is cut short');
    const id = fourcc(bytes, at);
    const size = u32(bytes, at + 4);
    const start = at + 8;
    const end = start + size;
    if (end > bytes.length) return refused(`the ${id} chunk runs past the file`);
    const payload = bytes.subarray(start, end);
    if (REFUSED_CHUNKS.has(id)) return refused(`a ${id.trim()} chunk is not accepted`);
    switch (id) {
      case 'VP8X': {
        if (!first) return refused('VP8X is not the first chunk');
        if (size < 10) return refused('the VP8X chunk is too short');
        const flags = payload[0]!;
        if ((flags & (VP8X_ICC | VP8X_EXIF | VP8X_XMP)) !== 0) return refused('the file declares metadata');
        if ((flags & VP8X_ANIMATION) !== 0) return refused('the file is animated');
        canvas = { width: u24(payload, 4) + 1, height: u24(payload, 7) + 1 };
        break;
      }
      case 'ALPH':
        // The alpha plane of a lossy image: only after VP8X, and before the bitstream.
        if (canvas === undefined || frame !== undefined) return refused('an ALPH chunk is out of place');
        break;
      case 'VP8 ':
      case 'VP8L': {
        if (frame !== undefined) return refused('the file has more than one image');
        frame = id === 'VP8 ' ? vp8Size(payload) : vp8lSize(payload);
        if (frame === undefined) return refused(`the ${id.trim()} bitstream header is not valid`);
        break;
      }
      default:
        return refused(`an unknown chunk is not accepted`);
    }
    first = false;
    // Chunks are padded to an even length; the padding byte, when present, must be inside the file.
    at = end + (size % 2);
    if (at > bytes.length) return refused('the last chunk is missing its padding');
  }
  if (frame === undefined) return refused('the file has no image');
  if (canvas !== undefined && (canvas.width !== frame.width || canvas.height !== frame.height)) {
    return refused('the canvas and the image disagree on the size');
  }
  return { ok: true, width: frame.width, height: frame.height };
}

/**
 * Strict base64: the standard alphabet with padding, nothing else (no line breaks, no URL-safe letters), and in its
 * canonical form, so one upload has one spelling. `undefined` when `text` is not that.
 */
export function decodeBase64Strict(text: string): Buffer | undefined {
  if (text.length === 0 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return undefined;
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : undefined;
}
