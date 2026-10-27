import type { WsApiWire, WsRequestWire } from '@shared/kinds/ws/wire.js';
import type { RestFolderWire } from '@shared/wire-base.js';
import { containerChildren } from '../../features/explorer/container-tree.js';
import type { ExplorerNode } from '../../features/explorer/tree-nodes.js';
import type { KindExplorerTree } from '../explorer-tree.js';

function wsRequestNode(api: WsApiWire, request: WsRequestWire): ExplorerNode {
  return {
    id: `ws:${request.id}`,
    kind: 'ws-request',
    label: request.name,
    requestId: request.id,
    apiId: api.id,
    ...(request.folderId !== undefined ? { folderId: request.folderId } : {}),
    ...(request.orphaned === true ? { orphaned: true } : {}),
  };
}

/** One WebSocket API row and everything under it; folds like a REST or gRPC API. */
function wsApiNode(
  api: WsApiWire,
  folders: readonly RestFolderWire[],
  requests: readonly WsRequestWire[],
): ExplorerNode {
  return {
    id: `ws-api:${api.id}`,
    kind: 'ws-api',
    label: api.name,
    apiId: api.id,
    children: containerChildren(api.id, 'websocket', undefined, folders, requests, (request) =>
      wsRequestNode(api, request),
    ),
  };
}

/** WebSocket's containers: each API, placed by its `order`. Its folders ride in REST's list. */
export const wsExplorerTree: KindExplorerTree = {
  movable: { 'ws-api': 'apiId', 'ws-request': 'requestId' },
  kind: 'websocket',
  containers: ({ rest, ws }) =>
    (ws?.apis ?? []).map((api) => ({
      order: api.order,
      node: wsApiNode(api, rest?.folders ?? [], ws?.requests ?? []),
    })),
};
