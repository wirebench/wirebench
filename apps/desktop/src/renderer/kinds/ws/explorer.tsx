import { Cable } from 'lucide-react';
import { explorerActions } from '../../features/explorer/explorer-actions.js';
import { exportItems, groups, reportRenameFailure } from '../../features/explorer/menu-items.js';
import { WsBadge } from '../../features/ws-editor/badge.js';
import { useProjectStore } from '../../state/project.js';
import type { KindExplorer } from '../renderer-kind.js';
import { useMoveApiStore } from '../../features/explorer/move-api-dialog.js';

function WsGutter() {
  return <WsBadge />;
}

/** WebSocket in the explorer: APIs and their requests. */
export const wsExplorer: KindExplorer = {
  nodes: {
    'ws-api': {
      container: true,
      icon: Cable,
      testId: 'ws-api-row',
      badge: 'WS',
      click: 'open',
      dropTarget: true,
      open: (node) => explorerActions.openWsApi(node.apiId),
      runTarget: (node) => node.apiId,
      rename: (node, name) => {
        if (node.apiId !== undefined) {
          void useProjectStore.getState().updateWsApi(node.apiId, { name }).catch(reportRenameFailure);
        }
      },
      remove: (node) => explorerActions.removeWsApi(node.apiId),
      menu: (node) => {
        if (node.apiId === undefined) return [];
        const apiId = node.apiId;
        return groups(
          [
            { key: 'open', label: 'Open', run: () => explorerActions.openWsApi(apiId) },
            { key: 'new-folder', label: 'New folder', run: () => explorerActions.newFolder(apiId) },
            { key: 'new-request', label: 'New request', run: () => explorerActions.newWsRequest(apiId) },
          ],
          exportItems({ containerId: apiId }),
          [
            { key: 'rename', label: 'Rename…', run: () => explorerActions.renameNode('ws-api', apiId) },
            { key: 'move-to-project', label: 'Move to project…', run: () => useMoveApiStore.getState().open(apiId) },
          ],
          [{ key: 'delete', label: 'Delete', run: () => explorerActions.removeWsApi(apiId) }],
        );
      },
    },
    'ws-request': {
      testId: 'ws-request-row',
      Gutter: WsGutter,
      click: 'open',
      movable: true,
      open: (node) => explorerActions.openWsRequest(node.requestId),
      rename: (node, name) => {
        if (node.requestId !== undefined) {
          void useProjectStore.getState().updateWsRequest(node.requestId, { name }).catch(reportRenameFailure);
        }
      },
      remove: (node) => explorerActions.deleteWsRequest(node.requestId),
      menu: (node) => {
        if (node.requestId === undefined) return [];
        const requestId = node.requestId;
        return groups(
          [
            { key: 'duplicate', label: 'Duplicate', run: () => explorerActions.duplicateWsRequest(requestId) },
            { key: 'rename', label: 'Rename…', run: () => explorerActions.renameNode('ws-request', requestId) },
          ],
          [{ key: 'delete', label: 'Delete', run: () => explorerActions.deleteWsRequest(requestId) }],
        );
      },
    },
  },
  newRequestIn: (apiId, folderId) => explorerActions.newWsRequest(apiId, folderId),
  ownsApi: (apiId, project) => project.wsApis[apiId] !== undefined,
  deletions: {
    'ws-api': { title: 'Delete API?', remove: (id) => useProjectStore.getState().removeWsApi(id) },
    'ws-request': { title: 'Delete request?', remove: (id) => useProjectStore.getState().removeWsRequest(id) },
  },
};
