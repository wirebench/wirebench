import type { ReactNode } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { recreateRequest, type RecreateMode } from '../request-editor/request-actions.js';
import { explorerActions } from './explorer-actions.js';
import { projectRowActions } from './project-actions.js';
import type { ExplorerNode } from './tree-nodes.js';

/**
 * The OS file manager's own name for itself, so the menu reads the way the platform does.
 * `navigator.platform` is deprecated but is what the renderer has; anything unrecognised falls
 * back to the neutral wording.
 */
const REVEAL_LABEL = /mac/i.test(navigator.userAgent)
  ? 'Reveal in Finder'
  : /win/i.test(navigator.userAgent)
    ? 'Reveal in Explorer'
    : 'Show in file manager';

const ITEM_CLASS =
  'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

export interface ExplorerContextMenuProps {
  readonly node: ExplorerNode;
  readonly children: ReactNode;
}

/** One right-click menu entry: what it says, and what it does. */
export interface ExplorerMenuItem {
  readonly key: string;
  readonly label: string;
  readonly run: () => void;
}

/**
 * The right-click menu for one explorer node, as data: which items a node of this kind offers,
 * in order. Pure and store-free, so the menu for every kind is unit-testable without mounting
 * Radix. Every item delegates to {@link explorerActions} or {@link projectRowActions} — the
 * same handlers the `explorer.*` / `workspace.*` palette commands run.
 */
export function explorerMenuItems(node: ExplorerNode): readonly ExplorerMenuItem[] {
  const items: ExplorerMenuItem[] = [];

  if (node.kind === 'project' && node.projectId !== undefined) {
    const projectId = node.projectId;
    items.push(
      { key: 'import', label: 'Import WSDL…', run: () => projectRowActions.importInto(projectId) },
      { key: 'rename', label: 'Rename', run: () => projectRowActions.rename(projectId) },
      { key: 'settings', label: 'Settings…', run: () => projectRowActions.settings(projectId) },
      // Only a linked project has environments of its own; an internal project's environments
      // are the workspace's, edited in the grid.
      ...(node.linked === true
        ? [
            {
              key: 'project-environments',
              label: 'Project environments (linked project)',
              run: () => {
                void projectRowActions.projectEnvironments(projectId);
              },
            },
          ]
        : []),
      { key: 'reveal', label: REVEAL_LABEL, run: () => projectRowActions.reveal(projectId) },
      { key: 'export', label: 'Export project…', run: () => projectRowActions.export(projectId) },
      { key: 'remove', label: 'Remove from workspace', run: () => projectRowActions.remove(projectId) },
    );
  }

  if (node.kind === 'project-missing' && node.projectId !== undefined) {
    const projectId = node.projectId;
    items.push(
      { key: 'locate', label: 'Locate…', run: () => projectRowActions.locate(projectId) },
      { key: 'remove', label: 'Remove from workspace', run: () => projectRowActions.remove(projectId) },
    );
  }

  if (node.kind === 'interface') {
    items.push(
      {
        key: 'show-interface',
        label: 'Show Interface Viewer',
        run: () => explorerActions.showInterface(node.interfaceId),
      },
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
      {
        key: 'generate-docs',
        label: 'Generate Documentation…',
        run: () => explorerActions.generateDocs(node.interfaceId),
      },
      { key: 'import-another', label: 'Import another WSDL…', run: () => explorerActions.importAnother() },
      { key: 'remove', label: 'Remove interface', run: () => explorerActions.removeInterface(node.interfaceId) },
      { key: 'copy-url', label: 'Copy definition URL', run: () => explorerActions.copyDefinitionUrl(node.interfaceId) },
      {
        key: 'check-wsi',
        label: 'Check WSDL WS-I compliance',
        run: () => explorerActions.checkWsiWsdl(node.interfaceId),
      },
    );
  }

  if (node.kind === 'operation') {
    items.push(
      {
        key: 'new-request',
        label: 'New request',
        run: () => explorerActions.newRequest(node.interfaceId, node.bindingName, node.operationName),
      },
      { key: 'copy-soap-action', label: 'Copy SOAPAction', run: () => explorerActions.copySoapAction(node.soapAction) },
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
      { key: 'open', label: 'Open', run: () => explorerActions.openRequest(node.requestId) },
      { key: 'clone', label: 'Clone', run: () => explorerActions.cloneRequest(node.requestId) },
      {
        key: 'recreate',
        label: 'Recreate request (keep values)',
        run: () => explorerActions.recreateRequest(node.requestId),
      },
      { key: 'recreate-discard', label: 'Recreate (discard values)', run: recreate('discard-values') },
      { key: 'recreate-empty', label: 'Create empty', run: recreate('empty') },
      { key: 'rename', label: 'Rename…', run: () => explorerActions.renameRequest(node.requestId) },
      { key: 'delete', label: 'Delete', run: () => explorerActions.deleteRequest(node.requestId) },
    );
  }

  if (node.kind === 'endpoint') {
    items.push({
      key: 'copy-address',
      label: 'Copy address',
      run: () => explorerActions.copyEndpointAddress(node.address),
    });
  }

  return items;
}

/** The right-click menu for one explorer node; the items shown depend on `node.kind`. */
export function ExplorerContextMenu({ node, children }: ExplorerContextMenuProps) {
  const items = explorerMenuItems(node);

  if (items.length === 0) {
    return <>{children}</>;
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-40 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg">
          {items.map((item) => (
            <ContextMenu.Item key={item.key} className={ITEM_CLASS} onSelect={item.run}>
              {item.label}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
