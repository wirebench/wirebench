import type { McpRequestWire, McpServerWire } from '@shared/kinds/mcp/wire.js';
import type { RestFolderWire } from '@shared/wire-base.js';
import { containerChildren } from '../../features/explorer/container-tree.js';
import type { ExplorerNode } from '../../features/explorer/tree-nodes.js';
import type { KindExplorerTree } from '../explorer-tree.js';

function mcpRequestNode(server: McpServerWire, request: McpRequestWire): ExplorerNode {
  return {
    id: `mcp:${request.id}`,
    kind: 'mcp-request',
    label: request.name,
    requestId: request.id,
    apiId: server.id,
    method: request.operation.method,
    ...(request.folderId !== undefined ? { folderId: request.folderId } : {}),
  };
}

/** One MCP server row and everything under it; folds like any other API. */
function mcpServerNode(
  server: McpServerWire,
  folders: readonly RestFolderWire[],
  requests: readonly McpRequestWire[],
): ExplorerNode {
  return {
    id: `mcp-api:${server.id}`,
    kind: 'mcp-api',
    label: server.name,
    apiId: server.id,
    children: containerChildren(server.id, 'mcp', undefined, folders, requests, (request) =>
      mcpRequestNode(server, request),
    ),
  };
}

/** MCP's containers (#79): each server, placed by its `order`. Its folders ride in REST's list. */
export const mcpExplorerTree: KindExplorerTree = {
  movable: { 'mcp-api': 'apiId', 'mcp-request': 'requestId' },
  kind: 'mcp',
  containers: ({ rest, mcp }) =>
    (mcp?.servers ?? []).map((server) => ({
      order: server.order,
      node: mcpServerNode(server, rest?.folders ?? [], mcp?.requests ?? []),
    })),
};
