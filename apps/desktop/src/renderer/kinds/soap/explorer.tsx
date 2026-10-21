import { FileCode2, Folder, Link2, Network, Plug, Workflow } from 'lucide-react';
import { copyAsCurl, recreateRequest, type RecreateMode } from '../../features/request-editor/request-actions.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { explorerActions } from '../../features/explorer/explorer-actions.js';
import { exportItems, groups, type ExplorerMenuGroup } from '../../features/explorer/menu-items.js';
import type { ExplorerNode } from '../../features/explorer/tree-nodes.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import type { KindExplorer } from '../renderer-kind.js';

function interfaceMenu(node: ExplorerNode): readonly ExplorerMenuGroup[] {
  return groups(
    [
      {
        key: 'show-interface',
        label: 'Show Interface Viewer',
        run: () => explorerActions.showInterface(node.interfaceId),
      },
    ],
    [
      {
        key: 'update-definition',
        label: 'Update Definition…',
        run: () => explorerActions.updateDefinition(node.interfaceId),
      },
      {
        key: 'export-definition',
        label: 'Export Definition…',
        run: () => explorerActions.exportDefinition(node.interfaceId),
      },
      ...(node.interfaceId !== undefined ? exportItems({ containerId: node.interfaceId }) : []),
      {
        key: 'generate-docs',
        label: 'Generate Documentation…',
        run: () => explorerActions.generateDocs(node.interfaceId),
      },
      {
        key: 'check-wsi',
        label: 'Check WSDL WS-I compliance',
        run: () => explorerActions.checkWsiWsdl(node.interfaceId),
      },
    ],
    [
      {
        key: 'copy-url',
        label: 'Copy definition URL',
        run: () => explorerActions.copyDefinitionUrl(node.interfaceId),
      },
      { key: 'import-another', label: 'Import another WSDL…', run: () => explorerActions.importAnother() },
    ],
    [
      {
        key: 'new-mock',
        label: 'New Mock',
        run: () => explorerActions.newMock(node.interfaceId),
      },
    ],
    [{ key: 'remove', label: 'Remove interface', run: () => explorerActions.removeInterface(node.interfaceId) }],
  );
}

function requestMenu(node: ExplorerNode): readonly ExplorerMenuGroup[] {
  // The three Recreate variants call the shared action directly (the explorer action only
  // covers "keep values"); the id is optional on the node type, so guard once here.
  const recreate = (mode: RecreateMode) => (): void => {
    if (node.requestId !== undefined) {
      void recreateRequest(node.requestId, mode);
    }
  };
  // No *Open*: a single click on the row already opens it, so the entry only restated what
  // the row's own default does.
  const requestId = node.requestId;
  return groups(
    // Send and Copy as cURL from the tree, as the editor's own menu offers them (#731 X22).
    requestId === undefined
      ? []
      : [
          {
            key: 'send',
            label: 'Send',
            run: () => {
              explorerActions.openRequest(requestId);
              void useExchangesStore.getState().send(requestId);
            },
          },
          { key: 'copy-curl', label: 'Copy as cURL', run: () => void copyAsCurl(requestId, 'posix') },
        ],
    [
      {
        key: 'recreate-from-definition',
        label: 'Recreate from definition',
        run: () => undefined,
        children: [
          {
            key: 'recreate',
            label: 'Keep values',
            run: () => explorerActions.recreateRequest(node.requestId),
          },
          { key: 'recreate-discard', label: 'Discard values', run: recreate('discard-values') },
        ],
      },
      { key: 'recreate-empty', label: 'Create empty', run: recreate('empty') },
    ],
    // Clone sits with Rename and Delete: all three are about this request as a thing you
    // name, copy or throw away, rather than about the envelope inside it.
    [
      { key: 'clone', label: 'Clone', run: () => explorerActions.cloneRequest(node.requestId) },
      { key: 'rename', label: 'Rename…', run: () => explorerActions.renameRequest(node.requestId) },
      { key: 'delete', label: 'Delete', run: () => explorerActions.deleteRequest(node.requestId) },
    ],
  );
}

/** SOAP in the explorer: interfaces, their endpoints, bindings and operations, and requests. */
export const soapExplorer: KindExplorer = {
  nodes: {
    interface: {
      icon: Plug,
      // The interface viewer answers to a double-click, as it always has, so a single click only
      // folds it.
      open: (node) => explorerActions.showInterface(node.interfaceId),
      runTarget: (node) => node.interfaceId,
      remove: (node) => useUiStore.getState().requestRemoveInterface(node.interfaceId),
      menu: interfaceMenu,
    },
    endpoints: { icon: Folder },
    // Operation, request and endpoint rows have icons of their own, as a REST request has its method (#731 X20).
    endpoint: {
      icon: Link2,
      menu: (node) =>
        groups([
          { key: 'copy-address', label: 'Copy address', run: () => explorerActions.copyEndpointAddress(node.address) },
        ]),
    },
    operations: { icon: Folder },
    binding: {
      icon: Network,
      menu: (node) =>
        node.interfaceId === undefined
          ? []
          : groups([
              {
                key: 'new-mock',
                label: 'New Mock of this binding',
                run: () => explorerActions.newMock(node.interfaceId, node.bindingName),
              },
            ]),
    },
    operation: {
      icon: Workflow,
      menu: (node) =>
        groups(
          [
            {
              key: 'new-request',
              label: 'New request',
              run: () => explorerActions.newRequest(node.interfaceId, node.bindingName, node.operationName),
            },
          ],
          [
            {
              key: 'copy-soap-action',
              label: 'Copy SOAPAction',
              run: () => explorerActions.copySoapAction(node.soapAction),
            },
          ],
        ),
    },
    request: {
      icon: FileCode2,
      click: 'open',
      open: (node) => explorerActions.openRequest(node.requestId),
      rename: (node, name) => {
        if (node.requestId !== undefined) useProjectStore.getState().updateRequest(node.requestId, { name });
      },
      remove: (node) => useUiStore.getState().requestDeleteRequest(node.requestId),
      menu: requestMenu,
    },
  },
};
