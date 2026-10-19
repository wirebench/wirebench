/**
 * Closing editor tabs the way the user asks for it (#679): one tab, the others, those to the right, the saved
 * ones or all of them, from the tab menu, the palette, ⌘W, × or a middle-click. A tab with unsaved edits asks
 * first — Save, Don't save or Cancel — and Cancel stops the rest of the batch with it.
 *
 * `useEditorsStore.close` stays the plain close: a request deleted or a project closed takes its tab without a
 * question, since there is nothing left to save it into.
 */
import { create } from 'zustand';
import { entityIdOf, TAB_KINDS } from '../kinds/index.js';
import { useDraftsStore } from '../state/drafts.js';
import { useEditorsStore, type EditorTab } from '../state/editors.js';
import { useProjectStore } from '../state/project.js';
import { tabsInSet } from '../state/tab-sets.js';
import { useWorkspaceStore } from '../state/workspace.js';

/** Which tabs a close acts on, counted on the strip in view. */
export type CloseScope = 'this' | 'others' | 'right' | 'saved' | 'all';

/** The ids `scope` closes among `tabs` (one set's, in strip order), around the tab `id`. */
export function closeTargets(
  tabs: readonly EditorTab[],
  id: string | undefined,
  scope: CloseScope,
  isDirty: (tab: EditorTab) => boolean,
): string[] {
  const index = tabs.findIndex((tab) => tab.id === id);
  const picked =
    scope === 'this'
      ? tabs.filter((tab) => tab.id === id)
      : scope === 'others'
        ? tabs.filter((tab) => tab.id !== id)
        : scope === 'right'
          ? index === -1
            ? []
            : tabs.slice(index + 1)
          : scope === 'saved'
            ? tabs.filter((tab) => !isDirty(tab))
            : [...tabs];
  return picked.map((tab) => tab.id);
}

/** Whether `tab` holds an edit not yet saved; only the request kinds carry drafts. */
export function isTabDirty(tab: EditorTab): boolean {
  const contribution = TAB_KINDS[tab.kind];
  const id = contribution === undefined ? undefined : entityIdOf(tab, contribution);
  return id !== undefined && contribution?.dirty?.(id, useDraftsStore.getState()) === true;
}

/** A tab's current name, read the way the strip reads it, falling back to the title it opened with. */
export function tabName(tab: EditorTab): string {
  const contribution = TAB_KINDS[tab.kind];
  const id = contribution === undefined ? undefined : entityIdOf(tab, contribution);
  const live =
    id === undefined
      ? undefined
      : contribution?.title(id, {
          project: useProjectStore.getState(),
          workspaceEnvironments: useWorkspaceStore.getState().workspace?.environments ?? [],
          hookNames: {},
          scheduleNames: {},
        });
  return live ?? tab.title;
}

export type UnsavedAnswer = 'save' | 'discard' | 'cancel';

interface UnsavedCloseState {
  /** The tab being asked about, while the question is up. */
  readonly question: { readonly name: string } | undefined;
  readonly resolve: ((answer: UnsavedAnswer) => void) | undefined;
  /** Puts the question up and settles with the answer. A question already up is cancelled. */
  readonly ask: (name: string) => Promise<UnsavedAnswer>;
  readonly answer: (answer: UnsavedAnswer) => void;
}

/** The one Save / Don't save / Cancel question, answered by `UnsavedCloseDialog`. */
export const useUnsavedCloseStore = create<UnsavedCloseState>((set, get) => ({
  question: undefined,
  resolve: undefined,
  ask: (name) => {
    get().resolve?.('cancel');
    return new Promise<UnsavedAnswer>((resolve) => {
      set({ question: { name }, resolve });
    });
  },
  answer: (answer) => {
    const { resolve } = get();
    set({ question: undefined, resolve: undefined });
    resolve?.(answer);
  },
}));

/** The request id a tab edits, of whichever kind, or `undefined` for a tab that edits none. */
function requestOf(tab: EditorTab): string | undefined {
  return tab.requestId ?? tab.restRequestId ?? tab.grpcRequestId ?? tab.wsRequestId ?? tab.mcpRequestId;
}

/** Saves one request's draft, the way ⌘S does for its tab. */
async function saveDraft(requestId: string): Promise<void> {
  const drafts = useDraftsStore.getState();
  const project = useProjectStore.getState();
  if (drafts.requests[requestId] !== undefined) await project.saveRequest(requestId);
  else if (drafts.restRequests[requestId] !== undefined) await project.saveRestRequest(requestId);
  else if (drafts.grpcRequests[requestId] !== undefined) await project.saveGrpcRequest(requestId);
  else if (drafts.wsRequests[requestId] !== undefined) await project.saveWsRequest(requestId);
  else if (drafts.mcpRequests[requestId] !== undefined) await project.saveMcpRequest(requestId);
}

/**
 * Closes `ids` in order, asking about each one with unsaved edits. A save that fails (or a review that is
 * cancelled) leaves the tab open and stops there, as Cancel does.
 */
export async function closeTabs(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const tab = useEditorsStore.getState().tabs.find((candidate) => candidate.id === id);
    if (tab === undefined) continue;
    const requestId = requestOf(tab);
    if (requestId !== undefined && isTabDirty(tab)) {
      // The question is about what is on screen, so the tab it is about comes forward first.
      useEditorsStore.getState().activate(id);
      const answer = await useUnsavedCloseStore.getState().ask(tabName(tab));
      if (answer === 'cancel') return;
      if (answer === 'save') {
        try {
          await saveDraft(requestId);
        } catch {
          return;
        }
        if (isTabDirty(tab)) return;
      } else {
        useProjectStore.getState().discardDraft(requestId);
      }
    }
    useEditorsStore.getState().close(id);
  }
}

/** Closes `scope` around the tab `id` (the active tab when unset) on the strip in view. */
export async function closeTabsIn(scope: CloseScope, id?: string): Promise<void> {
  const { tabs, displayedSet, activeId } = useEditorsStore.getState();
  await closeTabs(closeTargets(tabsInSet(tabs, displayedSet), id ?? activeId, scope, isTabDirty));
}
