/**
 * The Files tabs' state: one remote pane per tab, with its SFTP session, folder, listing, selection and Back
 * history. Every file operation is a typed channel to main; this store only remembers what main answered.
 * Each host's last folder and the hidden-entries toggle are remembered on this machine (`files-prefs.ts`).
 */
import { create } from 'zustand';
import type { IpcResult } from '../../../../shared/ipc.js';
import type { SftpEntryWire } from '../../../../shared/sftp-wire.js';
import { useEditorsStore } from '../../../state/editors.js';
import { ipc } from '../../../state/ipc-client.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { openTrustPrompt } from '../connect.js';
import { folderKey, readFilesPrefs, updateFilesPrefs } from './files-prefs.js';
import { parentOf } from './format.js';

export interface PaneError {
  readonly code: string;
  readonly message: string;
}

export type SortColumn = 'name' | 'size' | 'mtime' | 'mode';

export interface PaneSort {
  readonly column: SortColumn;
  readonly descending: boolean;
}

export interface PaneState {
  readonly place: { readonly kind: 'remote'; readonly hostId: string; readonly sessionId?: string };
  /** The absolute folder listed; `''` until the first listing lands. */
  readonly path: string;
  /** The server's login folder, what `~` means. */
  readonly home: string;
  readonly entries: readonly SftpEntryWire[];
  /** Names in `path`. */
  readonly selected: readonly string[];
  /** Folders Back returns to, most recent last. */
  readonly history: readonly string[];
  /**
   * `connecting` until the session opens (or while the trust prompt waits), `loading` while a listing is on
   * its way, `error` when there is no session (the connect failed or the connection ended; `error` says why),
   * otherwise `idle`. An `idle` pane with `error` set is a refused navigation: the old listing stays.
   */
  readonly status: 'idle' | 'connecting' | 'loading' | 'error';
  readonly error?: PaneError | undefined;
  readonly sort: PaneSort;
}

interface FilesState {
  /** By editor tab id. */
  readonly panes: Readonly<Record<string, PaneState>>;
  /** Whether names starting with `.` show; one setting for every pane, remembered on this machine. */
  readonly showHidden: boolean;
  /** Bumped per tab to turn its path bar into a text field (⌘L). */
  readonly pathEditRequests: Readonly<Record<string, number>>;
  requestPathEdit: (tabId: string) => void;
  setShowHidden: (show: boolean) => void;
  /** Opens the tab's SFTP session (again, after a failure) and lists the host's last folder or its home. */
  connect: (tabId: string, hostId: string) => Promise<void>;
  /** Lists `path`; with `push`, the folder left goes on the Back history. A refusal keeps the listing. */
  navigate: (tabId: string, path: string, options?: { readonly push?: boolean }) => Promise<boolean>;
  back: (tabId: string) => Promise<void>;
  up: (tabId: string) => Promise<void>;
  /** Lists the folder again, keeping what is still there selected; a pane with no session connects. */
  refresh: (tabId: string) => Promise<void>;
  select: (tabId: string, names: readonly string[]) => void;
  setSort: (tabId: string, sort: PaneSort) => void;
  /** Main ended a session (lost, or the workspace went): its pane says so and offers to connect again. */
  noteClosed: (sessionId: string) => void;
  /** The tab closed: its session ends and its state goes. */
  close: (tabId: string) => void;
}

const DEFAULT_SORT: PaneSort = { column: 'name', descending: false };

/** Tabs with a `sftp.open` in flight, so a second mount or click does not open a second session. */
const connecting = new Set<string>();

/** A navigation's turn per tab: an answer to an older one is dropped. */
const turns = new Map<string, number>();

function nextTurn(tabId: string): number {
  const turn = (turns.get(tabId) ?? 0) + 1;
  turns.set(tabId, turn);
  return turn;
}

function errorOf(value: unknown, fallback: string): PaneError {
  const shaped = value as { code?: unknown; message?: unknown } | null;
  return {
    code: typeof shaped?.code === 'string' ? shaped.code : 'sftp-failed',
    message: typeof shaped?.message === 'string' ? shaped.message : fallback,
  };
}

/** A channel call as an `IpcResult`, a throw included. */
export async function settle<T>(call: () => Promise<IpcResult<T>>, fallback: string): Promise<IpcResult<T>> {
  try {
    return await call();
  } catch (error) {
    return { ok: false, error: errorOf(error, fallback) };
  }
}

function tabExists(tabId: string): boolean {
  return useEditorsStore.getState().tabs.some((t) => t.id === tabId);
}

function rememberFolder(hostId: string, path: string): void {
  const workspaceId = useWorkspaceStore.getState().workspace?.id;
  if (workspaceId === undefined) return;
  updateFilesPrefs((prefs) => ({
    ...prefs,
    lastFolder: { ...prefs.lastFolder, [folderKey(workspaceId, hostId)]: path },
  }));
}

function lastFolder(hostId: string): string | undefined {
  const workspaceId = useWorkspaceStore.getState().workspace?.id;
  return workspaceId === undefined ? undefined : readFilesPrefs().lastFolder[folderKey(workspaceId, hostId)];
}

function freshPane(hostId: string): PaneState {
  return {
    place: { kind: 'remote', hostId },
    path: '',
    home: '',
    entries: [],
    selected: [],
    history: [],
    status: 'connecting',
    sort: DEFAULT_SORT,
  };
}

export const useFilesStore = create<FilesState>()((set, get) => {
  const replace = (tabId: string, change: (pane: PaneState) => PaneState): void => {
    const pane = get().panes[tabId];
    if (pane === undefined) return;
    set({ panes: { ...get().panes, [tabId]: change(pane) } });
  };
  const patch = (tabId: string, change: Partial<PaneState>): void => {
    replace(tabId, (pane) => ({ ...pane, ...change }));
  };

  return {
    panes: {},
    showHidden: readFilesPrefs().showHidden,
    pathEditRequests: {},
    requestPathEdit: (tabId) => {
      const { pathEditRequests } = get();
      set({ pathEditRequests: { ...pathEditRequests, [tabId]: (pathEditRequests[tabId] ?? 0) + 1 } });
    },
    setShowHidden: (showHidden) => {
      set({ showHidden });
      updateFilesPrefs((prefs) => ({ ...prefs, showHidden }));
    },

    connect: async (tabId, hostId) => {
      const existing = get().panes[tabId];
      if (existing?.place.sessionId !== undefined || connecting.has(tabId)) return;
      set({
        panes: {
          ...get().panes,
          [tabId]: existing === undefined ? freshPane(hostId) : { ...existing, error: undefined, status: 'connecting' },
        },
      });
      connecting.add(tabId);
      const opened = await settle(() => ipc().sftp.open({ hostId }), 'The connection could not be started').finally(
        () => {
          connecting.delete(tabId);
        },
      );
      if (!tabExists(tabId) || get().panes[tabId] === undefined) {
        // The tab closed while the connect ran: nothing will use the session.
        if (opened.ok)
          void ipc()
            .sftp.close({ sessionId: opened.value.sessionId })
            .catch(() => undefined);
        return;
      }
      if (!opened.ok) {
        const { code, message, details } = opened.error;
        if ((code === 'ssh-host-key-new' || code === 'ssh-host-key-changed') && details) {
          openTrustPrompt(
            hostId,
            {
              retry: () => {
                void get().connect(tabId, hostId);
              },
              cancel: () => {
                patch(tabId, { status: 'error', error: { code, message: 'The host key was not trusted.' } });
              },
            },
            details,
          );
          return;
        }
        patch(tabId, { status: 'error', error: { code, message } });
        return;
      }
      const { sessionId, home } = opened.value;
      patch(tabId, { place: { kind: 'remote', hostId, sessionId }, home, status: 'loading' });
      const remembered = lastFolder(hostId);
      if (remembered !== undefined && remembered !== home && (await get().navigate(tabId, remembered))) return;
      // A remembered folder that is gone falls back to home, without its refusal showing.
      await get().navigate(tabId, home);
    },

    navigate: async (tabId, path, options = {}) => {
      const pane = get().panes[tabId];
      const sessionId = pane?.place.sessionId;
      if (pane === undefined || sessionId === undefined) return false;
      const turn = nextTurn(tabId);
      patch(tabId, { status: 'loading' });
      const listed = await settle(
        () => ipc().sftp.list({ place: { kind: 'remote', sessionId }, path }),
        'The folder could not be listed',
      );
      const now = get().panes[tabId];
      if (turns.get(tabId) !== turn || now === undefined || now.place.sessionId !== sessionId) return false;
      if (!listed.ok) {
        const error = errorOf(listed.error, 'The folder could not be listed');
        if (error.code === 'sftp-session-unknown') {
          patch(tabId, { status: 'error', error, place: { kind: 'remote', hostId: now.place.hostId } });
        } else {
          patch(tabId, { status: 'idle', error });
        }
        return false;
      }
      const left = now.path;
      const pushed = options.push === true && left !== '' && left !== listed.value.path;
      replace(tabId, (current) => ({
        ...current,
        error: undefined,
        path: listed.value.path,
        entries: listed.value.entries,
        selected: [],
        history: pushed ? [...current.history, left] : current.history,
        status: 'idle',
      }));
      rememberFolder(now.place.hostId, listed.value.path);
      return true;
    },

    back: async (tabId) => {
      const pane = get().panes[tabId];
      const previous = pane?.history.at(-1);
      if (pane === undefined || previous === undefined) return;
      if (await get().navigate(tabId, previous)) patch(tabId, { history: pane.history.slice(0, -1) });
    },

    up: async (tabId) => {
      const pane = get().panes[tabId];
      if (pane === undefined || pane.path === '' || pane.path === '/') return;
      await get().navigate(tabId, parentOf(pane.path), { push: true });
    },

    refresh: async (tabId) => {
      const pane = get().panes[tabId];
      if (pane === undefined) return;
      if (pane.place.sessionId === undefined) {
        await get().connect(tabId, pane.place.hostId);
        return;
      }
      const selected = pane.selected;
      if (await get().navigate(tabId, pane.path === '' ? pane.home : pane.path)) {
        const names = new Set((get().panes[tabId]?.entries ?? []).map((e) => e.name));
        patch(tabId, { selected: selected.filter((name) => names.has(name)) });
      }
    },

    select: (tabId, names) => {
      patch(tabId, { selected: names });
    },

    setSort: (tabId, sort) => {
      patch(tabId, { sort });
    },

    noteClosed: (sessionId) => {
      const { panes } = get();
      const tabId = Object.keys(panes).find((id) => panes[id]?.place.sessionId === sessionId);
      const pane = tabId === undefined ? undefined : panes[tabId];
      if (tabId === undefined || pane === undefined) return;
      patch(tabId, {
        place: { kind: 'remote', hostId: pane.place.hostId },
        status: 'error',
        error: { code: 'sftp-closed', message: 'The connection to the host ended.' },
      });
    },

    close: (tabId) => {
      const pane = get().panes[tabId];
      if (pane === undefined) return;
      turns.delete(tabId);
      const sessionId = pane.place.sessionId;
      if (sessionId !== undefined)
        void ipc()
          .sftp.close({ sessionId })
          .catch(() => undefined);
      const panes = { ...get().panes };
      delete panes[tabId];
      set({ panes });
    },
  };
});
