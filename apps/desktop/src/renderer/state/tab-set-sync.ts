/**
 * Keeps the editor's tab set and the sidebar's area in step (see `tab-sets.ts`).
 *
 * Choosing an area shows its set of tabs; opening or activating a tab of another set — from the
 * command palette, a link, a restored workspace — brings that set's area into view, so the tab the
 * user asked for is always on screen. Each direction is a no-op when the other side already
 * agrees, which is what stops the two subscriptions from feeding each other.
 */
import { useEditorsStore } from './editors.js';
import { tabSetForView, viewForTabSet } from './tab-sets.js';
import { useUiStore } from './ui.js';

/** Starts the two-way sync; returns the function that stops it. */
export function syncTabSetsWithSidebar(): () => void {
  // Whatever the sidebar shows right now decides the strip the window starts with.
  useEditorsStore.getState().showSet(tabSetForView(useUiStore.getState().sidebar.view));

  const offUi = useUiStore.subscribe((state, previous) => {
    if (state.sidebar.view === previous.sidebar.view) return;
    useEditorsStore.getState().showSet(tabSetForView(state.sidebar.view));
  });

  const offEditors = useEditorsStore.subscribe((state, previous) => {
    if (state.displayedSet === previous.displayedSet) return;
    const view = useUiStore.getState().sidebar.view;
    if (tabSetForView(view) === state.displayedSet) return;
    useUiStore.getState().setSidebarView(viewForTabSet(state.displayedSet, view));
  });

  return () => {
    offUi();
    offEditors();
  };
}
