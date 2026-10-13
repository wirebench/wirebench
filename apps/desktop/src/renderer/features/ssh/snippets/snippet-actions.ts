/**
 * What the snippet commands, the palette and the terminal picker share: showing the Snippets view, and the
 * saved list, read once when nothing has read it yet in this workspace.
 */
import { create } from 'zustand';
import type { SnippetListItemWire } from '../../../../shared/snippets-wire.js';
import { useEditorsStore } from '../../../state/editors.js';
import { useUiStore } from '../../../state/ui.js';
import { useHostsStore } from '../hosts-store.js';
import { activeTerminal } from '../panes/pane-actions.js';
import { useSnippetsStore } from './snippets-store.js';

/** Shows the Snippets view in the SSH area's fixed first tab. */
export function showSnippets(): void {
  const { sidebar, showSidebarView } = useUiStore.getState();
  if (!sidebar.visible || sidebar.view !== 'ssh') showSidebarView('ssh');
  useHostsStore.getState().setHomeView('snippets');
  const editors = useEditorsStore.getState();
  editors.showSet('ssh');
  editors.showStart();
}

/** Reads the list unless this workspace's is loaded already; a failed read leaves it empty. */
export function loadSnippets(): Promise<void> {
  if (useSnippetsStore.getState().loaded) return Promise.resolve();
  return useSnippetsStore
    .getState()
    .refresh()
    .catch(() => undefined); // the Snippets view, or the next change, reads it again
}

/** A saved snippet by id, reading the list first when it is not loaded. */
export async function snippetById(id: string): Promise<SnippetListItemWire | undefined> {
  await loadSnippets();
  return useSnippetsStore.getState().snippets.find((s) => s.id === id);
}

/** The terminal tab whose snippet picker (⌘;) is open, if any. */
export const useSnippetPickerStore = create<{ tabId: string | undefined }>(() => ({ tabId: undefined }));

/** Opens the snippet picker over the terminal tab in front; with none in front it does nothing. */
export function openSnippetPicker(): void {
  const active = activeTerminal();
  if (active !== undefined) useSnippetPickerStore.setState({ tabId: active.tabId });
}

export function closeSnippetPicker(): void {
  useSnippetPickerStore.setState({ tabId: undefined });
}
