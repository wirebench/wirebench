import { Radio } from 'lucide-react';
import { explorerActions } from '../../features/explorer/explorer-actions.js';
import { exportItems, groups, reportRenameFailure } from '../../features/explorer/menu-items.js';
import type { ExplorerNode } from '../../features/explorer/tree-nodes.js';
import { MethodKindBadge } from '../../features/grpc-editor/method-kind-badge.js';
import { useProjectStore } from '../../state/project.js';
import type { KindExplorer } from '../renderer-kind.js';

function GrpcGutter({ node }: { readonly node: ExplorerNode }) {
  return node.methodKind === undefined ? null : <MethodKindBadge kind={node.methodKind} compact />;
}

/** gRPC in the explorer: APIs and their requests. */
export const grpcExplorer: KindExplorer = {
  nodes: {
    'grpc-api': {
      icon: Radio,
      testId: 'grpc-api-row',
      badge: 'gRPC',
      click: 'open-and-fold',
      dropTarget: true,
      open: (node) => explorerActions.openGrpcApi(node.apiId),
      runTarget: (node) => node.apiId,
      rename: (node, name) => {
        if (node.apiId !== undefined) {
          void useProjectStore.getState().updateGrpcApi(node.apiId, { name }).catch(reportRenameFailure);
        }
      },
      remove: (node) => explorerActions.removeGrpcApi(node.apiId),
      menu: (node) => {
        if (node.apiId === undefined) return [];
        const apiId = node.apiId;
        return groups(
          [
            { key: 'open', label: 'Open', run: () => explorerActions.openGrpcApi(apiId) },
            { key: 'new-folder', label: 'New folder', run: () => explorerActions.newFolder(apiId) },
            { key: 'new-request', label: 'New request', run: () => explorerActions.newGrpcRequest(apiId) },
          ],
          exportItems({ containerId: apiId }),
          [{ key: 'rename', label: 'Rename…', run: () => explorerActions.renameNode('grpc-api', apiId) }],
          [{ key: 'delete', label: 'Delete', run: () => explorerActions.removeGrpcApi(apiId) }],
        );
      },
    },
    'grpc-request': {
      testId: 'grpc-request-row',
      Gutter: GrpcGutter,
      click: 'open',
      movable: true,
      open: (node) => explorerActions.openGrpcRequest(node.requestId),
      rename: (node, name) => {
        if (node.requestId !== undefined) {
          void useProjectStore.getState().updateGrpcRequest(node.requestId, { name }).catch(reportRenameFailure);
        }
      },
      remove: (node) => explorerActions.deleteGrpcRequest(node.requestId),
      menu: (node) => {
        if (node.requestId === undefined) return [];
        const requestId = node.requestId;
        return groups(
          [
            { key: 'duplicate', label: 'Duplicate', run: () => explorerActions.duplicateGrpcRequest(requestId) },
            { key: 'rename', label: 'Rename…', run: () => explorerActions.renameNode('grpc-request', requestId) },
          ],
          [{ key: 'delete', label: 'Delete', run: () => explorerActions.deleteGrpcRequest(requestId) }],
        );
      },
    },
  },
  newRequestIn: (apiId, folderId) => explorerActions.newGrpcRequest(apiId, folderId),
  ownsApi: (apiId, project) => project.grpcApis[apiId] !== undefined,
  deletions: {
    'grpc-api': { title: 'Delete API?', remove: (id) => useProjectStore.getState().removeGrpcApi(id) },
    'grpc-request': { title: 'Delete request?', remove: (id) => useProjectStore.getState().removeGrpcRequest(id) },
  },
};
