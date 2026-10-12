import { lintRestDefinition } from '../../features/rest-api/lint-actions.js';
import { Globe } from 'lucide-react';
import { explorerActions } from '../../features/explorer/explorer-actions.js';
import { exportItems, groups, reportRenameFailure } from '../../features/explorer/menu-items.js';
import type { ExplorerNode } from '../../features/explorer/tree-nodes.js';
import { MethodBadge } from '../../features/rest-api/method-badge.js';
import { useProjectStore } from '../../state/project.js';
import type { KindExplorer } from '../renderer-kind.js';

function RestGutter({ node }: { readonly node: ExplorerNode }) {
  return node.method === undefined ? null : (
    <MethodBadge method={node.method} title={`${node.method} ${node.label}`} compact className="w-auto" />
  );
}

/** REST in the explorer: APIs and their requests. Folders are core; their menu asks {@link newRequestIn}. */
export const restExplorer: KindExplorer = {
  nodes: {
    api: {
      icon: Globe,
      testId: 'api-row',
      badge: 'REST',
      click: 'open-and-fold',
      dropTarget: true,
      open: (node) => explorerActions.openApi(node.apiId),
      runTarget: (node) => node.apiId,
      rename: (node, name) => {
        if (node.apiId !== undefined) {
          void useProjectStore.getState().updateApi(node.apiId, { name }).catch(reportRenameFailure);
        }
      },
      remove: (node) => explorerActions.removeApi(node.apiId),
      menu: (node) => {
        if (node.apiId === undefined) return [];
        const apiId = node.apiId;
        return groups(
          [
            { key: 'open', label: 'Open', run: () => explorerActions.openApi(apiId) },
            { key: 'new-folder', label: 'New folder', run: () => explorerActions.newFolder(apiId) },
            { key: 'new-request', label: 'New request', run: () => explorerActions.newRestRequest(apiId) },
            { key: 'import-curl', label: 'Import cURL…', run: () => explorerActions.importCurlInto(apiId) },
          ],
          // Only an API imported from a definition has one to read again, and one to import webhooks
          // and callbacks from.
          node.hasDefinition === true
            ? [
                {
                  key: 'update-definition',
                  label: 'Update Definition…',
                  run: () => explorerActions.updateRestDefinition(apiId),
                },
                { key: 'import-webhooks', label: 'Import webhooks…', run: () => explorerActions.importWebhooks(apiId) },
                { key: 'new-mock', label: 'New Mock', run: () => explorerActions.newMock(apiId) },
                {
                  key: 'lint-definition',
                  label: 'Lint Definition',
                  run: () => void lintRestDefinition(apiId, { reveal: true }),
                },
              ]
            : [],
          exportItems({ containerId: apiId }),
          [{ key: 'rename', label: 'Rename…', run: () => explorerActions.renameNode('api', apiId) }],
          [{ key: 'delete', label: 'Delete', run: () => explorerActions.removeApi(apiId) }],
        );
      },
    },
    'rest-request': {
      testId: 'rest-request-row',
      Gutter: RestGutter,
      click: 'open',
      movable: true,
      open: (node) => explorerActions.openRestRequest(node.requestId),
      rename: (node, name) => {
        if (node.requestId !== undefined) {
          void useProjectStore.getState().updateRestRequest(node.requestId, { name }).catch(reportRenameFailure);
        }
      },
      remove: (node) => explorerActions.deleteRestRequest(node.requestId),
      menu: (node) => {
        if (node.requestId === undefined) return [];
        const requestId = node.requestId;
        // No *Open*, for the same reason a SOAP request row has none: a single click already opens it.
        return groups(
          [
            { key: 'duplicate', label: 'Duplicate', run: () => explorerActions.duplicateRestRequest(requestId) },
            { key: 'rename', label: 'Rename…', run: () => explorerActions.renameNode('rest-request', requestId) },
          ],
          [{ key: 'delete', label: 'Delete', run: () => explorerActions.deleteRestRequest(requestId) }],
        );
      },
    },
  },
  newRequestIn: (apiId, folderId) => explorerActions.newRestRequest(apiId, folderId),
  importCurlIn: (apiId, folderId) => explorerActions.importCurlInto(apiId, folderId),
  ownsApi: (apiId, project) => project.apis[apiId] !== undefined,
  deletions: {
    api: { title: 'Delete API?', remove: (id) => useProjectStore.getState().removeApi(id) },
    'rest-request': { title: 'Delete request?', remove: (id) => useProjectStore.getState().removeRestRequest(id) },
  },
};
