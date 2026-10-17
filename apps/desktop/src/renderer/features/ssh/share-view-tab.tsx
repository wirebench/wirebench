import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { detectPlatform } from '../../lib/platform.js';
import { isPaletteChord } from '../../lib/terminal-focus.js';
import { ipc } from '../../state/ipc-client.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { terminalAppearance } from './terminal-appearance.js';
import { bytesToBase64 } from './terminal-session.js';
import { attachShareView, leaveShareView, useTerminalShareStore, viewIdOf } from './terminal-share-store.js';

const encoder = new TextEncoder();
const BUTTON = 'rounded border border-hairline px-2 py-0.5 text-xs hover:bg-surface-raised disabled:opacity-50';

const ENDED: Record<string, string> = {
  ended: 'The owner stopped sharing.',
  'owner-left': 'The owner left.',
  revoked: 'The session was signed out.',
  access: 'You no longer have access to this workspace.',
  removed: 'The owner removed you from this shared terminal.',
  server: 'The server stopped.',
  lost: 'The connection to the server was lost.',
};

/**
 * A teammate's shared terminal (#429): read only, at the owner's size, until the owner grants this user
 * control; then what is typed goes to their session. When the share ends the tab says why and keeps the
 * screen until it is closed. Closing the tab leaves the share.
 */
export function ShareViewTab({ tabId }: { readonly tabId: string }) {
  const viewId = viewIdOf(tabId);
  const holder = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const view = useTerminalShareStore((s) => s.views[viewId]);
  const state = view?.state;
  const self = state?.self;
  const holding = state !== undefined && self !== undefined && state.control === self && state.ended === undefined;
  const holdingRef = useRef(holding);
  holdingRef.current = holding;

  useEffect(() => {
    const element = holder.current;
    if (element === null) return;
    const xterm = new Terminal({
      ...terminalAppearance(usePreferencesStore.getState().preferences.terminal, undefined, 0),
      cols: useTerminalShareStore.getState().views[viewId]?.cols ?? 80,
      rows: useTerminalShareStore.getState().views[viewId]?.rows ?? 24,
      cursorBlink: false,
    });
    const platform = detectPlatform();
    // The palette's chord stays the app's; everything else is sent only while this user holds control.
    xterm.attachCustomKeyEventHandler((event) => !isPaletteChord(event, platform));
    xterm.open(element);
    term.current = xterm;
    const typed = xterm.onData((data) => {
      if (holdingRef.current) void ipc().terminalShare.input({ viewId, data: bytesToBase64(encoder.encode(data)) });
    });
    const detach = attachShareView(viewId, (bytes) => {
      xterm.write(bytes);
    });
    return () => {
      detach();
      typed.dispose();
      xterm.dispose();
      term.current = null;
      leaveShareView(viewId);
    };
  }, [viewId]);

  // The owner's terminal size, so lines wrap where theirs do.
  const cols = view?.cols;
  const rows = view?.rows;
  useEffect(() => {
    if (cols !== undefined && rows !== undefined) term.current?.resize(cols, rows);
  }, [cols, rows]);

  useEffect(() => {
    if (holding) term.current?.focus();
  }, [holding]);

  const ended = state?.ended;
  const holderName =
    state?.control === null || state === undefined
      ? undefined
      : state.control === self
        ? 'You'
        : (state.viewers.find((v) => v.userId === state.control)?.name ?? 'Someone');
  const others = [...new Map((state?.viewers ?? []).map((v) => [v.userId, v])).values()];

  return (
    <div className="flex h-full min-w-0 flex-col" data-testid="share-view">
      <div
        className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-1.5 text-xs text-fg-default"
        data-testid="share-view-header"
      >
        <span className="font-medium">
          {view?.ownerName ?? ''} · {view?.hostName ?? ''}
        </span>
        <span className="text-fg-subtle">{others.length} watching</span>
        {others.map((viewer) => (
          <span key={viewer.userId} className="rounded-full border border-hairline px-2 py-0.5">
            {viewer.userId === self ? `${viewer.name} (you)` : viewer.name}
          </span>
        ))}
        <span className="flex-1" />
        {ended === undefined && (
          <>
            <span data-testid="share-view-control">
              {holderName === undefined
                ? 'View only'
                : `${holderName} ${holderName === 'You' ? 'have' : 'has'} control`}
            </span>
            {state?.declined === true && <span className="text-fg-subtle">The owner declined.</span>}
            {holding ? (
              <button
                type="button"
                className={BUTTON}
                onClick={() => {
                  void ipc().terminalShare.release({ viewId });
                }}
              >
                Release control
              </button>
            ) : (
              <button
                type="button"
                className={BUTTON}
                disabled={state?.requesting === true}
                onClick={() => {
                  void ipc().terminalShare.requestControl({ viewId });
                }}
              >
                {state?.requesting === true ? 'Control requested' : 'Request control'}
              </button>
            )}
          </>
        )}
      </div>
      {ended !== undefined && (
        <div
          className="border-b border-hairline px-3 py-1.5 text-xs text-fg-default"
          role="status"
          data-testid="share-view-ended"
        >
          {ENDED[ended] ?? 'The shared terminal ended.'}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto bg-surface-sunken p-2">
        <div ref={holder} data-testid="share-view-terminal" data-control={holding ? 'true' : undefined} />
      </div>
    </div>
  );
}
