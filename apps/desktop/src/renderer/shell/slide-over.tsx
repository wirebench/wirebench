import { useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton } from '../components/icon-button.js';

/** The width the left-edge handle will not drag the panel narrower or wider than. */
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;

export interface SlideOverProps {
  readonly label: string;
  readonly width: number;
  readonly onWidthChange: (width: number) => void;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/**
 * The overlay that replaced the right panel's remaining content: anchored to the right edge, in
 * front of the editor area rather than resizing it, opened from the right rail's icon. Only the
 * Code panel lives here today (`shell/code-panel.tsx`); Escape and the close icon both dismiss
 * it, and its left edge is a drag handle that remembers the chosen width.
 */
export function SlideOver({ label, width, onWidthChange, onClose, children }: SlideOverProps) {
  const dragging = useRef<{ readonly startX: number; readonly startWidth: number } | undefined>(undefined);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      if (dragging.current === undefined) {
        return;
      }
      // The handle sits on the panel's left edge and the panel is anchored right, so dragging
      // the pointer left (a smaller clientX) widens it.
      const delta = dragging.current.startX - event.clientX;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragging.current.startWidth + delta));
      onWidthChange(next);
    },
    [onWidthChange],
  );

  const endDrag = useCallback(() => {
    dragging.current = undefined;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
  }, [onPointerMove]);

  const onHandlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    dragging.current = { startX: event.clientX, startWidth: width };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
  };

  // Cleanup for the rare case the panel unmounts (e.g. its own close) mid-drag.
  useEffect(() => () => endDrag(), [endDrag]);

  return (
    <aside
      id="slide-over"
      data-testid="slide-over"
      aria-label={label}
      style={{ width: `${String(width)}px`, right: 'var(--wb-right-rail-width)' }}
      className="absolute inset-y-0 z-30 flex min-w-0 border-l border-hairline bg-surface-base shadow-lg"
    >
      <div
        data-testid="panel-handle-slide-over"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label}`}
        onPointerDown={onHandlePointerDown}
        className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-accent-muted focus-visible:bg-accent"
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-row shrink-0 items-center justify-between border-b border-hairline pl-3 pr-2">
          <span className="text-sm font-medium text-fg-default">{label}</span>
          <IconButton
            label="Close"
            data-testid="slide-over-close"
            onClick={() => {
              onClose();
            }}
          >
            <X size={14} aria-hidden="true" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">{children}</div>
      </div>
    </aside>
  );
}
