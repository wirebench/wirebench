import { Fragment, type ReactNode } from 'react';
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
 * Items that belong together, drawn between two separator rules. Grouping is the menu's only
 * structure: it says "these do the same sort of thing", and it puts the entries that rename or
 * remove something at the bottom, away from the ones reached for by reflex.
 */
export type ExplorerMenuGroup = readonly ExplorerMenuItem[];

/**
 * The right-click menu for one explorer node, as data: which items a node of this kind offers,
 * in order. Pure and store-free, so the menu for every kind is unit-testable without mounting
 * Radix. Every item delegates to {@link explorerActions} or {@link projectRowActions} — the
 * same handlers the `explorer.*` / `workspace.*` palette commands run.
 */
export function explorerMenuGroups(node: ExplorerNode): readonly ExplorerMenuGroup[] {
  if (node.kind === 'project' && node.projectId !== undefined) {
    const projectId = node.projectId;
    return groups(
      [
        { key: 'import', label: 'Import WSDL…', run: () => projectRowActions.importInto(projectId) },
        {
          key: 'import-openapi',
          label: 'Import OpenAPI…',
          run: () => projectRowActions.importOpenApiInto(projectId),
        },
        // §3.1 puts _New API…_ on the project row: an API is created in a project, and this is the
        // only row that names one.
        { key: 'new-api', label: 'New API…', run: () => explorerActions.newApi(projectId) },
      ],
      [
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
      ],
      [
        { key: 'reveal', label: REVEAL_LABEL, run: () => projectRowActions.reveal(projectId) },
        { key: 'export', label: 'Export project…', run: () => projectRowActions.export(projectId) },
      ],
      [
        { key: 'rename', label: 'Rename', run: () => projectRowActions.rename(projectId) },
        { key: 'remove', label: 'Remove from workspace', run: () => projectRowActions.remove(projectId) },
      ],
    );
  }

  if (node.kind === 'project-missing' && node.projectId !== undefined) {
    const projectId = node.projectId;
    return groups(
      [{ key: 'locate', label: 'Locate…', run: () => projectRowActions.locate(projectId) }],
      [{ key: 'remove', label: 'Remove from workspace', run: () => projectRowActions.remove(projectId) }],
    );
  }

  if (node.kind === 'interface') {
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
      [{ key: 'remove', label: 'Remove interface', run: () => explorerActions.removeInterface(node.interfaceId) }],
    );
  }

  if (node.kind === 'operation') {
    return groups(
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
    // No *Open*: a single click on the row already opens it, so the entry only restated what
    // the row's own default does.
    return groups(
      [
        {
          key: 'recreate',
          label: 'Recreate request (keep values)',
          run: () => explorerActions.recreateRequest(node.requestId),
        },
        { key: 'recreate-discard', label: 'Recreate (discard values)', run: recreate('discard-values') },
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

  if (node.kind === 'api' && node.apiId !== undefined) {
    const apiId = node.apiId;
    return groups(
      [
        { key: 'open', label: 'Open', run: () => explorerActions.openApi(apiId) },
        { key: 'new-folder', label: 'New folder', run: () => explorerActions.newFolder(apiId) },
        { key: 'new-request', label: 'New request', run: () => explorerActions.newRestRequest(apiId) },
      ],
      [{ key: 'rename', label: 'Rename…', run: () => explorerActions.renameNode('api', apiId) }],
      [{ key: 'delete', label: 'Delete', run: () => explorerActions.removeApi(apiId) }],
    );
  }

  if (node.kind === 'folder' && node.apiId !== undefined && node.folderId !== undefined) {
    const { apiId, folderId } = { apiId: node.apiId, folderId: node.folderId };
    return groups(
      [
        { key: 'new-folder', label: 'New folder', run: () => explorerActions.newFolder(apiId, folderId) },
        { key: 'new-request', label: 'New request', run: () => explorerActions.newRestRequest(apiId, folderId) },
      ],
      [
        { key: 'rename', label: 'Rename…', run: () => explorerActions.renameNode('folder', folderId) },
        // A folder has no editor tab, so its one other field gets a dialog of its own.
        { key: 'auth', label: 'Auth…', run: () => explorerActions.editFolderAuth(folderId) },
      ],
      [{ key: 'delete', label: 'Delete', run: () => explorerActions.removeFolder(folderId) }],
    );
  }

  if (node.kind === 'rest-request' && node.requestId !== undefined) {
    const requestId = node.requestId;
    // No *Open*, for the same reason a SOAP request row has none: a single click already opens it.
    return groups(
      [
        { key: 'duplicate', label: 'Duplicate', run: () => explorerActions.duplicateRestRequest(requestId) },
        { key: 'rename', label: 'Rename…', run: () => explorerActions.renameNode('rest-request', requestId) },
      ],
      [{ key: 'delete', label: 'Delete', run: () => explorerActions.deleteRestRequest(requestId) }],
    );
  }

  if (node.kind === 'endpoint') {
    return groups([
      {
        key: 'copy-address',
        label: 'Copy address',
        run: () => explorerActions.copyEndpointAddress(node.address),
      },
    ]);
  }

  return [];
}

/** Drops the groups a node left empty, so no menu ever draws a rule against nothing. */
function groups(...candidates: readonly ExplorerMenuGroup[]): readonly ExplorerMenuGroup[] {
  return candidates.filter((group) => group.length > 0);
}

/** Every item the menu offers, in order, with the grouping flattened away. */
export function explorerMenuItems(node: ExplorerNode): readonly ExplorerMenuItem[] {
  return explorerMenuGroups(node).flat();
}

/** The right-click menu for one explorer node; the items shown depend on `node.kind`. */
export function ExplorerContextMenu({ node, children }: ExplorerContextMenuProps) {
  const menuGroups = explorerMenuGroups(node);

  if (menuGroups.length === 0) {
    return <>{children}</>;
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-40 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg">
          {menuGroups.map((group, index) => (
            <Fragment key={group[0]?.key ?? index}>
              {index > 0 && <ContextMenu.Separator className="my-1 h-px bg-hairline" />}
              {group.map((item) => (
                <ContextMenu.Item key={item.key} className={ITEM_CLASS} onSelect={item.run}>
                  {item.label}
                </ContextMenu.Item>
              ))}
            </Fragment>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
