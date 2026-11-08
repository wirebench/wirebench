/**
 * The crop maths behind the profile image dialog (user profile spec §3, plan ruling 7): which part of the picked
 * image lands in the fixed frame. Pure, so the dialog only draws.
 */

export type CropKind = 'photo' | 'cover';

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Offset {
  readonly x: number;
  readonly y: number;
}

/** A rectangle in source pixels, in the order `drawImage` takes them. */
export interface CropRect {
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
}

/**
 * The size each kind is saved at, restated from the server's `IMAGE_LIMITS`: the renderer imports no engine values
 * (a test pins these to the engine's).
 */
export const CROP_TARGETS: Readonly<Record<CropKind, Size>> = Object.freeze({
  photo: Object.freeze({ width: 256, height: 256 }),
  cover: Object.freeze({ width: 1500, height: 500 }),
});

/** The largest file the dialog hands to the image decoder (spec §3). */
export const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

function clampZoom(zoom: number): number {
  return Number.isFinite(zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) : MIN_ZOOM;
}

/** Frame pixels per source pixel: at zoom 1 the image just covers the frame. */
function scaleFor(image: Size, frame: Size, zoom: number): number {
  return Math.max(frame.width / image.width, frame.height / image.height) * clampZoom(zoom);
}

function clampAxis(value: number, slack: number): number {
  const limit = Math.max(0, slack / 2);
  const clamped = Math.min(limit, Math.max(-limit, Number.isFinite(value) ? value : 0));
  // No -0: a test compares offsets with toEqual, and a frame never cares about the sign of nothing.
  return clamped === 0 ? 0 : clamped;
}

/**
 * The drag offset (frame pixels, from the centred position) kept inside what the image can give: the frame never
 * shows past the image's edge.
 */
export function clampOffset(image: Size, frame: Size, zoom: number, offset: Offset): Offset {
  const scale = scaleFor(image, frame, zoom);
  return {
    x: clampAxis(offset.x, image.width * scale - frame.width),
    y: clampAxis(offset.y, image.height * scale - frame.height),
  };
}

/**
 * The part of the image the frame shows, in source pixels: cover-fit and centred at zoom 1, `zoom` (1–4) scales
 * in about the centre, and `offset` is the user's drag in frame pixels (clamped). Dragging right shows more of the
 * image's left side, as moving a photo under a window does.
 */
export function cropRect(image: Size, frame: Size, zoom: number, offset: Offset): CropRect {
  const scale = scaleFor(image, frame, zoom);
  const { x, y } = clampOffset(image, frame, zoom, offset);
  const left = (frame.width - image.width * scale) / 2 + x;
  const top = (frame.height - image.height * scale) / 2 + y;
  return { sx: -left / scale, sy: -top / scale, sw: frame.width / scale, sh: frame.height / scale };
}

/** Chunks that carry metadata, never pixels: a colour profile, camera details, XMP. */
const METADATA_CHUNKS = new Set(['ICCP', 'EXIF', 'XMP ']);
/** The VP8X flags that announce those chunks (ICC, EXIF, XMP). */
const VP8X_METADATA_FLAGS = 0x20 | 0x08 | 0x04;

function fourCc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

/**
 * The WebP without its metadata chunks, and with the VP8X flags that announced them cleared (user profile spec §9:
 * the server refuses metadata, and a browser's encoder may add a colour profile on its own). Anything that is not a
 * well-formed RIFF/WEBP file comes back unchanged, for the server to judge.
 */
export function stripWebpMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 12 || fourCc(bytes, 0) !== 'RIFF' || fourCc(bytes, 8) !== 'WEBP') return bytes;
  const kept: Uint8Array[] = [];
  let changed = false;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const size = (bytes[at + 4]! | (bytes[at + 5]! << 8) | (bytes[at + 6]! << 16) | (bytes[at + 7]! << 24)) >>> 0;
    const end = at + 8 + size + (size % 2);
    if (end > bytes.length) return bytes;
    const id = fourCc(bytes, at);
    if (METADATA_CHUNKS.has(id)) {
      changed = true;
    } else {
      const chunk = bytes.slice(at, end);
      if (id === 'VP8X' && size >= 1 && (chunk[8]! & VP8X_METADATA_FLAGS) !== 0) {
        chunk[8] = chunk[8]! & ~VP8X_METADATA_FLAGS;
        changed = true;
      }
      kept.push(chunk);
    }
    at = end;
  }
  // A trailing piece shorter than a chunk header means the file is cut short: leave it to the server.
  if (!changed || at !== bytes.length) return bytes;
  const body = kept.reduce((total, chunk) => total + chunk.length, 0);
  const out = new Uint8Array(12 + body);
  out.set(bytes.subarray(0, 12));
  const riffSize = 4 + body;
  out[4] = riffSize & 0xff;
  out[5] = (riffSize >> 8) & 0xff;
  out[6] = (riffSize >> 16) & 0xff;
  out[7] = (riffSize >>> 24) & 0xff;
  let offset = 12;
  for (const chunk of kept) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
