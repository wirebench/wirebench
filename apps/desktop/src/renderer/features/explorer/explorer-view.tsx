import { useEffect, useRef, useState } from 'react';
import type { NodeApi, NodeRendererProps } from 'react-arborist';
import { forwardRef } from 'react';
import { ListOuterElement, Tree } from 'react-arborist';
import {
  Box,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  FileDown,
  Folder,
  FolderPlus,
  FoldVertical,
  Forward,
  ListOrdered,
  Server,
  Inbox,
  Link,
  Link2,
  Loader2,
  UnfoldVertical,
  Webhook,
} from 'lucide-react';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { useMockRunsStore } from '../../state/mock-runs.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { IconButton } from '../../components/icon-button.js';
import { useConflictTargets } from '../sync/use-conflict-targets.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { MethodBadge } from '../rest-api/method-badge.js';
import { requestDisplayName } from '../rest-api/request-display-name.js';
import { EXPLORER_DIALOGS, explorerDeletion, explorerRole } from '../../kinds/index.js';
import { previewing, useEditorsStore } from '../../state/editors.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { kindLabel } from '../../kinds/placeholders.js';
import { ExplorerContextMenu } from './context-menu.js';
import { workspaceActions } from '../workspace/workspace-actions.js';
import { explorerActions } from './explorer-actions.js';
import { openProjectTab, projectRowActions } from './project-actions.js';
import { openFolderTab } from '../folder/folder-actions.js';
import { isContainerRow, isDropDisabled, planContainerDrop, planMoves } from './drag-drop.js';
import { dropApiOnProject } from './move-api-dialog.js';
import { getExplorerTree, registerExplorerTree, revealNode } from './explorer-api.js';
import {
  activeTabTreeNodeId,
  deleteExplorerNodes,
  expandExplorerAll,
  REQUEST_ROW_KINDS,
  runNodeDeletion,
} from './explorer-tree-actions.js';
import type { ExplorerNode, ExplorerProject, ExplorerSchedules, ExplorerWebhooks } from './tree-nodes.js';
import { buildExplorerTree, nodeProjectId, schedulesNode } from './tree-nodes.js';
import { openCatchUrlTab } from '../webhooks/webhooks-actions.js';
import { useSyncStore } from '../../state/sync.js';
import { useWebhooksStore } from '../../state/webhooks.js';
import { scheduleStateOf, schedulesShown, useSchedulesStore } from '../../state/schedules.js';
import { describeCron, STATE_DOT, STATE_LABEL } from '../schedules/schedule-format.js';
import { openScheduleTab } from '../schedules/schedules-actions.js';
import { useScriptValuesStore } from '../../state/script-values.js';
import { ConvertScriptsDialog } from '../scripts/convert-scripts-dialog.js';
import { EnableScriptsDialog } from '../scripts/enable-scripts-dialog.js';

/** Measures a container's box size with `ResizeObserver` so the virtualized tree can fill it. */
function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (el === null) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) {
        const { width, height } = entry.contentRect;
        setSize({ width, height });
      }
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  return [ref, size];
}

const NODE_ICON: Partial<Record<ExplorerNode['kind'], React.ComponentType<{ size: number }>>> = {
  project: Box,
  folder: Folder,
  'webhook-collection': Forward,
  'webhook-folder': Folder,
  'webhook-request': Forward,
  webhooks: Webhook,
  'catch-url': Inbox,
  schedules: CalendarClock,
  sequences: Folder,
  sequence: ListOrdered,
  mocks: Folder,
  mock: Server,
  values: Folder,
};

/**
 * react-arborist's scroll container, made focusable.
 *
 * The virtualised list is what actually scrolls, and a scrollable region nothing inside it can
 * focus is unreachable by keyboard alone (axe `scrollable-region-focusable`); the rows carry
 * `tabindex=-1`, so the container needs the tab stop. It is a `group` rather than
 * `presentation`: a presentational role is ignored on a focusable element, which would leave a
 * focusable generic sitting between the `tree` and its `treeitem`s, and `group` is a child the
 * `tree` role is allowed to own.
 */
const FocusableListOuter = forwardRef<HTMLDivElement, React.ComponentProps<typeof ListOuterElement>>(
  function FocusableListOuter(props, ref) {
    return (
      <ListOuterElement
        ref={ref}
        {...props}
        data-testid="explorer-tree-scroll"
        role="group"
        tabIndex={0}
        // Backspace, plain or with Mod (⌘⌫ on macOS), deletes the selection the way the Delete key does (#681):
        // through one confirm for several rows. Handled here, below the tree's own container, so its one-row-at-
        // a-time Backspace never runs as well; the window's keybindings see none of it either, which keeps the
        // `explorer.delete` command's own Delete key the only one they dispatch.
        onKeyDown={(event) => {
          if (event.key !== 'Backspace' || event.altKey || event.shiftKey) return;
          const target = event.target;
          if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]') !== null)
            return;
          const tree = getExplorerTree();
          if (tree === null || tree.selectedIds.size === 0) return;
          event.preventDefault();
          event.stopPropagation();
          deleteExplorerNodes(tree.selectedNodes.map((node) => node.data));
        }}
      />
    );
  },
);

/** Rows whose testid the names block fixes; everything else is a plain `explorer-tree-row`. */
const ROW_TESTID: Partial<Record<ExplorerNode['kind'], string>> = {
  project: 'explorer-project-row',
  'project-missing': 'explorer-project-missing',
  placeholder: 'explorer-placeholder-row',
  folder: 'folder-row',
  'webhook-collection': 'webhook-collection-row',
  'webhook-folder': 'webhook-folder-row',
  'webhook-request': 'webhook-request-row',
  webhooks: 'webhooks-row',
  'catch-url': 'catch-url-row',
  schedules: 'schedules-row',
  schedule: 'schedule-row',
  sequences: 'sequences-group-row',
  sequence: 'sequence-row',
  mocks: 'mocks-group-row',
  mock: 'mock-row',
  values: 'values-group-row',
  value: 'value-row',
};

const INLINE_BUTTON_CLASS =
  'shrink-0 rounded px-1.5 py-0.5 text-xs text-fg-default ring-1 ring-hairline-strong hover:bg-surface-base';

/**
 * The gap between the sidebar's edge and a row's chevron.
 *
 * It has to ride on the inline style rather than a `pl-*` class: react-arborist hands every row
 * `style.paddingLeft` (its per-level indent), and an inline padding beats any class we set — a
 * class here is silently dropped, and at the root level, where the indent is 0, it looks like no
 * padding was ever asked for.
 */
const ROW_PADDING_LEFT = 6;

/** A row's height, and the two-line height of the row that says a linked project's folder is gone (#685 E17). */
const ROW_HEIGHT = 26;
const MISSING_ROW_HEIGHT = 46;

/** A mock row's marker while it runs: where it listens, as its tooltip. */
function MockRunningBadge({ mockId }: { readonly mockId: string }) {
  const state = useMockRunsStore((s) => s.states[mockId]);
  if (state?.running !== true) {
    return null;
  }
  return (
    <span
      data-testid="mock-running-badge"
      title={state.url}
      className="shrink-0 rounded-full bg-surface-base px-1.5 text-xs text-status-success"
    >
      running
    </span>
  );
}

/**
 * Runs what a single click opens as a preview tab (#679), unless Settings turned preview tabs off: the next
 * single click replaces it, and a double-click, an edit or a send keeps it.
 */
function asPreview(open: () => void): void {
  if (usePreferencesStore.getState().preferences.ui.previewTabs) previewing(open);
  else open();
}

/**
 * Set while a context-menu action selects its target row (#680): the selection is bookkeeping for the action, so
 * `onSelect` must not open the row's tab over whatever the action opens.
 */
let selectingForMenu = false;

/** Selects `node` for a menu action without opening what a click on it would. */
function selectForMenu(node: NodeApi<ExplorerNode>): void {
  if (node.isSelected) return;
  selectingForMenu = true;
  try {
    node.select();
  } finally {
    selectingForMenu = false;
  }
}

function NodeRow({ node, style, dragHandle }: NodeRendererProps<ExplorerNode>) {
  const role = explorerRole(node.data.kind);
  const Icon = role?.icon ?? NODE_ICON[node.data.kind];
  const indent = typeof style.paddingLeft === 'number' ? style.paddingLeft : 0;
  const rowStyle = { ...style, paddingLeft: indent + ROW_PADDING_LEFT };
  const label = requestDisplayName(node.data.label, node.data.method);
  // The row the context menu was opened on wears an outline while the menu is up (#680): the menu acts on
  // the row under the pointer, not on the selection, and the two can differ.
  const [menuOpen, setMenuOpen] = useState(false);
  // What a single click opens, if anything; a row with nothing to open folds instead.
  const opens =
    role?.click === 'open' ||
    // A leaf with nothing to fold opens what its kind says (an empty SOAP operation makes its first request).
    (node.isLeaf && role?.open !== undefined) ||
    node.data.kind === 'project' ||
    // A folder opens its page (General, Authentication, Scripts) and unfolds, as an API row does.
    node.data.kind === 'folder' ||
    node.data.kind === 'webhook-request' ||
    node.data.kind === 'catch-url' ||
    node.data.kind === 'schedule' ||
    node.data.kind === 'sequence' ||
    node.data.kind === 'mock';
  return (
    <ExplorerContextMenu
      node={node.data}
      // A right-click on one of several selected rows gets the selection's menu (#681).
      {...(node.isSelected && node.tree.selectedIds.size > 1
        ? { selection: node.tree.selectedNodes.map((selected) => selected.data) }
        : {})}
      onOpenChange={setMenuOpen}
      onAction={() => selectForMenu(node)}
    >
      <div
        ref={dragHandle}
        style={rowStyle}
        data-testid={role?.testId ?? ROW_TESTID[node.data.kind] ?? 'explorer-tree-row'}
        data-tree-id={node.id}
        {...(node.data.projectId !== undefined ? { 'data-project-id': node.data.projectId } : {})}
        {...(menuOpen ? { 'data-menu-open': 'true' } : {})}
        // No `role`/`aria-selected`/`tabIndex` here: react-arborist's own row wrapper is the
        // `treeitem` (with `aria-level`, `aria-selected` and `aria-expanded`), and repeating
        // them on this child would nest a second treeitem inside the real one.
        // One click does the obvious thing for the row it lands on: a row with a tab (a request, an
        // API, a project) opens it, and a row with nothing to open folds or unfolds. A row with a tab
        // never folds on a click (#680): clicking a project to read its settings must not hide the
        // requests being worked on. Its folding is the chevron's, Left/Right's and a double-click's.
        // react-arborist's default row wrapper calls `node.handleClick` (which both selects AND
        // activates) on any click that bubbles to it, so both handlers here stop propagation to keep
        // it from also firing.
        onClick={(e) => {
          e.stopPropagation();
          // The desktop's selection modifiers (#681): Shift extends the selection from its anchor to this row,
          // Ctrl/⌘ adds or removes this row. Neither opens anything.
          if (e.shiftKey) {
            if (node.tree.selectedIds.size === 0) node.select();
            else node.selectContiguous();
            return;
          }
          if (e.metaKey || e.ctrlKey) {
            if (node.isSelected) node.deselect();
            else node.selectMulti();
            return;
          }
          // Whatever the click opens — here, or the project tab from `onSelect` — opens as a preview,
          // except on a double-click's second click, which keeps what the first one opened (#679). Read
          // from the click count rather than left to `dblclick`, which the row's re-render can swallow.
          const keep = e.detail >= 2;
          (keep ? (open: () => void) => open() : asPreview)(() => {
            node.select();
            if (keep && node.data.kind === 'project' && node.data.projectId !== undefined) {
              openProjectTab(node.data.projectId);
            }
            if (opens) {
              if (node.data.kind !== 'project') node.activate();
              // The double-click's second click folds a container that opens on one click.
              if (keep && node.isInternal) node.toggle();
            } else if (node.isInternal) {
              node.toggle();
            }
          });
        }}
        // A double-click opens for good: the preview the first click opened stays (#679). The interface
        // viewer still answers to it too, as it always has, so folding an interface open costs nothing.
        onDoubleClick={(e) => {
          e.stopPropagation();
          node.activate();
        }}
        {...(node.willReceiveDrop ? { 'data-drop-target': 'true' } : {})}
        className={`flex h-full items-center pr-1 text-sm ${
          node.willReceiveDrop
            ? 'bg-accent-muted text-fg-default ring-1 ring-accent ring-inset'
            : node.isSelected
              ? 'bg-accent-muted text-fg-default'
              : 'text-fg-default hover:bg-surface-raised'
        }${menuOpen && !node.willReceiveDrop ? ' ring-1 ring-accent ring-inset' : ''}`}
      >
        {/* The chevron's width is reserved on leaves as well, so a request's name lines up with the
            folder names around it: the fold marker is what differs between those rows, not the
            column their names start in. */}
        <span
          className="flex w-2.5 shrink-0 items-center text-fg-subtle"
          data-testid="explorer-row-twisty"
          onClick={(e) => {
            if (!node.isInternal) return;
            e.stopPropagation();
            node.toggle();
          }}
        >
          {node.isInternal &&
            (node.isOpen ? (
              <ChevronDown size={11} aria-hidden="true" />
            ) : (
              <ChevronRight size={11} aria-hidden="true" />
            ))}
        </span>
        {/* One gutter of fixed width carries whatever marks the row — a kind icon or the method —
            hard against the name, so every name in the tree lines up with every other. A method
            badge fills the gutter at a fixed width, left-aligned, so GET, POST and DEL start in one
            column too. */}
        <span className="flex w-6 shrink-0 items-center justify-end overflow-hidden" data-testid="explorer-row-gutter">
          {role?.Gutter !== undefined ? (
            <role.Gutter node={node.data} />
          ) : node.data.kind === 'webhook-request' && node.data.method !== undefined ? (
            <MethodBadge method={node.data.method} title={`${node.data.method} ${label}`} compact />
          ) : node.data.kind === 'schedule' && node.data.scheduleState !== undefined ? (
            <span
              role="img"
              data-testid="schedule-dot"
              data-state={node.data.scheduleState}
              aria-label={STATE_LABEL[node.data.scheduleState]}
              title={STATE_LABEL[node.data.scheduleState]}
              className={`mr-1 h-2 w-2 rounded-full ${STATE_DOT[node.data.scheduleState]}`}
            />
          ) : (
            Icon !== undefined && <Icon size={13} />
          )}
        </span>
        {node.data.kind === 'project-missing' ? (
          <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 pl-1 leading-tight">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="shrink-0 text-status-danger">{label}</span>
              {node.data.dir !== undefined && (
                <span
                  data-testid="explorer-project-missing-path"
                  className="min-w-0 truncate text-xs text-fg-subtle"
                  title={node.data.dir}
                >
                  {node.data.dir}
                </span>
              )}
            </span>
            {node.data.projectId !== undefined && (
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className={INLINE_BUTTON_CLASS}
                  onClick={(e) => {
                    e.stopPropagation();
                    projectRowActions.locate(node.data.projectId ?? '');
                  }}
                >
                  Locate…
                </button>
                <button
                  type="button"
                  className={INLINE_BUTTON_CLASS}
                  onClick={(e) => {
                    e.stopPropagation();
                    projectRowActions.remove(node.data.projectId ?? '');
                  }}
                >
                  Remove
                </button>
              </span>
            )}
          </span>
        ) : node.isEditing ? (
          <input
            autoFocus
            data-testid="explorer-rename-input"
            defaultValue={node.data.label}
            className="ml-1 min-w-0 flex-1 rounded bg-surface-base px-1 text-sm outline-none ring-1 ring-accent"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => node.submit(e.currentTarget.value)}
            onKeyDown={(e) => {
              // Keep typing inside the rename field away from the tree's own keys, but let chords
              // (⌘⏎ send, ⌘S save…) reach the window-level keybindings.
              if (!e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation();
              if (e.key === 'Enter') node.submit(e.currentTarget.value);
              if (e.key === 'Escape') node.reset();
            }}
          />
        ) : (
          <span
            className={`min-w-0 flex-1 truncate pl-1 ${node.data.kind === 'placeholder' ? 'text-fg-faint' : ''}`}
            title={node.data.kind === 'placeholder' ? node.data.message : label}
          >
            {label}
          </span>
        )}
        {node.data.kind === 'mock' && node.data.mockId !== undefined && <MockRunningBadge mockId={node.data.mockId} />}
        {node.data.suffix !== undefined && (
          <span
            className="min-w-0 max-w-[50%] shrink truncate pl-1 text-xs text-fg-subtle"
            data-testid="explorer-row-suffix"
            title={node.data.suffix}
          >
            · {node.data.suffix}
          </span>
        )}
        {node.data.kind === 'placeholder' && node.data.placeholderKind !== undefined && (
          <span
            data-testid="explorer-placeholder-badge"
            title={node.data.message}
            className="shrink-0 rounded-full bg-surface-base px-1.5 text-xs text-fg-faint"
          >
            {kindLabel(node.data.placeholderKind)}
          </span>
        )}
        {role?.badge !== undefined && (
          <span
            data-testid="explorer-api-badge"
            className="shrink-0 rounded-full bg-surface-base px-1.5 text-xs text-fg-subtle"
          >
            {role.badge}
          </span>
        )}
        {node.data.kind === 'project' && node.data.linked === true && (
          <span
            data-testid="explorer-project-linked-badge"
            title={node.data.dir}
            className="flex shrink-0 items-center gap-0.5 rounded-full bg-surface-base px-1.5 text-xs text-fg-subtle"
          >
            <Link2 size={11} aria-hidden="true" />
            linked
          </span>
        )}
        {/* A webhook folder imported from an OpenAPI document (§3.1): a quiet cue, not the
            project-level "linked" pill above — this folder is not a linked *project*. */}
        {node.data.kind === 'webhook-folder' && node.data.linked === true && (
          <span
            data-testid="webhook-folder-imported-badge"
            title="Imported from an API definition"
            aria-label="Imported from an API definition"
            className="flex shrink-0 items-center text-fg-subtle"
          >
            <Link size={11} aria-hidden="true" />
          </span>
        )}
        {node.data.kind === 'project' && node.data.loading === true && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-fg-subtle">
            <Loader2 size={11} aria-hidden="true" className="animate-spin" />
            opening…
          </span>
        )}
        {node.data.orphaned === true && (
          <span
            data-testid="explorer-orphaned-badge"
            title="This operation is no longer in the definition"
            className="shrink-0 rounded-full bg-status-warning px-1.5 text-xs text-fg-on-accent"
          >
            orphaned
          </span>
        )}
        {node.data.conflicted === true && (
          <span
            data-testid="explorer-conflict-badge"
            title="Has unresolved sync conflicts"
            className="shrink-0 rounded-full bg-status-danger px-1.5 text-xs text-fg-on-accent"
          >
            conflict
          </span>
        )}
        {node.data.problemCount !== undefined && node.data.problemCount > 0 && (
          <span className="shrink-0 rounded-full bg-status-danger px-1.5 text-xs text-fg-on-accent">
            {node.data.problemCount}
          </span>
        )}
        {node.data.kind === 'catch-url' && node.data.enabled === false && (
          <span
            data-testid="catch-url-disabled-badge"
            title="Answers 404 to every sender"
            className="shrink-0 rounded-full bg-surface-base px-1.5 text-xs text-fg-subtle"
          >
            off
          </span>
        )}
        {node.data.kind === 'schedule' && node.data.when !== undefined && (
          <span className="min-w-0 shrink truncate text-xs text-fg-subtle">{node.data.when}</span>
        )}
        {(node.data.kind === 'schedule' || node.data.kind === 'schedules') && (node.data.failing ?? 0) > 0 && (
          <span
            data-testid="schedule-failing"
            title={node.data.kind === 'schedule' ? 'Failing runs in a row' : 'Schedules failing now'}
            className="shrink-0 rounded-full bg-status-danger px-1.5 text-xs text-fg-on-accent"
          >
            {String(node.data.failing)}
          </span>
        )}
        {node.data.kind === 'catch-url' && (node.data.unseen ?? 0) > 0 && (
          <span
            data-testid="catch-url-unseen"
            title="Captures not seen on this device"
            className="shrink-0 rounded-full bg-accent px-1.5 text-xs text-fg-on-accent"
          >
            {`${String(node.data.unseen)}${node.data.unseenMore === true ? '+' : ''}`}
          </span>
        )}
      </div>
    </ExplorerContextMenu>
  );
}

/**
 * The Explorer sidebar view: an empty state offering both ways into a first project, or one
 * root per project in the open workspace with its interfaces/endpoints/operations/requests
 * beneath it.
 */
export function ExplorerView() {
  const interfaces = useProjectStore((state) => state.interfaces);
  const order = useProjectStore((state) => state.order);
  const requests = useProjectStore((state) => state.requests);
  const rest = useProjectStore((state) => state.rest);
  const webhookCollections = useProjectStore((state) => state.webhooks);
  const grpc = useProjectStore((state) => state.grpc);
  const ws = useProjectStore((state) => state.ws);
  const mcp = useProjectStore((state) => state.mcp);
  const sequenceLists = useProjectStore((state) => state.sequenceLists);
  const mockLists = useProjectStore((state) => state.mockLists);
  const scriptValues = useScriptValuesStore((state) => state.byProject);
  const removeInterface = useProjectStore((state) => state.removeInterface);
  const removeRequest = useProjectStore((state) => state.removeRequest);
  const setSelection = useUiStore((state) => state.setSelection);
  const projects = useProjectStore((state) => state.projects);
  const workspaceProjects = useWorkspaceStore((state) => state.workspace?.projects);
  const workspaceId = useWorkspaceStore((state) => state.workspace?.id);
  const shared = useWorkspaceStore((state) => state.workspace?.share !== undefined);
  const setExplorerOpen = useUiStore((state) => state.setExplorerOpen);
  const openImportDialog = useUiStore((state) => state.openImportDialog);
  const confirmRemoveInterfaceId = useUiStore((state) => state.confirmRemoveInterfaceId);
  const confirmDeleteRequestId = useUiStore((state) => state.confirmDeleteRequestId);
  const confirmDeleteNode = useUiStore((state) => state.confirmDeleteNode);
  const confirmDeleteNodes = useUiStore((state) => state.confirmDeleteNodes);
  const requestDeleteNode = useUiStore((state) => state.requestDeleteNode);
  const requestDeleteNodes = useUiStore((state) => state.requestDeleteNodes);
  const requestRemoveInterface = useUiStore((state) => state.requestRemoveInterface);
  const requestDeleteRequest = useUiStore((state) => state.requestDeleteRequest);
  const role = useSyncStore((state) => state.status.role);
  const hooksMeta = useWebhooksStore((state) => state.meta);
  const catchUrls = useWebhooksStore((state) => state.hooks);
  const unseen = useWebhooksStore((state) => state.unseen);
  const schedulesAvailable = useSchedulesStore((state) => state.available);
  const schedulesError = useSchedulesStore((state) => state.error);
  const scheduleList = useSchedulesStore((state) => state.schedules);

  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const [treeRef, setTreeRef] = useState<import('react-arborist').TreeApi<ExplorerNode> | null | undefined>(undefined);

  // One root per project in the open workspace, in the manifest's order. The *name* comes from
  // the project mirror when it holds one: a rename reaches it (`project.changed`) before the
  // workspace snapshot catches up, and the row must not lag a rename the user just typed.
  const roots: readonly ExplorerProject[] = (workspaceProjects ?? []).map((project) => ({
    id: project.id,
    name: projects[project.id]?.name ?? project.name,
    source: project.source,
    dir: project.dir,
    status: project.status,
    ...(project.message !== undefined ? { message: project.message } : {}),
  }));
  const conflicted = useConflictTargets();
  // webhook-capture §4.2: the Webhooks root, when the workspace's server offers catch URLs.
  const webhooks: ExplorerWebhooks | undefined =
    hooksMeta?.enabled === true
      ? {
          canEdit: role === 'editor' || role === 'admin',
          hooks: catchUrls.map((hook) => ({
            id: hook.id,
            name: hook.name,
            enabled: hook.enabled,
            unseen: unseen[hook.id] ?? { count: 0, more: false },
          })),
        }
      : undefined;
  // #517: the Schedules root, when the workspace's server runs schedules; every role sees it.
  const schedules: ExplorerSchedules | undefined = schedulesShown({
    available: schedulesAvailable,
    error: schedulesError,
  })
    ? {
        canEdit: role === 'admin',
        schedules: scheduleList.map((schedule) => ({
          id: schedule.id,
          name: schedule.name,
          state: scheduleStateOf(schedule),
          failureStreak: schedule.failureStreak,
          when: describeCron(schedule.cron),
        })),
      }
    : undefined;
  const tree = buildExplorerTree(
    roots,
    order,
    interfaces,
    Object.values(requests),
    rest,
    conflicted,
    grpc,
    ws,
    sequenceLists,
    webhooks,
    webhookCollections,
    scriptValues,
    mockLists,
    Object.fromEntries(Object.entries(projects).map(([id, project]) => [id, project.unsupported ?? []])),
    mcp,
  );
  const data = schedules === undefined ? tree : [...tree, schedulesNode(schedules)];

  useEffect(() => {
    registerExplorerTree(treeRef ?? null);
    return () => registerExplorerTree(null);
  }, [treeRef]);

  // The tree follows the active tab: its row is unfolded to, selected and scrolled into view, while focus
  // stays in the editor.
  const activeTabId = useEditorsStore((state) => state.activeId);
  useEffect(() => {
    if (treeRef === null || treeRef === undefined) return;
    const nodeId = activeTabTreeNodeId();
    if (nodeId !== undefined) revealNode(nodeId);
    // `activeTabId` is what the effect follows; the resolver reads the same store.
  }, [treeRef, activeTabId]);

  // What the user last folded open or shut in this workspace. Read once per tree mount — the tree
  // owns the live state and reports every change back through `onToggle`.
  const storedOpen = (): Readonly<Record<string, boolean>> =>
    (workspaceId === undefined ? undefined : useUiStore.getState().workspaces[workspaceId]?.explorerOpen) ?? {};

  // Everything below a project starts folded shut (so a freshly imported interface arrives
  // collapsed), but a project root starts open unless the user shut it. A root that appears after
  // the tree mounted — a new project, an import into a new one — is not in the tree's initial
  // state, so it is unfolded here.
  const rootIds = data.map((root) => root.id).join('\n');
  useEffect(() => {
    if (treeRef === null || treeRef === undefined) {
      return;
    }
    const stored = storedOpen();
    for (const id of rootIds.split('\n')) {
      if (id !== '' && stored[id] === undefined && !treeRef.isOpen(id)) {
        treeRef.open(id);
      }
    }
    // `storedOpen` reads the store directly; it is deliberately not a dependency.
  }, [treeRef, rootIds]);

  const requestPendingDeletion = confirmDeleteRequestId !== undefined ? requests[confirmDeleteRequestId] : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-end gap-1 border-b border-hairline px-2">
        <IconButton
          data-testid="explorer-new-project"
          label="New Project…"
          onClick={() => {
            workspaceActions.newProject();
          }}
        >
          <FolderPlus size={14} aria-hidden="true" />
        </IconButton>
        <IconButton label="Import…" onClick={() => openImportDialog()}>
          <FileDown size={14} aria-hidden="true" />
        </IconButton>
        <IconButton
          data-testid="explorer-link-project"
          label={
            shared
              ? 'Shared workspaces hold their projects inside the workspace; use Move to workspace…'
              : 'Link Project Folder…'
          }
          disabled={shared}
          onClick={() => {
            void workspaceActions.linkProject();
          }}
        >
          <Link2 size={14} aria-hidden="true" />
        </IconButton>
        <IconButton label="Expand all" onClick={() => expandExplorerAll()}>
          <UnfoldVertical size={14} aria-hidden="true" />
        </IconButton>
        <IconButton label="Collapse all" onClick={() => treeRef?.closeAll()}>
          <FoldVertical size={14} aria-hidden="true" />
        </IconButton>
        {/* No Refresh button (#685 E13): the folder watcher reports a project changed on disk, and its banner
            offers Reload; a button that re-read every project would discard unsaved edits for nothing. */}
      </div>

      <div ref={containerRef} className="min-h-0 flex-1">
        {data.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-md text-fg-muted">No projects yet</p>
            <p className="text-sm text-fg-subtle">
              Create a project, or import an API or service definition into a new one.
            </p>
            <div className="mt-1 flex gap-2">
              <Button
                onClick={() => {
                  workspaceActions.newProject();
                }}
              >
                New project
              </Button>
              <Button variant="primary" onClick={() => openImportDialog()}>
                Import…
              </Button>
            </div>
          </div>
        ) : (
          size.height > 0 && (
            <Tree<ExplorerNode>
              // Remounted per workspace, so each one starts from its own remembered fold state.
              key={workspaceId}
              ref={setTreeRef}
              data={data}
              width={size.width}
              height={size.height}
              // A missing linked project's row takes two lines (#685 E17); every other row one.
              rowHeight={(node) => (node.data.kind === 'project-missing' ? MISSING_ROW_HEIGHT : ROW_HEIGHT)}
              // Half react-arborist's 24px default: enough that a subfolder reads as sitting inside
              // its folder at a glance, without the four levels of this tree — project › API ›
              // folder › request — marching a request off to the right.
              indent={12}
              outerElementType={FocusableListOuter}
              // The tree never scrolls sideways: react-arborist lets a row grow to its content
              // (`min-width: max-content`), which at a narrow sidebar pushed a long name such as
              // "DELETE /pets/{id}" past the edge behind a horizontal scrollbar. Held to the
              // tree's width, a row's name truncates with an ellipsis and its title says it in full.
              className="overflow-x-hidden!"
              rowClassName="min-w-0!"
              openByDefault={false}
              initialOpenState={{ ...Object.fromEntries(data.map((root) => [root.id, true])), ...storedOpen() }}
              onToggle={(id) => {
                const tree = getExplorerTree();
                if (workspaceId !== undefined && tree !== null) {
                  setExplorerOpen(workspaceId, id, tree.isOpen(id));
                }
              }}
              disableEdit={(node) =>
                explorerRole(node.kind)?.rename === undefined &&
                node.kind !== 'project' &&
                node.kind !== 'folder' &&
                node.kind !== 'sequence' &&
                node.kind !== 'mock'
              }
              disableDrag={(node) =>
                explorerRole(node.kind)?.movable !== true &&
                explorerRole(node.kind)?.container !== true &&
                node.kind !== 'folder' &&
                node.kind !== 'webhook-request' &&
                node.kind !== 'webhook-folder'
              }
              // Reordering and moving happen inside the same API: a request or folder belongs to its
              // own API definition, and cannot move into another API or project. A webhook item or
              // folder likewise stays inside its own project's webhook collection. An API row moves
              // among its project's containers, or onto another project's row (#701).
              disableDrop={({ parentNode, dragNodes, index }) => {
                const ancestors: ExplorerNode[] = [];
                for (let node = parentNode?.parent ?? null; node !== null; node = node.parent) {
                  if (node.data !== undefined) ancestors.push(node.data);
                }
                return isDropDisabled({
                  parent: parentNode?.data,
                  children: (parentNode?.children ?? []).map((child) => child.data),
                  dragged: dragNodes[0]?.data,
                  index,
                  sameProject: sameProject(parentNode?.data, dragNodes[0]?.data),
                  ancestors,
                });
              }}
              onMove={async ({ dragNodes, parentNode, index }) => {
                const parent = parentNode?.data;
                const first = dragNodes[0]?.data;
                if (first !== undefined && isContainerRow(first)) {
                  if (parent?.kind !== 'project') return;
                  const drop = planContainerDrop(
                    parent,
                    (parentNode?.children ?? []).map((child) => child.data),
                    first,
                    index,
                  );
                  if (drop === undefined) return;
                  if (sameProject(parent, first)) {
                    await useProjectStore
                      .getState()
                      .reorderApi(drop.apiId, drop.beforeApiId)
                      .catch((error: unknown) =>
                        showToast(error instanceof Error ? error.message : 'Could not move it'),
                      );
                  } else {
                    await dropApiOnProject(drop.apiId, drop.targetProjectId, drop.beforeApiId);
                  }
                  return;
                }
                if (
                  parent === undefined ||
                  (explorerRole(parent.kind)?.dropTarget !== true &&
                    parent.kind !== 'folder' &&
                    parent.kind !== 'webhook-collection' &&
                    parent.kind !== 'webhook-folder')
                ) {
                  return;
                }
                const targetFolderId =
                  parent.kind === 'folder' || parent.kind === 'webhook-folder' ? parent.folderId : undefined;
                const plan = planMoves(
                  (parentNode?.children ?? []).map((child) => child.data),
                  dragNodes.map((node) => node.data),
                  index,
                );
                // One at a time and in order: each move's index assumes the previous one landed.
                for (const move of plan) {
                  try {
                    await useProjectStore.getState().moveNode(move.entityId, targetFolderId, move.index);
                  } catch (error: unknown) {
                    showToast(error instanceof Error ? error.message : 'Could not move it');
                  }
                }
              }}
              aria-label="Explorer"
              onActivate={(node: NodeApi<ExplorerNode>) => {
                // Reached by a click on a request row, a double-click on anything, and Enter.
                // On an interface row it opens the viewer, the same thing "Show Interface
                // Viewer" does.
                if (node.data.kind === 'project') {
                  // A project's tab opens from `onSelect`; a double-click or Enter keeps it (#679).
                  if (node.data.projectId !== undefined) openProjectTab(node.data.projectId);
                  return;
                }
                if (node.data.kind === 'folder' && node.data.folderId !== undefined) {
                  openFolderTab(node.data.folderId);
                  node.open();
                  return;
                }
                const role = explorerRole(node.data.kind);
                if (role !== undefined) {
                  role.open?.(node.data);
                  return;
                }
                if (node.data.kind === 'webhook-request') {
                  // No new tab kind: a webhook item is a REST request on the wire.
                  explorerActions.openRestRequest(node.data.requestId);
                  return;
                }
                if (node.data.kind === 'webhook-collection' || node.data.kind === 'webhook-folder') {
                  // Nothing to open; a click folds/unfolds the row, same as an interface's other
                  // grouping rows.
                  return;
                }
                if (node.data.kind === 'webhooks') {
                  return;
                }
                if (node.data.kind === 'catch-url') {
                  if (node.data.hookId !== undefined) openCatchUrlTab(node.data.hookId);
                  return;
                }
                if (node.data.kind === 'schedules') {
                  return;
                }
                if (node.data.kind === 'schedule') {
                  if (node.data.scheduleId !== undefined) openScheduleTab(node.data.scheduleId);
                  return;
                }
                if (node.data.kind === 'sequence') {
                  explorerActions.openSequence(node.data.sequenceId);
                  return;
                }
                if (node.data.kind === 'mock') {
                  explorerActions.openMock(node.data.mockId);
                  return;
                }
                if (
                  node.data.kind === 'sequences' ||
                  node.data.kind === 'mocks' ||
                  node.data.kind === 'values' ||
                  node.data.kind === 'value'
                ) {
                  // A group row has nothing to open; a click folds it. A value has nothing to open either.
                  return;
                }
              }}
              onSelect={(nodes) => {
                const node = nodes[0]?.data;
                if (node === undefined) {
                  setSelection(undefined);
                  return;
                }
                const definitionUrl =
                  node.kind === 'interface' ? interfaces[node.interfaceId ?? '']?.definitionUrl : undefined;
                // A project row's tab opens immediately on selection — a single click, not a
                // double-click — per the approved spec's amendment; project rows have no
                // "activate" behaviour of their own (see `onActivate` below), so this is the
                // only path that opens one.
                // Selecting is browsing, by click or by arrow key, so the tab is a preview (#679).
                if (node.kind === 'project' && node.projectId !== undefined && !selectingForMenu) {
                  const { projectId } = node;
                  asPreview(() => {
                    openProjectTab(projectId);
                  });
                }
                setSelection({
                  kind: node.kind,
                  // A project row stands for a project, so the selection names the project id —
                  // what `selection.project` commands and the details panel both read.
                  id: node.kind === 'project' ? (node.projectId ?? node.id) : node.id,
                  ...(node.interfaceId !== undefined ? { interfaceId: node.interfaceId } : {}),
                  ...(definitionUrl !== undefined ? { definitionUrl } : {}),
                  ...(node.bindingName !== undefined ? { bindingName: node.bindingName } : {}),
                  ...(node.operationName !== undefined ? { operationName: node.operationName } : {}),
                  ...(node.soapAction !== undefined ? { soapAction: node.soapAction } : {}),
                  ...(node.requestId !== undefined ? { requestId: node.requestId } : {}),
                  ...(node.apiId !== undefined ? { apiId: node.apiId } : {}),
                  ...(node.folderId !== undefined ? { folderId: node.folderId } : {}),
                  ...(node.address !== undefined ? { address: node.address } : {}),
                });
              }}
              onRename={({ id, name }) => {
                const node = data.flatMap(flatten).find((n) => n.id === id);
                if (node === undefined) return;
                const trimmed = name.trim();
                if (trimmed.length === 0 || trimmed === node.label) {
                  return;
                }
                const role = explorerRole(node.kind);
                if (role?.rename !== undefined) {
                  role.rename(node, trimmed);
                  return;
                }
                if (node.kind === 'project' && node.projectId !== undefined) {
                  projectRowActions.commitRename(node.projectId, trimmed);
                }
                if (node.kind === 'folder' && node.folderId !== undefined) {
                  void useProjectStore
                    .getState()
                    .updateFolder(node.folderId, { name: trimmed })
                    .catch(reportRenameFailure);
                }
                // openapi-webhooks-import §3.1: a webhook folder/request is a REST folder/request
                // on the wire, so the same update reaches it.
                if (node.kind === 'webhook-folder' && node.folderId !== undefined) {
                  void useProjectStore
                    .getState()
                    .updateFolder(node.folderId, { name: trimmed })
                    .catch(reportRenameFailure);
                }
                if (node.kind === 'webhook-request' && node.requestId !== undefined) {
                  void useProjectStore
                    .getState()
                    .updateRestRequest(node.requestId, { name: trimmed })
                    .catch(reportRenameFailure);
                }
                if (node.kind === 'sequence' && node.sequenceId !== undefined) {
                  void useProjectStore
                    .getState()
                    .updateSequence(node.sequenceId, { name: trimmed })
                    .catch(reportRenameFailure);
                }
                if (node.kind === 'mock' && node.mockId !== undefined) {
                  void useProjectStore.getState().updateMock(node.mockId, { name: trimmed }).catch(reportRenameFailure);
                }
              }}
              onDelete={({ nodes }) => {
                deleteExplorerNodes(nodes.map((node) => node.data));
              }}
            >
              {(props) => <NodeRow {...props} />}
            </Tree>
          )
        )}
      </div>

      <EnableScriptsDialog />
      <ConvertScriptsDialog />
      {EXPLORER_DIALOGS.map((Dialogs, index) => (
        <Dialogs key={index} />
      ))}

      <ConfirmDialog
        open={confirmRemoveInterfaceId !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            requestRemoveInterface(undefined);
          }
        }}
        title="Remove interface?"
        description="This closes the imported definition and discards its request drafts."
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (confirmRemoveInterfaceId !== undefined) {
            void removeInterface(confirmRemoveInterfaceId);
          }
        }}
      />

      <ConfirmDialog
        open={confirmDeleteNode !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            requestDeleteNode(undefined);
          }
        }}
        title={
          confirmDeleteNode === undefined
            ? 'Delete request?'
            : (explorerDeletion(confirmDeleteNode.kind)?.title ??
              (confirmDeleteNode.kind === 'folder'
                ? 'Delete folder?'
                : confirmDeleteNode.kind === 'sequence'
                  ? 'Delete sequence?'
                  : confirmDeleteNode.kind === 'mock'
                    ? 'Delete mock?'
                    : 'Delete request?'))
        }
        description={
          confirmDeleteNode === undefined
            ? 'This cannot be undone.'
            : `"${confirmDeleteNode.name}"${
                confirmDeleteNode.requestCount > 0
                  ? ` and the ${String(confirmDeleteNode.requestCount)} request(s) inside it`
                  : ''
              } will be deleted. This cannot be undone.`
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (confirmDeleteNode === undefined) {
            return;
          }
          void runNodeDeletion(confirmDeleteNode).catch(reportDeleteFailure);
        }}
      />

      <ConfirmDialog
        open={confirmDeleteNodes !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            requestDeleteNodes(undefined);
          }
        }}
        title={
          confirmDeleteNodes === undefined
            ? 'Delete items?'
            : `Delete ${String(confirmDeleteNodes.length)} ${
                confirmDeleteNodes.every((pending) => REQUEST_ROW_KINDS.has(pending.kind)) ? 'requests' : 'items'
              }?`
        }
        description={`${namesOf(confirmDeleteNodes ?? [])} will be deleted. This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          for (const pending of confirmDeleteNodes ?? []) {
            void runNodeDeletion(pending).catch(reportDeleteFailure);
          }
        }}
      />

      <ConfirmDialog
        open={confirmDeleteRequestId !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            requestDeleteRequest(undefined);
          }
        }}
        title="Delete request?"
        description={
          requestPendingDeletion !== undefined
            ? `"${requestPendingDeletion.name}" will be deleted. This cannot be undone.`
            : 'This cannot be undone.'
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (confirmDeleteRequestId !== undefined) {
            void removeRequest(confirmDeleteRequestId);
          }
        }}
      />
    </div>
  );
}

function flatten(node: ExplorerNode): ExplorerNode[] {
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

/** Whether a drop target and the node being dragged live in the same project. */
export function sameProject(target: ExplorerNode | undefined, dragged: ExplorerNode | undefined): boolean {
  const projectOf = useProjectStore.getState().projectOf;
  const into = nodeProjectId(target, projectOf);
  const from = nodeProjectId(dragged, projectOf);
  return into !== undefined && into === from;
}

function reportRenameFailure(error: unknown): void {
  showToast(error instanceof Error ? error.message : 'Could not rename it');
}

function reportDeleteFailure(error: unknown): void {
  showToast(error instanceof Error ? error.message : 'Delete failed');
}

/** The first few of `pending` by name, quoted, and how many more: what the many-rows confirm names. */
function namesOf(pending: readonly { readonly name: string }[]): string {
  const shown = pending.slice(0, 3).map((item) => `"${item.name}"`);
  const more = pending.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${String(more)} more`;
  if (shown.length <= 1) return shown[0] ?? 'Nothing';
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1] ?? ''}`;
}
