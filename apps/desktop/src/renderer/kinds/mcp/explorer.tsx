import { Plug } from 'lucide-react';
import { explorerActions } from '../../features/explorer/explorer-actions.js';
import { exportItems, groups, reportRenameFailure } from '../../features/explorer/menu-items.js';
import type { ExplorerNode } from '../../features/explorer/tree-nodes.js';
import { McpBadge } from '../../features/mcp-editor/badge.js';
import { NewMcpServerDialog } from '../../features/mcp-api/new-server-dialog.js';
import { McpToolPickerDialog } from '../../features/mcp-api/tool-picker-dialog.js';
import { useProjectStore } from '../../state/project.js';
import type { KindExplorer } from '../renderer-kind.js';

function McpGutter({ node }: { readonly node: ExplorerNode }) {
  return node.method === undefined ? null : <McpBadge method={node.method} />;
}

function McpDialogs() {
  return (
    <>
      <NewMcpServerDialog />
      <McpToolPickerDialog />
    </>
  );
}

/** MCP in the explorer (#79): servers, their folders and requests. */
export const mcpExplorer: KindExplorer = {
  nodes: {
    'mcp-api': {
      icon: Plug,
      testId: 'mcp-api-row',
      badge: 'MCP',
      click: 'open-and-fold',
      dropTarget: true,
      open: (node) => explorerActions.openMcpApi(node.apiId),
      runTarget: (node) => node.apiId,
      rename: (node, name) => {
        if (node.apiId !== undefined) {
          void useProjectStore.getState().updateMcpServer(node.apiId, { name }).catch(reportRenameFailure);
        }
      },
      remove: (node) => explorerActions.removeMcpApi(node.apiId),
      menu: (node) => {
        if (node.apiId === undefined) return [];
        const apiId = node.apiId;
        return groups(
          [
            { key: 'open', label: 'Open', run: () => explorerActions.openMcpApi(apiId) },
            { key: 'new-folder', label: 'New folder', run: () => explorerActions.newFolder(apiId) },
            { key: 'new-request', label: 'New request', run: () => explorerActions.newMcpRequest(apiId) },
            {
              key: 'new-request-from-tool',
              label: 'New request from tool…',
              run: () => explorerActions.newMcpRequestFromTool(apiId),
            },
          ],
          [
            {
              key: 'refresh-catalogue',
              label: 'Refresh catalogue',
              run: () => explorerActions.refreshMcpCatalogue(apiId),
            },
          ],
          exportItems({ containerId: apiId }),
          [{ key: 'rename', label: 'Rename…', run: () => explorerActions.renameNode('mcp-api', apiId) }],
          [{ key: 'delete', label: 'Delete', run: () => explorerActions.removeMcpApi(apiId) }],
        );
      },
    },
    'mcp-request': {
      testId: 'mcp-request-row',
      Gutter: McpGutter,
      click: 'open',
      movable: true,
      open: (node) => explorerActions.openMcpRequest(node.requestId),
      rename: (node, name) => {
        if (node.requestId !== undefined) {
          void useProjectStore.getState().updateMcpRequest(node.requestId, { name }).catch(reportRenameFailure);
        }
      },
      remove: (node) => explorerActions.deleteMcpRequest(node.requestId),
      menu: (node) => {
        if (node.requestId === undefined) return [];
        const requestId = node.requestId;
        return groups(
          [
            { key: 'duplicate', label: 'Duplicate', run: () => explorerActions.duplicateMcpRequest(requestId) },
            { key: 'rename', label: 'Rename…', run: () => explorerActions.renameNode('mcp-request', requestId) },
          ],
          [{ key: 'delete', label: 'Delete', run: () => explorerActions.deleteMcpRequest(requestId) }],
        );
      },
    },
  },
  newRequestIn: (apiId, folderId) => explorerActions.newMcpRequest(apiId, folderId),
  ownsApi: (apiId, project) => project.mcpServers[apiId] !== undefined,
  deletions: {
    'mcp-api': { title: 'Delete server?', remove: (id) => useProjectStore.getState().removeMcpServer(id) },
    'mcp-request': { title: 'Delete request?', remove: (id) => useProjectStore.getState().removeMcpRequest(id) },
  },
  Dialogs: McpDialogs,
};
