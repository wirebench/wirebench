import type { Draft } from 'immer';
import { produce } from 'immer';
import { create } from 'zustand';
import type {
  CodeShell,
  ConsoleTab,
  EditorLayoutSnapshot,
  PersistedWorkspaceUi,
  SidebarView,
  ThemePreference,
  UiSnapshot,
} from './ui-state.js';
import type { PreferencesSectionWire, RequestImportCurlTarget } from '../../shared/wire-types.js';
import { DEFAULT_UI_STATE, readUi, writeUi } from './ui-state.js';

/** A selected node in the explorer tree, read by the request inspectors and explorer actions. */
export interface Selection {
  readonly kind: string;
  readonly id: string;
  /** Set when `kind` is `interface`: the interface id and its definition URL. */
  readonly interfaceId?: string;
  readonly definitionUrl?: string;
  /** Set when `kind` is `operation`: the binding/operation this node maps to, and its SOAPAction. */
  readonly bindingName?: string;
  readonly operationName?: string;
  readonly soapAction?: string;
  /** Set when `kind` is `request`: the request draft id. */
  readonly requestId?: string;
  /** Set when `kind` is `endpoint`: the port's address. */
  readonly address?: string;
  /** Set on an `api`, `folder` or `rest-request` selection: the API it belongs to. */
  readonly apiId?: string;
  /** Set on a `folder` selection (the folder itself) and on a `rest-request` inside one. */
  readonly folderId?: string;
}

/**
 * A REST node the user asked to delete, held until they confirm. One shape for all three kinds
 * because the dialog only needs to name the thing and say how much goes with it.
 */
export interface PendingNodeDeletion {
  readonly kind: 'api' | 'folder' | 'rest-request';
  readonly id: string;
  readonly name: string;
  /** How many requests are inside it; `0` for an empty folder or API, and for a request. */
  readonly requestCount: number;
}

/** The UI store: the persisted layout plus the actions the shell and commands drive it with. */
export interface UiStore extends UiSnapshot {
  /** The explorer's current selection, if any. Transient — never persisted. */
  readonly selection: Selection | undefined;
  /** Whether the Import WSDL dialog is open. Transient — never persisted. */
  readonly importDialogOpen: boolean;
  /** Whether the Import OpenAPI dialog is open. Its own flag: the two dialogs share no state. */
  readonly importOpenApiDialogOpen: boolean;
  /** The folder whose credentials dialog is open, if any. A folder has no tab to put them on. */
  readonly folderAuthId: string | undefined;
  /**
   * Where an Import cURL… opened from the palette or the explorer should land, if it is open.
   *
   * Held here rather than in the dialog because the two entry points that are *not* an editor tab —
   * the palette and an explorer row — have nowhere else to put it.
   */
  readonly importCurlTarget: RequestImportCurlTarget | undefined;
  /** Whether the New Project dialog (a name, nothing else) is open. Transient — never persisted. */
  readonly newProjectDialogOpen: boolean;
  /** Interface id pending a remove confirmation, from either the context menu or a command. */
  readonly confirmRemoveInterfaceId: string | undefined;
  /** Request id pending a delete confirmation, from either the context menu or a command. */
  readonly confirmDeleteRequestId: string | undefined;
  /** The API, folder or REST request pending a delete confirmation. Transient. */
  readonly confirmDeleteNode: PendingNodeDeletion | undefined;
  /** Whether the status bar's environment dropdown is open. Transient — never persisted. */
  readonly envSwitcherOpen: boolean;
  /** Whether the title bar's workspace dropdown is open. Transient — never persisted. */
  readonly workspaceSwitcherOpen: boolean;
  /** Whether the Manage workspaces dialog is open. Transient — never persisted. */
  readonly workspaceManageOpen: boolean;
  /** Whether the Create workspace dialog (a name, nothing else) is open. Transient. */
  readonly workspaceCreateOpen: boolean;
  /** Whether the Sync panel is open. Transient — never persisted. */
  readonly syncPanelOpen: boolean;
  /** Whether the conflict resolver (Task 11) is open. Transient — never persisted. */
  readonly conflictResolverOpen: boolean;
  /** Whether the Settings dialog is open, and which section it should land on. Transient. */
  readonly preferences: { readonly open: boolean; readonly section: PreferencesSectionWire | undefined };
  /** Project id pending a "remove from workspace" confirmation, from a command or a menu. */
  readonly confirmRemoveProjectId: string | undefined;
  readonly setSelection: (selection: Selection | undefined) => void;
  readonly openImportDialog: () => void;
  readonly setImportOpenApiDialogOpen: (open: boolean) => void;
  readonly setFolderAuthId: (folderId: string | undefined) => void;
  readonly setImportCurlTarget: (target: RequestImportCurlTarget | undefined) => void;
  readonly setNewProjectDialogOpen: (open: boolean) => void;
  readonly closeImportDialog: () => void;
  readonly requestRemoveInterface: (interfaceId: string | undefined) => void;
  readonly requestDeleteRequest: (requestId: string | undefined) => void;
  /** Asks for a REST node's deletion to be confirmed; `undefined` dismisses the dialog. */
  readonly requestDeleteNode: (pending: PendingNodeDeletion | undefined) => void;
  readonly setEnvSwitcherOpen: (open: boolean) => void;
  readonly setWorkspaceSwitcherOpen: (open: boolean) => void;
  readonly setWorkspaceManageOpen: (open: boolean) => void;
  readonly setWorkspaceCreateOpen: (open: boolean) => void;
  readonly setSyncPanelOpen: (open: boolean) => void;
  readonly setConflictResolverOpen: (open: boolean) => void;
  /** Opens the Settings dialog, optionally on one section. Every route into Settings goes here. */
  readonly openPreferences: (section?: PreferencesSectionWire) => void;
  readonly setPreferencesOpen: (open: boolean) => void;
  readonly requestRemoveProject: (projectId: string | undefined) => void;
  /** Hides the sidebar, remembering its current size in `lastSize` so expand can restore it. What
   *  a double-click on its (still-mounted) handle does while the sidebar is visible — "collapse
   *  or restore", the collapse half. */
  readonly collapseSidebar: () => void;
  /** Reveals the sidebar at its remembered `lastSize`. A no-op while already visible. What a
   *  double-click on its handle does while the sidebar is collapsed — the "restore" half. */
  readonly expandSidebar: () => void;
  /** Snaps a visible sidebar back to `lastSize` without touching visibility — a plain "undo the
   *  last drag" with no collapse involved. Kept for callers that want exactly that; the handle's
   *  own double-click uses {@link collapseSidebar}/{@link expandSidebar} instead. */
  readonly restoreSidebarSize: () => void;
  readonly toggleSidebar: () => void;
  /** The console's equivalent of {@link collapseSidebar}. */
  readonly collapseConsole: () => void;
  /** The console's equivalent of {@link expandSidebar}. */
  readonly expandConsole: () => void;
  /** The console's equivalent of {@link restoreSidebarSize}. */
  readonly restoreConsoleSize: () => void;
  readonly toggleConsole: () => void;
  /** Flips the Code slide-over open or closed — what the right rail's icon does. */
  readonly toggleCode: () => void;
  /** Opens the Code slide-over unconditionally — what the "Show code" command does. */
  readonly openCode: () => void;
  /** Closes the Code slide-over unconditionally — the close icon and Escape. */
  readonly closeCode: () => void;
  readonly showSidebarView: (view: SidebarView) => void;
  /** Selects a sidebar view without the collapse-on-reselect behaviour of {@link showSidebarView}. */
  readonly setSidebarView: (view: SidebarView) => void;
  readonly showConsoleTab: (tab: ConsoleTab) => void;
  readonly setSidebarSize: (size: number) => void;
  readonly setConsoleSize: (size: number) => void;
  /** Remembers the Code slide-over's width, dragged from its left-edge handle. */
  readonly setSlideOverWidth: (width: number) => void;
  /** Remembers the Code panel's POSIX/PowerShell choice. */
  readonly setCodeShell: (shell: CodeShell) => void;
  readonly toggleTheme: () => void;
  readonly setTheme: (theme: ThemePreference) => void;
  readonly toggleEditorLineNumbers: () => void;
  /** Sets the gutter preference directly — how the preferences mirror pushes its value in. */
  readonly setEditorLineNumbers: (lineNumbers: boolean) => void;
  /** Remembers (or, with `undefined`, forgets) one workspace's editor tabs and sidebar view. */
  readonly setWorkspaceUi: (workspaceId: string, entry: PersistedWorkspaceUi | undefined) => void;
  /** Remembers whether one explorer node is folded open in `workspaceId` — written on every toggle. */
  readonly setExplorerOpen: (workspaceId: string, nodeId: string, open: boolean) => void;
  /** Replaces the default request-editor layout (persisted); see `request-editor/layout.ts`. */
  readonly setEditorLayout: (layout: EditorLayoutSnapshot) => void;
  /** The layout without the actions — what commands and keybindings receive as context. */
  readonly snapshot: () => UiSnapshot;
  /** Starts (or, with `undefined`, stops) mirroring every change into a storage backend. */
  readonly persistTo: (storage: Storage | undefined) => void;
}

type Mutate = (draft: Draft<UiSnapshot>) => void;

export const useUiStore = create<UiStore>((set, get) => {
  let target: Storage | undefined;

  const update = (recipe: Mutate): void => {
    set((state) => produce(state, recipe));
    if (target !== undefined) {
      writeUi(get().snapshot(), target);
    }
  };

  return {
    ...DEFAULT_UI_STATE,
    selection: undefined,
    importDialogOpen: false,
    importOpenApiDialogOpen: false,
    folderAuthId: undefined,
    importCurlTarget: undefined,
    newProjectDialogOpen: false,
    confirmRemoveInterfaceId: undefined,
    confirmDeleteRequestId: undefined,
    confirmDeleteNode: undefined,
    envSwitcherOpen: false,
    workspaceSwitcherOpen: false,
    workspaceManageOpen: false,
    preferences: { open: false, section: undefined },
    workspaceCreateOpen: false,
    syncPanelOpen: false,
    conflictResolverOpen: false,
    confirmRemoveProjectId: undefined,

    setSelection: (selection) => {
      set({ selection });
    },
    openImportDialog: () => {
      set({ importDialogOpen: true });
    },
    setImportOpenApiDialogOpen: (open) => {
      set({ importOpenApiDialogOpen: open });
    },
    setFolderAuthId: (folderId) => {
      set({ folderAuthId: folderId });
    },
    setImportCurlTarget: (target) => {
      set({ importCurlTarget: target });
    },
    setNewProjectDialogOpen: (open) => {
      set({ newProjectDialogOpen: open });
    },
    closeImportDialog: () => {
      set({ importDialogOpen: false });
    },
    requestRemoveInterface: (interfaceId) => {
      set({ confirmRemoveInterfaceId: interfaceId });
    },
    requestDeleteRequest: (requestId) => {
      set({ confirmDeleteRequestId: requestId });
    },
    requestDeleteNode: (pending) => {
      set({ confirmDeleteNode: pending });
    },
    setEnvSwitcherOpen: (open) => {
      set({ envSwitcherOpen: open });
    },
    setWorkspaceSwitcherOpen: (open) => {
      set({ workspaceSwitcherOpen: open });
    },
    setWorkspaceManageOpen: (open) => {
      set({ workspaceManageOpen: open });
    },
    setWorkspaceCreateOpen: (open) => {
      set({ workspaceCreateOpen: open });
    },
    setSyncPanelOpen: (open) => {
      set({ syncPanelOpen: open });
    },
    setConflictResolverOpen: (open) => {
      set({ conflictResolverOpen: open });
    },
    openPreferences: (section) => {
      set({ preferences: { open: true, section } });
    },
    setPreferencesOpen: (open) => {
      // The section is cleared on close, so reopening from a plain "Settings" lands on the
      // default rather than wherever the last caller happened to send it.
      set((state) => ({
        preferences: open ? { ...state.preferences, open: true } : { open: false, section: undefined },
      }));
    },
    requestRemoveProject: (projectId) => {
      set({ confirmRemoveProjectId: projectId });
    },

    collapseSidebar: () =>
      update((draft) => {
        if (!draft.sidebar.visible) {
          return;
        }
        draft.sidebar.lastSize = draft.sidebar.size;
        draft.sidebar.visible = false;
      }),
    expandSidebar: () =>
      update((draft) => {
        if (draft.sidebar.visible) {
          return;
        }
        draft.sidebar.visible = true;
        draft.sidebar.size = draft.sidebar.lastSize;
      }),
    restoreSidebarSize: () =>
      update((draft) => {
        if (!draft.sidebar.visible) {
          return;
        }
        draft.sidebar.size = draft.sidebar.lastSize;
      }),
    toggleSidebar: () =>
      update((draft) => {
        if (draft.sidebar.visible) {
          draft.sidebar.lastSize = draft.sidebar.size;
          draft.sidebar.visible = false;
        } else {
          draft.sidebar.visible = true;
          draft.sidebar.size = draft.sidebar.lastSize;
        }
      }),
    collapseConsole: () =>
      update((draft) => {
        if (!draft.console.visible) {
          return;
        }
        draft.console.lastSize = draft.console.size;
        draft.console.visible = false;
      }),
    expandConsole: () =>
      update((draft) => {
        if (draft.console.visible) {
          return;
        }
        draft.console.visible = true;
        draft.console.size = draft.console.lastSize;
      }),
    restoreConsoleSize: () =>
      update((draft) => {
        if (!draft.console.visible) {
          return;
        }
        draft.console.size = draft.console.lastSize;
      }),
    toggleConsole: () =>
      update((draft) => {
        if (draft.console.visible) {
          draft.console.lastSize = draft.console.size;
          draft.console.visible = false;
        } else {
          draft.console.visible = true;
          draft.console.size = draft.console.lastSize;
        }
      }),
    toggleCode: () =>
      update((draft) => {
        draft.slideOver.open = !draft.slideOver.open;
      }),
    openCode: () =>
      update((draft) => {
        draft.slideOver.open = true;
      }),
    closeCode: () =>
      update((draft) => {
        draft.slideOver.open = false;
      }),

    showSidebarView: (view) =>
      update((draft) => {
        // Clicking the active view again collapses the sidebar, the way VS Code's activity bar does.
        if (draft.sidebar.visible && draft.sidebar.view === view) {
          draft.sidebar.lastSize = draft.sidebar.size;
          draft.sidebar.visible = false;
          return;
        }
        draft.sidebar.view = view;
        if (!draft.sidebar.visible) {
          draft.sidebar.visible = true;
          draft.sidebar.size = draft.sidebar.lastSize;
        }
      }),
    setSidebarView: (view) =>
      update((draft) => {
        draft.sidebar.view = view;
      }),
    showConsoleTab: (tab) =>
      update((draft) => {
        draft.console.activeTab = tab;
        draft.console.visible = true;
      }),

    setSidebarSize: (size) =>
      update((draft) => {
        draft.sidebar.size = size;
      }),
    setConsoleSize: (size) =>
      update((draft) => {
        draft.console.size = size;
      }),
    setSlideOverWidth: (width) =>
      update((draft) => {
        draft.slideOver.width = width;
      }),
    setCodeShell: (shell) =>
      update((draft) => {
        draft.slideOver.codeShell = shell;
      }),

    toggleTheme: () =>
      update((draft) => {
        draft.theme = draft.theme === 'light' ? 'dark' : 'light';
      }),
    setTheme: (theme) =>
      update((draft) => {
        draft.theme = theme;
      }),
    toggleEditorLineNumbers: () =>
      update((draft) => {
        draft.editorLineNumbers = !draft.editorLineNumbers;
      }),
    setEditorLineNumbers: (lineNumbers) =>
      update((draft) => {
        draft.editorLineNumbers = lineNumbers;
      }),

    setWorkspaceUi: (workspaceId, entry) =>
      update((draft) => {
        if (entry === undefined) {
          delete draft.workspaces[workspaceId];
          return;
        }
        draft.workspaces[workspaceId] = entry as Draft<PersistedWorkspaceUi>;
      }),
    setExplorerOpen: (workspaceId, nodeId, open) =>
      update((draft) => {
        const entry = (draft.workspaces[workspaceId] ??= { tabs: [] });
        const explorerOpen = (entry.explorerOpen ??= {});
        if (explorerOpen[nodeId] !== open) {
          explorerOpen[nodeId] = open;
        }
      }),

    setEditorLayout: (layout) =>
      update((draft) => {
        draft.editorLayout = layout;
      }),

    snapshot: () => {
      const { sidebar, console: consoleState, slideOver, theme, editorLineNumbers, editorLayout, workspaces } = get();
      return { sidebar, console: consoleState, slideOver, theme, editorLineNumbers, editorLayout, workspaces };
    },

    persistTo: (storage) => {
      target = storage;
    },
  };
});

/**
 * Hydrates the store from `localStorage` once, then keeps writing every later change back.
 * Called from the shell on mount; safe to call when storage is unavailable.
 */
export function hydrateUi(storage: Storage | undefined = globalThis.localStorage): void {
  if (storage === undefined) {
    return;
  }
  useUiStore.setState(readUi(storage));
  useUiStore.getState().persistTo(storage);
}
