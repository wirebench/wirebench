import { Fragment, useRef, type ReactNode } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { useMockRunsStore } from '../../state/mock-runs.js';
import { explorerActions } from './explorer-actions.js';
import { exportItems, groups, type ExplorerMenuGroup, type ExplorerMenuItem } from './menu-items.js';
import { explorerRole, kindExplorer } from '../../kinds/index.js';
import { projectRowActions } from './project-actions.js';
import { hasCapability } from '../../lib/capabilities.js';
import { levelIdOf, type ExplorerNode } from './tree-nodes.js';
import {
  deleteExplorerNodes,
  DUPLICABLE_KINDS,
  duplicateExplorerNodes,
  pendingDeletionOf,
  REQUEST_ROW_KINDS,
} from './explorer-tree-actions.js';
import { useMoveRequestStore } from './move-request-dialog.js';
import { webhooksActions } from '../webhooks/webhooks-actions.js';
import { openRunnerTab } from '../runner/runner-actions.js';
import { canManageSchedules, openScheduleTab, schedulesActions } from '../schedules/schedules-actions.js';
import { openFolderTab } from '../folder/folder-actions.js';

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

export type { ExplorerMenuGroup, ExplorerMenuItem } from './menu-items.js';

export interface ExplorerContextMenuProps {
  readonly node: ExplorerNode;
  readonly children: ReactNode;
  /**
   * The tree's selected rows. When `node` is one of two or more, the menu is the selection's (#681) —
   * what can be done to all of them at once — rather than the row's own.
   */
  readonly selection?: readonly ExplorerNode[];
  /** Told when the menu opens and closes, so the row can mark itself as the menu's target (#680). */
  readonly onOpenChange?: (open: boolean) => void;
  /** Runs right before any item's action: the row selects itself, so the action's target is the selected row. */
  readonly onAction?: () => void;
}

/**
 * The right-click menu for one explorer node, as data: which items a node of this kind offers,
 * in order. Pure and store-free, so the menu for every kind is unit-testable without mounting
 * Radix. Every item delegates to {@link explorerActions} or {@link projectRowActions} — the
 * same handlers the `explorer.*` / `workspace.*` palette commands run.
 */
export function explorerMenuGroups(node: ExplorerNode): readonly ExplorerMenuGroup[] {
  return withScriptsGroup(node, menuGroupsOf(node));
}

/**
 * **Switch on scripts…** (#63) on an interface, API or folder with requests beneath it whose
 * scripts are off, and **Convert scripts…** on one with imported scripts at or below it, after the
 * node's own first group.
 */
function withScriptsGroup(node: ExplorerNode, menu: readonly ExplorerMenuGroup[]): readonly ExplorerMenuGroup[] {
  const off = node.scriptsOff;
  const owner = (node.scriptsLayered?.length ?? 0) > 0 ? levelIdOf(node) : undefined;
  const items: ExplorerMenuItem[] = [
    ...(off !== undefined && off.length > 0
      ? [{ key: 'enable-scripts', label: 'Switch on scripts…', run: () => explorerActions.enableScripts(off) }]
      : []),
    ...(owner !== undefined
      ? [{ key: 'convert-scripts', label: 'Convert scripts…', run: () => explorerActions.convertScripts(owner) }]
      : []),
  ];
  if (items.length === 0) {
    return menu;
  }
  return [...menu.slice(0, 1), items, ...menu.slice(1)];
}

/** **Run…**: opens the Runner tab for `targetId` (#336). */
function runItem(targetId: string, label: string): ExplorerMenuItem {
  return { key: 'runner', label: 'Run…', run: () => openRunnerTab(targetId, label) };
}

/**
 * **Schedule…**: a new server schedule that runs this row (#517). Only a workspace admin of a server that
 * runs schedules is offered it; a linked project lives off the server, so none of its rows are.
 */
function scheduleItems(entityId: string, linked = false): readonly ExplorerMenuItem[] {
  if (linked || !canManageSchedules()) return [];
  return [{ key: 'schedule', label: 'Schedule…', run: () => void schedulesActions.scheduleEntity(entityId) }];
}

/** The kinds whose folders carry scripts (#334). */
const SCRIPTED_FOLDER_KINDS: ReadonlySet<string> = new Set(['rest', 'grpc']);

/**
 * What a project's New submenu creates (#686 E18). Every one is named "New … " with an ellipsis,
 * since each asks for more (a name typed inline, or a dialog), and a REST API is "New REST API…"
 * here as on the Start page, beside its gRPC, WebSocket and MCP siblings.
 */
export function projectCreators(projectId: string): ExplorerMenuItem[] {
  return [
    { key: 'new-api', label: 'New REST API…', run: () => explorerActions.newApi(projectId) },
    { key: 'new-grpc-api', label: 'New gRPC API…', run: () => explorerActions.newGrpcApi(projectId) },
    { key: 'new-ws-api', label: 'New WebSocket API…', run: () => explorerActions.newWsApi(projectId) },
    { key: 'new-mcp-server', label: 'New MCP server…', run: () => explorerActions.newMcpServer(projectId) },
    { key: 'new-webhook', label: 'New Webhook…', run: () => explorerActions.newWebhook(projectId) },
    { key: 'new-sequence', label: 'New Sequence…', run: () => explorerActions.newSequence(projectId) },
  ];
}

function menuGroupsOf(node: ExplorerNode): readonly ExplorerMenuGroup[] {
  // A node a protocol kind owns gets that kind's menu, and Run… when the kind names it a Runner target.
  const role = explorerRole(node.kind);
  if (role !== undefined) {
    const menu = role.menu?.(node) ?? [];
    const target = role.runTarget?.(node);
    return target === undefined
      ? menu
      : [...menu.slice(0, 1), [runItem(target, node.label), ...scheduleItems(target)], ...menu.slice(1)];
  }

  if (node.kind === 'project' && node.projectId !== undefined) {
    const projectId = node.projectId;
    return groups(
      [
        { key: 'import', label: 'Import…', run: () => projectRowActions.importInto(projectId) },
        // §3.1 puts the creators on the project row: an API is created in a project, and this is the
        // only row that names one. They sit under one New submenu, so the menu stays short (#686 E18).
        {
          key: 'new',
          label: 'New',
          run: () => undefined,
          children: projectCreators(projectId),
        },
      ],
      [runItem(projectId, node.label), ...scheduleItems(projectId, node.linked === true)],
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
        // The folder in the machine's file manager, and a copy written to a folder picked in a dialog.
        ...(hasCapability('files')
          ? [{ key: 'reveal', label: REVEAL_LABEL, run: () => projectRowActions.reveal(projectId) }]
          : []),
        ...(hasCapability('dialogs')
          ? [{ key: 'export', label: 'Export project…', run: () => projectRowActions.export(projectId) }]
          : []),
        ...exportItems({ projectId }),
      ],
      [
        {
          key: 'move-to-workspace',
          label: 'Move to workspace…',
          run: () => projectRowActions.moveToWorkspace(projectId),
        },
      ],
      [
        { key: 'rename', label: 'Rename', run: () => projectRowActions.rename(projectId) },
        { key: 'remove', label: 'Remove from workspace', run: () => projectRowActions.remove(projectId) },
      ],
    );
  }

  // A placeholder's only item says why it cannot be opened or changed; choosing it does nothing.
  if (node.kind === 'placeholder' && node.message !== undefined) {
    return groups([{ key: 'placeholder', label: node.message, run: () => undefined }]);
  }

  if (node.kind === 'project-missing' && node.projectId !== undefined) {
    const projectId = node.projectId;
    return groups(
      hasCapability('files')
        ? [{ key: 'locate', label: 'Locate…', run: () => projectRowActions.locate(projectId) }]
        : [],
      [{ key: 'remove', label: 'Remove from workspace', run: () => projectRowActions.remove(projectId) }],
    );
  }

  if (node.kind === 'folder' && node.apiId !== undefined && node.folderId !== undefined) {
    const { apiId, folderId } = { apiId: node.apiId, folderId: node.folderId };
    // The folder's kind makes its requests; a cURL line describes an HTTP request, which only a
    // kind that offers `importCurlIn` can hold.
    const owner = kindExplorer(node.ownerKind ?? 'rest');
    const newRequestIn = owner?.newRequestIn;
    const importCurlIn = owner?.importCurlIn;
    return groups(
      [
        { key: 'new-folder', label: 'New folder', run: () => explorerActions.newFolder(apiId, folderId) },
        ...(newRequestIn === undefined
          ? []
          : [{ key: 'new-request', label: 'New request', run: () => newRequestIn(apiId, folderId) }]),
        ...(importCurlIn === undefined
          ? []
          : [{ key: 'import-curl', label: 'Import cURL…', run: () => importCurlIn(apiId, folderId) }]),
      ],
      [runItem(folderId, node.label)],
      [
        { key: 'rename', label: 'Rename…', run: () => explorerActions.renameNode('folder', folderId) },
        // Both open the folder's page on their tab.
        { key: 'auth', label: 'Auth…', run: () => openFolderTab(folderId, 'auth') },
        // Scripts run around a REST or gRPC request (#334); a WebSocket folder has none.
        ...(SCRIPTED_FOLDER_KINDS.has(node.ownerKind ?? 'rest')
          ? [{ key: 'scripts', label: 'Scripts…', run: () => openFolderTab(folderId, 'scripts') }]
          : []),
      ],
      [{ key: 'delete', label: 'Delete', run: () => explorerActions.removeFolder(folderId) }],
    );
  }

  // openapi-webhooks-import §3.1. Rename/delete/duplicate/auth reuse the REST actions verbatim:
  // a webhook folder/request is a REST folder/request on the wire, so the same ids resolve in
  // the same stores.
  if (node.kind === 'webhook-collection' && node.projectId !== undefined) {
    const projectId = node.projectId;
    return groups(
      [
        { key: 'new-webhook', label: 'New Webhook…', run: () => explorerActions.newWebhook(projectId) },
        { key: 'new-folder', label: 'New Folder', run: () => explorerActions.newWebhookFolder(projectId) },
      ],
      [{ key: 'settings', label: 'Settings…', run: () => explorerActions.openWebhookSettings(projectId) }],
    );
  }

  if (node.kind === 'webhook-folder' && node.projectId !== undefined && node.folderId !== undefined) {
    const projectId = node.projectId;
    const folderId = node.folderId;
    return groups(
      [
        { key: 'new-webhook', label: 'New Webhook…', run: () => explorerActions.newWebhook(projectId, folderId) },
        { key: 'new-folder', label: 'New Folder', run: () => explorerActions.newWebhookFolder(projectId, folderId) },
      ],
      [
        { key: 'settings', label: 'Settings…', run: () => explorerActions.openWebhookSettings(projectId, folderId) },
        { key: 'rename', label: 'Rename…', run: () => explorerActions.renameNode('webhook-folder', folderId) },
        { key: 'auth', label: 'Auth…', run: () => explorerActions.editFolderAuth(folderId) },
      ],
      [{ key: 'delete', label: 'Delete', run: () => explorerActions.removeFolder(folderId) }],
    );
  }

  if (node.kind === 'webhook-request' && node.requestId !== undefined) {
    const requestId = node.requestId;
    return groups(
      [
        { key: 'duplicate', label: 'Duplicate', run: () => explorerActions.duplicateRestRequest(requestId) },
        { key: 'rename', label: 'Rename…', run: () => explorerActions.renameNode('webhook-request', requestId) },
      ],
      [{ key: 'delete', label: 'Delete', run: () => explorerActions.deleteRestRequest(requestId) }],
    );
  }

  if (node.kind === 'sequences' && node.projectId !== undefined) {
    const projectId = node.projectId;
    return groups([{ key: 'new-sequence', label: 'New Sequence…', run: () => explorerActions.newSequence(projectId) }]);
  }

  if ((node.kind === 'values' || node.kind === 'value') && node.projectId !== undefined) {
    const projectId = node.projectId;
    return groups([{ key: 'clear-values', label: 'Clear values', run: () => explorerActions.clearValues(projectId) }]);
  }

  if (node.kind === 'mock' && node.mockId !== undefined) {
    const mockId = node.mockId;
    const running = useMockRunsStore.getState().states[mockId]?.running === true;
    return groups(
      [
        { key: 'open', label: 'Open', run: () => explorerActions.openMock(mockId) },
        { key: 'toggle', label: running ? 'Stop' : 'Start', run: () => explorerActions.toggleMock(mockId) },
        { key: 'duplicate', label: 'Duplicate', run: () => explorerActions.duplicateMock(mockId) },
      ],
      [{ key: 'rename', label: 'Rename…', run: () => explorerActions.renameNode('mock', mockId) }],
      [{ key: 'delete', label: 'Delete', run: () => explorerActions.removeMock(mockId) }],
    );
  }

  if (node.kind === 'sequence' && node.sequenceId !== undefined) {
    const sequenceId = node.sequenceId;
    return groups(
      [
        { key: 'open', label: 'Open', run: () => explorerActions.openSequence(sequenceId) },
        { key: 'run', label: 'Run', run: () => explorerActions.runSequence(sequenceId) },
        runItem(sequenceId, node.label),
        ...scheduleItems(sequenceId),
        { key: 'duplicate', label: 'Duplicate', run: () => explorerActions.duplicateSequence(sequenceId) },
      ],
      [{ key: 'rename', label: 'Rename…', run: () => explorerActions.renameNode('sequence', sequenceId) }],
      [{ key: 'delete', label: 'Delete', run: () => explorerActions.removeSequence(sequenceId) }],
    );
  }

  // webhook-capture §4.2: a viewer sees what it may run and nothing else.
  if (node.kind === 'webhooks') {
    return groups(
      node.canEdit === true
        ? [{ key: 'new-catch-url', label: 'New catch URL…', run: () => webhooksActions.newCatchUrl() }]
        : [],
    );
  }

  if (node.kind === 'catch-url' && node.hookId !== undefined) {
    const hookId = node.hookId;
    const editor = node.canEdit === true;
    return groups(
      [
        { key: 'copy-url', label: 'Copy URL', run: () => void webhooksActions.copyUrl(hookId) },
        { key: 'settings', label: 'Settings…', run: () => webhooksActions.openSettings(hookId) },
      ],
      editor
        ? [
            { key: 'rotate', label: 'Rotate URL…', run: () => webhooksActions.confirm('rotate', hookId) },
            { key: 'clear', label: 'Clear captures', run: () => webhooksActions.confirm('clear', hookId) },
          ]
        : [],
      editor ? [{ key: 'delete', label: 'Delete', run: () => webhooksActions.confirm('delete', hookId) }] : [],
    );
  }

  // #517: everyone reads schedules; a workspace admin changes them.
  if (node.kind === 'schedules') {
    return groups(
      node.canEdit === true
        ? [{ key: 'new-schedule', label: 'New schedule…', run: () => schedulesActions.newSchedule() }]
        : [],
    );
  }

  if (node.kind === 'schedule' && node.scheduleId !== undefined) {
    const scheduleId = node.scheduleId;
    const admin = node.canEdit === true;
    const paused = node.scheduleState === 'paused';
    return groups(
      [{ key: 'open', label: 'Open', run: () => openScheduleTab(scheduleId) }],
      admin
        ? [
            { key: 'run-now', label: 'Run now', run: () => void schedulesActions.runNow(scheduleId) },
            {
              key: 'toggle',
              label: paused ? 'Resume' : 'Pause',
              run: () => void schedulesActions.setEnabled(scheduleId, paused),
            },
            { key: 'edit', label: 'Edit…', run: () => schedulesActions.edit(scheduleId) },
            { key: 'secrets', label: 'Secrets…', run: () => schedulesActions.secrets(scheduleId) },
          ]
        : [],
      admin ? [{ key: 'delete', label: 'Delete', run: () => schedulesActions.confirmDelete(scheduleId) }] : [],
    );
  }

  return [];
}

/** Every item the menu offers, in order, with the grouping flattened away. */
export function explorerMenuItems(node: ExplorerNode): readonly ExplorerMenuItem[] {
  return explorerMenuGroups(node).flat();
}

/**
 * The right-click menu for a selection of several rows (#681): **Move to…** when they are REST requests of
 * one API, **Duplicate** when every row is a request, a sequence or a mock, and **Delete N requests…** (or
 * **items…**, when folders or APIs are among them) for the rows the explorer's confirm can delete. A row
 * with no item in common with the others — a project, an interface — is left to its own menu.
 */
export function explorerMultiMenuGroups(nodes: readonly ExplorerNode[]): readonly ExplorerMenuGroup[] {
  const restIds = nodes.flatMap((node) =>
    node.kind === 'rest-request' && node.requestId !== undefined ? [node.requestId] : [],
  );
  const oneApi = restIds.length === nodes.length && new Set(nodes.map((node) => node.apiId)).size === 1;
  const duplicable = nodes.every((node) => DUPLICABLE_KINDS.has(node.kind));
  const deletable = nodes.filter((node) => pendingDeletionOf(node) !== undefined);
  const requests = deletable.every((node) => REQUEST_ROW_KINDS.has(node.kind));
  return groups(
    [
      ...(oneApi ? [{ key: 'move', label: 'Move to…', run: () => useMoveRequestStore.getState().open(restIds) }] : []),
      ...(duplicable ? [{ key: 'duplicate', label: 'Duplicate', run: () => duplicateExplorerNodes(nodes) }] : []),
    ],
    deletable.length > 0
      ? [
          {
            key: 'delete',
            label: `Delete ${String(deletable.length)} ${requests ? 'requests' : 'items'}…`,
            run: () => deleteExplorerNodes(deletable),
          },
        ]
      : [],
  );
}

/**
 * The items that leave a row in inline rename: Rename… itself, and the creators whose new row starts in it. The
 * menu must not hand focus back to the row it was opened on after one of these, or the rename field would lose
 * focus at once and commit the name unchanged.
 */
const RENAMING_ITEMS: ReadonlySet<string> = new Set([
  'rename',
  'new-folder',
  'new-request',
  'new-graphql-request',
  'new-grpc-api',
  'new-ws-api',
  'new-sequence',
  'new-webhook',
]);

/** The right-click menu for one explorer node; the items shown depend on `node.kind`. */
export function ExplorerContextMenu({ node, children, selection, onOpenChange, onAction }: ExplorerContextMenuProps) {
  const multi = selection !== undefined && selection.length > 1 && selection.some((other) => other.id === node.id);
  const menuGroups = multi ? explorerMultiMenuGroups(selection) : explorerMenuGroups(node);

  const isRenamingRef = useRef(false);

  if (menuGroups.length === 0) {
    return <>{children}</>;
  }

  const run = (item: ExplorerMenuItem): void => {
    onAction?.();
    item.run();
  };

  return (
    <ContextMenu.Root {...(onOpenChange === undefined ? {} : { onOpenChange })}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="z-dropdown min-w-40 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
          // Portalled, yet React bubbles its clicks through the component tree to the tree's row
          // wrapper, which would select and open the row over the tab an item just opened.
          onClick={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            if (isRenamingRef.current) {
              event.preventDefault();
              isRenamingRef.current = false;
            }
          }}
        >
          {menuGroups.map((group, index) => (
            <Fragment key={group[0]?.key ?? index}>
              {index > 0 && <ContextMenu.Separator className="my-1 h-px bg-hairline" />}
              {group.map((item) =>
                item.children !== undefined ? (
                  <ContextMenu.Sub key={item.key}>
                    <ContextMenu.SubTrigger className={`${ITEM_CLASS} justify-between gap-4`}>
                      {item.label}
                      <span aria-hidden="true" className="text-fg-faint">
                        ›
                      </span>
                    </ContextMenu.SubTrigger>
                    <ContextMenu.Portal>
                      <ContextMenu.SubContent
                        className="z-dropdown min-w-40 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {item.children.map((child) => (
                          <ContextMenu.Item key={child.key} className={ITEM_CLASS} onSelect={() => run(child)}>
                            {child.label}
                          </ContextMenu.Item>
                        ))}
                      </ContextMenu.SubContent>
                    </ContextMenu.Portal>
                  </ContextMenu.Sub>
                ) : (
                  <ContextMenu.Item
                    key={item.key}
                    className={ITEM_CLASS}
                    onSelect={() => {
                      if (RENAMING_ITEMS.has(item.key)) {
                        isRenamingRef.current = true;
                      }
                      run(item);
                    }}
                  >
                    {item.label}
                  </ContextMenu.Item>
                ),
              )}
            </Fragment>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
