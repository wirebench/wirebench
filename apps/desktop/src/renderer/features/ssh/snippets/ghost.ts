/**
 * Inline snippet suggestions in one terminal pane (spec D7): the rest of a matching snippet's first line,
 * dimmed after the cursor as an xterm decoration, with the snippet's name and `Tab` at the right edge. Tab
 * while it shows accepts: the snippet is typed from where the user stopped, without Enter.
 */
import type { IDecoration, IDisposable, Terminal } from '@xterm/xterm';
import { usePreferencesStore } from '../../../state/preferences.js';
import { startRun } from './run.js';
import { recentSnippetIds } from './snippets-prefs.js';
import { useSnippetsStore } from './snippets-store.js';
import { createLineTracker, matchSnippet } from './suggest.js';
import type { SnippetListItemWire } from '@shared/snippets-wire.js';

export interface SnippetSuggestions {
  /** What the user typed (xterm `onData`), before it goes to the session. */
  input(data: string): void;
  /** The next `onData` is a paste (xterm's own, or `term.paste`): the line becomes unknown. */
  markPaste(): void;
  /** For xterm's custom key handler: `true` when the key accepted a ghost and must not reach the shell. */
  handleKey(event: KeyboardEvent): boolean;
  dispose(): void;
}

interface Shown {
  readonly item: SnippetListItemWire;
  readonly skip: number;
  /** The column it was drawn at: a write that leaves the cursor there keeps it. */
  readonly x: number;
  readonly decoration: IDecoration | undefined;
}

function render(element: HTMLElement, term: Terminal, rest: string, name: string): void {
  element.dataset['testid'] = 'snippet-ghost';
  element.classList.add('wb-snippet-ghost');
  element.style.fontFamily = String(term.options.fontFamily ?? '');
  element.style.fontSize = `${String(term.options.fontSize ?? 13)}px`;
  element.style.lineHeight = element.style.height;
  const text = document.createElement('span');
  text.className = 'wb-snippet-ghost-text';
  text.textContent = rest;
  const label = document.createElement('span');
  label.className = 'wb-snippet-ghost-label';
  label.textContent = `${name} · Tab`;
  element.replaceChildren(text, label);
}

/** Wires suggestions to a pane's terminal; `connected` says whether keystrokes reach a live session. */
export function attachSnippetSuggestions(term: Terminal, opts: { connected: () => boolean }): SnippetSuggestions {
  const tracker = createLineTracker();
  let pasting = false;
  // The snippet the typed line matches, drawn once the shell has echoed that line (and again on each write).
  let wanted: SnippetListItemWire | undefined;
  let shown: Shown | undefined;
  if (!useSnippetsStore.getState().loaded) {
    useSnippetsStore
      .getState()
      .refresh()
      .catch(() => undefined); // no list, no suggestions; the next snippets change reads it again
  }

  const hide = (): void => {
    shown?.decoration?.dispose();
    shown = undefined;
  };
  const offered = (): boolean =>
    opts.connected() &&
    term.buffer.active.type !== 'alternate' &&
    usePreferencesStore.getState().preferences.terminal.snippetSuggestions;

  // The ghost goes after the echo of what was typed, where the cursor is once the shell has written it. A
  // write can be the echo of an earlier key while the last one is still on its way (fast typing, a slow link),
  // so every write checks again: the ghost shows only while the text before the cursor ends with the typed
  // line, and moves when the cursor does (#594).
  const parsed: IDisposable = term.onWriteParsed(() => {
    const item = wanted;
    const line = tracker.line;
    if (item === undefined || line === undefined || !offered()) {
      hide();
      return;
    }
    const buffer = term.buffer.active;
    const { cursorX } = buffer;
    const before = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(false, 0, cursorX) ?? '';
    // A line longer than the row wrapped: only its tail is on the cursor's row.
    if (!before.endsWith(line.slice(Math.max(0, line.length - cursorX)))) {
      hide();
      return;
    }
    if (shown?.item === item && shown.x === cursorX && shown.skip === line.length) return;
    hide();
    const marker = term.registerMarker(0);
    const decoration = term.registerDecoration({
      marker,
      x: cursorX,
      width: Math.max(1, term.cols - cursorX),
      layer: 'top',
    });
    const rest = item.firstLine.slice(line.length);
    decoration?.onRender((element) => {
      render(element, term, rest, item.name);
    });
    decoration?.onDispose(() => {
      marker.dispose();
    });
    shown = { item, skip: line.length, x: cursorX, decoration };
  });

  return {
    input(data) {
      hide();
      tracker.input(data, { paste: pasting });
      pasting = false;
      wanted = offered()
        ? matchSnippet(tracker.line, useSnippetsStore.getState().snippets, recentSnippetIds())
        : undefined;
    },
    markPaste() {
      pasting = true;
      // An empty paste fires no `onData`; the flag must not catch the next key instead.
      queueMicrotask(() => {
        pasting = false;
      });
    },
    handleKey(event) {
      const tab = event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
      if (!tab || shown === undefined) return false;
      // The session ended, or an editor took the screen, since the ghost was drawn.
      if (!offered()) {
        hide();
        return false;
      }
      if (event.type === 'keydown') {
        event.preventDefault();
        const { item, skip } = shown;
        hide();
        wanted = undefined;
        // Main types the rest; what the line holds then is out of the tracker's sight.
        tracker.input('', { paste: true });
        startRun(item, { enter: false, skip });
      }
      return true;
    },
    dispose() {
      hide();
      parsed.dispose();
    },
  };
}
