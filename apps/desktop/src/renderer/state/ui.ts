import type { Draft } from 'immer';
import { produce } from 'immer';
import { create } from 'zustand';
import type { ConsoleTab, EditorLayoutSnapshot, SidebarView, ThemePreference, UiSnapshot } from './ui-state.js';
import { DEFAULT_UI_STATE, readUi, writeUi } from './ui-state.js';

/** A selected node in the explorer tree, read by the details panel (Task 30) and explorer actions. */
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
}

/** The UI store: the persisted layout plus the actions the shell and commands drive it with. */
export interface UiStore extends UiSnapshot {
  /** The explorer's current selection, if any. Transient — never persisted. */
  readonly selection: Selection | undefined;
  /** Whether the Import WSDL dialog is open. Transient — never persisted. */
  readonly importDialogOpen: boolean;
  /** Folder chosen for a new project, awaiting its name in the New Project dialog. */
  readonly newProjectDir: string | undefined;
  /** Interface id pending a remove confirmation, from either the context menu or a command. */
  readonly confirmRemoveInterfaceId: string | undefined;
  /** Request id pending a delete confirmation, from either the context menu or a command. */
  readonly confirmDeleteRequestId: string | undefined;
  /** Whether the status bar's environment dropdown is open. Transient — never persisted. */
  readonly envSwitcherOpen: boolean;
  readonly setSelection: (selection: Selection | undefined) => void;
  readonly openImportDialog: () => void;
  /** Opens (with a folder) or closes (with `undefined`) the New Project name prompt. */
  readonly promptNewProject: (dir: string | undefined) => void;
  readonly closeImportDialog: () => void;
  readonly requestRemoveInterface: (interfaceId: string | undefined) => void;
  readonly requestDeleteRequest: (requestId: string | undefined) => void;
  readonly setEnvSwitcherOpen: (open: boolean) => void;
  readonly toggleSidebar: () => void;
  readonly toggleConsole: () => void;
  readonly toggleDetails: () => void;
  readonly showSidebarView: (view: SidebarView) => void;
  readonly showConsoleTab: (tab: ConsoleTab) => void;
  readonly setSidebarSize: (size: number) => void;
  readonly setConsoleSize: (size: number) => void;
  readonly setDetailsSize: (size: number) => void;
  readonly toggleTheme: () => void;
  readonly setTheme: (theme: ThemePreference) => void;
  readonly toggleEditorLineNumbers: () => void;
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
    newProjectDir: undefined,
    confirmRemoveInterfaceId: undefined,
    confirmDeleteRequestId: undefined,
    envSwitcherOpen: false,

    setSelection: (selection) => {
      set({ selection });
    },
    openImportDialog: () => {
      set({ importDialogOpen: true });
    },
    promptNewProject: (dir) => {
      set({ newProjectDir: dir });
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
    setEnvSwitcherOpen: (open) => {
      set({ envSwitcherOpen: open });
    },

    toggleSidebar: () =>
      update((draft) => {
        draft.sidebar.visible = !draft.sidebar.visible;
      }),
    toggleConsole: () =>
      update((draft) => {
        draft.console.visible = !draft.console.visible;
      }),
    toggleDetails: () =>
      update((draft) => {
        draft.details.visible = !draft.details.visible;
      }),

    showSidebarView: (view) =>
      update((draft) => {
        // Clicking the active view again collapses the sidebar, the way VS Code's activity bar does.
        if (draft.sidebar.visible && draft.sidebar.view === view) {
          draft.sidebar.visible = false;
          return;
        }
        draft.sidebar.view = view;
        draft.sidebar.visible = true;
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
    setDetailsSize: (size) =>
      update((draft) => {
        draft.details.size = size;
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

    setEditorLayout: (layout) =>
      update((draft) => {
        draft.editorLayout = layout;
      }),

    snapshot: () => {
      const { sidebar, console: consoleState, details, theme, editorLineNumbers, editorLayout } = get();
      return { sidebar, console: consoleState, details, theme, editorLineNumbers, editorLayout };
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
