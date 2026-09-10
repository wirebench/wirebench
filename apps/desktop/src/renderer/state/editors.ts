import { create } from 'zustand';

/** Which fields the Form view shows. Owned here, not by the request pane's component state, so
 * it survives a tab switch or a remount (e.g. the pane unmounting while its tab stays open in
 * the background) instead of resetting to `'full'` every time. */
export type FormViewType = 'full' | 'required' | 'non-empty';

const DEFAULT_FORM_VIEW_TYPE: FormViewType = 'full';

/** One open editor tab. Task 15 extends this with real request-editor state. */
export interface EditorTab {
  readonly id: string;
  readonly kind: 'request' | 'welcome' | 'environment' | 'history' | 'diff';
  readonly title: string;
  /** Set when `kind` is `'request'`: the request draft this tab edits. */
  readonly requestId?: string;
  /** Set when `kind` is `'environment'`: the environment this tab edits. */
  readonly environmentId?: string;
  /** Set when `kind` is `'history'`: the history entry this read-only tab shows. */
  readonly historyId?: string;
  /** Set when `kind` is `'diff'`: the two sides being compared. */
  readonly diff?: {
    readonly leftLabel: string;
    readonly rightLabel: string;
    readonly leftXml: string;
    readonly rightXml: string;
  };
}

/** The editors store: open tabs plus which one is active. */
export interface EditorsStore {
  readonly tabs: EditorTab[];
  readonly activeId: string | undefined;
  /** Form view type per request draft id. Editor state, not project data — never saved to disk. */
  readonly formViewTypes: Readonly<Record<string, FormViewType>>;
  readonly open: (tab: EditorTab) => void;
  /** Like `open`, but replaces an already-open tab's content instead of leaving it stale —
   * what a diff tab needs when "Compare…" is run again with a different pair of entries. */
  readonly openOrReplace: (tab: EditorTab) => void;
  readonly close: (id: string) => void;
  readonly activate: (id: string) => void;
  /** The Form view type for `requestId`, defaulting to `'full'` when never set. */
  readonly formViewTypeFor: (requestId: string) => FormViewType;
  readonly setFormViewType: (requestId: string, viewType: FormViewType) => void;
}

export const useEditorsStore = create<EditorsStore>((set, get) => ({
  tabs: [],
  activeId: undefined,
  formViewTypes: {},

  open: (tab) => {
    const { tabs } = get();
    const existing = tabs.find((t) => t.id === tab.id);
    if (existing === undefined) {
      set({ tabs: [...tabs, tab], activeId: tab.id });
      return;
    }
    set({ activeId: existing.id });
  },

  openOrReplace: (tab) => {
    const { tabs } = get();
    const index = tabs.findIndex((t) => t.id === tab.id);
    if (index === -1) {
      set({ tabs: [...tabs, tab], activeId: tab.id });
      return;
    }
    const nextTabs = [...tabs];
    nextTabs[index] = tab;
    set({ tabs: nextTabs, activeId: tab.id });
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

  formViewTypeFor: (requestId) => get().formViewTypes[requestId] ?? DEFAULT_FORM_VIEW_TYPE,

  setFormViewType: (requestId, viewType) => {
    set({ formViewTypes: { ...get().formViewTypes, [requestId]: viewType } });
  },
}));
