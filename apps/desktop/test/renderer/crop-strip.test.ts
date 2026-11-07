import { describe, expect, it } from 'vitest';
import { stripWebpMetadata } from '../../src/renderer/features/preferences/user/crop.js';

function chunk(id: string, payload: number[]): number[] {
  const size = payload.length;
  const bytes = [...id].map((c) => c.charCodeAt(0));
  bytes.push(size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff, ...payload);
  if (size % 2 === 1) bytes.push(0);
  return bytes;
}

function webp(...chunks: number[][]): Uint8Array {
  const body = chunks.flat();
  const riff = 4 + body.length;
  return new Uint8Array([
    ...[...'RIFF'].map((c) => c.charCodeAt(0)),
    riff & 0xff,
    (riff >> 8) & 0xff,
    (riff >> 16) & 0xff,
    (riff >> 24) & 0xff,
    ...[...'WEBP'].map((c) => c.charCodeAt(0)),
    ...body,
  ]);
}

function ids(bytes: Uint8Array): string[] {
  const found: string[] = [];
  let at = 12;
  while (at + 8 <= bytes.length) {
    const size = bytes[at + 4]! | (bytes[at + 5]! << 8) | (bytes[at + 6]! << 16) | (bytes[at + 7]! << 24);
    found.push(String.fromCharCode(...bytes.subarray(at, at + 4)));
    at += 8 + size + (size % 2);
  }
  return found;
}

describe('stripWebpMetadata (user profile spec §9)', () => {
  // VP8X flags: ICC 0x20, alpha 0x10, EXIF 0x08, XMP 0x04.
  const vp8x = (flags: number) => chunk('VP8X', [flags, 0, 0, 0, 255, 0, 0, 255, 0, 0]);

  it('drops a colour profile and camera details, and clears their flags', () => {
    const input = webp(
      vp8x(0x20 | 0x10 | 0x08),
      chunk('ICCP', [1, 2, 3]),
      chunk('ALPH', [9]),
      chunk('VP8 ', [7, 7]),
      chunk('EXIF', [4]),
    );
    const out = stripWebpMetadata(input);
    expect(ids(out)).toEqual(['VP8X', 'ALPH', 'VP8 ']);
    // The alpha flag stays; the ICC and EXIF flags are gone.
    expect(out[20]).toBe(0x10);
    const riff = out[4]! | (out[5]! << 8) | (out[6]! << 16) | (out[7]! << 24);
    expect(riff).toBe(out.length - 8);
  });

  it('leaves a file without metadata as it was', () => {
    const input = webp(vp8x(0x10), chunk('ALPH', [9]), chunk('VP8 ', [7, 7]));
    expect(stripWebpMetadata(input)).toBe(input);
  });

  it('leaves anything that is not a well-formed WebP to the server', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(stripWebpMetadata(png)).toBe(png);
    const truncated = webp(vp8x(0x20), chunk('ICCP', [1, 2, 3])).slice(0, 33);
    expect(stripWebpMetadata(truncated)).toBe(truncated);
  });
});
