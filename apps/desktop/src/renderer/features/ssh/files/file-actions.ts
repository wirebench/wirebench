/**
 * What the Files tab's menu and its `sftp.*` commands do, in one place: each acts on a tab's pane and its
 * selection. Dialogs and renaming are state in the store, so a command and a right click open the same one.
 */
import { useEditorsStore } from '../../../state/editors.js';
import { useFilesStore } from './files-store.js';
import { isFolderLike, joinRemote } from './format.js';

/** The Files tab in front, if the active editor tab is one. */
export function activeFilesTab(): string | undefined {
  const { tabs, activeId } = useEditorsStore.getState();
  const tab = tabs.find((t) => t.id === activeId);
  return tab?.kind === 'ssh-files' && useFilesStore.getState().panes[tab.id] !== undefined ? tab.id : undefined;
}

function selectedEntries(tabId: string) {
  const pane = useFilesStore.getState().panes[tabId];
  if (pane === undefined) return [];
  const chosen = new Set(pane.selected);
  return pane.entries.filter((e) => chosen.has(e.name));
}

export const fileActions = {
  refresh(tabId: string): void {
    void useFilesStore.getState().refresh(tabId);
  },
  newFolder(tabId: string): void {
    void useFilesStore.getState().newFolder(tabId);
  },
  /** Renames the one selected entry in place. */
  rename(tabId: string): void {
    const [entry, ...more] = selectedEntries(tabId);
    if (entry !== undefined && more.length === 0) useFilesStore.getState().setRenaming(tabId, entry.name);
  },
  /** Asks, then deletes the selection. */
  remove(tabId: string): void {
    const entries = selectedEntries(tabId);
    if (entries.length === 0) return;
    useFilesStore.getState().setDialog(tabId, {
      kind: 'delete',
      names: entries.map((e) => e.name),
      folders: entries.some((e) => e.type === 'dir'),
    });
  },
  /** The permissions of the one selected entry. */
  permissions(tabId: string): void {
    const [entry, ...more] = selectedEntries(tabId);
    if (entry === undefined || more.length > 0) return;
    useFilesStore.getState().setDialog(tabId, { kind: 'permissions', name: entry.name, mode: entry.mode ?? 0 });
  },
  /** The selected entries' paths, one per line, or the folder's own when nothing is selected. */
  copyPath(tabId: string): void {
    const pane = useFilesStore.getState().panes[tabId];
    if (pane === undefined || pane.path === '') return;
    const entries = selectedEntries(tabId);
    const text = entries.length === 0 ? pane.path : entries.map((e) => joinRemote(pane.path, e.name)).join('\n');
    void navigator.clipboard.writeText(text).catch(() => undefined);
  },
  /** Opens the one selected folder. */
  open(tabId: string): void {
    const pane = useFilesStore.getState().panes[tabId];
    const [entry, ...more] = selectedEntries(tabId);
    if (pane === undefined || entry === undefined || more.length > 0 || !isFolderLike(entry)) return;
    void useFilesStore.getState().navigate(tabId, joinRemote(pane.path, entry.name), { push: true });
  },
  toggleHidden(): void {
    const store = useFilesStore.getState();
    store.setShowHidden(!store.showHidden);
  },
  focusPathBar(tabId: string): void {
    useFilesStore.getState().requestPathEdit(tabId);
  },
};
