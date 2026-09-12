import { useEffect } from 'react';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton } from '../components/icon-button.js';
import { PanelHandle } from './panel-handle.js';

/** The width the left-edge handle will not drag the panel narrower or wider than. */
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;
/** Arrow-key resize step, in pixels. */
const STEP_PX = 16;

export interface SlideOverProps {
  readonly label: string;
  /** Whether the slide-over is open. `false` renders only its handle (see below). */
  readonly open: boolean;
  readonly width: number;
  readonly onWidthChange: (width: number) => void;
  /** Flips `open` either way — what a double-click on the handle does. */
  readonly onToggle: () => void;
  /** Closes the slide-over unconditionally — Escape and the header's close icon. */
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/**
 * The overlay that replaced the right panel's remaining content: anchored to the right edge, in
 * front of the editor area rather than resizing it, opened from the right rail's icon. Only the
 * Code panel lives here today (`shell/code-panel.tsx`); Escape and the close icon both dismiss
 * it, and its left edge is a drag handle that remembers the chosen width.
 *
 * The component itself stays mounted regardless of `open`: while closed it renders nothing but
 * its handle, anchored at the same right edge, so a double-click can still reach it and reopen
 * the panel — the same "handle survives the collapse" contract the sidebar and console follow.
 * Being `absolute` and out of flow, this never shifts the editor area either way.
 */
export function SlideOver({ label, open, width, onWidthChange, onToggle, onClose, children }: SlideOverProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  // The handle sits on the panel's left edge and the panel is anchored right, so dragging the
  // pointer left (a negative delta) widens it — the opposite sign from the sidebar's handle.
  // Both are no-ops while closed: there is nothing to resize until the panel reopens.
  const onDrag = (deltaPx: number): void => {
    if (!open) {
      return;
    }
    onWidthChange(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width - deltaPx)));
  };
  const onStep = (direction: 1 | -1): void => {
    if (!open) {
      return;
    }
    onWidthChange(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width - direction * STEP_PX)));
  };

  return (
    <aside
      id="slide-over"
      data-testid="slide-over"
      aria-label={label}
      style={
        open
          ? { width: `${String(width)}px`, right: 'var(--wb-right-rail-width)' }
          : { right: 'var(--wb-right-rail-width)' }
      }
      className={`absolute inset-y-0 z-30 flex min-w-0 ${
        open ? 'border-l border-hairline bg-surface-base shadow-lg' : ''
      }`}
    >
      <PanelHandle
        testId="panel-handle-slide-over"
        label={open ? `Resize ${label}` : `Show ${label}`}
        orientation="vertical"
        valueNow={open ? width : 0}
        valueMin={MIN_WIDTH}
        valueMax={MAX_WIDTH}
        onDrag={onDrag}
        onStep={onStep}
        onDoubleClick={onToggle}
      />
      {open && (
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
      )}
    </aside>
  );
}
