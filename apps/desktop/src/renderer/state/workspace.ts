/**
 * The renderer's mirror of the open workspace: the picker's list, the open workspace's
 * manifest, and one action per `workspace.*` channel.
 *
 * This store is what decides whether the app shows the IDE at all — `workspace === null` is
 * the picker. Closing a workspace therefore also resets every store keyed by entities of its
 * projects (see {@link WorkspaceStore.applySnapshot}), so nothing survives into the next one.
 */

import { create } from 'zustand';
import type { IpcError } from '../../shared/ipc.js';
import type {
  WorkspaceChange,
  WorkspaceChangedEvent,
  WorkspaceEnvironmentPatchWire,
  WorkspaceSummaryWire,
  WorkspaceWire,
} from '../../shared/wire-types.js';
import { queueEnvironmentPatch } from '../features/environments/environment-queue.js';
import { useInterfaceEditorStore } from '../features/interface-editor/interface-editor-state.js';
import { useDraftsStore } from './drafts.js';
import { useEditorsStore } from './editors.js';
import { useExchangesStore } from './exchanges.js';
import { useProjectStore } from './project.js';
import { restoreWorkspaceTabs, saveWorkspaceTabs } from './workspace-tabs.js';
import { ipc } from './ipc-client.js';
import { restoreUnsaved, stashDrafts, subscribeToDraftStash } from './unsaved-drafts.js';

function asError(error: IpcError): Error {
  return Object.assign(new Error(error.message), {
    code: error.code,
    ...(error.details !== undefined ? { details: error.details } : {}),
  });
}

/** The workspace store's serialisable state. */
export interface WorkspaceSnapshot {
  /** The open workspace, or `null` when the picker should be shown. */
  readonly workspace: WorkspaceWire | null;
  /** Every workspace on disk, newest-opened first; the picker's rows. */
  readonly workspaces: readonly WorkspaceSummaryWire[];
  /** Project folders from a leftover pre-workspace recent list, offered on the picker. */
  readonly suggestions: readonly string[];
  /**
   * `false` until the first `workspace.snapshot` pull has answered. Main holds that answer
   * until its launch-time reopen settles, so while this is `false` the shell shows neither the
   * picker nor the IDE — it does not yet know which one is right.
   */
  readonly ready: boolean;
  /** Why the launch-time reopen (or the last close) failed, from `workspace.list`; the picker's banner. */
  readonly lastError?: string | undefined;
  readonly status: 'idle' | 'loading' | 'error';
  readonly error?: IpcError | undefined;
}

/** The workspace store: {@link WorkspaceSnapshot} plus one action per `workspace.*` channel. */
export interface WorkspaceStore extends WorkspaceSnapshot {
  /**
   * Replaces the mirror wholesale. `null` (the workspace closed) also resets the editors,
   * exchanges, interface-editor and project stores: every one of them is keyed by an entity id
   * of a project that is no longer open.
   */
  readonly applySnapshot: (workspace: WorkspaceWire | null) => void;
  readonly list: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly create: (name: string) => Promise<void>;
  readonly open: (workspaceId: string) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly rename: (workspaceId: string, name: string) => Promise<void>;
  readonly remove: (workspaceId: string) => Promise<void>;
  /** Creates a project inside the open workspace; returns its id. */
  readonly addProject: (name: string) => Promise<string>;
  /** Runs main's folder picker and links the project it names. `false` when cancelled. */
  readonly linkProject: () => Promise<boolean>;
  /** Runs main's folder picker and copies the project it names into the workspace. */
  readonly importProjectFolder: () => Promise<boolean>;
  /** Copies the `index`th of {@link WorkspaceSnapshot.suggestions} into the workspace (creating one if none is open). */
  readonly importSuggestion: (index: number) => Promise<void>;
  /** Shows a workspace's folder in the OS file manager. */
  readonly reveal: (workspaceId: string) => Promise<void>;
  /** Shows one project's folder in the OS file manager. */
  readonly revealProject: (projectId: string) => Promise<void>;
  /** Runs main's folder picker and writes the project out to it; the folder, or `null`. */
  readonly exportProject: (projectId: string) => Promise<string | null>;
  /** Re-points a missing linked project at a folder the user picks. `false` when cancelled. */
  readonly locateProject: (projectId: string) => Promise<boolean>;
  readonly removeProject: (projectId: string, deleteFiles: boolean) => Promise<void>;
  /** Switches the workspace's active environment; `null` deactivates. */
  readonly setActiveEnvironment: (environmentId: string | null) => Promise<void>;
  /** Applies one change to the workspace manifest; returns any entity it created. */
  readonly mutate: (change: WorkspaceChange) => Promise<{ readonly createdEnvironmentId?: string }>;
  /** Toggles one workspace property's disabled flag without removing it. */
  readonly setWorkspacePropertyEnabled: (name: string, enabled: boolean) => Promise<void>;
  /**
   * Patches one workspace environment. `endpoints`/`properties`/`disabled` REPLACE the whole
   * map or list (send the complete one you want it to end up with); omit a field to leave it
   * untouched. Routed through {@link queueEnvironmentPatch} so a burst of edits to the same
   * environment serialise rather than race — see `environment-queue.ts`.
   */
  readonly updateEnvironment: (environmentId: string, patch: WorkspaceEnvironmentPatchWire) => Promise<void>;
  /** Shares the open local workspace as a git repository (remote/branch validated and trimmed in main). */
  readonly share: (remote?: string, branch?: string) => Promise<void>;
  /** Shares the open local workspace to an empty folder the user picks. `false` when cancelled. */
  readonly shareToFolder: () => Promise<boolean>;
  /** Clones a shared workspace from `remote` and opens it. */
  readonly join: (remote: string, branch?: string) => Promise<void>;
  /** Joins a shared workspace from an existing clone or synced folder the user picks. `false` when cancelled. */
  readonly joinFromFolder: () => Promise<boolean>;
  /** Makes the open shared workspace local again. */
  readonly stopSharing: () => Promise<void>;
  /** Moves a project from the open workspace into another one. */
  readonly moveProject: (projectId: string, workspaceId: string) => Promise<void>;
}

/** Projects whose `project.snapshot` pull is in flight, so a burst of workspace updates asks once. */
const pulling = new Set<string>();

/**
 * Pulls every ready project the mirror does not hold yet. `project.changed` is the usual way a
 * project reaches the mirror, but a renderer that subscribed after the hosts came up — a reload,
 * a window reopened from the dock, the startup race with `openLast()` — has missed those events,
 * and the workspace arriving is its only cue.
 *
 * A reply is applied only if it is still wanted: the workspace is still open with that project
 * in it, and no `project.changed` has filled the mirror in the meantime (that one is newer).
 *
 * @returns a promise that settles once every pull this call started has been applied — what
 * the tab restore waits on, since a tab can only be reopened once its entity is in the mirror.
 */
function pullMissingProjects(workspace: WorkspaceWire): Promise<void> {
  const mirrored = useProjectStore.getState().projects;
  const pulls: Promise<void>[] = [];
  for (const project of workspace.projects) {
    if (project.status !== 'ready' || mirrored[project.id] !== undefined || pulling.has(project.id)) {
      continue;
    }
    const projectId = project.id;
    pulling.add(projectId);
    pulls.push(
      ipc()
        .project.snapshot({ projectId })
        .then((result) => {
          const current = useWorkspaceStore.getState().workspace;
          const stillWanted =
            current !== null &&
            current.id === workspace.id &&
            current.projects.some((candidate) => candidate.id === projectId) &&
            useProjectStore.getState().projects[projectId] === undefined;
          if (result.ok && result.value.project !== null && stillWanted) {
            useProjectStore.getState().applySnapshot(projectId, result.value.project);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          pulling.delete(projectId);
        }),
    );
  }
  return Promise.all(pulls).then(() => undefined);
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => {
  /** Which workspace the tabs currently on screen belong to; `undefined` when none is open. */
  let tabsOwner: string | undefined;

  /**
   * Bumped every time the mirror goes empty. A reply that was already in flight when the
   * workspace closed describes a workspace that is no longer open, and applying it would flip
   * the shell from the picker back into an IDE over projects whose hosts are gone. Mirrors the
   * counter `state/project.ts` uses for the same reason.
   */
  let generation = 0;

  const apply = (workspace: WorkspaceWire | null): void => {
    if (workspace === null && tabsOwner !== undefined) {
      // Only a real close bumps it. A `null` while nothing is open — the startup `refresh()`
      // answering before `openLast()` has settled — must not invalidate an `open()` the user
      // started in the meantime.
      generation += 1;
    }
    const leaving = tabsOwner !== undefined && tabsOwner !== workspace?.id;
    if (leaving && tabsOwner !== undefined) {
      // Recorded while the outgoing workspace's tabs are still open, so neither closing it nor
      // replacing it with another one takes them with it.
      saveWorkspaceTabs(tabsOwner);
      tabsOwner = undefined;
    }
    if (leaving || workspace === null) {
      // Order matters only in that all of it happens before the shell rerenders: every one of
      // these holds ids of projects that are about to stop existing. The drafts were handed to
      // main before the switch was asked for (`handOverDrafts`), which keeps them with the
      // workspace being left.
      useDraftsStore.getState().reset();
      useEditorsStore.getState().reset();
      // Before the reset: dropping `wsByRequest` forgets the send ids, and main would then hold
      // sockets open against a workspace nothing on screen belongs to any more. The close is
      // asked for synchronously and its promise deliberately not waited on — the shell must not
      // wait on a socket to finish switching workspaces.
      void useExchangesStore.getState().closeOpenWsSessions();
      useExchangesStore.getState().reset();
      useInterfaceEditorStore.getState().reset();
      useProjectStore.getState().reset();
    }
    set({ workspace, status: 'idle', error: undefined });
    if (workspace === null) {
      return;
    }
    const opening = tabsOwner === undefined;
    tabsOwner = workspace.id;
    const pulled = pullMissingProjects(workspace);
    if (opening) {
      // The remembered tabs name entities of projects the mirror may not hold yet, so the
      // restore waits for the pull rather than dropping every tab as unresolvable.
      void pulled.then(() => {
        if (useWorkspaceStore.getState().workspace?.id === workspace.id) {
          restoreWorkspaceTabs(workspace.id);
          // Unsaved request edits from the last session name requests the mirror now holds.
          void restoreUnsaved(workspace.id).catch(() => undefined);
        }
      });
    }
  };

  /**
   * `apply`, for a reply to a request sent in `sentIn`: a stale reply is dropped rather than
   * put back on screen. Every action that awaits main and then mirrors the answer goes through
   * this; `apply` itself stays direct for the `workspace.changed` event, which is always
   * current by construction.
   */
  const applyReply = (sentIn: number, workspace: WorkspaceWire | null): void => {
    if (sentIn === generation) {
      apply(workspace);
    }
  };

  /**
   * Hands the open workspace's unsaved request edits to main before anything that may leave it:
   * main keeps them with that workspace (nothing is written to a project) and they come back the
   * next time it opens. A failure is not fatal — leaving still goes ahead.
   */
  const handOverDrafts = async (): Promise<void> => {
    const workspaceId = get().workspace?.id;
    if (workspaceId !== undefined) {
      await stashDrafts(workspaceId).catch(() => undefined);
    }
  };

  /** Unwraps an `IpcResult`, throwing the error so every action reports failure the same way. */
  const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: IpcError }): T => {
    if (!result.ok) {
      set({ status: 'error', error: result.error });
      throw asError(result.error);
    }
    return result.value;
  };

  return {
    workspace: null,
    workspaces: [],
    suggestions: [],
    ready: false,
    status: 'idle',

    applySnapshot: apply,

    list: async () => {
      set({ status: 'loading' });
      const result = await ipc().workspace.list(undefined);
      if (!result.ok) {
        set({ status: 'error', error: result.error });
        return;
      }
      set({
        workspaces: result.value.workspaces,
        suggestions: result.value.suggestions ?? [],
        lastError: result.value.lastError,
        status: 'idle',
        error: undefined,
      });
    },

    refresh: async () => {
      const sentIn = generation;
      const result = await ipc()
        .workspace.snapshot(undefined)
        .catch(() => undefined);
      if (result?.ok === true) {
        applyReply(sentIn, result.value.workspace);
      }
      // Even a failed pull ends the wait: the picker (with its error) beats an endless spinner.
      if (!get().ready) {
        set({ ready: true });
      }
    },

    create: async (name) => {
      await handOverDrafts();
      const sentIn = generation;
      applyReply(sentIn, unwrap(await ipc().workspace.create({ name })).workspace);
      await get().list();
    },

    open: async (workspaceId) => {
      await handOverDrafts();
      const sentIn = generation;
      applyReply(sentIn, unwrap(await ipc().workspace.open({ workspaceId })).workspace);
      await get().list();
    },

    close: async () => {
      await handOverDrafts();
      const sentIn = generation;
      applyReply(sentIn, unwrap(await ipc().workspace.close(undefined)).workspace);
      await get().list();
    },

    rename: async (workspaceId, name) => {
      set({ workspaces: unwrap(await ipc().workspace.rename({ workspaceId, name })).workspaces });
    },

    remove: async (workspaceId) => {
      set({ workspaces: unwrap(await ipc().workspace.delete({ workspaceId })).workspaces });
    },

    addProject: async (name) => {
      const sentIn = generation;
      const value = unwrap(await ipc().workspace.addProject({ name }));
      applyReply(sentIn, value.workspace);
      return value.projectId;
    },

    linkProject: async () => {
      const sentIn = generation;
      const { workspace } = unwrap(await ipc().workspace.linkProject(undefined));
      if (workspace === null) {
        return false;
      }
      applyReply(sentIn, workspace);
      return true;
    },

    importProjectFolder: async () => {
      const sentIn = generation;
      const { workspace } = unwrap(await ipc().workspace.importProjectFolder(undefined));
      if (workspace === null) {
        return false;
      }
      applyReply(sentIn, workspace);
      // From the picker this may have created a workspace, which the list should now show.
      await get().list();
      return true;
    },

    importSuggestion: async (index) => {
      await handOverDrafts();
      const sentIn = generation;
      applyReply(sentIn, unwrap(await ipc().workspace.importSuggestion({ index })).workspace);
      await get().list();
    },

    reveal: async (workspaceId) => {
      unwrap(await ipc().workspace.reveal({ workspaceId }));
    },

    revealProject: async (projectId) => {
      unwrap(await ipc().workspace.revealProject({ projectId }));
    },

    exportProject: async (projectId) => unwrap(await ipc().workspace.exportProject({ projectId })).dir,

    locateProject: async (projectId) => {
      const sentIn = generation;
      const { workspace } = unwrap(await ipc().workspace.locateProject({ projectId }));
      if (workspace === null) {
        return false;
      }
      applyReply(sentIn, workspace);
      return true;
    },

    removeProject: async (projectId, deleteFiles) => {
      const sentIn = generation;
      // A session belonging to a project that is about to stop existing has nothing left to
      // answer to, and the mirror naming its request goes with the project.
      const mirror = useProjectStore.getState();
      const owned = Object.keys(mirror.wsRequests).filter((requestId) => mirror.projectOf[requestId] === projectId);
      void useExchangesStore.getState().closeOpenWsSessions(owned);
      applyReply(sentIn, unwrap(await ipc().workspace.removeProject({ projectId, deleteFiles })).workspace);
    },

    setActiveEnvironment: async (environmentId) => {
      const sentIn = generation;
      applyReply(sentIn, unwrap(await ipc().workspace.setActiveEnvironment({ environmentId })).workspace);
    },

    mutate: async (change) => {
      const sentIn = generation;
      const value = unwrap(await ipc().workspace.mutate({ change }));
      applyReply(sentIn, value.workspace);
      return value.createdEnvironmentId === undefined ? {} : { createdEnvironmentId: value.createdEnvironmentId };
    },

    setWorkspacePropertyEnabled: async (name, enabled) => {
      await get().mutate({ kind: 'set-workspace-property-enabled', name, enabled });
    },

    updateEnvironment: async (environmentId, patch) => {
      await queueEnvironmentPatch(environmentId, () => patch);
    },

    share: async (remote, branch) => {
      const sentIn = generation;
      applyReply(sentIn, unwrap(await ipc().workspace.share({ remote, branch })).workspace);
    },

    shareToFolder: async () => {
      const sentIn = generation;
      const { workspace } = unwrap(await ipc().workspace.shareToFolder(undefined));
      if (workspace === null) {
        return false;
      }
      applyReply(sentIn, workspace);
      return true;
    },

    join: async (remote, branch) => {
      await handOverDrafts();
      const sentIn = generation;
      applyReply(sentIn, unwrap(await ipc().workspace.join({ remote, branch })).workspace);
      await get().list();
    },

    joinFromFolder: async () => {
      await handOverDrafts();
      const sentIn = generation;
      const { workspace } = unwrap(await ipc().workspace.joinFromFolder(undefined));
      if (workspace === null) {
        return false;
      }
      applyReply(sentIn, workspace);
      await get().list();
      return true;
    },

    stopSharing: async () => {
      const sentIn = generation;
      applyReply(sentIn, unwrap(await ipc().workspace.stopSharing(undefined)).workspace);
    },

    moveProject: async (projectId, workspaceId) => {
      const sentIn = generation;
      applyReply(sentIn, unwrap(await ipc().project.moveToWorkspace({ projectId, workspaceId })).workspace);
    },
  };
});

/**
 * Subscribes the mirror to `workspace.changed` and pulls the initial snapshot and list. Called
 * once from the shell; returns an unsubscribe for symmetry with React effects.
 */
export function subscribeToWorkspace(): () => void {
  const store = useWorkspaceStore.getState();
  void store.refresh();
  void store.list();
  // `defineEvent` types every event's `name` as `string`, so the derived event map cannot
  // narrow a payload by channel; the cast is the same one `subscribeToProject` uses.
  const off = window.wirebench.on('workspace.changed', ((payload: WorkspaceChangedEvent) => {
    useWorkspaceStore.getState().applySnapshot(payload.workspace);
  }) as (payload: unknown) => void);
  const offStash = subscribeToDraftStash(() => useWorkspaceStore.getState().workspace?.id);
  return () => {
    off();
    offStash();
  };
}
