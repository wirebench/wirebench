import { lintRestDefinition } from '../../features/rest-api/lint-actions.js';
import { Globe } from 'lucide-react';
import { showToast } from '../../components/toast.js';
import { MoveRequestDialog, useMoveRequestStore } from '../../features/explorer/move-request-dialog.js';
import { copyAsCurl } from '../../features/request-editor/request-actions.js';
import { openRestRequestTab } from '../../features/rest-editor/rest-actions.js';
import { restSendBlocked } from '../../features/rest-editor/send-blocked.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { featureOn, useUiStore } from '../../state/ui.js';
import { explorerActions } from '../../features/explorer/explorer-actions.js';
import { exportItems, groups, reportRenameFailure } from '../../features/explorer/menu-items.js';
import type { ExplorerNode } from '../../features/explorer/tree-nodes.js';
import { MethodBadge } from '../../features/rest-api/method-badge.js';
import { requestDisplayName } from '../../features/rest-api/request-display-name.js';
import { useProjectStore } from '../../state/project.js';
import type { KindExplorer } from '../renderer-kind.js';
import { useMoveApiStore } from '../../features/explorer/move-api-dialog.js';
import { hasCapability } from '../../lib/capabilities.js';

function RestGutter({ node }: { readonly node: ExplorerNode }) {
  if (node.method === undefined) {
    return null;
  }
  // A GraphQL request reads `GQL`; its title still names the method it goes out with.
  return node.graphql === true ? (
    <MethodBadge
      method="GQL"
      title={`GraphQL (${node.method}) ${requestDisplayName(node.label, node.method)}`}
      compact
    />
  ) : (
    <MethodBadge method={node.method} title={`${node.method} ${requestDisplayName(node.label, node.method)}`} compact />
  );
}

/** **Send** from the row: opens the request's tab, where the response lands, and sends it as its Send button would. */
function sendFromRow(requestId: string): void {
  openRestRequestTab(requestId);
  const blocked = restSendBlocked(requestId);
  if (blocked !== undefined) {
    showToast(blocked);
    return;
  }
  void useExchangesStore.getState().sendRest(requestId);
}

/** **Copy URL**: the request's URL joined to its API's base URL, `${…}` references left as written. */
async function copyUrl(requestId: string): Promise<void> {
  const { restRequests, apis } = useProjectStore.getState();
  const request = restRequests[requestId];
  if (request === undefined) return;
  // Loaded on use: the engine's URL helpers stay out of the bundle the explorer is drawn with.
  const { joinBase } = await import('@wirebench/engine/rest');
  try {
    await navigator.clipboard.writeText(joinBase(apis[request.apiId]?.baseUrl ?? '', request.url));
    showToast('URL copied');
  } catch {
    showToast('Could not copy to the clipboard');
  }
}

/** REST in the explorer: APIs and their requests. Folders are core; their menu asks {@link newRequestIn}. */
export const restExplorer: KindExplorer = {
  nodes: {
    api: {
      container: true,
      icon: Globe,
      testId: 'api-row',
      badge: 'REST',
      click: 'open',
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
            // Offered while the GraphQL switch is on (phase 6 spec §3.4).
            ...(featureOn('graphql')
              ? [
                  {
                    key: 'new-graphql-request',
                    label: 'New GraphQL request',
                    run: () => explorerActions.newGraphqlRequest(apiId),
                  },
                ]
              : []),
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
                // A mock is a listener on the machine's network.
                ...(hasCapability('listen')
                  ? [{ key: 'new-mock', label: 'New Mock', run: () => explorerActions.newMock(apiId) }]
                  : []),
                {
                  key: 'lint-definition',
                  label: 'Lint Definition',
                  run: () => void lintRestDefinition(apiId, { reveal: true }),
                },
              ]
            : [],
          exportItems({ containerId: apiId }),
          [
            { key: 'rename', label: 'Rename…', run: () => explorerActions.renameNode('api', apiId) },
            { key: 'move-to-project', label: 'Move to project…', run: () => useMoveApiStore.getState().open(apiId) },
          ],
          [{ key: 'delete', label: 'Delete', run: () => explorerActions.removeApi(apiId) }],
        );
      },
    },
    'rest-request': {
      testId: 'rest-request-row',
      Gutter: RestGutter,
      click: 'open',
      movable: true,
      // One request runs in the Runner too: its iterations and data file without the rest of its folder.
      runTarget: (node) => node.requestId,
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
        // Run… follows the first group (see `runTarget`).
        return groups(
          [
            { key: 'send', label: 'Send', run: () => sendFromRow(requestId) },
            {
              key: 'copy-curl',
              label: 'Copy as cURL',
              run: () => void copyAsCurl(requestId, useUiStore.getState().slideOver.codeShell),
            },
            { key: 'copy-url', label: 'Copy URL', run: () => void copyUrl(requestId) },
          ],
          [
            { key: 'duplicate', label: 'Duplicate', run: () => explorerActions.duplicateRestRequest(requestId) },
            { key: 'move', label: 'Move to…', run: () => useMoveRequestStore.getState().open(requestId) },
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
  Dialogs: MoveRequestDialog,
  deletions: {
    api: { title: 'Delete API?', remove: (id) => useProjectStore.getState().removeApi(id) },
    'rest-request': { title: 'Delete request?', remove: (id) => useProjectStore.getState().removeRestRequest(id) },
  },
};
