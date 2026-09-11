import type { ReactNode } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { recreateRequest, type RecreateMode } from '../request-editor/request-actions.js';
import { explorerActions } from './explorer-actions.js';
import type { ExplorerNode } from './tree-nodes.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

export interface ExplorerContextMenuProps {
  readonly node: ExplorerNode;
  readonly children: ReactNode;
}

/** The right-click menu for one explorer node; the items shown depend on `node.kind`. Every item
 * delegates to {@link explorerActions} — the same handlers the `explorer.*` palette commands run. */
export function ExplorerContextMenu({ node, children }: ExplorerContextMenuProps) {
  const items: ReactNode[] = [];

  if (node.kind === 'interface') {
    items.push(
      <ContextMenu.Item key="import-another" className={ITEM_CLASS} onSelect={() => explorerActions.importAnother()}>
        Import another WSDL…
      </ContextMenu.Item>,
      <ContextMenu.Item
        key="remove"
        className={ITEM_CLASS}
        onSelect={() => explorerActions.removeInterface(node.interfaceId)}
      >
        Remove interface
      </ContextMenu.Item>,
      <ContextMenu.Item
        key="copy-url"
        className={ITEM_CLASS}
        onSelect={() => explorerActions.copyDefinitionUrl(node.interfaceId)}
      >
        Copy definition URL
      </ContextMenu.Item>,
      <ContextMenu.Item
        key="check-wsi"
        className={ITEM_CLASS}
        onSelect={() => explorerActions.checkWsiWsdl(node.interfaceId)}
      >
        Check WSDL WS-I compliance
      </ContextMenu.Item>,
    );
  }

  if (node.kind === 'operation') {
    items.push(
      <ContextMenu.Item
        key="new-request"
        className={ITEM_CLASS}
        onSelect={() => explorerActions.newRequest(node.interfaceId, node.bindingName, node.operationName)}
      >
        New request
      </ContextMenu.Item>,
      <ContextMenu.Item
        key="copy-soap-action"
        className={ITEM_CLASS}
        onSelect={() => explorerActions.copySoapAction(node.soapAction)}
      >
        Copy SOAPAction
      </ContextMenu.Item>,
    );
  }

  if (node.kind === 'request') {
    // The three Recreate variants call the shared action directly (the explorer action only
    // covers "keep values"); the id is optional on the node type, so guard once here.
    const recreate = (mode: RecreateMode) => (): void => {
      if (node.requestId !== undefined) {
        void recreateRequest(node.requestId, mode);
      }
    };
    items.push(
      <ContextMenu.Item key="open" className={ITEM_CLASS} onSelect={() => explorerActions.openRequest(node.requestId)}>
        Open
      </ContextMenu.Item>,
      <ContextMenu.Item
        key="clone"
        className={ITEM_CLASS}
        onSelect={() => explorerActions.cloneRequest(node.requestId)}
      >
        Clone
      </ContextMenu.Item>,
      <ContextMenu.Item
        key="recreate"
        className={ITEM_CLASS}
        onSelect={() => explorerActions.recreateRequest(node.requestId)}
      >
        Recreate request (keep values)
      </ContextMenu.Item>,
      <ContextMenu.Item key="recreate-discard" className={ITEM_CLASS} onSelect={recreate('discard-values')}>
        Recreate (discard values)
      </ContextMenu.Item>,
      <ContextMenu.Item key="recreate-empty" className={ITEM_CLASS} onSelect={recreate('empty')}>
        Create empty
      </ContextMenu.Item>,
      <ContextMenu.Item
        key="rename"
        className={ITEM_CLASS}
        onSelect={() => explorerActions.renameRequest(node.requestId)}
      >
        Rename…
      </ContextMenu.Item>,
      <ContextMenu.Item
        key="delete"
        className={ITEM_CLASS}
        onSelect={() => explorerActions.deleteRequest(node.requestId)}
      >
        Delete
      </ContextMenu.Item>,
    );
  }

  if (node.kind === 'endpoint') {
    items.push(
      <ContextMenu.Item
        key="copy-address"
        className={ITEM_CLASS}
        onSelect={() => explorerActions.copyEndpointAddress(node.address)}
      >
        Copy address
      </ContextMenu.Item>,
    );
  }

  if (items.length === 0) {
    return <>{children}</>;
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-40 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg">
          {items}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
