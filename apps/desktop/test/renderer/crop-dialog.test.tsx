import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IMAGE_LIMITS } from '@wirebench/engine';
import {
  CROP_TARGETS,
  MAX_IMAGE_FILE_BYTES,
  clampOffset,
  cropRect,
} from '../../src/renderer/features/preferences/user/crop.js';
import {
  CROP_NOT_AN_IMAGE,
  CROP_NO_WEBP,
  CROP_TOO_LARGE,
  CropDialog,
} from '../../src/renderer/features/preferences/user/crop-dialog.js';

describe('cropRect', () => {
  const square = { width: 256, height: 256 };
  const band = { width: 480, height: 160 };

  it.each([
    [
      'a square into a square',
      { width: 1000, height: 1000 },
      square,
      1,
      { x: 0, y: 0 },
      { sx: 0, sy: 0, sw: 1000, sh: 1000 },
    ],
    [
      'a wide image into a square, centred',
      { width: 2000, height: 1000 },
      square,
      1,
      { x: 0, y: 0 },
      { sx: 500, sy: 0, sw: 1000, sh: 1000 },
    ],
    [
      'a tall image into 3:1, centred',
      { width: 600, height: 1200 },
      band,
      1,
      { x: 0, y: 0 },
      { sx: 0, sy: 500, sw: 600, sh: 200 },
    ],
    [
      'zoom 2 about the centre',
      { width: 1000, height: 1000 },
      square,
      2,
      { x: 0, y: 0 },
      { sx: 250, sy: 250, sw: 500, sh: 500 },
    ],
    [
      'a drag right shows the left edge, clamped',
      { width: 2000, height: 1000 },
      square,
      1,
      { x: 9999, y: 0 },
      { sx: 0, sy: 0, sw: 1000, sh: 1000 },
    ],
    [
      'a drag left shows the right edge, clamped',
      { width: 2000, height: 1000 },
      square,
      1,
      { x: -9999, y: 0 },
      { sx: 1000, sy: 0, sw: 1000, sh: 1000 },
    ],
    [
      'a drag down shows the top edge, clamped',
      { width: 600, height: 1200 },
      band,
      1,
      { x: 0, y: 9999 },
      { sx: 0, sy: 0, sw: 600, sh: 200 },
    ],
    [
      'a drag up shows the bottom edge, clamped',
      { width: 600, height: 1200 },
      band,
      1,
      { x: 0, y: -9999 },
      { sx: 0, sy: 1000, sw: 600, sh: 200 },
    ],
    [
      'zoom out of range is held at 4',
      { width: 1000, height: 1000 },
      square,
      10,
      { x: 0, y: 0 },
      { sx: 375, sy: 375, sw: 250, sh: 250 },
    ],
  ])('%s', (_name, image, frame, zoom, offset, expected) => {
    const rect = cropRect(image, frame, zoom, offset);
    expect(rect.sx).toBeCloseTo(expected.sx);
    expect(rect.sy).toBeCloseTo(expected.sy);
    expect(rect.sw).toBeCloseTo(expected.sw);
    expect(rect.sh).toBeCloseTo(expected.sh);
  });

  it('never reaches outside the image', () => {
    const image = { width: 1234, height: 567 };
    for (const zoom of [1, 1.5, 4]) {
      for (const offset of [
        { x: 500, y: 500 },
        { x: -500, y: -500 },
        { x: 37, y: -12 },
      ]) {
        const rect = cropRect(image, band, zoom, offset);
        expect(rect.sx).toBeGreaterThanOrEqual(-1e-9);
        expect(rect.sy).toBeGreaterThanOrEqual(-1e-9);
        expect(rect.sx + rect.sw).toBeLessThanOrEqual(image.width + 1e-9);
        expect(rect.sy + rect.sh).toBeLessThanOrEqual(image.height + 1e-9);
      }
    }
  });
});

describe('clampOffset', () => {
  const frame = { width: 256, height: 256 };
  const wide = { width: 2000, height: 1000 };

  it.each([
    ['inside the slack, unchanged', 1, { x: 40, y: 0 }, { x: 40, y: 0 }],
    ['the right edge', 1, { x: 900, y: 0 }, { x: 128, y: 0 }],
    ['the left edge', 1, { x: -900, y: 0 }, { x: -128, y: 0 }],
    ['no slack on the short side at zoom 1', 1, { x: 0, y: 50 }, { x: 0, y: 0 }],
    ['zoom 2 gives the short side slack', 2, { x: 0, y: 500 }, { x: 0, y: 128 }],
    ['the top edge at zoom 2', 2, { x: 0, y: -500 }, { x: 0, y: -128 }],
  ])('%s', (_name, zoom, offset, expected) => {
    expect(clampOffset(wide, frame, zoom, offset)).toEqual(expected);
  });
});

describe('crop constants', () => {
  it('keeps the renderer’s target sizes equal to the engine’s image limits', () => {
    for (const kind of ['photo', 'cover'] as const) {
      expect(CROP_TARGETS[kind]).toEqual({ width: IMAGE_LIMITS[kind].width, height: IMAGE_LIMITS[kind].height });
    }
  });

  it('caps a picked file at 20 MB before decoding', () => {
    expect(MAX_IMAGE_FILE_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe('CropDialog', () => {
  const decode = vi.fn<(file: Blob) => Promise<ImageBitmap>>();
  const drawImage = vi.fn();

  const bitmap = (width = 800, height = 600): ImageBitmap => ({ width, height, close: vi.fn() });
  const png = (size = 10): File => new File([new Uint8Array(size)], 'me.png', { type: 'image/png' });

  beforeEach(() => {
    vi.stubGlobal('createImageBitmap', decode);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => ({ drawImage, clearRect: vi.fn() }) as unknown as CanvasRenderingContext2D,
    );
  });

  afterEach(() => {
    cleanup();
    decode.mockReset();
    drawImage.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('titles itself by kind', () => {
    decode.mockResolvedValue(bitmap());
    const { rerender } = render(<CropDialog open kind="photo" file={png()} onCancel={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Crop photo' })).toBeTruthy();
    rerender(<CropDialog open kind="cover" file={png()} onCancel={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Crop cover' })).toBeTruthy();
    expect(screen.getByLabelText('Zoom')).toBeTruthy();
  });

  it('refuses a file over 20 MB without decoding it', () => {
    const huge = Object.defineProperty(png(), 'size', { value: MAX_IMAGE_FILE_BYTES + 1 });
    render(<CropDialog open kind="photo" file={huge} onCancel={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByTestId('crop-error').textContent).toBe(CROP_TOO_LARGE);
    expect(decode).not.toHaveBeenCalled();
    expect(screen.getByTestId('crop-save').hasAttribute('disabled')).toBe(true);
  });

  it('says so when the browser cannot decode the file', async () => {
    decode.mockRejectedValue(new Error('InvalidStateError'));
    render(<CropDialog open kind="photo" file={png()} onCancel={vi.fn()} onSave={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('crop-error').textContent).toBe(CROP_NOT_AN_IMAGE));
    expect(screen.getByTestId('crop-save').hasAttribute('disabled')).toBe(true);
  });

  it('calls onCancel from Cancel', async () => {
    decode.mockResolvedValue(bitmap());
    const onCancel = vi.fn();
    render(<CropDialog open kind="photo" file={png()} onCancel={onCancel} onSave={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('crop-preview')).toBeTruthy());
    fireEvent.click(screen.getByTestId('crop-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('saves the frame as base64 WebP at the target size', async () => {
    decode.mockResolvedValue(bitmap(2000, 1000));
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback) {
      callback(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }));
    });
    const onSave = vi.fn();
    render(<CropDialog open kind="photo" file={png()} onCancel={vi.fn()} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('crop-preview')).toBeTruthy());
    // Two nudges right show more of the image's left side.
    fireEvent.keyDown(screen.getByTestId('crop-frame'), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByTestId('crop-frame'), { key: 'ArrowRight' });
    fireEvent.click(screen.getByTestId('crop-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('AQID'));
    const last = drawImage.mock.calls.at(-1) as unknown[];
    const scale = 256 / 1000;
    expect(last.slice(5)).toEqual([0, 0, 256, 256]);
    expect(last[1] as number).toBeCloseTo(500 - 20 / scale);
  });

  it('shows an error when WebP cannot be encoded', async () => {
    decode.mockResolvedValue(bitmap());
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback) {
      callback(new Blob([new Uint8Array([1])], { type: 'image/png' }));
    });
    const onSave = vi.fn();
    render(<CropDialog open kind="cover" file={png()} onCancel={vi.fn()} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('crop-preview')).toBeTruthy());
    fireEvent.click(screen.getByTestId('crop-save'));
    await waitFor(() => expect(screen.getByTestId('crop-error').textContent).toBe(CROP_NO_WEBP));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows the message onSave throws and lets the user try again', async () => {
    decode.mockResolvedValue(bitmap());
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback) {
      callback(new Blob([new Uint8Array([1])], { type: 'image/webp' }));
    });
    const onSave = vi.fn().mockRejectedValue(new Error('The image is too large.'));
    render(<CropDialog open kind="photo" file={png()} onCancel={vi.fn()} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('crop-preview')).toBeTruthy());
    fireEvent.click(screen.getByTestId('crop-save'));
    await waitFor(() => expect(screen.getByTestId('crop-error').textContent).toBe('The image is too large.'));
    expect(screen.getByTestId('crop-save').hasAttribute('disabled')).toBe(false);
  });
});
