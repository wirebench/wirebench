/**
 * What a container row offers without its menu: the **+** that runs its first New item, and the line an
 * empty one shows under itself naming that next step ("No requests yet · New request"). Both read the row's
 * own menu, so they never offer what the menu would not.
 */
import { explorerMenuGroups } from './context-menu.js';
import type { ExplorerMenuItem } from './menu-items.js';
import type { ExplorerNode, ExplorerNodeKind } from './tree-nodes.js';

/** The rows that carry hover actions and an empty-state line: the ones things are created in. */
const CONTAINER_KINDS: ReadonlySet<ExplorerNodeKind> = new Set<ExplorerNodeKind>([
  'project',
  'api',
  'grpc-api',
  'ws-api',
  'mcp-api',
  'folder',
  'webhook-collection',
  'webhook-folder',
  'webhooks',
  'sequences',
  'schedules',
]);

/** Which New item is a row's first, in order of preference: a request before a folder, a REST API before a webhook. */
const PRIMARY_NEW_KEYS: readonly string[] = [
  'new-request',
  'new-catch-url',
  'new-schedule',
  'new-api',
  'new-webhook',
  'new-sequence',
];

/** What an empty row says it has none of. */
const EMPTY_TEXT: Partial<Record<ExplorerNodeKind, string>> = {
  project: 'No APIs yet',
  api: 'No requests yet',
  'grpc-api': 'No requests yet',
  'ws-api': 'No requests yet',
  'mcp-api': 'No requests yet',
  folder: 'No requests yet',
  'webhook-collection': 'No webhooks yet',
  'webhook-folder': 'No webhooks yet',
  webhooks: 'No catch URLs yet',
  sequences: 'No sequences yet',
  schedules: 'No schedules yet',
};

/** Whether `node` is a row things are created in. */
export function isCreatingContainer(node: ExplorerNode): boolean {
  return CONTAINER_KINDS.has(node.kind);
}

/** The New item a container row's **+** runs: the first of its menu's New items, submenus included. */
export function primaryNewItem(node: ExplorerNode): ExplorerMenuItem | undefined {
  if (!isCreatingContainer(node)) return undefined;
  const items = explorerMenuGroups(node)
    .flat()
    .flatMap((item) => [item, ...(item.children ?? [])]);
  for (const key of PRIMARY_NEW_KEYS) {
    const found = items.find((item) => item.key === key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** What an empty container row says under itself, and the New item it offers; `undefined` for any other row. */
export interface EmptyHint {
  readonly text: string;
  readonly action?: ExplorerMenuItem;
}

export function emptyHint(node: ExplorerNode): EmptyHint | undefined {
  if (!isCreatingContainer(node) || node.children === undefined || node.children.length > 0) return undefined;
  const text = EMPTY_TEXT[node.kind];
  if (text === undefined) return undefined;
  const action = primaryNewItem(node);
  return action === undefined ? { text } : { text, action };
}
