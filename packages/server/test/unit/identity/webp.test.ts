import { describe, expect, it } from 'vitest';
import { checkWebp, decodeBase64Strict } from '../../../src/identity/webp.js';
import { chunk, riff, vp8, vp8l, vp8x } from '../../helpers/webp.js';

const VP8X_ALPHA = 0x10;

describe('checkWebp (user profile ruling 2)', () => {
  it('reads the size of a lossy, a lossless and an extended still image', () => {
    expect(checkWebp(riff(vp8(256, 256)))).toEqual({ ok: true, width: 256, height: 256 });
    expect(checkWebp(riff(vp8l(1500, 500)))).toEqual({ ok: true, width: 1500, height: 500 });
    expect(checkWebp(riff(vp8x(256, 256), vp8l(256, 256)))).toEqual({ ok: true, width: 256, height: 256 });
    // Alpha beside a lossy bitstream, as a canvas with transparency writes it.
    expect(checkWebp(riff(vp8x(256, 256, VP8X_ALPHA), chunk('ALPH', Buffer.alloc(9, 1)), vp8(256, 256)))).toMatchObject(
      { ok: true },
    );
  });

  it.each([
    ['EXIF', 0x08],
    ['XMP ', 0x04],
    ['ICCP', 0x20],
  ])('refuses %s metadata, as a chunk or as a VP8X flag', (id, flag) => {
    expect(checkWebp(riff(vp8x(256, 256), chunk(id, Buffer.alloc(8, 1)), vp8(256, 256)))).toMatchObject({ ok: false });
    expect(checkWebp(riff(vp8x(256, 256, flag), vp8(256, 256)))).toMatchObject({
      ok: false,
      reason: 'the file declares metadata',
    });
    // Trailing after the image, where an encoder puts EXIF, too.
    expect(checkWebp(riff(vp8x(256, 256), vp8(256, 256), chunk(id, Buffer.alloc(8, 1))))).toMatchObject({ ok: false });
  });

  it('refuses an animation, by flag or by its chunks', () => {
    expect(checkWebp(riff(vp8x(256, 256, 0x02), vp8(256, 256)))).toMatchObject({ reason: 'the file is animated' });
    expect(checkWebp(riff(vp8x(256, 256), chunk('ANIM', Buffer.alloc(6)), vp8(256, 256)))).toMatchObject({ ok: false });
    expect(checkWebp(riff(vp8x(256, 256), chunk('ANMF', Buffer.alloc(16)), vp8(256, 256)))).toMatchObject({
      ok: false,
    });
    expect(checkWebp(riff(vp8(256, 256), vp8(256, 256)))).toMatchObject({ reason: 'the file has more than one image' });
  });

  it('refuses a file that is not RIFF/WEBP, or whose RIFF size is wrong', () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    expect(checkWebp(png)).toMatchObject({ reason: 'not a WebP file' });
    expect(checkWebp(Buffer.from('RIFF\u0004\u0000\u0000\u0000WAVE', 'latin1'))).toMatchObject({ ok: false });
    const file = riff(vp8(256, 256));
    expect(checkWebp(Buffer.concat([file, Buffer.alloc(2)]))).toMatchObject({
      reason: 'the RIFF size does not match the file',
    });
    expect(checkWebp(Buffer.alloc(0))).toMatchObject({ ok: false });
  });

  it('refuses a truncated file, chunk header or bitstream header', () => {
    const file = riff(vp8(256, 256));
    const cut = file.subarray(0, file.length - 4);
    cut.writeUInt32LE(cut.length - 8, 4);
    expect(checkWebp(cut)).toMatchObject({ ok: false });
    expect(checkWebp(riff(Buffer.from('VP8 ', 'latin1')))).toMatchObject({ reason: 'a chunk header is cut short' });
    expect(checkWebp(riff(chunk('VP8 ', Buffer.from([0x10, 0x02, 0x00, 0x9d]))))).toMatchObject({ ok: false });
    expect(checkWebp(riff())).toMatchObject({ reason: 'the file has no image' });
  });

  it('refuses a bad start code, an inter frame, a bad lossless signature or version', () => {
    const lossy = vp8(256, 256);
    const badStart = Buffer.from(lossy);
    badStart[8 + 3] = 0x00;
    expect(checkWebp(riff(badStart))).toMatchObject({ ok: false });
    const interFrame = Buffer.from(lossy);
    interFrame[8] = 0x11;
    expect(checkWebp(riff(interFrame))).toMatchObject({ ok: false });
    const lossless = vp8l(256, 256);
    const badSignature = Buffer.from(lossless);
    badSignature[8] = 0x2e;
    expect(checkWebp(riff(badSignature))).toMatchObject({ ok: false });
    const badVersion = Buffer.from(lossless);
    badVersion[8 + 4] = badVersion[8 + 4]! | 0x20;
    expect(checkWebp(riff(badVersion))).toMatchObject({ ok: false });
  });

  it('refuses a canvas that disagrees with its image, a misplaced VP8X or ALPH, and an unknown chunk', () => {
    expect(checkWebp(riff(vp8x(300, 256), vp8(256, 256)))).toMatchObject({
      reason: 'the canvas and the image disagree on the size',
    });
    expect(checkWebp(riff(vp8(256, 256), vp8x(256, 256)))).toMatchObject({ reason: 'VP8X is not the first chunk' });
    expect(checkWebp(riff(chunk('ALPH', Buffer.alloc(4)), vp8(256, 256)))).toMatchObject({ ok: false });
    expect(checkWebp(riff(vp8(256, 256), chunk('ABCD', Buffer.alloc(4))))).toMatchObject({
      reason: 'an unknown chunk is not accepted',
    });
  });
});

describe('decodeBase64Strict', () => {
  it('decodes canonical padded base64', () => {
    expect(decodeBase64Strict('aGVsbG8=')?.toString()).toBe('hello');
    expect(decodeBase64Strict('aGk=')?.toString()).toBe('hi');
  });

  it.each(['', 'aGVsbG8', 'aGVs bG8=', 'aGVs\nbG8=', 'aGVsbG8_', 'a-Vs', '====', 'aGk==', 'aGl='])(
    'refuses %j',
    (text) => {
      expect(decodeBase64Strict(text)).toBeUndefined();
    },
  );
});
