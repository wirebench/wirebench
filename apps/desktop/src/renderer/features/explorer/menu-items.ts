/**
 * The explorer's right-click menu as data, and the helpers a kind's menu is built with. Kept apart
 * from `context-menu.tsx` so the kinds' menus (`renderer/kinds/<kind>/explorer.tsx`) can use them
 * without importing the component that composes them.
 */
import { showToast } from '../../components/toast.js';
import { exportCollection, type CollectionExportTarget } from './export-collection.js';
import { explorerActions } from './explorer-actions.js';
import type { CommandId } from '@shared/commands.js';
import { hasCapability } from '../../lib/capabilities.js';

/** One right-click menu entry: what it says, and what it does. */
export interface ExplorerMenuItem {
  readonly key: string;
  readonly label: string;
  readonly run: () => void;
  /** Set on an entry that opens a submenu of these instead of running (#731 X22); `run` is then unused. */
  readonly children?: readonly ExplorerMenuItem[];
  /** Set on an entry that deletes or removes: it is drawn last, after a rule, in the danger colour. */
  readonly destructive?: boolean;
  /** The command whose key does the same to this row, so the menu shows that key beside the entry. */
  readonly command?: CommandId;
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

/**
 * **Export as Postman Collection…** and **Export as OpenCollection…** for a project, API or interface;
 * none without `dialogs`, since each writes to a folder picked in a native dialog.
 */
export function exportItems(target: CollectionExportTarget): ExplorerMenuItem[] {
  if (!hasCapability('dialogs')) return [];
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

/** The entries that delete or remove a row. */
export const DESTRUCTIVE_KEYS: ReadonlySet<string> = new Set(['delete', 'remove']);

/**
 * Where an entry belongs in the one order every row's menu follows: Open · Send/Run · New… · Import… · Copy… ·
 * Duplicate, Rename…, Move… · Settings… · Export… · then what deletes or removes. `undefined` for an entry no
 * step names (a placeholder's reason, say), which keeps the place its menu gives it.
 */
export function menuRank(key: string): number | undefined {
  if (key === 'open' || key === 'show-interface') return 0;
  if (['send', 'run', 'runner', 'run-now', 'toggle', 'schedule'].includes(key)) return 1;
  if (key === 'new' || key.startsWith('new-') || key.startsWith('recreate')) return 2;
  if (key.startsWith('import')) return 3;
  if (key.startsWith('copy-')) return 4;
  if (['duplicate', 'duplicate-api', 'rename', 'move', 'move-to-project', 'move-to-workspace'].includes(key)) return 5;
  if (
    [
      'settings',
      'project-environments',
      'auth',
      'scripts',
      'edit',
      'secrets',
      'enable-scripts',
      'convert-scripts',
      'update-definition',
      'lint-definition',
      'check-wsi',
      'refresh-catalogue',
      'rotate',
      'clear',
      'clear-values',
      'locate',
    ].includes(key)
  )
    return 6;
  if (key === 'reveal' || key === 'generate-docs' || key.startsWith('export')) return 7;
  if (DESTRUCTIVE_KEYS.has(key)) return 9;
  return undefined;
}

/** Moves the entries that delete or remove into one last group of their own, marked destructive. */
export function destructiveLast(menu: readonly ExplorerMenuGroup[]): readonly ExplorerMenuGroup[] {
  const danger = menu.flat().filter((item) => DESTRUCTIVE_KEYS.has(item.key));
  if (danger.length === 0) return menu;
  return groups(
    ...menu.map((group) => group.filter((item) => !DESTRUCTIVE_KEYS.has(item.key))),
    danger.map((item) => ({ ...item, destructive: true })),
  );
}

/**
 * **Export API…**: an API's own definition written to a folder picked in a dialog (its OpenAPI document, a gRPC
 * API's descriptor set). Only an API that keeps a cached definition has one to write, and only with `dialogs`.
 */
export function exportApiItems(apiId: string, hasDefinition: boolean): ExplorerMenuItem[] {
  if (!hasDefinition || !hasCapability('dialogs')) return [];
  return [{ key: 'export-api', label: 'Export API…', run: () => explorerActions.exportApi(apiId) }];
}
