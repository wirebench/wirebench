/**
 * Opening a folder's page: General (its name and description), Authentication and, for a REST or
 * gRPC folder, Scripts. The id — `folder:<folderId>` — is fixed here because the explorer, the path
 * line, the persisted-tab restore and the tab table all use it.
 */
import { useSettingsPageTabStore } from '../../components/settings-page-tabs.js';
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';

export type FolderPageTab = 'general' | 'auth' | 'scripts';

/** The editor-tab id for one folder's page. */
export function folderTabId(folderId: string): string {
  return `folder:${folderId}`;
}

/** Opens (or focuses) the folder's page, on `tab` when given. A folder the mirror does not hold is ignored. */
export function openFolderTab(folderId: string, tab?: FolderPageTab): void {
  const name = useProjectStore.getState().folders[folderId]?.name;
  if (name === undefined) {
    return;
  }
  if (tab !== undefined) {
    useSettingsPageTabStore.getState().select(folderId, tab);
  }
  useEditorsStore.getState().open({ id: folderTabId(folderId), kind: 'folder', title: name, folderId });
}
