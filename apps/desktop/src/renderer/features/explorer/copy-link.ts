/**
 * **Copy link** on a project, API or request row: the browser client's address of that entity's tab, so a
 * teammate who opens it lands on the same tab of the same workspace (see `features/address/address.ts`).
 *
 * In a browser tab the link is on this page's own origin. On the desktop it is on the server the open workspace
 * is shared to, and only when that server serves the browser client: whether it does is asked when the item is
 * chosen, since the menu is drawn without waiting on the network.
 */
import type { WorkspaceWire } from '@shared/wire-base.js';
import { showToast } from '../../components/toast.js';
import { isBrowserTab } from '../../lib/capabilities.js';
import { ipc } from '../../state/ipc-client.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { formatAddress, workspaceKey, type AddressTab } from '../address/address.js';
import { BROWSER_CLIENT_CAPABILITY } from '../team/team-link.js';
import type { ExplorerMenuItem } from './menu-items.js';
import type { ExplorerNode } from './tree-nodes.js';

/** The tab a row's link opens: the row kinds that name one, by the tab kind and the entity id the address uses. */
export function linkTab(node: ExplorerNode): AddressTab | undefined {
  switch (node.kind) {
    case 'project':
      return node.projectId === undefined ? undefined : { kind: 'project', id: node.projectId };
    case 'api':
    case 'grpc-api':
    case 'ws-api':
    case 'mcp-api':
      return node.apiId === undefined ? undefined : { kind: node.kind, id: node.apiId };
    case 'request':
    case 'rest-request':
    case 'grpc-request':
    case 'ws-request':
    case 'mcp-request':
      return node.requestId === undefined ? undefined : { kind: node.kind, id: node.requestId };
    default:
      return undefined;
  }
}

/** The server the open workspace is shared to, when it is shared to one. */
function sharedServer(workspace: WorkspaceWire | null | undefined): string | undefined {
  return workspace?.share?.kind === 'server' ? workspace.share.server?.url : undefined;
}

/** The link to `tab` of `workspace` on `origin`. */
export function entityLink(origin: string, workspace: Pick<WorkspaceWire, 'id' | 'share'>, tab: AddressTab): string {
  const key = workspaceKey(workspace);
  return new URL(formatAddress({ ...(key !== undefined ? { workspace: key } : {}), tab }), origin).toString();
}

async function copyLink(tab: AddressTab): Promise<void> {
  const workspace = useWorkspaceStore.getState().workspace;
  if (workspace === null || workspace === undefined) return;
  let origin: string;
  if (isBrowserTab()) {
    origin = window.location.origin;
  } else {
    const server = sharedServer(workspace);
    if (server === undefined) return;
    const probe = await ipc().account.probe({ url: server });
    if (!probe.ok || !probe.value.meta.capabilities.includes(BROWSER_CLIENT_CAPABILITY)) {
      showToast('This workspace’s server has no browser client to link to');
      return;
    }
    origin = server;
  }
  try {
    await navigator.clipboard.writeText(entityLink(origin, workspace, tab));
    showToast('Link copied');
  } catch {
    showToast('Could not copy to the clipboard');
  }
}

/**
 * **Copy link** for `node`, or nothing: a row that names no tab, or a desktop workspace that is not shared to a
 * server, has no link anyone else could open.
 */
export function copyLinkItems(node: ExplorerNode): ExplorerMenuItem[] {
  const tab = linkTab(node);
  if (tab === undefined) return [];
  if (!isBrowserTab() && sharedServer(useWorkspaceStore.getState().workspace) === undefined) return [];
  return [{ key: 'copy-link', label: 'Copy link', run: () => void copyLink(tab) }];
}
