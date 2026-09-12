import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

/**
 * `vertical` is a handle you drag left/right (the sidebar's right edge, the slide-over's left
 * edge); `horizontal` is one you drag up/down (the console's top edge). This names the drag axis,
 * matching the `aria-orientation` value a resize separator conventionally carries.
 */
export type HandleOrientation = 'vertical' | 'horizontal';

/** Which arrow key nudges "forward" for each orientation; the caller decides what that means. */
const STEP_KEYS: Readonly<Record<HandleOrientation, { readonly forward: string; readonly backward: string }>> = {
  vertical: { forward: 'ArrowRight', backward: 'ArrowLeft' },
  horizontal: { forward: 'ArrowDown', backward: 'ArrowUp' },
};

export interface PanelHandleProps {
  readonly testId: string;
  /** The accessible name, e.g. "Resize Sidebar". */
  readonly label: string;
  readonly orientation: HandleOrientation;
  /** Current size, in whatever unit the caller manages (a percentage, or pixels). */
  readonly valueNow: number;
  readonly valueMin: number;
  readonly valueMax: number;
  /** Called on every pointer move while dragging, with the pixel delta since the last call. */
  readonly onDrag: (deltaPx: number) => void;
  /** Called once the drag ends (pointerup, or the handle unmounting mid-drag). */
  readonly onDragEnd?: () => void;
  /** Called on the "forward" (`+1`) or "backward" (`-1`) arrow key; a no-op for other keys. */
  readonly onStep: (direction: 1 | -1) => void;
  readonly onDoubleClick: () => void;
}

/**
 * The drag handle shared by the sidebar, the console, and the Code slide-over (§4/§9 of the
 * layout plan): a 4px visible strip inside an 8px hit area, `role="separator"` with
 * `aria-orientation`/`aria-valuenow`/`aria-valuemin`/`aria-valuemax` for assistive tech,
 * arrow-key resizing, and a double-click hook. It is purely gestural — it reports pixel deltas
 * and step directions and leaves unit conversion, clamping, and any collapse threshold to the
 * caller, since the sidebar and console are percentage-sized while the slide-over is pixel-sized.
 */
export function PanelHandle({
  testId,
  label,
  orientation,
  valueNow,
  valueMin,
  valueMax,
  onDrag,
  onDragEnd,
  onStep,
  onDoubleClick,
}: PanelHandleProps) {
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef(0);

  const onPointerMove = useCallback(
    (event: globalThis.PointerEvent) => {
      const pos = orientation === 'vertical' ? event.clientX : event.clientY;
      onDrag(pos - lastPos.current);
      lastPos.current = pos;
    },
    [onDrag, orientation],
  );

  const endDrag = useCallback(() => {
    setDragging(false);
    onDragEnd?.();
  }, [onDragEnd]);

  // The `window` listeners are (re)installed for the duration of the drag rather than once at
  // `pointerdown`, and specifically keyed on `onPointerMove`'s identity: the caller's `onDrag`
  // typically closes over live state (a panel's current size), so a prop that changes mid-drag —
  // as it does for every real caller, since `onDrag` triggers the very state update that produces
  // it — must swap in a fresh listener rather than have the rest of the gesture run against
  // whatever was captured at the first `pointerdown`.
  useEffect(() => {
    if (!dragging) {
      return;
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endDrag);
    };
  }, [dragging, onPointerMove, endDrag]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    lastPos.current = orientation === 'vertical' ? event.clientX : event.clientY;
    setDragging(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const keys = STEP_KEYS[orientation];
    if (event.key === keys.forward) {
      event.preventDefault();
      onStep(1);
    } else if (event.key === keys.backward) {
      event.preventDefault();
      onStep(-1);
    } else if (event.key === 'Enter') {
      // Enter is the keyboard equivalent of a double-click — there is no keyboard "double press" —
      // so a collapsed handle stays operable to collapse/restore from the keyboard, not only a
      // pointer.
      event.preventDefault();
      onDoubleClick();
    }
  };

  return (
    <div
      data-testid={testId}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(valueNow)}
      aria-valuemin={Math.round(valueMin)}
      aria-valuemax={Math.round(valueMax)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
      className={`group relative shrink-0 touch-none outline-none ${
        orientation === 'vertical' ? 'w-2 cursor-col-resize' : 'h-2 cursor-row-resize'
      }`}
    >
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute rounded-full transition-colors ${
          orientation === 'vertical'
            ? 'inset-y-0 left-1/2 w-1 -translate-x-1/2'
            : 'inset-x-0 top-1/2 h-1 -translate-y-1/2'
        } ${
          dragging ? 'bg-handle-active' : 'bg-hairline group-hover:bg-handle-hover group-focus-visible:bg-handle-hover'
        }`}
      />
    </div>
  );
}
