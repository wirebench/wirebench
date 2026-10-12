/**
 * The Files tabs' state: two panes per tab, this machine on the left and the host on the right, each with its
 * place, folder, listing, selection and Back history (the host's with its SFTP session). A pane's id is its
 * tab's id for the host's pane and {@link localPaneId} for this machine's. Every file operation is a typed
 * channel to main; this store only remembers what main answered. Each host's last folder and the
 * hidden-entries toggle are remembered on this machine (`files-prefs.ts`).
 */
import { create } from 'zustand';
import type { IpcResult } from '../../../../shared/ipc.js';
import type { SftpEntryWire, SftpPlaceWire } from '../../../../shared/sftp-wire.js';
import { useEditorsStore } from '../../../state/editors.js';
import { showToast } from '../../../components/toast.js';
import { ipc } from '../../../state/ipc-client.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { openTrustPrompt } from '../connect.js';
import { folderKey, readFilesPrefs, updateFilesPrefs } from './files-prefs.js';
import { freeName, joinPath, parentOf } from './format.js';

/** The id of a tab's pane for this machine; the host's pane has the tab's own id. */
export function localPaneId(tabId: string): string {
  return `${tabId}#local`;
}

/** The tab a pane belongs to. */
export function tabOfPane(paneId: string): string {
  return paneId.endsWith('#local') ? paneId.slice(0, -'#local'.length) : paneId;
}

/** The pane beside `paneId` in its tab. */
export function otherPaneId(paneId: string): string {
  const tabId = tabOfPane(paneId);
  return paneId === tabId ? localPaneId(tabId) : tabId;
}

export interface PaneError {
  readonly code: string;
  readonly message: string;
}

export type SortColumn = 'name' | 'size' | 'mtime' | 'mode';

export interface PaneSort {
  readonly column: SortColumn;
  readonly descending: boolean;
}

export type PanePlace =
  { readonly kind: 'local' } | { readonly kind: 'remote'; readonly hostId: string; readonly sessionId?: string };

export interface PaneState {
  readonly place: PanePlace;
  /** The absolute folder listed; `''` until the first listing lands. */
  readonly path: string;
  /** The server's login folder, or this machine's home folder: what `~` means. */
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

/** A pane's open dialog: confirming a delete, or editing one entry's permissions. */
export type PaneDialog =
  | { readonly kind: 'delete'; readonly names: readonly string[]; readonly folders: boolean }
  | { readonly kind: 'permissions'; readonly name: string; readonly mode: number };

interface FilesState {
  /** By pane id (see {@link localPaneId}). The store's per-pane actions take a pane id. */
  readonly panes: Readonly<Record<string, PaneState>>;
  /** Per tab: the pane last used, which the `sftp.*` commands act on. */
  readonly activePanes: Readonly<Record<string, string>>;
  setActivePane: (paneId: string) => void;
  /** Bumped per pane to move the keyboard into its list (Tab from the other pane). */
  readonly focusRequests: Readonly<Record<string, number>>;
  focusPane: (paneId: string) => void;
  /** Lists this machine's home folder in a new local pane; a pane already listing is left as it is. */
  openLocal: (paneId: string) => Promise<void>;
  /** Whether names starting with `.` show; one setting for every pane, remembered on this machine. */
  readonly showHidden: boolean;
  /** Bumped per tab to turn its path bar into a text field (⌘L). */
  readonly pathEditRequests: Readonly<Record<string, number>>;
  requestPathEdit: (tabId: string) => void;
  /** Per tab: the dialog open over its pane. */
  readonly dialogs: Readonly<Record<string, PaneDialog | undefined>>;
  setDialog: (tabId: string, dialog: PaneDialog | undefined) => void;
  /** Per tab: the entry being renamed in place. */
  readonly renaming: Readonly<Record<string, string | undefined>>;
  setRenaming: (tabId: string, name: string | undefined) => void;
  /** Makes a folder with a free name (`New folder`, `New folder 2`, …), selects it and starts renaming it. */
  newFolder: (tabId: string) => Promise<void>;
  /** Renames `from` to `to` in the pane's folder; `false` when refused (the toast says why). */
  rename: (tabId: string, from: string, to: string) => Promise<boolean>;
  /** Deletes the named entries, folders with their contents. */
  remove: (tabId: string, names: readonly string[]) => Promise<void>;
  chmod: (tabId: string, name: string, mode: number) => Promise<void>;
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
  /** The tab closed: its session ends and both panes' state goes. */
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

/** Where a pane's operations go: this machine, or its session; `undefined` while a host's pane has none. */
export function placeWireOf(pane: PaneState): SftpPlaceWire | undefined {
  if (pane.place.kind === 'local') return { kind: 'local' };
  return pane.place.sessionId === undefined ? undefined : { kind: 'remote', sessionId: pane.place.sessionId };
}

/** The session of a host's pane. */
const sessionOf = (pane: PaneState | undefined): string | undefined =>
  pane?.place.kind === 'remote' ? pane.place.sessionId : undefined;

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

/** Where a pane's file operations go: its place and folder, and the names already there. */
interface PaneTarget {
  readonly place: SftpPlaceWire;
  readonly path: string;
  readonly names: readonly string[];
}

function paneTarget(paneId: string): PaneTarget | undefined {
  const pane = useFilesStore.getState().panes[paneId];
  const place = pane === undefined ? undefined : placeWireOf(pane);
  if (pane === undefined || place === undefined || pane.path === '') return undefined;
  return { place, path: pane.path, names: pane.entries.map((e) => e.name) };
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
    activePanes: {},
    setActivePane: (paneId) => {
      const tabId = tabOfPane(paneId);
      if (get().activePanes[tabId] !== paneId) set({ activePanes: { ...get().activePanes, [tabId]: paneId } });
    },
    focusRequests: {},
    focusPane: (paneId) => {
      const { focusRequests } = get();
      set({ focusRequests: { ...focusRequests, [paneId]: (focusRequests[paneId] ?? 0) + 1 } });
      get().setActivePane(paneId);
    },
    openLocal: async (paneId) => {
      // A pane that never listed (its home could not be read) may try again.
      const existing = get().panes[paneId];
      if (existing !== undefined && !(existing.status === 'error' && existing.path === '')) return;
      set({
        panes: {
          ...get().panes,
          [paneId]: {
            place: { kind: 'local' },
            path: '',
            home: '',
            entries: [],
            selected: [],
            history: [],
            status: 'loading',
            sort: DEFAULT_SORT,
          },
        },
      });
      const home = await settle(() => ipc().sftp.localHome({}), 'The home folder could not be found');
      if (get().panes[paneId] === undefined) return;
      if (!home.ok) {
        patch(paneId, { status: 'error', error: errorOf(home.error, 'The home folder could not be found') });
        return;
      }
      patch(paneId, { home: home.value.home });
      if (!(await get().navigate(paneId, home.value.home))) {
        const pane = get().panes[paneId];
        if (pane !== undefined && pane.path === '') patch(paneId, { status: 'error' });
      }
    },
    showHidden: readFilesPrefs().showHidden,
    pathEditRequests: {},
    dialogs: {},
    setDialog: (tabId, dialog) => {
      set({ dialogs: { ...get().dialogs, [tabId]: dialog } });
    },
    renaming: {},
    setRenaming: (tabId, name) => {
      set({ renaming: { ...get().renaming, [tabId]: name } });
    },

    newFolder: async (tabId) => {
      const target = paneTarget(tabId);
      if (target === undefined) return;
      const name = freeName('New folder', target.names);
      const made = await settle(
        () => ipc().sftp.mkdir({ place: target.place, path: joinPath(target.path, name) }),
        'The folder could not be made',
      );
      if (!made.ok) {
        showToast(made.error.message);
        await get().refresh(tabId);
        return;
      }
      await get().refresh(tabId);
      get().select(tabId, [name]);
      get().setRenaming(tabId, name);
    },

    rename: async (tabId, from, to) => {
      const target = paneTarget(tabId);
      if (target === undefined) return false;
      const renamed = await settle(
        () =>
          ipc().sftp.rename({
            place: target.place,
            from: joinPath(target.path, from),
            to: joinPath(target.path, to),
          }),
        'The entry could not be renamed',
      );
      if (!renamed.ok) showToast(renamed.error.message);
      await get().refresh(tabId);
      if (renamed.ok) get().select(tabId, [to]);
      return renamed.ok;
    },

    remove: async (tabId, names) => {
      const target = paneTarget(tabId);
      if (target === undefined || names.length === 0) return;
      const removed = await settle(
        () =>
          ipc().sftp.remove({
            place: target.place,
            paths: names.map((name) => joinPath(target.path, name)),
            recursive: true,
          }),
        'The entries could not be deleted',
      );
      if (!removed.ok) showToast(removed.error.message);
      await get().refresh(tabId);
    },

    chmod: async (tabId, name, mode) => {
      const target = paneTarget(tabId);
      if (target === undefined) return;
      const changed = await settle(
        () => ipc().sftp.chmod({ place: target.place, path: joinPath(target.path, name), mode }),
        'The permissions could not be changed',
      );
      if (!changed.ok) showToast(changed.error.message);
      await get().refresh(tabId);
    },

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
      if (sessionOf(existing) !== undefined || connecting.has(tabId)) return;
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
          // The Files tab stands in for the terminal's pane: the prompt resumes the tab's own connect.
          openTrustPrompt(
            { paneId: tabId, hostId },
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
      const place = pane === undefined ? undefined : placeWireOf(pane);
      if (pane === undefined || place === undefined) return false;
      const sessionId = sessionOf(pane);
      const turn = nextTurn(tabId);
      patch(tabId, { status: 'loading' });
      const listed = await settle(() => ipc().sftp.list({ place, path }), 'The folder could not be listed');
      const now = get().panes[tabId];
      if (turns.get(tabId) !== turn || now === undefined || sessionOf(now) !== sessionId) return false;
      if (!listed.ok) {
        const error = errorOf(listed.error, 'The folder could not be listed');
        if (error.code === 'sftp-session-unknown' && now.place.kind === 'remote') {
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
      if (now.place.kind === 'remote') rememberFolder(now.place.hostId, listed.value.path);
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
      if (pane === undefined || pane.path === '' || parentOf(pane.path) === pane.path) return;
      await get().navigate(tabId, parentOf(pane.path), { push: true });
    },

    refresh: async (tabId) => {
      const pane = get().panes[tabId];
      if (pane === undefined) return;
      if (pane.place.kind === 'remote' && pane.place.sessionId === undefined) {
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
      const tabId = Object.keys(panes).find((id) => sessionOf(panes[id]) === sessionId);
      const pane = tabId === undefined ? undefined : panes[tabId];
      if (tabId === undefined || pane?.place.kind !== 'remote') return;
      patch(tabId, {
        place: { kind: 'remote', hostId: pane.place.hostId },
        status: 'error',
        error: { code: 'sftp-closed', message: 'The connection to the host ended.' },
      });
    },

    close: (tabId) => {
      const local = localPaneId(tabId);
      const { panes, activePanes } = get();
      if (panes[tabId] === undefined && panes[local] === undefined) return;
      turns.delete(tabId);
      turns.delete(local);
      const sessionId = sessionOf(panes[tabId]);
      if (sessionId !== undefined)
        void ipc()
          .sftp.close({ sessionId })
          .catch(() => undefined);
      const rest = { ...panes };
      delete rest[tabId];
      delete rest[local];
      const active = { ...activePanes };
      delete active[tabId];
      set({
        panes: rest,
        activePanes: active,
        dialogs: { ...get().dialogs, [tabId]: undefined, [local]: undefined },
        renaming: { ...get().renaming, [tabId]: undefined, [local]: undefined },
      });
    },
  };
});
