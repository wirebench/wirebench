import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Columns2, FolderOpen, LayoutPanelLeft, Rows2 } from 'lucide-react';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { CommandId } from '@shared/commands.js';
import { effectiveShortcutFor, matchesEvent, parseKeybinding } from '../../lib/keybindings.js';
import { detectPlatform } from '../../lib/platform.js';
import type { Platform } from '../../lib/platform.js';
import { ipc } from '../../state/ipc-client.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { connectToHost, paneIsOpen, reconnectToHost } from './connect.js';
import { openFiles } from './files/open-files.js';
import { useHostsStore } from './hosts-store.js';
import { PasteDialog } from './paste-dialog.js';
import { guardPaste } from './paste-guard.js';
import { finderFor, FIND_HIGHLIGHT_LIMIT, isFindChord, TerminalFindBar, type FindResults } from './terminal-find.js';
import { HostPicker } from './panes/host-picker.js';
import {
  cancelSplit,
  completeSplit,
  focusedPaneOf,
  focusPane,
  forgetPaneSize,
  notePaneSize,
  requestSplit,
  usePanesStore,
} from './panes/pane-actions.js';
import { useLayoutsStore } from './panes/layouts-store.js';
import { MissingHostPane } from './panes/missing-host-pane.js';
import { PaneHeader } from './panes/pane-header.js';
import { SaveLayoutDialog } from './panes/save-layout-dialog.js';
import { leaves, type PaneLeaf, type PaneNode } from './panes/pane-tree.js';
import { PaneView } from './panes/pane-view.js';
import { isDrop, onReconnectNow, Reconnector } from './reconnect.js';
import type { ReconnectState } from './reconnect.js';
import { attachTerminal, bytesToBase64, detachTerminal } from './terminal-session.js';
import { monoFontFromCss, themeFromCss } from './terminal-theme.js';

/** How long a layout change settles before the new size goes to the remote pty. */
const RESIZE_DEBOUNCE_MS = 100;
/** How long a selection holds still before copy-on-select writes it, so a drag copies once. */
const COPY_ON_SELECT_DEBOUNCE_MS = 150;

/** Opens a link from the terminal; main hands only http(s) to the OS browser. */
function openLink(uri: string): void {
  window.open(uri, '_blank', 'noopener');
}

/** The terminal one mount of a pane owns, with what the session was last told its size is. */
interface Live {
  readonly term: Terminal;
  readonly search: SearchAddon;
  /** Fits the terminal to its holder (never while the holder is hidden) and, debounced, tells the session. */
  readonly refit: () => void;
  /** Tells the session the terminal's size now, when it differs from what it was last told. */
  readonly syncSize: () => void;
}

const encoder = new TextEncoder();

function hasSize(element: HTMLElement): boolean {
  return element.clientWidth > 0 && element.clientHeight > 0;
}

/** Closes a pane's session for good: no more output routed, main told, the pane idle again. */
function endSession(paneId: string, sessionId: string): void {
  detachTerminal(sessionId);
  void ipc().ssh.close({ sessionId });
  const hosts = useHostsStore.getState();
  if (hosts.panes[paneId]?.sessionId === sessionId) hosts.setPane(paneId, undefined);
}

/**
 * A connect that ended after its pane was torn down. A remount of the same pane picks the session up from
 * the store; with the pane gone, nothing will, so the session and any trust prompt go with it.
 */
function settleAfterTeardown(paneId: string, sessionId: string | undefined): void {
  if (paneIsOpen(paneId)) return;
  if (sessionId !== undefined) endSession(paneId, sessionId);
  const hosts = useHostsStore.getState();
  if (hosts.trustPrompt?.paneId === paneId) hosts.setTrustPrompt(null);
}

/** The line a reconnect leaves in the scrollback, dimmed, between the old session's output and the new one's. */
function reconnectedLine(at: Date): Uint8Array {
  return encoder.encode(`\r\n\x1b[2m── reconnected ${at.toLocaleTimeString([], { hour12: false })} ──\x1b[0m\r\n`);
}

/** The pane commands whose chords a focused terminal leaves to the app instead of sending to the shell. */
const PANE_COMMANDS: readonly CommandId[] = [
  'ssh.splitRight',
  'ssh.splitDown',
  'ssh.focusPaneLeft',
  'ssh.focusPaneRight',
  'ssh.focusPaneUp',
  'ssh.focusPaneDown',
  'ssh.closePane',
];

/** Whether a keystroke is the chord of a pane command, as bound now (a rebind counts). */
function isPaneChord(event: KeyboardEvent, platform: Platform): boolean {
  return PANE_COMMANDS.some((id) => {
    const chord = effectiveShortcutFor(id);
    if (chord === undefined) return false;
    try {
      return matchesEvent(parseKeybinding(chord), event, platform);
    } catch {
      return false;
    }
  });
}

const TOOL_CLASS =
  'inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-sm text-fg-muted hover:bg-surface-hover hover:text-fg-default';

/** Whole seconds until `at`, never below zero. */
function secondsUntil(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * A terminal tab: its pane tree, laid out, under a toolbar that splits the focused pane or opens Files on its
 * host. The tab stays mounted while another tab is in front (the editor area hides it), so only closing a
 * pane, or the tab, ends a session.
 */
export function TerminalTab({
  tabId,
  panes,
  active,
}: {
  readonly tabId: string;
  readonly panes: PaneNode;
  readonly active: boolean;
}) {
  // Connect on a host brings forward the tab used last with a pane on it.
  useEffect(() => {
    if (active) useHostsStore.getState().noteTerminalTabUsed(tabId);
  }, [active, tabId]);
  // Re-read on every focus change; `focusedPaneOf` falls back to the first pane.
  usePanesStore((s) => s.focused[tabId]);
  const focused = focusedPaneOf(tabId, panes);
  const focusedHost = leaves(panes).find((leaf) => leaf.paneId === focused)?.hostId;
  const picker = usePanesStore((s) => (s.picker?.tabId === tabId ? s.picker : undefined));
  const split = panes.kind === 'split';
  // A pane whose host left `hosts.yaml` (a layout saved before) shows so instead of connecting; known only once
  // read. A pane that already has a session keeps its terminal: deleting the host does not end it.
  const knownHosts = useHostsStore((s) => (s.loaded ? s.resolved : undefined));
  const paneSessions = useHostsStore((s) => s.panes);
  const missing = (pane: PaneLeaf): boolean =>
    knownHosts !== undefined &&
    paneSessions[pane.paneId] === undefined &&
    !knownHosts.some((host) => host.id === pane.hostId);
  const saving = useLayoutsStore((s) => s.savingTabId === tabId);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end gap-1 border-b border-hairline px-2 py-0.5">
        <button
          type="button"
          className={TOOL_CLASS}
          onClick={() => {
            requestSplit(tabId, 'row');
          }}
        >
          <Columns2 size={13} aria-hidden="true" /> Split right
        </button>
        <button
          type="button"
          className={TOOL_CLASS}
          onClick={() => {
            requestSplit(tabId, 'column');
          }}
        >
          <Rows2 size={13} aria-hidden="true" /> Split down
        </button>
        <button
          type="button"
          className={TOOL_CLASS}
          onClick={() => {
            if (focusedHost !== undefined) openFiles(focusedHost);
          }}
        >
          <FolderOpen size={13} aria-hidden="true" /> Files
        </button>
        <button
          type="button"
          className={TOOL_CLASS}
          onClick={() => {
            useLayoutsStore.getState().setSavingTabId(tabId);
          }}
        >
          <LayoutPanelLeft size={13} aria-hidden="true" /> Save layout…
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <PaneView
          tabId={tabId}
          node={panes}
          renderPane={(pane) =>
            missing(pane) ? (
              <MissingHostPane key={`${pane.paneId}:missing`} tabId={tabId} pane={pane} />
            ) : (
              <TerminalPane
                key={`${pane.paneId}:${pane.hostId}`}
                tabId={tabId}
                pane={pane}
                active={active}
                focused={pane.paneId === focused}
                split={split}
              />
            )
          }
        />
      </div>
      <SaveLayoutDialog
        tabId={tabId}
        open={saving}
        onOpenChange={(open) => {
          if (!open) useLayoutsStore.getState().setSavingTabId(undefined);
        }}
      />
      {picker !== undefined && (
        <HostPicker initialHostId={picker.hostId} onPick={completeSplit} onCancel={cancelSplit} />
      )}
    </div>
  );
}

/**
 * One pane's shell. Only closing its tab — or Reconnect, which bumps the pane's nonce — ends the session.
 * The pane attaches to whatever session the hosts store records for it, so a connect that went through
 * the trust prompt lands here too. A session the network dropped reconnects on its own (Preferences →
 * Terminal) into the same terminal, so the scrollback stays.
 */
function TerminalPane({
  tabId,
  pane,
  active,
  focused,
  split,
}: {
  readonly tabId: string;
  readonly pane: PaneLeaf;
  /** Whether the pane's tab is in front. */
  readonly active: boolean;
  /** Whether keystrokes go to this pane while its tab is in front. */
  readonly focused: boolean;
  /** Whether the tab holds more than this pane, so it draws its header. */
  readonly split: boolean;
}) {
  const { paneId, hostId } = pane;
  const holder = useRef<HTMLDivElement>(null);
  const live = useRef<Live | null>(null);
  /** The session keystrokes go to; unset until attached and again once the session has ended. */
  const target = useRef<string | undefined>(undefined);
  const focusRef = useRef(active && focused);
  focusRef.current = active && focused;
  const nonce = useHostsStore((s) => s.reconnectNonce[paneId] ?? 0);
  const session = useHostsStore((s) => s.panes[paneId]);
  // The last connect ended with no session (refused, failed, or the trust prompt dismissed).
  const failed = useHostsStore((s) => s.connectFailed[paneId] === true) && session === undefined;
  const sessionId = session?.sessionId;
  const [exit, setExit] = useState<{ sessionId: string; code: number | null } | undefined>(undefined);
  /** A multi-line paste held for the user's yes; xterm never saw it. */
  const [heldPaste, setHeldPaste] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findFocus, setFindFocus] = useState(0);
  const [findResults, setFindResults] = useState<FindResults | undefined>(undefined);
  const finder = useMemo(() => finderFor(() => live.current?.search), []);
  const reconnector = useRef<Reconnector | null>(null);
  const [reconnect, setReconnect] = useState<ReconnectState>({ kind: 'idle' });
  /** Ticks once a second while a reconnect waits, for the countdown. */
  const [now, setNow] = useState(() => Date.now());

  // The terminal and the connect, once per mount and again per Reconnect.
  useEffect(() => {
    const element = holder.current;
    if (element === null) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: monoFontFromCss(),
      fontSize: 13,
      theme: themeFromCss(),
      // The find bar's match highlights are decorations, which xterm still calls proposed API; without it
      // every search throws and the count never comes.
      allowProposedApi: true,
      // OSC 8 hyperlinks the remote program prints.
      linkHandler: {
        activate: (_event, uri) => {
          openLink(uri);
        },
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon({ highlightLimit: FIND_HIGHLIGHT_LIMIT });
    term.loadAddon(search);
    const results = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setFindResults({ index: resultIndex, count: resultCount });
    });
    // xterm sees keys only while it has focus, so the find chord is the focused terminal's alone; it opens
    // the find bar and never reaches the shell.
    const platform = detectPlatform();
    term.attachCustomKeyEventHandler((event) => {
      // A pane command's chord is the app's: the window's listener runs it, the shell never sees it.
      if (isPaneChord(event, platform)) return false;
      if (!isFindChord(event, platform)) return true;
      if (event.type === 'keydown') {
        event.preventDefault();
        setFindOpen(true);
        setFindFocus((n) => n + 1);
      }
      return false;
    });
    // The default handler opens a blank window first, which main refuses; this hands main the URL.
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        openLink(uri);
      }),
    );
    term.open(element);
    if (hasSize(element)) {
      fit.fit();
      notePaneSize(paneId, { cols: term.cols, rows: term.rows });
    }

    let sent = { cols: term.cols, rows: term.rows };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const syncSize = (): void => {
      const id = target.current;
      if (id === undefined || (term.cols === sent.cols && term.rows === sent.rows)) return;
      sent = { cols: term.cols, rows: term.rows };
      void ipc().ssh.resize({ sessionId: id, ...sent });
    };
    const refit = (): void => {
      if (!hasSize(element)) return;
      fit.fit();
      notePaneSize(paneId, { cols: term.cols, rows: term.rows });
      clearTimeout(timer);
      timer = setTimeout(syncSize, RESIZE_DEBOUNCE_MS);
    };
    live.current = { term, search, refit, syncSize };
    const observer = new ResizeObserver(refit);
    observer.observe(element);

    const send = (bytes: Uint8Array): void => {
      const id = target.current;
      if (id !== undefined) void ipc().ssh.write({ sessionId: id, data: bytesToBase64(bytes) });
    };
    const input = term.onData((text) => {
      send(encoder.encode(text));
    });
    // Some mouse reports are raw bytes, one per char code.
    const binary = term.onBinary((text) => {
      send(Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff));
    });
    // Capture phase, so a held paste is stopped before xterm's own listener on its textarea sees it. The
    // preferences are read per paste, so "Don't ask again" and the Preferences toggle take effect at once.
    const onPaste = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData('text') ?? '';
      if (guardPaste(text, usePreferencesStore.getState().preferences.terminal) === 'send') return;
      event.preventDefault();
      event.stopPropagation();
      setHeldPaste(text);
    };
    element.addEventListener('paste', onPaste, true);
    let copyTimer: ReturnType<typeof setTimeout> | undefined;
    const selection = term.onSelectionChange(() => {
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        if (!usePreferencesStore.getState().preferences.terminal.copyOnSelect) return;
        const selected = term.getSelection();
        if (selected !== '') void navigator.clipboard.writeText(selected).catch(() => undefined);
      }, COPY_ON_SELECT_DEBOUNCE_MS);
    });
    const themeWatch = new MutationObserver(() => {
      term.options.theme = themeFromCss();
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    let disposed = false;
    void connectToHost({ paneId, hostId }, sent).then((result) => {
      if (disposed) settleAfterTeardown(paneId, result?.sessionId);
    });

    const loop = new Reconnector({
      attempt: async () => {
        const outcome = await reconnectToHost({ paneId, hostId }, { cols: term.cols, rows: term.rows });
        if (disposed) settleAfterTeardown(paneId, useHostsStore.getState().panes[paneId]?.sessionId);
        return outcome;
      },
      onChange: setReconnect,
      onReconnected: () => {
        term.write(reconnectedLine(new Date()));
      },
    });
    reconnector.current = loop;
    const offWake = onReconnectNow(() => {
      loop.wake();
    });

    return () => {
      disposed = true;
      offWake();
      loop.cancel();
      reconnector.current = null;
      clearTimeout(timer);
      observer.disconnect();
      themeWatch.disconnect();
      element.removeEventListener('paste', onPaste, true);
      selection.dispose();
      clearTimeout(copyTimer);
      input.dispose();
      binary.dispose();
      results.dispose();
      const current = useHostsStore.getState().panes[paneId]?.sessionId;
      if (current !== undefined) endSession(paneId, current);
      target.current = undefined;
      live.current = null;
      forgetPaneSize(paneId);
      term.dispose();
    };
  }, [paneId, hostId, nonce]);

  // Attach to the pane's session once the store has one: from the connect above, or from the trust prompt.
  useEffect(() => {
    const current = live.current;
    if (sessionId === undefined || current === null) return;
    // A render from before a Reconnect still names the session the teardown just closed.
    if (useHostsStore.getState().panes[paneId]?.sessionId !== sessionId) return;
    target.current = sessionId;
    attachTerminal(sessionId, {
      write: (data) => {
        current.term.write(data);
      },
      exit: (code, reason) => {
        if (target.current === sessionId) target.current = undefined;
        setExit({ sessionId, code });
        // Read per drop, so the Preferences switch and limit apply from the next drop on.
        const prefs = usePreferencesStore.getState().preferences.terminal;
        if (isDrop(reason) && prefs.autoReconnect) reconnector.current?.start(prefs.reconnectAttempts);
      },
    });
    current.syncSize();
    if (focusRef.current) current.term.focus();
    return () => {
      detachTerminal(sessionId);
      if (target.current === sessionId) target.current = undefined;
    };
  }, [paneId, sessionId, nonce]);

  // Coming back to the front: the holder had no size while hidden, so fit it now.
  useEffect(() => {
    if (!active) return;
    live.current?.refit();
    if (focused) live.current?.term.focus();
  }, [active, focused]);

  const waiting = reconnect.kind === 'waiting';
  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const tick = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(tick);
    };
  }, [waiting]);

  const exitCode = sessionId !== undefined && exit?.sessionId === sessionId ? exit.code : undefined;
  const ended = sessionId !== undefined && (exitCode !== undefined || session?.state === 'closed');
  const reconnecting = reconnect.kind === 'waiting' || reconnect.kind === 'trying';
  let notice: string | undefined;
  if (reconnect.kind === 'waiting') {
    const wait = secondsUntil(reconnect.at, now);
    notice = `Connection lost · Reconnecting… attempt ${String(reconnect.attempt)} of ${String(reconnect.limit)} in ${String(wait)}s`;
  } else if (reconnect.kind === 'trying') {
    notice = `Reconnecting… attempt ${String(reconnect.attempt)} of ${String(reconnect.limit)}`;
  } else if (reconnect.kind === 'gave-up') {
    const attempts = `${String(reconnect.attempts)} ${reconnect.attempts === 1 ? 'attempt' : 'attempts'}`;
    notice = `Connection lost · gave up after ${attempts} (${reconnect.message})`;
  } else if (failed) {
    notice = 'Could not connect · see Problems';
  } else if (ended) {
    notice = `Session ended${exitCode === undefined || exitCode === null ? '' : ` (code ${String(exitCode)})`}`;
  }

  const closePaste = (): void => {
    setHeldPaste(null);
    live.current?.term.focus();
  };

  return (
    <div
      className={`flex h-full flex-col ${split && focused ? 'outline-1 -outline-offset-1 outline-accent' : ''}`}
      data-testid="ssh-pane"
      data-focused={focused ? 'true' : undefined}
      // A click or a tab into the pane gives it the focus, as ⌘⌥ + arrow does.
      onFocusCapture={() => {
        focusPane(tabId, paneId);
      }}
      onPointerDownCapture={() => {
        focusPane(tabId, paneId);
      }}
    >
      <PasteDialog
        text={heldPaste}
        onCancel={closePaste}
        onConfirm={(dontAskAgain) => {
          // term.paste keeps bracketed-paste mode and newline handling the same as an unguarded paste, and
          // fires no DOM paste event, so the guard cannot catch it again.
          if (heldPaste !== null) live.current?.term.paste(heldPaste);
          if (dontAskAgain) void usePreferencesStore.getState().update({ terminal: { confirmMultilinePaste: false } });
          closePaste();
        }}
      />
      {split && <PaneHeader tabId={tabId} pane={pane} focused={focused} />}
      <div className="relative min-h-0 flex-1">
        <div ref={holder} className="h-full bg-surface-sunken p-2" data-testid="ssh-terminal" />
        <TerminalFindBar
          open={findOpen}
          focusRequest={findFocus}
          finder={finder}
          results={findResults}
          onClose={() => {
            setFindOpen(false);
            live.current?.term.focus();
          }}
        />
      </div>
      {notice !== undefined && (
        <div
          className="flex items-center gap-3 border-t border-hairline px-3 py-2 text-sm text-fg-default"
          role="status"
          data-testid="ssh-terminal-notice"
        >
          <span className="min-w-0 flex-1 truncate">{notice}</span>
          {reconnect.kind === 'waiting' && (
            <button
              type="button"
              className="rounded border border-hairline px-2 py-0.5 text-sm hover:bg-surface-raised"
              onClick={() => {
                reconnector.current?.retryNow();
              }}
            >
              Retry now
            </button>
          )}
          {reconnecting ? (
            <button
              type="button"
              className="rounded border border-hairline px-2 py-0.5 text-sm hover:bg-surface-raised"
              onClick={() => {
                reconnector.current?.cancel();
              }}
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="rounded border border-hairline px-2 py-0.5 text-sm hover:bg-surface-raised"
              onClick={() => {
                useHostsStore.getState().bumpReconnect(paneId);
              }}
            >
              Reconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}
