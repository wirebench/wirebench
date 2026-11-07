/**
 * The crop dialog behind *Change photo…* and *Change cover…* (user profile spec §3): the picked image under a fixed
 * frame, drag or arrow keys to move it, a zoom slider, and Save, which hands back the frame as WebP at the size the
 * server stores. The picked file only ever goes to the browser's image decoder (spec §9).
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../../components/button.js';
import {
  CROP_TARGETS,
  MAX_IMAGE_FILE_BYTES,
  MAX_ZOOM,
  MIN_ZOOM,
  clampOffset,
  cropRect,
  type CropKind,
  type Offset,
  type Size,
} from './crop.js';

export interface CropDialogProps {
  readonly open: boolean;
  readonly kind: CropKind;
  readonly file: File | undefined;
  readonly onCancel: () => void;
  /** The cropped image as base64 WebP, at the kind's target size. A throw shows its message in the dialog. */
  readonly onSave: (webpBase64: string) => Promise<void> | void;
}

/** The frame on screen, in CSS pixels: the photo's circle and the cover's 3:1 band. */
const FRAMES: Readonly<Record<CropKind, Size>> = Object.freeze({
  photo: Object.freeze({ width: 256, height: 256 }),
  cover: Object.freeze({ width: 480, height: 160 }),
});

const NUDGE = 10;
const NUDGE_LARGE = 50;
const WEBP_QUALITY = 0.85;

export const CROP_NOT_AN_IMAGE = 'This file is not an image Wirebench can read.';
export const CROP_TOO_LARGE = 'This file is larger than 20 MB. Pick a smaller image.';
export const CROP_NO_WEBP = 'This app cannot save WebP images here.';

const ZERO: Offset = { x: 0, y: 0 };

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/webp', WEBP_QUALITY);
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function draw(canvas: HTMLCanvasElement | null, bitmap: ImageBitmap, frame: Size, zoom: number, offset: Offset): void {
  const context = canvas?.getContext('2d');
  if (!canvas || !context) {
    return;
  }
  const rect = cropRect(bitmap, frame, zoom, offset);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, canvas.width, canvas.height);
}

export function CropDialog({ open, kind, file, onCancel, onSave }: CropDialogProps) {
  const frame = FRAMES[kind];
  const target = CROP_TARGETS[kind];
  const [bitmap, setBitmap] = useState<ImageBitmap | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState<Offset>(ZERO);
  const [busy, setBusy] = useState(false);
  const preview = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<{ pointer: number; startX: number; startY: number; from: Offset } | undefined>(undefined);

  // Each file starts centred at 1×; an oversize file is refused before the decoder ever sees it.
  useEffect(() => {
    setBitmap(undefined);
    setError(undefined);
    setZoom(MIN_ZOOM);
    setOffset(ZERO);
    setBusy(false);
    if (!open || file === undefined) {
      return;
    }
    if (file.size > MAX_IMAGE_FILE_BYTES) {
      setError(CROP_TOO_LARGE);
      return;
    }
    let live = true;
    let decoded: ImageBitmap | undefined;
    createImageBitmap(file).then(
      (result) => {
        decoded = result;
        if (live) {
          setBitmap(result);
        } else {
          result.close();
        }
      },
      () => {
        if (live) {
          setError(CROP_NOT_AN_IMAGE);
        }
      },
    );
    return () => {
      live = false;
      decoded?.close();
    };
  }, [open, file]);

  useEffect(() => {
    if (bitmap) {
      draw(preview.current, bitmap, frame, zoom, offset);
    }
  }, [bitmap, frame, zoom, offset]);

  const move = (next: Offset): void => {
    if (bitmap) {
      setOffset(clampOffset(bitmap, frame, zoom, next));
    }
  };

  const changeZoom = (next: number): void => {
    setZoom(next);
    if (bitmap) {
      setOffset((current) => clampOffset(bitmap, frame, next, current));
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!bitmap || busy) {
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, from: offset };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (current?.pointer !== event.pointerId) {
      return;
    }
    move({ x: current.from.x + event.clientX - current.startX, y: current.from.y + event.clientY - current.startY });
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointer === event.pointerId) {
      drag.current = undefined;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? NUDGE_LARGE : NUDGE;
    const deltas: Readonly<Record<string, Offset>> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const delta = deltas[event.key];
    if (delta === undefined || !bitmap || busy) {
      return;
    }
    event.preventDefault();
    move({ x: offset.x + delta.x, y: offset.y + delta.y });
  };

  const save = async (): Promise<void> => {
    if (!bitmap) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = target.width;
      canvas.height = target.height;
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error(CROP_NO_WEBP);
      }
      const rect = cropRect(bitmap, frame, zoom, offset);
      context.drawImage(bitmap, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, target.width, target.height);
      const blob = await toBlob(canvas);
      // A browser without a WebP encoder quietly hands back PNG; the server stores WebP only.
      if (blob?.type !== 'image/webp') {
        throw new Error(CROP_NO_WEBP);
      }
      await onSave(await blobToBase64(blob));
    } catch (failure) {
      setError(failure instanceof Error && failure.message.length > 0 ? failure.message : 'Could not save the image.');
    } finally {
      setBusy(false);
    }
  };

  const title = kind === 'photo' ? 'Crop photo' : 'Crop cover';

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) {
          onCancel();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          aria-describedby="crop-dialog-hint"
          data-testid="crop-dialog"
          className="fixed top-1/2 left-1/2 w-[33rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">{title}</Dialog.Title>
          <p id="crop-dialog-hint" className="mt-1 text-sm text-fg-muted">
            Drag the image or use the arrow keys to move it. Zoom to fill the frame.
          </p>
          <div className="mt-3 flex justify-center">
            <div
              data-testid="crop-frame"
              role="group"
              aria-label="Image position"
              aria-roledescription="crop frame"
              tabIndex={bitmap ? 0 : -1}
              style={{ width: frame.width, height: frame.height }}
              className={`relative touch-none overflow-hidden bg-surface-base ring-1 ring-hairline-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                kind === 'photo' ? 'rounded-full' : 'rounded-md'
              } ${bitmap ? 'cursor-grab active:cursor-grabbing' : ''}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
              onKeyDown={onKeyDown}
            >
              {bitmap ? (
                <canvas
                  ref={preview}
                  data-testid="crop-preview"
                  width={frame.width}
                  height={frame.height}
                  className="pointer-events-none block h-full w-full"
                />
              ) : (
                error === undefined && (
                  <span className="absolute inset-0 flex items-center justify-center text-sm text-fg-subtle">
                    Loading…
                  </span>
                )
              )}
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3 text-sm text-fg-default">
            <label htmlFor="crop-zoom">Zoom</label>
            <input
              id="crop-zoom"
              data-testid="crop-zoom"
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.01}
              value={zoom}
              disabled={!bitmap || busy}
              aria-valuetext={`${zoom.toFixed(1)}×`}
              className="min-w-0 flex-1 accent-accent"
              onChange={(event) => changeZoom(Number(event.target.value))}
            />
            <span className="w-10 text-right text-fg-subtle tabular-nums">{zoom.toFixed(1)}×</span>
          </div>
          {error !== undefined && (
            <p role="alert" data-testid="crop-error" className="mt-2 text-sm text-status-danger">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button data-testid="crop-cancel" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" data-testid="crop-save" disabled={!bitmap || busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
