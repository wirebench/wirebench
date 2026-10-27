import type { GrpcApiWire, GrpcRequestWire } from '@shared/kinds/grpc/wire.js';
import type { RestFolderWire } from '@shared/wire-base.js';
import { containerChildren } from '../../features/explorer/container-tree.js';
import type { ExplorerNode } from '../../features/explorer/tree-nodes.js';
import type { KindExplorerTree } from '../explorer-tree.js';

function grpcRequestNode(api: GrpcApiWire, request: GrpcRequestWire): ExplorerNode {
  return {
    id: `grpc:${request.id}`,
    kind: 'grpc-request',
    label: request.name,
    requestId: request.id,
    apiId: api.id,
    methodKind: request.methodKind,
    ...(request.folderId !== undefined ? { folderId: request.folderId } : {}),
    ...(request.orphaned === true ? { orphaned: true } : {}),
  };
}

/** One gRPC API row and everything under it; folds like a REST API. */
function grpcApiNode(
  api: GrpcApiWire,
  folders: readonly RestFolderWire[],
  requests: readonly GrpcRequestWire[],
): ExplorerNode {
  return {
    id: `grpc-api:${api.id}`,
    kind: 'grpc-api',
    label: api.name,
    apiId: api.id,
    children: containerChildren(api.id, 'grpc', undefined, folders, requests, (request) =>
      grpcRequestNode(api, request),
    ),
  };
}

/** gRPC's containers: each API, placed by its `order`. Its folders ride in REST's list. */
export const grpcExplorerTree: KindExplorerTree = {
  scriptContainers: ['grpc-api'],
  movable: { 'grpc-api': 'apiId', 'grpc-request': 'requestId' },
  kind: 'grpc',
  containers: ({ rest, grpc }) =>
    (grpc?.apis ?? []).map((api) => ({
      order: api.order,
      node: grpcApiNode(api, rest?.folders ?? [], grpc?.requests ?? []),
    })),
};
