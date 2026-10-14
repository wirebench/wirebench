import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Columns2, FolderOpen, LayoutPanelLeft, Radio, Rows2 } from 'lucide-react';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { CommandId } from '@shared/commands.js';
import { effectiveShortcutFor, matchesEvent, parseKeybinding } from '../../lib/keybindings.js';
import { detectPlatform } from '../../lib/platform.js';
import type { Platform } from '../../lib/platform.js';
import { ipc } from '../../state/ipc-client.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { connectToHost, editHost, paneIsOpen, reconnectToHost } from './connect.js';
import { ConnectScreen } from './connect-screen.js';
import type { ReconnectBanner } from './connect-screen.js';
import { dropAttempt, useConnectStore } from './connect-store.js';
import { openFiles } from './files/open-files.js';
import { useHostsStore } from './hosts-store.js';
import { PasteDialog } from './paste-dialog.js';
import { guardPaste } from './paste-guard.js';
import { trackPaneModes } from './terminal-modes.js';
import { attachSnippetSuggestions } from './snippets/ghost.js';
import { closeSnippetPicker, openSnippetPicker, useSnippetPickerStore } from './snippets/snippet-actions.js';
import { TerminalPicker } from './snippets/terminal-picker.js';
import { finderFor, FIND_HIGHLIGHT_LIMIT, isFindChord, TerminalFindBar, type FindResults } from './terminal-find.js';
import { clipboardChord, TerminalContextMenu, type TerminalMenuActions } from './terminal-menu.js';
import { BroadcastBanner } from './panes/broadcast-banner.js';
import {
  broadcastOf,
  noteWriteMany,
  pruneBroadcast,
  receiversFor,
  stopBroadcast,
  toggleBroadcast,
  useTabBroadcast,
} from './panes/broadcast.js';
import { HostPicker } from './panes/host-picker.js';
import {
  cancelSplit,
  closePane,
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
import { applyAppearance, nextZoom, terminalAppearance, zoomChord } from './terminal-appearance.js';
import type { TerminalAppearance, TerminalOverride } from './terminal-appearance.js';

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
  /** Tells the snippet suggestions the next input is a paste. */
  readonly markPaste: () => void;
  /** Copies the selection, as copy-on-select does. */
  readonly copy: () => void;
  /** Pastes what the clipboard holds through the paste guard, as a paste event would. */
  readonly paste: () => void;
}

const encoder = new TextEncoder();

/** Each pane's session while it is open; a pane connecting, reconnecting or ended receives nothing. */
function openSessions(): Record<string, string | undefined> {
  const sessions: Record<string, string | undefined> = {};
  for (const [paneId, pane] of Object.entries(useHostsStore.getState().panes)) {
    if (pane.state === 'open') sessions[paneId] = pane.sessionId;
  }
  return sessions;
}

/** The sessions a broadcast takes a pane's input to, or `undefined` when it goes to the pane alone. */
function broadcastReceivers(tabId: string, paneId: string): string[] | undefined {
  const broadcast = broadcastOf(tabId);
  if (!broadcast.on || !broadcast.ticked.has(paneId)) return undefined;
  return receiversFor(broadcast, paneId, openSessions());
}

/** What hosts.yaml sets for a host's terminal (its own level or a group's), read now. */
function overrideOf(hostId: string): TerminalOverride {
  const terminal = useHostsStore.getState().resolved.find((host) => host.id === hostId)?.terminal;
  return { scheme: terminal?.scheme.value, fontSize: terminal?.fontSize.value };
}

/** The size a host's terminal starts from before its own zoom: the host or group's, else the preferences'. */
function baseFontSize(hostId: string): number {
  return overrideOf(hostId).fontSize ?? usePreferencesStore.getState().preferences.terminal.fontSize;
}

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
  // Not a pane command, but its chord too is the app's: it opens the snippet picker over this terminal.
  'ssh.snippetPicker',
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
  const paneIds = leaves(panes).map((leaf) => leaf.paneId);
  const paneKey = paneIds.join(' ');
  const broadcasting = useTabBroadcast(tabId).on;
  // A closed pane leaves the ticks; one pane left ends the broadcast, and so does closing the tab.
  useEffect(() => {
    pruneBroadcast(tabId, paneKey.split(' '));
  }, [tabId, paneKey]);
  useEffect(
    () => () => {
      stopBroadcast(tabId);
    },
    [tabId],
  );
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
          className={`${TOOL_CLASS} disabled:cursor-not-allowed disabled:opacity-50 ${
            broadcasting ? 'bg-status-danger/15 text-fg-default' : ''
          }`}
          aria-pressed={broadcasting}
          disabled={!split}
          title={split ? undefined : 'Broadcast needs two or more panes'}
          onClick={() => {
            toggleBroadcast(tabId, paneIds);
          }}
        >
          <Radio size={13} aria-hidden="true" className={broadcasting ? 'text-status-danger' : undefined} /> Broadcast
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
      <BroadcastBanner tabId={tabId} paneIds={paneIds} />
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
  // The connection screen's attempt (#528): shown while it runs, on failure, and briefly once connected.
  const attempt = useConnectStore((s) => s.views[paneId]);
  const session = useHostsStore((s) => s.panes[paneId]);
  // The last connect ended with no session (refused, failed, or the trust prompt dismissed).
  const failed = useHostsStore((s) => s.connectFailed[paneId] === true) && session === undefined;
  const sessionId = session?.sessionId;
  const broadcast = useTabBroadcast(tabId);
  const receiving = broadcast.on && broadcast.ticked.has(paneId);
  const [exit, setExit] = useState<{ sessionId: string; code: number | null } | undefined>(undefined);
  /** A paste held for the user's yes; xterm never saw it. `receivers` above one: a broadcast takes it there. */
  const [heldPaste, setHeldPaste] = useState<{ text: string; receivers: number } | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  // ⌘; opens the snippet picker over the tab in front; it sits on the pane that has the focus.
  const pickerWanted = useSnippetPickerStore((s) => s.tabId === tabId);
  const pickerOpen = pickerWanted && active && focused;
  // Another tab coming to the front closes it, so it does not come back with this one.
  useEffect(() => {
    if (pickerWanted && !active) closeSnippetPicker();
  }, [pickerWanted, active]);
  const [findFocus, setFindFocus] = useState(0);
  const [findResults, setFindResults] = useState<FindResults | undefined>(undefined);
  const finder = useMemo(() => finderFor(() => live.current?.search), []);
  /** Opens this pane's find bar, or gives its query the focus again. */
  const openFind = (): void => {
    setFindOpen(true);
    setFindFocus((n) => n + 1);
  };
  const reconnector = useRef<Reconnector | null>(null);
  const [reconnect, setReconnect] = useState<ReconnectState>({ kind: 'idle' });
  /** Ticks once a second while a reconnect waits, for the countdown. */
  const [now, setNow] = useState(() => Date.now());
  /** ⌘+ / ⌘− on this pane, in points over its size; lives as long as the pane. */
  const [zoom, setZoom] = useState(0);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // How the terminal looks: Preferences → Terminal, the host or group's override, this pane's zoom.
  const prefs = usePreferencesStore((s) => s.preferences.terminal);
  const hostScheme = useHostsStore((s) => s.resolved.find((h) => h.id === hostId)?.terminal?.scheme.value);
  const hostFontSize = useHostsStore((s) => s.resolved.find((h) => h.id === hostId)?.terminal?.fontSize.value);

  // The terminal and the connect, once per mount and again per Reconnect.
  useEffect(() => {
    const element = holder.current;
    if (element === null) return;
    const look = (): TerminalAppearance =>
      terminalAppearance(usePreferencesStore.getState().preferences.terminal, overrideOf(hostId), zoomRef.current);
    const term = new Terminal({
      cursorBlink: true,
      ...look(),
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
    // Inline snippet suggestions: fed what the user types, Tab accepts a ghost.
    // Not while this pane broadcasts: the typed start went to every ticked pane, a completion would not.
    const suggestions = attachSnippetSuggestions(term, {
      connected: () => target.current !== undefined && broadcastReceivers(tabId, paneId) === undefined,
    });
    const copySelection = (): void => {
      const selected = term.getSelection();
      if (selected !== '') void navigator.clipboard.writeText(selected).catch(() => undefined);
    };
    /** Text the paste guard lets through goes in as xterm's own paste; anything else waits for the user's yes. */
    const pasteText = (text: string): void => {
      if (text === '' || target.current === undefined) return;
      const receivers = broadcastReceivers(tabId, paneId)?.length ?? 1;
      if (guardPaste(text, usePreferencesStore.getState().preferences.terminal, receivers) === 'send') {
        suggestions.markPaste();
        term.paste(text);
        return;
      }
      setHeldPaste({ text, receivers });
    };
    const pasteClipboard = (): void => {
      void navigator.clipboard
        .readText()
        .then(pasteText)
        .catch(() => undefined);
    };
    term.attachCustomKeyEventHandler((event) => {
      if (suggestions.handleKey(event)) return false;
      // Off a Mac, Ctrl+Shift+C / V / A copy, paste and select all; Ctrl+C stays the shell's.
      const clip = clipboardChord(event, platform);
      if (clip !== undefined) {
        if (event.type === 'keydown') {
          event.preventDefault();
          if (clip === 'copy') copySelection();
          else if (clip === 'paste') pasteClipboard();
          else term.selectAll();
        }
        return false;
      }
      // ⌘+ / ⌘− / ⌘0 size this terminal alone; neither the shell nor the app's zoom sees them.
      const zoomed = zoomChord(event, platform);
      if (zoomed !== undefined) {
        if (event.type === 'keydown') {
          event.preventDefault();
          setZoom((z) => nextZoom(baseFontSize(hostId), z, zoomed));
        }
        return false;
      }
      // A pane command's chord is the app's: the window's listener runs it, the shell never sees it.
      if (isPaneChord(event, platform)) return false;
      if (!isFindChord(event, platform)) return true;
      if (event.type === 'keydown') {
        event.preventDefault();
        openFind();
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
    live.current = {
      term,
      search,
      refit,
      syncSize,
      markPaste: () => {
        suggestions.markPaste();
      },
      copy: copySelection,
      paste: pasteClipboard,
    };
    // A snippet run asks whether the shell turned bracketed paste on.
    const untrackModes = trackPaneModes(paneId, () => term.modes.bracketedPasteMode);
    const observer = new ResizeObserver(refit);
    observer.observe(element);

    const send = (bytes: Uint8Array): void => {
      const id = target.current;
      if (id === undefined) return;
      const data = bytesToBase64(bytes);
      const receivers = broadcastReceivers(tabId, paneId);
      if (receivers === undefined) {
        void ipc().ssh.write({ sessionId: id, data });
        return;
      }
      // One call per keystroke batch keeps the panes in step; main writes nothing to a session not ours.
      void ipc()
        .ssh.writeMany({ sessionIds: receivers, data })
        .then((result) => {
          if (result.ok) noteWriteMany(tabId, result.value.skipped.length);
        })
        .catch(() => undefined);
    };
    const input = term.onData((text) => {
      suggestions.input(text);
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
      const receivers = broadcastReceivers(tabId, paneId)?.length ?? 1;
      if (guardPaste(text, usePreferencesStore.getState().preferences.terminal, receivers) === 'send') {
        suggestions.markPaste();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setHeldPaste({ text, receivers });
    };
    element.addEventListener('paste', onPaste, true);
    let copyTimer: ReturnType<typeof setTimeout> | undefined;
    const selection = term.onSelectionChange(() => {
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        if (!usePreferencesStore.getState().preferences.terminal.copyOnSelect) return;
        copySelection();
      }, COPY_ON_SELECT_DEBOUNCE_MS);
    });
    // The app theme switching restyles a terminal that follows it; a palette scheme stays as it is.
    const themeWatch = new MutationObserver(() => {
      term.options.theme = look().theme;
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
      untrackModes();
      suggestions.dispose();
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
      // A pane closed for good takes its connection screen with it; a Reconnect starts a new attempt anyway.
      if (!paneIsOpen(paneId)) dropAttempt(paneId);
      term.dispose();
    };
  }, [tabId, paneId, hostId, nonce]);

  // A change to the preferences, the host's override or the zoom restyles the open terminal; a new cell size refits it.
  useEffect(() => {
    const current = live.current;
    if (current === null) return;
    const look = terminalAppearance(prefs, { scheme: hostScheme, fontSize: hostFontSize }, zoom);
    if (applyAppearance(current.term, look)) current.refit();
  }, [prefs, hostScheme, hostFontSize, zoom]);

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
        // The screen of the connect that opened this session has nothing left to show.
        if (useConnectStore.getState().views[paneId]?.outcome.kind === 'connected') dropAttempt(paneId);
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
  // The find bar belongs to the session it searched: an end, a drop or a Reconnect closes it.
  const sessionLive = session?.state === 'open' && !ended;
  useEffect(() => {
    if (!sessionLive) setFindOpen(false);
  }, [sessionLive]);
  const stopReconnect = (): void => {
    reconnector.current?.cancel();
  };
  // A dropped session's reconnect (#407) shows on the connection screen: its countdown, then each attempt.
  let banner: ReconnectBanner | undefined;
  if (reconnect.kind === 'waiting') {
    const wait = secondsUntil(reconnect.at, now);
    banner = {
      text: `Connection lost · Reconnecting… attempt ${String(reconnect.attempt)} of ${String(reconnect.limit)} in ${String(wait)}s`,
      onNow: () => {
        reconnector.current?.retryNow();
      },
      onStop: stopReconnect,
    };
  } else if (reconnect.kind === 'trying') {
    banner = {
      text: `Reconnecting… attempt ${String(reconnect.attempt)} of ${String(reconnect.limit)}`,
      onStop: stopReconnect,
    };
  } else if (reconnect.kind === 'gave-up') {
    const attempts = `${String(reconnect.attempts)} ${reconnect.attempts === 1 ? 'attempt' : 'attempts'}`;
    banner = { text: `Connection lost · gave up after ${attempts}` };
  }
  const screen = banner !== undefined || attempt !== undefined || failed;
  const notice =
    !screen && ended
      ? `Session ended${exitCode === undefined || exitCode === null ? '' : ` (code ${String(exitCode)})`}`
      : undefined;

  const closePaste = (): void => {
    setHeldPaste(null);
    live.current?.term.focus();
  };

  /** Runs `act` on the terminal, then gives it the keys back. */
  const onTerminal = (act: (current: Live) => void) => (): void => {
    const current = live.current;
    if (current === null) return;
    act(current);
    current.term.focus();
  };
  // The right-click menu runs what the chords, the toolbar and the commands run.
  const menuActions: TerminalMenuActions = {
    copy: onTerminal((current) => {
      current.copy();
    }),
    paste: onTerminal((current) => {
      current.paste();
    }),
    selectAll: onTerminal((current) => {
      current.term.selectAll();
    }),
    find: openFind,
    clear: onTerminal((current) => {
      current.term.clear();
    }),
    splitRight: () => {
      requestSplit(tabId, 'row', paneId);
    },
    splitDown: () => {
      requestSplit(tabId, 'column', paneId);
    },
    runSnippet: () => {
      focusPane(tabId, paneId);
      openSnippetPicker();
    },
    openFiles: () => {
      openFiles(hostId);
    },
    reconnect: () => {
      useHostsStore.getState().bumpReconnect(paneId);
    },
  };

  return (
    <div
      className={`flex h-full flex-col ${
        receiving
          ? 'outline-2 -outline-offset-2 outline-status-danger'
          : split && focused
            ? 'outline-1 -outline-offset-1 outline-accent'
            : ''
      }`}
      data-testid="ssh-pane"
      data-focused={focused ? 'true' : undefined}
      data-broadcast={receiving ? 'true' : undefined}
      // A click or a tab into the pane gives it the focus, as ⌘⌥ + arrow does.
      onFocusCapture={() => {
        focusPane(tabId, paneId);
      }}
      onPointerDownCapture={() => {
        focusPane(tabId, paneId);
      }}
    >
      <PasteDialog
        text={heldPaste?.text ?? null}
        receivers={heldPaste?.receivers}
        onCancel={closePaste}
        onConfirm={(dontAskAgain) => {
          // term.paste keeps bracketed-paste mode and newline handling the same as an unguarded paste, and
          // fires no DOM paste event, so the guard cannot catch it again.
          if (heldPaste !== null) {
            live.current?.markPaste();
            live.current?.term.paste(heldPaste.text);
          }
          if (dontAskAgain) void usePreferencesStore.getState().update({ terminal: { confirmMultilinePaste: false } });
          closePaste();
        }}
      />
      {split && <PaneHeader tabId={tabId} pane={pane} focused={focused} />}
      {/* A strip above the terminal, pushing it down: it never covers the text or a notice on the screen. */}
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
      <div className="relative min-h-0 flex-1">
        <TerminalContextMenu
          platform={detectPlatform()}
          state={() => ({
            hasSelection: live.current?.term.hasSelection() ?? false,
            connected: target.current !== undefined,
          })}
          actions={menuActions}
        >
          <div ref={holder} className="h-full bg-surface-sunken p-2" data-testid="ssh-terminal" />
        </TerminalContextMenu>
        {pickerOpen && (
          <TerminalPicker
            onClose={() => {
              closeSnippetPicker();
              live.current?.term.focus();
            }}
          />
        )}
        {screen && (
          <ConnectScreen
            overlay
            hostId={hostId}
            purpose="terminal"
            view={attempt}
            reconnect={banner}
            onRetry={() => {
              useHostsStore.getState().bumpReconnect(paneId);
            }}
            onEditHost={() => {
              editHost(hostId);
            }}
            onClose={() => {
              closePane(tabId, paneId);
            }}
            onFaded={() => {
              dropAttempt(paneId);
              // Not from where the user has moved on to since connecting, such as this pane's find bar.
              const away = document.activeElement;
              const idle = away === null || away === document.body || holder.current?.contains(away) === true;
              if (focusRef.current && idle) live.current?.term.focus();
            }}
          />
        )}
      </div>
      {notice !== undefined && (
        <div
          className="flex items-center gap-3 border-t border-hairline px-3 py-2 text-sm text-fg-default"
          role="status"
          data-testid="ssh-terminal-notice"
        >
          <span className="min-w-0 flex-1 truncate">{notice}</span>
          <button
            type="button"
            className="rounded border border-hairline px-2 py-0.5 text-sm hover:bg-surface-raised"
            onClick={() => {
              useHostsStore.getState().bumpReconnect(paneId);
            }}
          >
            Reconnect
          </button>
        </div>
      )}
    </div>
  );
}
