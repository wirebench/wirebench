import { create } from 'zustand';

/** One open editor tab. Task 15 extends this with real request-editor state. */
export interface EditorTab {
  readonly id: string;
  readonly kind: 'request' | 'welcome' | 'environment';
  readonly title: string;
  /** Set when `kind` is `'request'`: the request draft this tab edits. */
  readonly requestId?: string;
  /** Set when `kind` is `'environment'`: the environment this tab edits. */
  readonly environmentId?: string;
}

/** The editors store: open tabs plus which one is active. */
export interface EditorsStore {
  readonly tabs: EditorTab[];
  readonly activeId: string | undefined;
  readonly open: (tab: EditorTab) => void;
  readonly close: (id: string) => void;
  readonly activate: (id: string) => void;
}

export const useEditorsStore = create<EditorsStore>((set, get) => ({
  tabs: [],
  activeId: undefined,

  open: (tab) => {
    const { tabs } = get();
    const existing = tabs.find((t) => t.id === tab.id);
    if (existing === undefined) {
      set({ tabs: [...tabs, tab], activeId: tab.id });
      return;
    }
    set({ activeId: existing.id });
  },

  close: (id) => {
    const { tabs, activeId } = get();
    const index = tabs.findIndex((t) => t.id === id);
    if (index === -1) {
      return;
    }
    const nextTabs = tabs.filter((t) => t.id !== id);
    let nextActive = activeId;
    if (activeId === id) {
      const fallback = nextTabs[Math.min(index, nextTabs.length - 1)];
      nextActive = fallback?.id;
    }
    set({ tabs: nextTabs, activeId: nextActive });
  },

  activate: (id) => {
    if (get().tabs.some((t) => t.id === id)) {
      set({ activeId: id });
    }
  },
}));
