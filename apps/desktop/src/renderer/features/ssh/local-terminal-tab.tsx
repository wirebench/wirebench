import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { detectPlatform } from '../../lib/platform.js';
import { ipc } from '../../state/ipc-client.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { useLocalTerminalsStore } from './local-terminal.js';
import { PasteDialog } from './paste-dialog.js';
import { guardPaste } from './paste-guard.js';
import { finderFor, FIND_HIGHLIGHT_LIMIT, isFindChord, TerminalFindBar, type FindResults } from './terminal-find.js';
import { attachTerminal, bytesToBase64, detachTerminal } from './terminal-session.js';
import { attachOutputHighlights, type OutputHighlights } from './output-highlights.js';
import { applyAppearance, nextZoom, terminalAppearance, zoomChord } from './terminal-appearance.js';
import type { TerminalAppearance } from './terminal-appearance.js';

/** How long a layout change settles before the new size goes to the pty. */
const RESIZE_DEBOUNCE_MS = 100;
/** How long a selection holds still before copy-on-select writes it, so a drag copies once. */
const COPY_ON_SELECT_DEBOUNCE_MS = 150;

const encoder = new TextEncoder();

/** Opens a link from the terminal; main hands only http(s) to the OS browser. */
function openLink(uri: string): void {
  window.open(uri, '_blank', 'noopener');
}

function hasSize(element: HTMLElement): boolean {
  return element.clientWidth > 0 && element.clientHeight > 0;
}

/**
 * A local terminal tab (#410): this machine's shell, in a pseudo-terminal in main. It behaves as an SSH
 * terminal's pane does — theme, paste guard, copy on select, find, links, the ended state — and holds one
 * shell: there is no split, layout or broadcast here. The tab stays mounted while another tab is in front,
 * so only closing it (or Restart) ends the shell.
 */
export function LocalTerminalTab({ tabId, active }: { readonly tabId: string; readonly active: boolean }) {
  const holder = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const refitRef = useRef<() => void>(() => undefined);
  const highlightsRef = useRef<OutputHighlights | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  /** Bumped by Restart: the shell and its terminal start again. */
  const [run, setRun] = useState(0);
  const session = useLocalTerminalsStore((s) => s.sessions[tabId]);
  const [heldPaste, setHeldPaste] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findFocus, setFindFocus] = useState(0);
  const [findResults, setFindResults] = useState<FindResults | undefined>(undefined);
  const finder = useMemo(() => finderFor(() => search.current ?? undefined), []);
  /** ⌘+ / ⌘− on this tab, in points over the Preferences size; lives as long as the tab. */
  const [zoom, setZoom] = useState(0);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const prefs = usePreferencesStore((s) => s.preferences.terminal);

  useEffect(() => {
    const element = holder.current;
    if (element === null) return;
    const store = useLocalTerminalsStore.getState();
    // Preferences → Terminal and this tab's zoom; a local shell has no host to override them.
    const look = (): TerminalAppearance =>
      terminalAppearance(usePreferencesStore.getState().preferences.terminal, undefined, zoomRef.current);
    const xterm = new Terminal({
      cursorBlink: true,
      ...look(),
      // The find bar's match highlights are decorations, which xterm still calls proposed API.
      allowProposedApi: true,
      linkHandler: {
        activate: (_event, uri) => {
          openLink(uri);
        },
      },
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    const searchAddon = new SearchAddon({ highlightLimit: FIND_HIGHLIGHT_LIMIT });
    xterm.loadAddon(searchAddon);
    const results = searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
      setFindResults({ index: resultIndex, count: resultCount });
    });
    const platform = detectPlatform();
    xterm.attachCustomKeyEventHandler((event) => {
      // ⌘+ / ⌘− / ⌘0 size this terminal alone; neither the shell nor the app's zoom sees them.
      const zoomed = zoomChord(event, platform);
      if (zoomed !== undefined) {
        if (event.type === 'keydown') {
          event.preventDefault();
          setZoom((z) => nextZoom(usePreferencesStore.getState().preferences.terminal.fontSize, z, zoomed));
        }
        return false;
      }
      if (!isFindChord(event, platform)) return true;
      if (event.type === 'keydown') {
        event.preventDefault();
        setFindOpen(true);
        setFindFocus((n) => n + 1);
      }
      return false;
    });
    xterm.loadAddon(
      new WebLinksAddon((_event, uri) => {
        openLink(uri);
      }),
    );
    xterm.open(element);
    const highlights = attachOutputHighlights(xterm);
    highlightsRef.current = highlights;
    if (hasSize(element)) fit.fit();
    term.current = xterm;
    search.current = searchAddon;

    /** The shell keystrokes go to; unset until it starts and again once it has ended. */
    let target: string | undefined;
    let disposed = false;
    let sent = { cols: xterm.cols, rows: xterm.rows };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const syncSize = (): void => {
      if (target === undefined || (xterm.cols === sent.cols && xterm.rows === sent.rows)) return;
      sent = { cols: xterm.cols, rows: xterm.rows };
      void ipc().localTerminal.resize({ sessionId: target, ...sent });
    };
    const refit = (): void => {
      if (!hasSize(element)) return;
      fit.fit();
      clearTimeout(timer);
      timer = setTimeout(syncSize, RESIZE_DEBOUNCE_MS);
    };
    refitRef.current = refit;
    const observer = new ResizeObserver(refit);
    observer.observe(element);

    const send = (bytes: Uint8Array): void => {
      if (target === undefined) return;
      void ipc().localTerminal.write({ sessionId: target, data: bytesToBase64(bytes) });
    };
    const input = xterm.onData((text) => {
      send(encoder.encode(text));
    });
    const binary = xterm.onBinary((text) => {
      send(Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff));
    });
    // Capture phase, so a held paste is stopped before xterm's own listener sees it.
    const onPaste = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData('text') ?? '';
      if (guardPaste(text, usePreferencesStore.getState().preferences.terminal, 1) === 'send') return;
      event.preventDefault();
      event.stopPropagation();
      setHeldPaste(text);
    };
    element.addEventListener('paste', onPaste, true);
    let copyTimer: ReturnType<typeof setTimeout> | undefined;
    const selection = xterm.onSelectionChange(() => {
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        if (!usePreferencesStore.getState().preferences.terminal.copyOnSelect) return;
        const selected = xterm.getSelection();
        if (selected !== '') void navigator.clipboard.writeText(selected).catch(() => undefined);
      }, COPY_ON_SELECT_DEBOUNCE_MS);
    });
    // The app theme switching restyles a terminal that follows it; a palette scheme stays as it is.
    const themeWatch = new MutationObserver(() => {
      xterm.options.theme = look().theme;
      highlights.refresh();
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    store.setSession(tabId, { state: 'connecting' });
    void ipc()
      .localTerminal.open({ cols: xterm.cols, rows: xterm.rows })
      .then((result) => {
        if (!result.ok) {
          if (!disposed) store.setSession(tabId, { state: 'closed', error: result.error.message });
          return;
        }
        const { sessionId, shell } = result.value;
        // The tab closed (or restarted) while the shell started: it goes at once.
        if (disposed) {
          void ipc().localTerminal.close({ sessionId });
          return;
        }
        target = sessionId;
        store.setSession(tabId, { state: 'open', sessionId, shell });
        attachTerminal(sessionId, {
          write: (data) => {
            xterm.write(data);
          },
          exit: (code) => {
            target = undefined;
            store.setSession(tabId, { state: 'closed', sessionId, shell, code });
          },
        });
        syncSize();
        if (activeRef.current) xterm.focus();
      });

    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(copyTimer);
      observer.disconnect();
      themeWatch.disconnect();
      element.removeEventListener('paste', onPaste, true);
      selection.dispose();
      input.dispose();
      binary.dispose();
      results.dispose();
      const current = useLocalTerminalsStore.getState().sessions[tabId]?.sessionId;
      if (current !== undefined) {
        detachTerminal(current);
        void ipc().localTerminal.close({ sessionId: current });
      }
      useLocalTerminalsStore.getState().setSession(tabId, undefined);
      refitRef.current = () => undefined;
      highlights.dispose();
      highlightsRef.current = null;
      term.current = null;
      search.current = null;
      xterm.dispose();
    };
  }, [tabId, run]);

  // A change to the preferences or the zoom restyles the open terminal; a new cell size refits it.
  useEffect(() => {
    const current = term.current;
    if (current === null) return;
    if (applyAppearance(current, terminalAppearance(prefs, undefined, zoom))) refitRef.current();
    highlightsRef.current?.refresh();
  }, [prefs, zoom]);

  // Coming back to the front: the holder had no size while hidden, so fit it now.
  useEffect(() => {
    if (!active) return;
    refitRef.current();
    term.current?.focus();
  }, [active]);

  let notice: string | undefined;
  if (session?.error !== undefined) notice = `Could not start the shell · ${session.error}`;
  else if (session?.state === 'closed') {
    notice = `Shell ended${session.code === undefined || session.code === null ? '' : ` (code ${String(session.code)})`}`;
  }

  const closePaste = (): void => {
    setHeldPaste(null);
    term.current?.focus();
  };

  return (
    <div className="flex h-full flex-col" data-testid="local-terminal-pane">
      <PasteDialog
        text={heldPaste}
        onCancel={closePaste}
        onConfirm={(dontAskAgain) => {
          // term.paste keeps bracketed-paste mode the same as an unguarded paste, and fires no DOM paste event.
          if (heldPaste !== null) term.current?.paste(heldPaste);
          if (dontAskAgain) void usePreferencesStore.getState().update({ terminal: { confirmMultilinePaste: false } });
          closePaste();
        }}
      />
      <div className="relative min-h-0 flex-1">
        <div ref={holder} className="h-full bg-surface-sunken p-2" data-testid="local-terminal" />
        <TerminalFindBar
          open={findOpen}
          focusRequest={findFocus}
          finder={finder}
          results={findResults}
          onClose={() => {
            setFindOpen(false);
            term.current?.focus();
          }}
        />
      </div>
      {notice !== undefined && (
        <div
          className="flex items-center gap-3 border-t border-hairline px-3 py-2 text-sm text-fg-default"
          role="status"
          data-testid="local-terminal-notice"
        >
          <span className="min-w-0 flex-1 truncate">{notice}</span>
          <button
            type="button"
            className="rounded border border-hairline px-2 py-0.5 text-sm hover:bg-surface-raised"
            onClick={() => {
              setRun((n) => n + 1);
            }}
          >
            Restart
          </button>
        </div>
      )}
    </div>
  );
}
