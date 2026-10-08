import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useEditorsStore } from '../../state/editors.js';
import { ipc } from '../../state/ipc-client.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { connectToHost, terminalTabId } from './connect.js';
import { useHostsStore } from './hosts-store.js';
import { PasteDialog } from './paste-dialog.js';
import { guardPaste } from './paste-guard.js';
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

/** The terminal one mount of the tab owns, with what the session was last told its size is. */
interface Live {
  readonly term: Terminal;
  /** Fits the terminal to its holder (never while the holder is hidden) and, debounced, tells the session. */
  readonly refit: () => void;
  /** Tells the session the terminal's size now, when it differs from what it was last told. */
  readonly syncSize: () => void;
}

const encoder = new TextEncoder();

function hasSize(element: HTMLElement): boolean {
  return element.clientWidth > 0 && element.clientHeight > 0;
}

/** Closes a host's session for good: no more output routed, main told, the host idle again. */
function endSession(hostId: string, sessionId: string): void {
  detachTerminal(sessionId);
  void ipc().ssh.close({ sessionId });
  const hosts = useHostsStore.getState();
  if (hosts.sessions[hostId]?.sessionId === sessionId) hosts.setSession(hostId, undefined);
}

/**
 * One host's shell. The tab stays mounted while another tab is in front (the editor area hides it),
 * so only closing the tab — or Reconnect, which bumps the host's nonce — ends the session. The tab
 * attaches to whatever session the hosts store records for its host, so a connect that went through
 * the trust prompt lands here too.
 */
export function TerminalTab({ hostId, active }: { readonly hostId: string; readonly active: boolean }) {
  const holder = useRef<HTMLDivElement>(null);
  const live = useRef<Live | null>(null);
  /** The session keystrokes go to; unset until attached and again once the session has ended. */
  const target = useRef<string | undefined>(undefined);
  const activeRef = useRef(active);
  activeRef.current = active;
  const nonce = useHostsStore((s) => s.reconnectNonce[hostId] ?? 0);
  const session = useHostsStore((s) => s.sessions[hostId]);
  // The last connect ended with no session (refused, failed, or the trust prompt dismissed).
  const failed = useHostsStore((s) => s.connectFailed[hostId] === true) && session === undefined;
  const sessionId = session?.sessionId;
  const [exit, setExit] = useState<{ sessionId: string; code: number | null } | undefined>(undefined);
  /** A multi-line paste held for the user's yes; xterm never saw it. */
  const [heldPaste, setHeldPaste] = useState<string | null>(null);

  // The terminal and the connect, once per mount and again per Reconnect.
  useEffect(() => {
    const element = holder.current;
    if (element === null) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: monoFontFromCss(),
      fontSize: 13,
      theme: themeFromCss(),
      // OSC 8 hyperlinks the remote program prints.
      linkHandler: {
        activate: (_event, uri) => {
          openLink(uri);
        },
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // The default handler opens a blank window first, which main refuses; this hands main the URL.
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        openLink(uri);
      }),
    );
    term.open(element);
    if (hasSize(element)) fit.fit();

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
      clearTimeout(timer);
      timer = setTimeout(syncSize, RESIZE_DEBOUNCE_MS);
    };
    live.current = { term, refit, syncSize };
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
    void connectToHost(hostId, sent).then((result) => {
      if (!disposed) return;
      // Torn down while connecting. A remount of the same tab picks the session up from the store;
      // with the tab gone, nothing will, so the session and any trust prompt go with it.
      if (useEditorsStore.getState().tabs.some((t) => t.id === terminalTabId(hostId))) return;
      if (result) endSession(hostId, result.sessionId);
      const hosts = useHostsStore.getState();
      if (hosts.trustPrompt?.hostId === hostId) hosts.setTrustPrompt(null);
    });

    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      themeWatch.disconnect();
      element.removeEventListener('paste', onPaste, true);
      selection.dispose();
      clearTimeout(copyTimer);
      input.dispose();
      binary.dispose();
      const current = useHostsStore.getState().sessions[hostId]?.sessionId;
      if (current !== undefined) endSession(hostId, current);
      target.current = undefined;
      live.current = null;
      term.dispose();
    };
  }, [hostId, nonce]);

  // Attach to the host's session once the store has one: from the connect above, or from the trust prompt.
  useEffect(() => {
    const current = live.current;
    if (sessionId === undefined || current === null) return;
    // A render from before a Reconnect still names the session the teardown just closed.
    if (useHostsStore.getState().sessions[hostId]?.sessionId !== sessionId) return;
    target.current = sessionId;
    attachTerminal(sessionId, {
      write: (data) => {
        current.term.write(data);
      },
      exit: (code) => {
        if (target.current === sessionId) target.current = undefined;
        setExit({ sessionId, code });
      },
    });
    current.syncSize();
    if (activeRef.current) current.term.focus();
    return () => {
      detachTerminal(sessionId);
      if (target.current === sessionId) target.current = undefined;
    };
  }, [hostId, sessionId, nonce]);

  // Coming back to the front: the holder had no size while hidden, so fit it now.
  useEffect(() => {
    if (!active) return;
    live.current?.refit();
    live.current?.term.focus();
  }, [active]);

  const exitCode = sessionId !== undefined && exit?.sessionId === sessionId ? exit.code : undefined;
  const ended = sessionId !== undefined && (exitCode !== undefined || session?.state === 'closed');
  const notice = failed
    ? 'Could not connect · see Problems'
    : ended
      ? `Session ended${exitCode === undefined || exitCode === null ? '' : ` (code ${String(exitCode)})`}`
      : undefined;

  const closePaste = (): void => {
    setHeldPaste(null);
    live.current?.term.focus();
  };

  return (
    <div className="flex h-full flex-col">
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
      <div ref={holder} className="min-h-0 flex-1 bg-surface-sunken p-2" data-testid="ssh-terminal" />
      {notice !== undefined && (
        <div className="flex items-center gap-3 border-t border-hairline px-3 py-2 text-sm text-fg-default">
          <span>{notice}</span>
          <button
            type="button"
            className="rounded border border-hairline px-2 py-0.5 text-sm hover:bg-surface-raised"
            onClick={() => {
              useHostsStore.getState().bumpReconnect(hostId);
            }}
          >
            Reconnect
          </button>
        </div>
      )}
    </div>
  );
}
