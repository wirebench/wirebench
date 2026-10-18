import { create } from 'zustand';
import type {
  TerminalShareStateEvent,
  TerminalShareViewerDataEvent,
  TerminalShareViewerStateEvent,
} from '@shared/terminal-share-wire.js';
import { useEditorsStore } from '../../state/editors.js';
import { ipc } from '../../state/ipc-client.js';
import { base64ToBytes } from './terminal-session.js';

/**
 * Shared terminals (#429) in this window: the shares of its own sessions, by session id, and the
 * teammates' terminals it watches, by view id. A view's output is held here until its tab's terminal
 * takes it, so the replay that arrives before `join` answers is not lost.
 */
export interface ShareView {
  readonly hostName: string;
  readonly ownerName: string;
  readonly cols: number;
  readonly rows: number;
  readonly state?: TerminalShareViewerStateEvent;
}

interface TerminalShareState {
  /** The window's workspace is on a server that relays shared terminals; unknown until asked. */
  readonly available: boolean | undefined;
  readonly owned: Readonly<Record<string, TerminalShareStateEvent>>;
  readonly views: Readonly<Record<string, ShareView>>;
  readonly joinOpen: boolean;
}

export const useTerminalShareStore = create<TerminalShareState>()(() => ({
  available: undefined,
  owned: {},
  views: {},
  joinOpen: false,
}));

type Sink = (bytes: Uint8Array) => void;
const sinks = new Map<string, Sink>();
const pending = new Map<string, Uint8Array[]>();

/** Hands a view's output to its terminal: what arrived before now first. Returns the detach. */
export function attachShareView(viewId: string, sink: Sink): () => void {
  sinks.set(viewId, sink);
  for (const bytes of pending.get(viewId) ?? []) sink(bytes);
  pending.delete(viewId);
  return () => {
    if (sinks.get(viewId) === sink) sinks.delete(viewId);
  };
}

function onViewerData(event: TerminalShareViewerDataEvent): void {
  const bytes = base64ToBytes(event.data);
  const sink = sinks.get(event.viewId);
  if (sink !== undefined) sink(bytes);
  else pending.set(event.viewId, [...(pending.get(event.viewId) ?? []), bytes]);
}

function onOwnedState(event: TerminalShareStateEvent): void {
  useTerminalShareStore.setState((s) => {
    const owned = { ...s.owned };
    if (event.ended !== undefined) delete owned[event.sessionId];
    else owned[event.sessionId] = event;
    return { owned };
  });
}

function onViewerState(event: TerminalShareViewerStateEvent): void {
  useTerminalShareStore.setState((s) => {
    const view = s.views[event.viewId];
    if (view === undefined) return s;
    return { views: { ...s.views, [event.viewId]: { ...view, cols: event.cols, rows: event.rows, state: event } } };
  });
}

type Listener = (payload: unknown) => void;

/** Listens for share and view events; called once from the shell. */
export function subscribeToShareEvents(): () => void {
  const offs = [
    window.wirebench.on('terminalShare.state', onOwnedState as Listener),
    window.wirebench.on('terminalShare.viewerData', onViewerData as Listener),
    window.wirebench.on('terminalShare.viewerState', onViewerState as Listener),
  ];
  return () => {
    for (const off of offs) off();
  };
}

/** Asks main whether Share session is offered here; the answer stays until the workspace changes. */
export async function refreshShareAvailable(): Promise<void> {
  try {
    const result = await ipc().terminalShare.available({});
    useTerminalShareStore.setState({ available: result.ok && result.value.available });
  } catch {
    // Not offered when main cannot say (the SSH area off, a window going away).
    useTerminalShareStore.setState({ available: false });
  }
}

/** Starts sharing a session; the answer says why not when it could not. */
export async function startShare(request: {
  readonly sessionId: string;
  readonly hostName: string;
  readonly cols: number;
  readonly rows: number;
}): Promise<{ readonly ok: true; readonly invite: string } | { readonly ok: false; readonly message: string }> {
  const result = await ipc().terminalShare.start(request);
  if (!result.ok) return { ok: false, message: result.error.message };
  // The first state event may come before this answer; until then the strip shows nobody watching.
  useTerminalShareStore.setState((s) =>
    s.owned[request.sessionId] !== undefined
      ? s
      : {
          owned: {
            ...s.owned,
            [request.sessionId]: {
              sessionId: request.sessionId,
              shareId: result.value.shareId,
              invite: result.value.invite,
              viewers: [],
              control: null,
            },
          },
        },
  );
  return { ok: true, invite: result.value.invite };
}

export function openJoinShare(): void {
  useTerminalShareStore.setState({ joinOpen: true });
}

export function closeJoinShare(): void {
  useTerminalShareStore.setState({ joinOpen: false });
}

/** Joins the share a link names, in a new tab; the answer says why not when it could not. */
export async function joinShare(
  link: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const viewId = crypto.randomUUID();
  const result = await ipc().terminalShare.join({ link, viewId });
  if (!result.ok) {
    pending.delete(viewId);
    return { ok: false, message: result.error.message };
  }
  const { hostName, ownerName, cols, rows } = result.value;
  useTerminalShareStore.setState((s) => ({
    views: { ...s.views, [viewId]: { hostName, ownerName, cols, rows, ...(s.views[viewId] ?? {}) } },
  }));
  useEditorsStore
    .getState()
    .open({ id: shareTabId(viewId), kind: 'terminal-share', title: shareTitle(ownerName, hostName) });
  return { ok: true };
}

/** The tab of a view: `terminal-share:<viewId>`. */
export function shareTabId(viewId: string): string {
  return `terminal-share:${viewId}`;
}

export function viewIdOf(tabId: string): string {
  return tabId.slice('terminal-share:'.length);
}

export function shareTitle(ownerName: string, hostName: string): string {
  return ownerName.length > 0 ? `${ownerName} · ${hostName}` : hostName;
}

/** The tab closed: the view leaves the share and its state goes. */
export function leaveShareView(viewId: string): void {
  void ipc().terminalShare.leave({ viewId });
  sinks.delete(viewId);
  pending.delete(viewId);
  useTerminalShareStore.setState((s) => {
    const views = { ...s.views };
    delete views[viewId];
    return { views };
  });
}
