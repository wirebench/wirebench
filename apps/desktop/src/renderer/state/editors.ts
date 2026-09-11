import { create } from 'zustand';
import type { EditorLayout } from '../features/request-editor/layout.js';

/** Which fields the Form view shows. Owned here, not by the request pane's component state, so
 * it survives a tab switch or a remount (e.g. the pane unmounting while its tab stays open in
 * the background) instead of resetting to `'full'` every time. */
export type FormViewType = 'full' | 'required' | 'non-empty';

const DEFAULT_FORM_VIEW_TYPE: FormViewType = 'full';

/** Which response tab is showing. Owned here for the same reason as {@link FormViewType}: it
 * must survive a remount, but it is editor state, never saved to the project file. */
export type ResponseViewType = 'xml' | 'outline' | 'raw' | 'query' | 'fault';

const DEFAULT_RESPONSE_VIEW_TYPE: ResponseViewType = 'xml';

/** Which inspector is showing in a pane's bottom strip. Editor state, never saved to disk. */
export type InspectorId = 'headers' | 'attachments' | 'auth' | 'wsa' | 'wss' | 'ssl';

/** Which pane's strip an inspector selection belongs to — the two are independent. */
export type InspectorPane = 'request' | 'response';

const DEFAULT_INSPECTOR: InspectorId = 'headers';

/** Inspector state is per request AND per pane, so the two strips key off distinct entries. */
function inspectorKey(requestId: string, pane: InspectorPane): string {
  return `${requestId}:${pane}`;
}

/** One open editor tab. Task 15 extends this with real request-editor state. */
export interface EditorTab {
  readonly id: string;
  readonly kind: 'request' | 'welcome' | 'environment' | 'history' | 'diff' | 'preferences' | 'interface';
  readonly title: string;
  /** Set when `kind` is `'request'`: the request draft this tab edits. */
  readonly requestId?: string;
  /** Set when `kind` is `'interface'`: the imported interface this viewer tab shows. */
  readonly interfaceId?: string;
  /** Set when `kind` is `'environment'`: the environment this tab edits. */
  readonly environmentId?: string;
  /** Set when `kind` is `'history'`: the history entry this read-only tab shows. */
  readonly historyId?: string;
  /** Set when `kind` is `'preferences'`: which section to open on. */
  readonly preferencesSection?: string;
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
  /** Selected response tab per request draft id. Editor state, not project data. */
  readonly responseViewTypes: Readonly<Record<string, ResponseViewType>>;
  /** Whether the user has explicitly picked a response tab for this request — once true, an
   * arriving fault no longer auto-selects the Fault tab for them (see `setResponseView`). */
  readonly responseViewPinned: Readonly<Record<string, boolean>>;
  /** Per-request layout override, set by the layout toggles. Session state, never persisted —
   * the persisted default lives in the `ui` store (see `request-editor/layout.ts`). */
  readonly editorLayouts: Readonly<Record<string, EditorLayout>>;
  /** Selected inspector per `${requestId}:${pane}`. Editor state, not project data. */
  readonly inspectorTabs: Readonly<Record<string, InspectorId>>;
  /** Whether a pane's inspector panel is collapsed, per `${requestId}:${pane}`. */
  readonly inspectorCollapsed: Readonly<Record<string, boolean>>;
  /** The attachment row selected in a request's Attachments inspector. Editor state, not project data. */
  readonly selectedAttachments: Readonly<Record<string, string>>;
  readonly open: (tab: EditorTab) => void;
  /** Like `open`, but replaces an already-open tab's content instead of leaving it stale —
   * what a diff tab needs when "Compare…" is run again with a different pair of entries. */
  readonly openOrReplace: (tab: EditorTab) => void;
  readonly close: (id: string) => void;
  readonly activate: (id: string) => void;
  /** The Form view type for `requestId`, defaulting to `'full'` when never set. */
  readonly formViewTypeFor: (requestId: string) => FormViewType;
  readonly setFormViewType: (requestId: string, viewType: FormViewType) => void;

  /** The selected response tab for `requestId`, defaulting to `'xml'` when never set. */
  readonly responseViewFor: (requestId: string) => ResponseViewType;
  /** Records the user's own tab choice — pins it, so a later fault no longer overrides it. */
  readonly setResponseView: (requestId: string, viewType: ResponseViewType) => void;
  /** Switches to the Fault tab when a fault just arrived, unless the user already pinned a
   * different tab for this request (see `setResponseView`). */
  readonly revealFaultTab: (requestId: string) => void;
  /** Records this request's layout override. */
  readonly setEditorLayout: (requestId: string, layout: EditorLayout) => void;

  /** The selected inspector for one pane of one request, defaulting to `'headers'`. */
  readonly inspectorFor: (requestId: string, pane: InspectorPane) => InspectorId;
  /** Selects an inspector — which also expands the panel, since picking a tab means "show me it". */
  readonly setInspector: (requestId: string, pane: InspectorPane, inspector: InspectorId) => void;
  /** Whether one pane's inspector panel is collapsed. Panels start collapsed, so the editor keeps
   * the full pane until the user asks for an inspector. */
  readonly inspectorCollapsedFor: (requestId: string, pane: InspectorPane) => boolean;
  readonly setInspectorCollapsed: (requestId: string, pane: InspectorPane, collapsed: boolean) => void;

  /** The selected attachment row for `requestId`, or `undefined` when none is selected. */
  readonly selectedAttachmentFor: (requestId: string) => string | undefined;
  /** Selects (or, with `undefined`, clears) the attachment row the Remove action acts on. */
  readonly setSelectedAttachment: (requestId: string, attachmentId: string | undefined) => void;
}

export const useEditorsStore = create<EditorsStore>((set, get) => ({
  tabs: [],
  activeId: undefined,
  formViewTypes: {},
  responseViewTypes: {},
  responseViewPinned: {},
  editorLayouts: {},
  inspectorTabs: {},
  inspectorCollapsed: {},
  selectedAttachments: {},

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

  responseViewFor: (requestId) => get().responseViewTypes[requestId] ?? DEFAULT_RESPONSE_VIEW_TYPE,

  setResponseView: (requestId, viewType) => {
    set({
      responseViewTypes: { ...get().responseViewTypes, [requestId]: viewType },
      responseViewPinned: { ...get().responseViewPinned, [requestId]: true },
    });
  },

  setEditorLayout: (requestId, layout) => {
    set({ editorLayouts: { ...get().editorLayouts, [requestId]: layout } });
  },

  inspectorFor: (requestId, pane) => get().inspectorTabs[inspectorKey(requestId, pane)] ?? DEFAULT_INSPECTOR,

  setInspector: (requestId, pane, inspector) => {
    const key = inspectorKey(requestId, pane);
    set({
      inspectorTabs: { ...get().inspectorTabs, [key]: inspector },
      inspectorCollapsed: { ...get().inspectorCollapsed, [key]: false },
    });
  },

  inspectorCollapsedFor: (requestId, pane) => get().inspectorCollapsed[inspectorKey(requestId, pane)] ?? true,

  setInspectorCollapsed: (requestId, pane, collapsed) => {
    set({ inspectorCollapsed: { ...get().inspectorCollapsed, [inspectorKey(requestId, pane)]: collapsed } });
  },

  selectedAttachmentFor: (requestId) => get().selectedAttachments[requestId],

  setSelectedAttachment: (requestId, attachmentId) => {
    const next = { ...get().selectedAttachments };
    if (attachmentId === undefined) {
      delete next[requestId];
    } else {
      next[requestId] = attachmentId;
    }
    set({ selectedAttachments: next });
  },

  revealFaultTab: (requestId) => {
    if (get().responseViewPinned[requestId] === true) {
      return;
    }
    set({ responseViewTypes: { ...get().responseViewTypes, [requestId]: 'fault' } });
  },
}));
