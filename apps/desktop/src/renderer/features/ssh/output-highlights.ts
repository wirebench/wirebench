/**
 * Draws the output highlights (#424) over one terminal: the visible rows are matched again after each
 * write, scroll and resize, at most once a frame, and every match becomes a decoration that recolours its
 * cells. The buffer keeps the bytes the remote program sent; switching the preference off takes every
 * decoration away.
 *
 * Only text in the default colours is highlighted, so a program that colours its own output keeps its
 * colours; full-screen programs (the alternate buffer) are left alone.
 */
import type { IBufferLine, IDecoration, IDisposable, IMarker, ITheme, Terminal } from '@xterm/xterm';
import { usePreferencesStore } from '../../state/preferences.js';
import { findHighlights, type HighlightKind } from './output-highlight.js';

export interface OutputHighlights {
  /** Matches the visible rows again on the next frame, after a theme or scheme change for instance. */
  refresh(): void;
  dispose(): void;
}

/** The terminal palette entry each kind is drawn in, so it follows the app theme and the colour scheme. */
const PALETTE: Readonly<Record<HighlightKind, keyof ITheme>> = {
  error: 'red',
  warning: 'yellow',
  info: 'blue',
  address: 'cyan',
};

/** The design token each kind falls back to when the palette entry is unset or not `#RRGGBB`. */
const TOKEN: Readonly<Record<HighlightKind, string>> = {
  error: '--wb-status-danger',
  warning: '--wb-status-warning',
  info: '--wb-status-info',
  address: '--wb-accent-default',
};

function hex(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : undefined;
}

function colourOf(term: Terminal, kind: HighlightKind): string | undefined {
  const fromTheme = term.options.theme?.[PALETTE[kind]];
  return (
    hex(typeof fromTheme === 'string' ? fromTheme : undefined) ??
    hex(getComputedStyle(document.documentElement).getPropertyValue(TOKEN[kind]))
  );
}

/** A row's text, and for each of its characters the cell it starts in (wide characters take two cells). */
function rowText(line: IBufferLine): { text: string; cells: number[] } {
  let text = '';
  const cells: number[] = [];
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x);
    if (cell === undefined) break;
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars() || ' ';
    for (let i = 0; i < chars.length; i += 1) cells.push(x);
    text += chars;
  }
  cells.push(line.length);
  return { text, cells };
}

/** Whether every cell from `start` to `end` is in the default colours, so a highlight hides nothing. */
function plain(line: IBufferLine, start: number, end: number): boolean {
  for (let x = start; x < end; x += 1) {
    const cell = line.getCell(x);
    if (cell === undefined || !cell.isFgDefault() || !cell.isBgDefault() || cell.isInverse() !== 0) return false;
  }
  return true;
}

export function attachOutputHighlights(term: Terminal): OutputHighlights {
  let shown: { marker: IMarker; decoration: IDecoration | undefined }[] = [];
  let frame: number | undefined;

  const clear = (): void => {
    for (const { marker, decoration } of shown) {
      decoration?.dispose();
      marker.dispose();
    }
    shown = [];
  };

  const paint = (): void => {
    frame = undefined;
    clear();
    const buffer = term.buffer.active;
    if (!usePreferencesStore.getState().preferences.terminal.highlightOutput || buffer.type === 'alternate') return;
    const cursorLine = buffer.baseY + buffer.cursorY;
    for (let row = 0; row < term.rows; row += 1) {
      const y = buffer.viewportY + row;
      const line = buffer.getLine(y);
      if (line === undefined) continue;
      const { text, cells } = rowText(line);
      for (const highlight of findHighlights(text)) {
        const x = cells[highlight.start] ?? 0;
        const end = cells[highlight.end] ?? line.length;
        const colour = colourOf(term, highlight.kind);
        if (colour === undefined || end <= x || !plain(line, x, end)) continue;
        const marker = term.registerMarker(y - cursorLine);
        if (marker === undefined) continue;
        const decoration = term.registerDecoration({ marker, x, width: end - x, foregroundColor: colour });
        decoration?.onRender((element) => {
          element.classList.add('wb-output-highlight');
          element.dataset['highlight'] = highlight.kind;
        });
        shown.push({ marker, decoration });
      }
    }
  };

  const schedule = (): void => {
    frame ??= requestAnimationFrame(paint);
  };

  const listeners: IDisposable[] = [term.onWriteParsed(schedule), term.onScroll(schedule), term.onResize(schedule)];
  const unsubscribe = usePreferencesStore.subscribe((state, previous) => {
    if (state.preferences.terminal.highlightOutput !== previous.preferences.terminal.highlightOutput) schedule();
  });
  schedule();

  return {
    refresh: schedule,
    dispose() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      for (const listener of listeners) listener.dispose();
      unsubscribe();
      clear();
    },
  };
}
