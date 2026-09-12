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
  /** Whether the slide-over is open. `false` renders nothing at all (see below). */
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
 * Unlike the sidebar and the console — which are in normal flow, and whose handles stay
 * hit-testable while collapsed so a drag or double-click can reopen them — this one is
 * `absolute` and sits *in front of* the editor area. A handle left behind while closed is
 * therefore an invisible strip over the editor's right edge that swallows clicks and
 * drag-selection there, so the closed panel renders nothing at all and takes no pointer events.
 * It is reopened from the right rail's Code icon, `view.toggleCode`, or the command palette.
 * Being out of flow, it never shifts the editor area either way.
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
  const onDrag = (deltaPx: number): void => {
    onWidthChange(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width - deltaPx)));
  };
  const onStep = (direction: 1 | -1): void => {
    onWidthChange(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width - direction * STEP_PX)));
  };

  if (!open) {
    return null;
  }

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
        onDoubleClick={onToggle}
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
