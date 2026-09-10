import type { Draft } from 'immer';
import { produce } from 'immer';
import { create } from 'zustand';
import type { ConsoleTab, SidebarView, ThemePreference, UiSnapshot } from './ui-state.js';
import { DEFAULT_UI_STATE, readUi, writeUi } from './ui-state.js';

/** The UI store: the persisted layout plus the actions the shell and commands drive it with. */
export interface UiStore extends UiSnapshot {
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

    snapshot: () => {
      const { sidebar, console: consoleState, details, theme } = get();
      return { sidebar, console: consoleState, details, theme };
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
