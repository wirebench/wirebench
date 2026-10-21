/**
 * The explorer's right-click menu as data, and the helpers a kind's menu is built with. Kept apart
 * from `context-menu.tsx` so the kinds' menus (`renderer/kinds/<kind>/explorer.tsx`) can use them
 * without importing the component that composes them.
 */
import { showToast } from '../../components/toast.js';
import { exportCollection, type CollectionExportTarget } from './export-collection.js';

/** One right-click menu entry: what it says, and what it does. */
export interface ExplorerMenuItem {
  readonly key: string;
  readonly label: string;
  readonly run: () => void;
  /** Set on an entry that opens a submenu of these instead of running (#731 X22); `run` is then unused. */
  readonly children?: readonly ExplorerMenuItem[];
}

/**
 * Items that belong together, drawn between two separator rules. Grouping is the menu's only
 * structure: it says "these do the same sort of thing", and it puts the entries that rename or
 * remove something at the bottom, away from the ones reached for by reflex.
 */
export type ExplorerMenuGroup = readonly ExplorerMenuItem[];

/** Drops the groups a node left empty, so no menu ever draws a rule against nothing. */
export function groups(...candidates: readonly ExplorerMenuGroup[]): readonly ExplorerMenuGroup[] {
  return candidates.filter((group) => group.length > 0);
}

/** **Export as Postman Collection…** and **Export as OpenCollection…** for a project, API or interface. */
export function exportItems(target: CollectionExportTarget): ExplorerMenuItem[] {
  return [
    {
      key: 'export-postman',
      label: 'Export as Postman Collection…',
      run: () => void exportCollection(target, 'postman'),
    },
    {
      key: 'export-opencollection',
      label: 'Export as OpenCollection…',
      run: () => void exportCollection(target, 'opencollection'),
    },
  ];
}

/** Reports a failed inline rename. */
export function reportRenameFailure(error: unknown): void {
  showToast(error instanceof Error ? error.message : 'Could not rename it');
}
