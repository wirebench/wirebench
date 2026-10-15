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

/** Whether `target` is a field Escape cancels an edit in: a text input, a text area or editable content. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(target.type);
}

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file']);

/**
 * The right-hand panel, opened from the right rail's icon: the Code panel for a request, Host details
 * in the SSH area, Environment details in the Environments area. Like the sidebar it sits in the row and takes its width from the content beside it,
 * so nothing (a toolbar button, a card) is ever hidden behind it. Escape and the close icon both
 * dismiss it, and its left edge is a drag handle that remembers the chosen width.
 *
 * Unlike the sidebar and the console, whose handles stay mounted while collapsed so a drag or
 * double-click can reopen them, the closed panel renders nothing at all: it is reopened from the right
 * rail's icon, `view.toggleCode`, or the command palette.
 */
export function SlideOver({ label, open, width, onWidthChange, onToggle, onClose, children }: SlideOverProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // Escape in a text field cancels that edit (a variable's value, a custom colour); it does
      // not also put the panel away.
      if (event.key === 'Escape' && !isTextEntry(event.target)) {
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
      style={{ width: `${String(width)}px` }}
      className="flex min-w-0 shrink-0 border-l border-hairline bg-surface-base"
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
        {/* Scrolls down only: the content is a container, so a narrow panel lays it out narrower (its
            children may not hold it wider) rather than scrolling sideways. */}
        <div className="@container min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-2 *:min-w-0">
          {children}
        </div>
      </div>
    </aside>
  );
}
