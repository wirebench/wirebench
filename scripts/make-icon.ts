/**
 * Regenerates `apps/desktop/resources/icon.png`, the single 1024×1024 source image
 * electron-builder derives every platform icon from (`.icns`, `.ico`, Linux png set).
 *
 * The icon is drawn in code rather than exported from a design tool so it needs no binary
 * asset pipeline and no image dependency: a PNG is just zlib-deflated scanlines, and the
 * artwork is a signed-distance field over a handful of line segments — the Wirebench "wire",
 * a probe line stepping across a dark rounded square.
 *
 * Run with `node scripts/make-icon.ts`; commit the PNG it writes.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;

/** One RGB colour, 0-255 per channel. */
type Rgb = readonly [number, number, number];

const BACKGROUND: Rgb = [15, 23, 42];
const WIRE: Rgb = [56, 189, 248];
const NODE: Rgb = [226, 232, 240];

/** A straight segment of the wire, in icon pixels. */
interface Segment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/**
 * The waveform: a flat lead-in, a step up, a step down and a flat lead-out — a square pulse
 * travelling along a wire, which is what the app does to a SOAP envelope.
 */
const SEGMENTS: readonly Segment[] = [
  { x1: 150, y1: 562, x2: 330, y2: 562 },
  { x1: 330, y1: 562, x2: 330, y2: 346 },
  { x1: 330, y1: 346, x2: 604, y2: 346 },
  { x1: 604, y1: 346, x2: 604, y2: 562 },
  { x1: 604, y1: 562, x2: 874, y2: 562 },
];

const NODES: readonly (readonly [number, number])[] = [
  [150, 562],
  [874, 562],
  [467, 346],
];

/** Distance from `(px, py)` to the segment, used as the stroke's distance field. */
function distanceToSegment(px: number, py: number, segment: Segment): number {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((px - segment.x1) * dx + (py - segment.y1) * dy) / lengthSquared));
  return Math.hypot(px - (segment.x1 + t * dx), py - (segment.y1 + t * dy));
}

/** Signed distance to the rounded square that forms the icon's plate (negative = inside). */
function plateDistance(px: number, py: number): number {
  const half = SIZE / 2 - 40;
  const radius = 190;
  const qx = Math.abs(px - SIZE / 2) - (half - radius);
  const qy = Math.abs(py - SIZE / 2) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Linear blend of two colours; `amount` 0 keeps `from`, 1 takes `to`. */
function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  const clamped = Math.min(1, Math.max(0, amount));
  return [
    Math.round(from[0] + (to[0] - from[0]) * clamped),
    Math.round(from[1] + (to[1] - from[1]) * clamped),
    Math.round(from[2] + (to[2] - from[2]) * clamped),
  ];
}

/** Antialiased coverage for a distance field: 1 well inside the shape, 0 well outside. */
function coverage(distance: number): number {
  return Math.min(1, Math.max(0, 0.5 - distance));
}

/** RGBA scanlines, each prefixed with PNG filter byte 0. */
function renderRaw(): Buffer {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  let offset = 0;
  for (let y = 0; y < SIZE; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < SIZE; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const plate = coverage(plateDistance(px, py));
      const wire = coverage(Math.min(...SEGMENTS.map((segment) => distanceToSegment(px, py, segment))) - 26);
      const node = coverage(Math.min(...NODES.map(([nx, ny]) => Math.hypot(px - nx, py - ny))) - 54);
      // The plate's own vertical gradient keeps the dark square from looking flat.
      const base = mix(BACKGROUND, [30, 41, 59], y / SIZE);
      const colour = mix(mix(base, WIRE, wire), NODE, node);
      raw[offset] = colour[0];
      raw[offset + 1] = colour[1];
      raw[offset + 2] = colour[2];
      raw[offset + 3] = Math.round(plate * 255);
      offset += 4;
    }
  }
  return raw;
}

/** One PNG chunk: length, type, payload, CRC-32. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

/** CRC-32 as PNG defines it. */
function crc32(data: Buffer): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // colour type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(renderRaw(), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const target = fileURLToPath(new URL('../apps/desktop/resources/icon.png', import.meta.url));
writeFileSync(target, png);
process.stdout.write(`wrote ${target} (${png.length} bytes)\n`);
