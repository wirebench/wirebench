import type { Draft } from 'immer';
import { AREAS } from '@shared/area-module.js';
import { KINDS, type KindId } from '@shared/kinds/kind-module.js';
import type { AreaId } from '@shared/area-module.js';
import type { CodeLanguage, CodeSettings, CodeTarget } from '@shared/code-targets.js';
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
import type { RequestImportCurlTarget } from '../../shared/kinds/rest/wire.js';
import type { SettingsSectionRequest } from '../features/preferences/settings-model.js';
import { DEFAULT_UI_STATE, defaultSidebarSize, readUi, writeUi } from './ui-state.js';

/**
 * Moves the sidebar to `view`, saving the width of the area it leaves and taking up the one `view`
 * was last left at (or its default), so each area keeps its own width, collapsed or not.
 */
function moveSidebarTo(draft: Draft<UiSnapshot>, view: SidebarView): void {
  const sidebar = draft.sidebar;
  if (view !== sidebar.view) {
    const byView = (sidebar.sizeByView ??= {});
    byView[sidebar.view] = sidebar.visible ? sidebar.size : sidebar.lastSize;
    const next = byView[view] ?? defaultSidebarSize(view);
    sidebar.size = next;
    sidebar.lastSize = next;
  }
  sidebar.view = view;
}

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
  readonly kind:
    | 'api'
    | 'folder'
    | 'rest-request'
    | 'grpc-api'
    | 'grpc-request'
    | 'ws-api'
    | 'ws-request'
    | 'mcp-api'
    | 'mcp-request'
    | 'sequence'
    | 'mock';
  readonly id: string;
  readonly name: string;
  /** How many requests are inside it; `0` for an empty folder or API, and for a request. */
  readonly requestCount: number;
}

/** Which project's tokens the Secret token values dialog shows, and which one it starts editing. */
export interface SecretTokenDialogTarget {
  readonly projectId: string;
  readonly name?: string;
}

/** Which name the Secret Sources dialog opens its add form on; `{}` opens the table alone. */
export interface SecretSourcesDialogTarget {
  readonly name?: string;
}

/** The UI store: the persisted layout plus the actions the shell and commands drive it with. */
export type ImportDialogFormat =
  | 'auto'
  | 'openapi'
  | 'asyncapi'
  | 'postman'
  | 'postman-environment'
  | 'postman-globals'
  | 'har'
  | 'http-file'
  | 'http-env'
  | 'opencollection'
  | 'postman-v3'
  | 'wsdl'
  | 'proto'
  | 'legacy-soap-project';

export interface UiStore extends UiSnapshot {
  /** The explorer's current selection, if any. Transient — never persisted. */
  readonly selection: Selection | undefined;
  /** Whether the unified Import dialog is open. Transient — never persisted. */
  readonly importDialogOpen: boolean;
  /** The format to pre-select when opening the import dialog. */
  readonly importDialogFormat: ImportDialogFormat;
  /** Whether the Import OpenAPI dialog is open. Maintained for compatibility. */
  readonly importOpenApiDialogOpen: boolean;
  /** Whether the Import Postman dialog is open. Maintained for compatibility. */
  readonly importPostmanDialogOpen: boolean;
  /** The folder whose credentials dialog is open, if any. A folder has no tab to put them on. */
  readonly folderAuthId: string | undefined;
  /** The folder whose scripts dialog is open, if any (#334). */
  readonly folderScriptsId: string | undefined;
  /**
   * Where an Import cURL… opened from the palette or the explorer should land, if it is open.
   *
   * Held here rather than in the dialog because the two entry points that are *not* an editor tab —
   * the palette and an explorer row — have nowhere else to put it.
   */
  readonly importCurlTarget: RequestImportCurlTarget | undefined;
  /**
   * The API made only to give an Import cURL… a home (an empty project has none): removed again when
   * the dialog closes without importing, so a cancel leaves the project as it was.
   */
  readonly importCurlProvisionalApiId: string | undefined;
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
  /** The sidebar areas this run has switched on (`WIREBENCH_AREAS`). Transient — answered by main. */
  readonly enabledAreas: readonly AreaId[];
  readonly setEnabledAreas: (ids: readonly AreaId[]) => void;
  /** Whether this run has the local terminal tab on (#410; `WIREBENCH_AREAS`). Transient — answered by main. */
  readonly localTerminalEnabled: boolean;
  readonly setLocalTerminalEnabled: (enabled: boolean) => void;
  /** The protocol kinds this run has switched on (`WIREBENCH_KINDS`). Transient — answered by main. */
  readonly enabledKinds: readonly KindId[];
  readonly setEnabledKinds: (ids: readonly KindId[]) => void;
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
  /** Whether the Share Workspace dialog is open. Transient — never persisted. */
  readonly shareDialogOpen: boolean;
  /** Whether the Join Shared Workspace dialog is open. Transient — never persisted. */
  readonly joinDialogOpen: boolean;
  /** Whether *Open a team workspace…* is open (server-sync §3.4). Transient — never persisted. */
  readonly teamWorkspaceDialogOpen: boolean;
  /**
   * Whether the Sign in dialog is open and, when it was opened for a known server (the status
   * bar's "Sign in" on a signed-out account), which URL to start from. Transient.
   */
  readonly signInDialog: { readonly open: boolean; readonly url: string | undefined };
  /** *Manage teams…* (teams-access §3.5); `url` picks the server, or the first signed-in one. */
  readonly teamDialog: { readonly open: boolean; readonly url: string | undefined };
  /** The project id the Move to Workspace dialog is open for, or `null` when it is closed. */
  readonly moveProjectDialog: string | null;
  /**
   * The project the Secret token values dialog is open for, and the token to start editing, or
   * `null` when it is closed. Names only: a value typed there stays in the dialog's own state.
   */
  readonly secretTokenDialog: SecretTokenDialogTarget | null;
  /** The Secret Sources dialog: `null` while closed. */
  readonly secretSourcesDialog: SecretSourcesDialogTarget | null;
  /** The dialog that approves the workspace's shared secret sources on this machine. */
  readonly secretSourcesApproval: boolean;
  /** Whether the Settings page is open, and which section it should land on. Transient. */
  readonly preferences: { readonly open: boolean; readonly section: SettingsSectionRequest | undefined };
  /** Project id pending a "remove from workspace" confirmation, from a command or a menu. */
  readonly confirmRemoveProjectId: string | undefined;
  readonly setSelection: (selection: Selection | undefined) => void;
  readonly openImportDialog: (initialFormat?: ImportDialogFormat) => void;
  readonly setImportOpenApiDialogOpen: (open: boolean) => void;
  readonly setImportPostmanDialogOpen: (open: boolean) => void;
  readonly setFolderAuthId: (folderId: string | undefined) => void;
  readonly setFolderScriptsId: (folderId: string | undefined) => void;
  /** `provisional` marks the target's API as made for this import alone; see `importCurlProvisionalApiId`. */
  readonly setImportCurlTarget: (
    target: RequestImportCurlTarget | undefined,
    options?: { readonly provisional?: boolean },
  ) => void;
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
  readonly setShareDialogOpen: (open: boolean) => void;
  readonly setJoinDialogOpen: (open: boolean) => void;
  readonly setTeamWorkspaceDialogOpen: (open: boolean) => void;
  readonly openSignInDialog: (url?: string) => void;
  readonly setSignInDialogOpen: (open: boolean) => void;
  readonly openTeamDialog: (url?: string) => void;
  readonly setTeamDialogOpen: (open: boolean) => void;
  readonly setMoveProjectDialog: (projectId: string | null) => void;
  readonly setSecretTokenDialog: (target: SecretTokenDialogTarget | null) => void;
  readonly setSecretSourcesDialog: (target: SecretSourcesDialogTarget | null) => void;
  readonly setSecretSourcesApproval: (open: boolean) => void;
  /** Opens the Settings page, optionally on one section. Every route into Settings goes here. */
  readonly openPreferences: (section?: SettingsSectionRequest) => void;
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
  /** Opens the console for a send, once: only while `console.openOnFirstSend` is still set. */
  readonly openConsoleForFirstSend: () => void;
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
  /** Remembers the language the Code panel shows; `curl` keeps using the remembered shell. */
  readonly setCodeLanguage: (language: CodeLanguage) => void;
  /** Remembers (or, with `undefined`, forgets) one language's layout choices. */
  readonly setCodeSettings: (target: CodeTarget, settings: CodeSettings | undefined) => void;
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
    importDialogFormat: 'auto',
    importOpenApiDialogOpen: false,
    importPostmanDialogOpen: false,
    folderAuthId: undefined,
    folderScriptsId: undefined,
    importCurlTarget: undefined,
    importCurlProvisionalApiId: undefined,
    newProjectDialogOpen: false,
    confirmRemoveInterfaceId: undefined,
    confirmDeleteRequestId: undefined,
    confirmDeleteNode: undefined,
    envSwitcherOpen: false,
    enabledKinds: KINDS.map((kind) => kind.kind),
    setEnabledKinds: (ids) => {
      set({ enabledKinds: ids });
    },
    enabledAreas: AREAS.map((area) => area.id),
    setEnabledAreas: (ids) => {
      set({ enabledAreas: ids });
      // A restored view may belong to an area this run switched off; fall back to the first enabled one.
      const first = ids[0];
      if (first !== undefined && !ids.includes(get().sidebar.view)) {
        get().setSidebarView(first);
      }
    },
    localTerminalEnabled: true,
    setLocalTerminalEnabled: (enabled) => {
      set({ localTerminalEnabled: enabled });
    },
    workspaceSwitcherOpen: false,
    workspaceManageOpen: false,
    preferences: { open: false, section: undefined },
    workspaceCreateOpen: false,
    syncPanelOpen: false,
    conflictResolverOpen: false,
    shareDialogOpen: false,
    joinDialogOpen: false,
    teamWorkspaceDialogOpen: false,
    signInDialog: { open: false, url: undefined },
    teamDialog: { open: false, url: undefined },
    moveProjectDialog: null,
    secretTokenDialog: null,
    secretSourcesDialog: null,
    secretSourcesApproval: false,
    confirmRemoveProjectId: undefined,

    setSelection: (selection) => {
      set({ selection });
    },
    openImportDialog: (initialFormat = 'auto') => {
      set({
        importDialogOpen: true,
        importDialogFormat: initialFormat,
        importOpenApiDialogOpen: initialFormat === 'openapi',
        importPostmanDialogOpen: initialFormat === 'postman',
      });
    },
    setImportOpenApiDialogOpen: (open) => {
      if (open) {
        get().openImportDialog('openapi');
      } else if (get().importDialogFormat === 'openapi') {
        // Closing is only this format's to do: the one dialog may be open for another format.
        get().closeImportDialog();
      }
    },
    setImportPostmanDialogOpen: (open) => {
      if (open) {
        get().openImportDialog('postman');
      } else if (get().importDialogFormat === 'postman') {
        // Closing is only this format's to do: the one dialog may be open for another format.
        get().closeImportDialog();
      }
    },
    setFolderAuthId: (folderId) => {
      set({ folderAuthId: folderId });
    },
    setFolderScriptsId: (folderId) => {
      set({ folderScriptsId: folderId });
    },
    setImportCurlTarget: (target, options) => {
      set({
        importCurlTarget: target,
        importCurlProvisionalApiId: options?.provisional === true && target?.kind === 'rest' ? target.apiId : undefined,
      });
    },
    setNewProjectDialogOpen: (open) => {
      set({ newProjectDialogOpen: open });
    },
    closeImportDialog: () => {
      set({
        importDialogOpen: false,
        importDialogFormat: 'auto',
        importOpenApiDialogOpen: false,
        importPostmanDialogOpen: false,
      });
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
    setShareDialogOpen: (open) => {
      set({ shareDialogOpen: open });
    },
    setJoinDialogOpen: (open) => {
      set({ joinDialogOpen: open });
    },
    setTeamWorkspaceDialogOpen: (open) => {
      set({ teamWorkspaceDialogOpen: open });
    },
    openSignInDialog: (url) => {
      set({ signInDialog: { open: true, url } });
    },
    setSignInDialogOpen: (open) => {
      set({ signInDialog: { open, url: open ? get().signInDialog.url : undefined } });
    },
    openTeamDialog: (url) => {
      set({ teamDialog: { open: true, url } });
    },
    setTeamDialogOpen: (open) => {
      set({ teamDialog: { open, url: open ? get().teamDialog.url : undefined } });
    },
    setMoveProjectDialog: (projectId) => {
      set({ moveProjectDialog: projectId });
    },
    setSecretTokenDialog: (target) => {
      set({ secretTokenDialog: target });
    },
    setSecretSourcesDialog: (target) => {
      set({ secretSourcesDialog: target });
    },
    setSecretSourcesApproval: (open) => {
      set({ secretSourcesApproval: open });
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
        draft.console.openOnFirstSend = false;
      }),
    expandConsole: () =>
      update((draft) => {
        draft.console.openOnFirstSend = false;
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
        draft.console.openOnFirstSend = false;
        if (draft.console.visible) {
          draft.console.lastSize = draft.console.size;
          draft.console.visible = false;
        } else {
          draft.console.visible = true;
          draft.console.size = draft.console.lastSize;
        }
      }),
    openConsoleForFirstSend: () =>
      update((draft) => {
        if (!draft.console.openOnFirstSend) {
          return;
        }
        draft.console.openOnFirstSend = false;
        draft.console.visible = true;
        draft.console.size = draft.console.lastSize;
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
        if (!get().enabledAreas.includes(view)) return;
        // Clicking the active view again collapses the sidebar, the way VS Code's activity bar does.
        if (draft.sidebar.visible && draft.sidebar.view === view) {
          draft.sidebar.lastSize = draft.sidebar.size;
          draft.sidebar.visible = false;
          return;
        }
        moveSidebarTo(draft, view);
        if (!draft.sidebar.visible) {
          draft.sidebar.visible = true;
          draft.sidebar.size = draft.sidebar.lastSize;
        }
      }),
    setSidebarView: (view) =>
      update((draft) => {
        if (!get().enabledAreas.includes(view)) return;
        moveSidebarTo(draft, view);
      }),
    showConsoleTab: (tab) =>
      update((draft) => {
        draft.console.activeTab = tab;
        draft.console.visible = true;
        draft.console.openOnFirstSend = false;
      }),

    setSidebarSize: (size) =>
      update((draft) => {
        draft.sidebar.size = size;
      }),
    setConsoleSize: (size) =>
      update((draft) => {
        draft.console.size = size;
        draft.console.openOnFirstSend = false;
      }),
    setSlideOverWidth: (width) =>
      update((draft) => {
        // Each area keeps its own: the width set here is the one this area comes back to.
        draft.slideOver.widthByView = { ...draft.slideOver.widthByView, [draft.sidebar.view]: width };
      }),
    setCodeShell: (shell) =>
      update((draft) => {
        draft.slideOver.codeShell = shell;
      }),

    setCodeLanguage: (language) =>
      update((draft) => {
        draft.slideOver.codeLanguage = language;
      }),

    setCodeSettings: (target, settings) =>
      update((draft) => {
        if (settings === undefined) {
          delete draft.slideOver.codeSettings[target];
        } else {
          draft.slideOver.codeSettings[target] = settings;
        }
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
 * A window shorter than this starts with the console collapsed: at 700px its quarter of the
 * column leaves the editor too little room. The default 820px window stays above it, even inside
 * the native frame and menu bar Windows draws (less than 760px of content there).
 */
export const CONSOLE_COLLAPSED_BELOW_PX = 720;

/**
 * Whether the layout ignores the window's size (see `env.fixedLayout` in the preload): only an e2e
 * run on a CI runner whose screen is smaller than the window its specs expect. The same specs expect
 * the console open from the start, so a fresh workspace there skips the collapsed first run too.
 */
export function fixedLayout(): boolean {
  const api = (globalThis as { wirebench?: { env?: { fixedLayout?: boolean } } }).wirebench;
  return api?.env?.fixedLayout === true;
}

/**
 * Hydrates the store from `localStorage` once, then keeps writing every later change back.
 * Called from the shell on mount; safe to call when storage is unavailable.
 */
export function hydrateUi(
  storage: Storage | undefined = globalThis.localStorage,
  windowHeight: number | undefined = globalThis.innerHeight,
): void {
  if (storage === undefined) {
    return;
  }
  useUiStore.setState(readUi(storage));
  if (fixedLayout() && useUiStore.getState().console.openOnFirstSend) {
    useUiStore.getState().expandConsole();
  }
  // Before persisting starts, so the collapse alone is not written back as the saved layout.
  if (!fixedLayout() && windowHeight !== undefined && windowHeight > 0 && windowHeight < CONSOLE_COLLAPSED_BELOW_PX) {
    useUiStore.getState().collapseConsole();
  }
  useUiStore.getState().persistTo(storage);
}
