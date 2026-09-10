import type { ReactNode } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import type { ExplorerNode } from './tree-nodes.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

export interface ExplorerContextMenuProps {
  readonly node: ExplorerNode;
  readonly children: ReactNode;
  readonly onRemoveInterface: () => void;
}

/** The right-click menu for one explorer node; the items shown depend on `node.kind`. */
export function ExplorerContextMenu({ node, children, onRemoveInterface }: ExplorerContextMenuProps) {
  const openImportDialog = useUiStore((state) => state.openImportDialog);
  const openEditor = useEditorsStore((state) => state.open);
  const requests = useProjectStore((state) => state.requests);

  const items: ReactNode[] = [];

  if (node.kind === 'interface') {
    items.push(
      <ContextMenu.Item key="import-another" className={ITEM_CLASS} onSelect={openImportDialog}>
        Import another WSDL…
      </ContextMenu.Item>,
      <ContextMenu.Item key="remove" className={ITEM_CLASS} onSelect={onRemoveInterface}>
        Remove interface
      </ContextMenu.Item>,
      <ContextMenu.Item
        key="copy-url"
        className={ITEM_CLASS}
        onSelect={() => {
          const summary = useProjectStore.getState().interfaces[node.interfaceId ?? ''];
          if (summary !== undefined) void navigator.clipboard.writeText(summary.definitionUrl);
        }}
      >
        Copy definition URL
      </ContextMenu.Item>,
    );
  }

  if (node.kind === 'operation') {
    items.push(
      <ContextMenu.Item
        key="new-request"
        className={ITEM_CLASS}
        onSelect={() => {
          console.info('[wirebench] New request — not implemented yet (Task 15)');
        }}
      >
        New request
      </ContextMenu.Item>,
      <ContextMenu.Item
        key="copy-soap-action"
        className={ITEM_CLASS}
        onSelect={() => {
          if (node.soapAction !== undefined) void navigator.clipboard.writeText(node.soapAction);
        }}
      >
        Copy SOAPAction
      </ContextMenu.Item>,
    );
  }

  if (node.kind === 'request') {
    items.push(
      <ContextMenu.Item
        key="open"
        className={ITEM_CLASS}
        onSelect={() => {
          const request = node.requestId !== undefined ? requests[node.requestId] : undefined;
          if (request !== undefined) {
            openEditor({ id: `request:${request.id}`, kind: 'request', title: request.name, requestId: request.id });
          }
        }}
      >
        Open
      </ContextMenu.Item>,
      <ContextMenu.Item
        key="clone"
        className={ITEM_CLASS}
        onSelect={() => {
          console.info('[wirebench] Clone request — not implemented yet (Task 15)');
        }}
      >
        Clone
      </ContextMenu.Item>,
      <ContextMenu.Item
        key="rename"
        className={ITEM_CLASS}
        onSelect={() => {
          console.info('[wirebench] Rename request — use the inline tree editor');
        }}
      >
        Rename…
      </ContextMenu.Item>,
      <ContextMenu.Item
        key="delete"
        className={ITEM_CLASS}
        onSelect={() => {
          console.info('[wirebench] Delete request — not implemented yet (Task 15)');
        }}
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
        onSelect={() => {
          if (node.address !== undefined) void navigator.clipboard.writeText(node.address);
        }}
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
