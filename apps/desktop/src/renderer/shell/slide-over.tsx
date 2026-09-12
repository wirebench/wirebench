import { useEffect } from 'react';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton } from '../components/icon-button.js';
import { PanelHandle } from './panel-handle.js';

/** The width the left-edge handle will not drag the panel narrower or wider than. */
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;
/** The width a double-click on the handle restores — there is no per-session "last size" concept
    for the slide-over the way there is for the sidebar/console, so it resets to this instead. */
const DEFAULT_WIDTH = 420;
/** Arrow-key resize step, in pixels. */
const STEP_PX = 16;

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

  // The handle sits on the panel's left edge and the panel is anchored right, so dragging the
  // pointer left (a negative delta) widens it — the opposite sign from the sidebar's handle.
  const onDrag = (deltaPx: number): void => {
    onWidthChange(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width - deltaPx)));
  };
  const onStep = (direction: 1 | -1): void => {
    onWidthChange(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width - direction * STEP_PX)));
  };

  return (
    <aside
      id="slide-over"
      data-testid="slide-over"
      aria-label={label}
      style={{ width: `${String(width)}px`, right: 'var(--wb-right-rail-width)' }}
      className="absolute inset-y-0 z-30 flex min-w-0 border-l border-hairline bg-surface-base shadow-lg"
    >
      <PanelHandle
        testId="panel-handle-slide-over"
        label={`Resize ${label}`}
        orientation="vertical"
        valueNow={width}
        valueMin={MIN_WIDTH}
        valueMax={MAX_WIDTH}
        onDrag={onDrag}
        onStep={onStep}
        onDoubleClick={() => {
          onWidthChange(DEFAULT_WIDTH);
        }}
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
