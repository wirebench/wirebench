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
