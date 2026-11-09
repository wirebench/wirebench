import { EthernetPort, FileCode2, Folder, Link2, Network, Plug, Workflow } from 'lucide-react';
import { copyAsCurl, recreateRequest, type RecreateMode } from '../../features/request-editor/request-actions.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { explorerActions } from '../../features/explorer/explorer-actions.js';
import { exportItems, groups, type ExplorerMenuGroup } from '../../features/explorer/menu-items.js';
import { copyLinkItems } from '../../features/explorer/copy-link.js';
import type { ExplorerNode } from '../../features/explorer/tree-nodes.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { hasCapability } from '../../lib/capabilities.js';
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
    // A mock is a listener on the machine's network.
    hasCapability('listen')
      ? [{ key: 'new-mock', label: 'New Mock', run: () => explorerActions.newMock(node.interfaceId) }]
      : [],
    [{ key: 'import-another', label: 'Import another WSDL…', run: () => explorerActions.importAnother() }],
    [
      {
        key: 'copy-url',
        label: 'Copy definition URL',
        run: () => explorerActions.copyDefinitionUrl(node.interfaceId),
      },
    ],
    [
      {
        key: 'update-definition',
        label: 'Update Definition…',
        run: () => explorerActions.updateDefinition(node.interfaceId),
      },
      {
        key: 'check-wsi',
        label: 'Check WSDL WS-I compliance',
        run: () => explorerActions.checkWsiWsdl(node.interfaceId),
      },
    ],
    [
      // Each writes to a folder or file picked in a native dialog. A SOAP API's own export is its WSDL.
      ...(hasCapability('dialogs')
        ? [
            {
              key: 'export-definition',
              label: 'Export API…',
              run: () => explorerActions.exportDefinition(node.interfaceId),
            },
          ]
        : []),
      ...(node.interfaceId !== undefined ? exportItems({ containerId: node.interfaceId }) : []),
      ...(hasCapability('dialogs')
        ? [
            {
              key: 'generate-docs',
              label: 'Generate Documentation…',
              run: () => explorerActions.generateDocs(node.interfaceId),
            },
          ]
        : []),
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
  const requestId = node.requestId;
  return groups(
    // Open, and Send as the editor's own menu offers it (#731 X22).
    requestId === undefined
      ? []
      : [
          { key: 'open', label: 'Open', run: () => explorerActions.openRequest(requestId) },
          {
            key: 'send',
            label: 'Send',
            run: () => {
              explorerActions.openRequest(requestId);
              void useExchangesStore.getState().send(requestId);
            },
          },
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
    [
      ...copyLinkItems(node),
      ...(requestId === undefined
        ? []
        : [{ key: 'copy-curl', label: 'Copy as cURL', run: () => void copyAsCurl(requestId, 'posix') }]),
    ],
    [
      { key: 'duplicate', label: 'Duplicate', run: () => explorerActions.cloneRequest(node.requestId) },
      { key: 'rename', label: 'Rename…', run: () => explorerActions.renameRequest(node.requestId) },
    ],
    [{ key: 'delete', label: 'Delete', run: () => explorerActions.deleteRequest(node.requestId) }],
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
    // The group of an interface's ports wears a port rather than a folder: nothing is filed in it.
    endpoints: { icon: EthernetPort },
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
        node.interfaceId === undefined || !hasCapability('listen')
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
      // An operation with no request is a leaf (#685 E14): a click makes its first request. One with
      // requests folds on a click and does nothing on a double-click, as before.
      open: (node) => {
        if (node.children === undefined) {
          explorerActions.newRequest(node.interfaceId, node.bindingName, node.operationName);
        }
      },
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
