import { useEffect, useRef, useState } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { Check, Cookie, Globe, Layers, PanelLeftClose, Plus } from 'lucide-react';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { IconButton } from '../../components/icon-button.js';
import { openCookiesTab } from '../cookies/cookie-actions.js';
import { useEditorsStore } from '../../state/editors.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { useGridNavigation, type GridRowProps } from '../../lib/grid-navigation.js';
import type { WorkspaceEnvironmentWire } from '../../../shared/wire-types.js';
import { duplicateEnvironment, nextEnvironmentName, openEnvironmentTab } from './environment-actions.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

const NAME_INPUT_CLASS =
  'h-6 min-w-0 flex-1 rounded bg-surface-base px-1 text-sm text-fg-default outline-none ring-1 ring-accent';

const ROW_CLASS =
  'group flex cursor-pointer items-center rounded border-l-2 py-1 pr-2 pl-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-accent';

/**
 * The one `gridcell` every row holds, carrying the row's own layout. One cell, not one per
 * part, as in the keystores grid: the check, the name and the action are one entry, not columns.
 */
const CELL_CLASS = 'flex min-w-0 flex-1 items-center gap-1.5';

/**
 * How a row shows that its target is the one the editor is on. The left bar and the selected
 * surface say "you are editing this"; the check in an environment row says something else
 * entirely — "this one resolves when you send" — so the two signals never share a treatment.
 */
const OPEN_ROW_CLASS = 'border-accent bg-surface-selected text-fg-default';
const CLOSED_ROW_CLASS = 'border-transparent text-fg-default hover:bg-surface-raised';

/**
 * Which target the active editor tab is editing, or `undefined` when it is on something else.
 * Read from the tab rather than from a selection of its own: opening an environment is what the
 * sidebar does, so the tab is the one place that already knows which one is being edited.
 */
function useOpenTarget(): string | undefined {
  return useEditorsStore((state) => {
    const tab = state.tabs.find((candidate) => candidate.id === state.activeId);
    return tab?.kind === 'environment' ? tab.environmentId : undefined;
  });
}

/**
 * Keeps the open row on screen. The list is short today but grows with the workspace, and a row
 * scrolled out of view cannot show anything — `'nearest'` so a row already visible never moves.
 */
function useRevealWhenOpen(open: boolean): React.RefObject<HTMLLIElement | null> {
  const ref = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (open) {
      ref.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [open]);
  return ref;
}

/** Globals and Workspace: the rows above the environments, always present. */
const FIXED_ROWS = 2;

/** A stable empty list, so the view does not rerender while no workspace is open. */
const NO_ENVIRONMENTS: readonly WorkspaceEnvironmentWire[] = [];

/**
 * The Globals and Workspace rows: fixed scopes, opened by a click. No context menu — *Open* was
 * the only thing it ever offered, and the row itself now does that.
 */
function ScopeRow({
  kind,
  label,
  icon: Icon,
  open,
  rowIndex,
  rowProps,
  onOpen,
}: {
  readonly kind: 'globals' | 'workspace';
  readonly label: string;
  readonly icon: typeof Globe;
  readonly open: boolean;
  /** 1-based position in the grid, for `aria-rowindex`. */
  readonly rowIndex: number;
  /** Roving-tabindex props from {@link useGridNavigation}; the view is one tab stop. */
  readonly rowProps: GridRowProps;
  readonly onOpen: () => void;
}) {
  const ref = useRevealWhenOpen(open);
  return (
    <li
      ref={ref}
      data-testid="environment-row"
      data-kind={kind}
      data-active="false"
      data-open={open}
      aria-current={open ? 'page' : undefined}
      role="row"
      aria-rowindex={rowIndex}
      {...rowProps}
      className={`${ROW_CLASS} ${open ? OPEN_ROW_CLASS : CLOSED_ROW_CLASS}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          onOpen();
        }
      }}
    >
      <div role="gridcell" className={CELL_CLASS}>
        <Icon size={13} aria-hidden="true" className="shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </div>
    </li>
  );
}

interface EnvironmentRowProps {
  readonly environment: WorkspaceEnvironmentWire;
  readonly active: boolean;
  /** True when this environment is the one the active editor tab is editing. */
  readonly open: boolean;
  readonly renaming: boolean;
  /** 1-based position in the grid, for `aria-rowindex`. */
  readonly rowIndex: number;
  /** Roving-tabindex props from {@link useGridNavigation}; the view is one tab stop. */
  readonly rowProps: GridRowProps;
  readonly onStartRename: () => void;
  readonly onFinishRename: (name: string | undefined) => void;
  readonly onDelete: () => void;
}

function EnvironmentRow({
  environment,
  active,
  open,
  renaming,
  rowIndex,
  rowProps,
  onStartRename,
  onFinishRename,
  onDelete,
}: EnvironmentRowProps) {
  const setActiveEnvironment = useWorkspaceStore((state) => state.setActiveEnvironment);
  const ref = useRevealWhenOpen(open);

  const setActive = (): void => {
    void setActiveEnvironment(active ? null : environment.id);
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <li
          ref={ref}
          data-testid="environment-row"
          data-kind="environment"
          data-active={active}
          data-open={open}
          aria-current={open ? 'page' : undefined}
          role="row"
          aria-rowindex={rowIndex}
          {...rowProps}
          className={`${ROW_CLASS} ${open ? OPEN_ROW_CLASS : CLOSED_ROW_CLASS}`}
          onClick={() => {
            if (!renaming) {
              openEnvironmentTab({ kind: 'environment', id: environment.id });
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !renaming) {
              openEnvironmentTab({ kind: 'environment', id: environment.id });
            }
          }}
        >
          <div role="gridcell" className={CELL_CLASS}>
            <button
              type="button"
              aria-label={active ? `Deactivate ${environment.name}` : `Set ${environment.name} active`}
              className="flex size-4 shrink-0 items-center justify-center"
              onClick={(event) => {
                event.stopPropagation();
                setActive();
              }}
            >
              {active ? <Check size={13} aria-hidden="true" className="text-accent" /> : null}
            </button>
            {renaming ? (
              <input
                autoFocus
                aria-label={`Rename ${environment.name}`}
                defaultValue={environment.name}
                className={NAME_INPUT_CLASS}
                onClick={(event) => {
                  event.stopPropagation();
                }}
                onBlur={(event) => {
                  onFinishRename(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    onFinishRename(event.currentTarget.value);
                  }
                  if (event.key === 'Escape') {
                    onFinishRename(undefined);
                  }
                }}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{environment.name}</span>
            )}
            {!active && !renaming && (
              <button
                type="button"
                className="hidden shrink-0 text-xs text-fg-subtle hover:text-fg-default group-hover:inline"
                onClick={(event) => {
                  event.stopPropagation();
                  setActive();
                }}
              >
                Set active
              </button>
            )}
          </div>
        </li>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="min-w-40 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
          // Selecting "Rename" swaps this row's label for an autofocused input; Radix's default
          // close behaviour returns focus to the trigger `<li>` right after, which would steal
          // it back and blur (committing) the input before anyone typed a thing.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          {/* No *Open*: a click on the row already does that. What is left splits in two —
              which environment resolves on Send, then the entries that copy, rename or destroy
              this one, kept away from anything reached for by reflex. */}
          <ContextMenu.Item className={ITEM_CLASS} onSelect={setActive}>
            {active ? 'Deactivate' : 'Set active'}
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-hairline" />
          <ContextMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              void duplicateEnvironment(environment.id);
            }}
          >
            Duplicate
          </ContextMenu.Item>
          <ContextMenu.Item className={ITEM_CLASS} onSelect={onStartRename}>
            Rename
          </ContextMenu.Item>
          <ContextMenu.Item className={ITEM_CLASS} onSelect={onDelete}>
            Delete
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * The left menu's Environments view: Globals, Workspace, a divider, then every workspace
 * environment in order. Replaces the Explorer's `EnvironmentsSection` — this is now the only
 * place the workspace's environments are listed and managed from the sidebar.
 */
export function EnvironmentsView() {
  const environments = useWorkspaceStore((state) => state.workspace?.environments ?? NO_ENVIRONMENTS);
  const activeId = useWorkspaceStore((state) => state.workspace?.activeEnvironmentId);
  const hasWorkspace = useWorkspaceStore((state) => state.workspace !== null);
  const mutate = useWorkspaceStore((state) => state.mutate);
  // `collapseSidebar`, not `toggleSidebar`: this button is only ever reachable while the sidebar
  // is open, and every other collapse affordance on the shell collapses rather than toggles.
  const collapseSidebar = useUiStore((state) => state.collapseSidebar);
  // `EditorTab.environmentId` already holds the encoded target — a real id, or `'globals'` /
  // `'workspace'` for the two fixed scopes — so each row compares against it directly.
  const openTarget = useOpenTarget();

  const [renamingId, setRenamingId] = useState<string | undefined>(undefined);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | undefined>(undefined);

  const pendingDelete = environments.find((candidate) => candidate.id === pendingDeleteId);

  // Globals, Workspace, then every environment: one tab stop, Up/Down/Home/End between rows.
  const { gridProps, rowProps } = useGridNavigation(FIXED_ROWS + environments.length);

  return (
    <section data-testid="environments-view" className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex h-8 shrink-0 items-center justify-end gap-1 px-2">
        <IconButton
          label="Add environment"
          data-testid="environments-add"
          disabled={!hasWorkspace}
          onClick={() => {
            void mutate({ kind: 'add-workspace-environment', name: nextEnvironmentName(environments) }).then(
              (result) => {
                if (result.createdEnvironmentId !== undefined) {
                  openEnvironmentTab({ kind: 'environment', id: result.createdEnvironmentId });
                }
              },
            );
          }}
        >
          <Plus size={14} aria-hidden="true" />
        </IconButton>
        <IconButton label="Cookies…" data-testid="environments-cookies" onClick={openCookiesTab}>
          <Cookie size={14} aria-hidden="true" />
        </IconButton>
        <IconButton label="Collapse sidebar" onClick={collapseSidebar}>
          <PanelLeftClose size={14} aria-hidden="true" />
        </IconButton>
      </div>

      {/* A grid, as History and Keystores are: Up/Down move between rows while the view stays a
          single tab stop. The empty state sits after it — a grid may hold nothing but rows. */}
      <ul
        aria-label="Environments"
        role="grid"
        aria-rowcount={FIXED_ROWS + environments.length}
        className="flex flex-col gap-0.5 px-1 pb-2"
        {...gridProps}
      >
        <ScopeRow
          kind="globals"
          label="Globals"
          icon={Globe}
          open={openTarget === 'globals'}
          rowIndex={1}
          rowProps={rowProps(0)}
          onOpen={() => {
            openEnvironmentTab({ kind: 'globals' });
          }}
        />
        <ScopeRow
          kind="workspace"
          label="Workspace"
          icon={Layers}
          open={openTarget === 'workspace'}
          rowIndex={2}
          rowProps={rowProps(1)}
          onOpen={() => {
            openEnvironmentTab({ kind: 'workspace' });
          }}
        />
        {/* Decorative only: a `separator` is not a valid child of a `grid`, whose children are
            rows, so this one is hidden from assistive tech rather than mis-typed. */}
        <li role="presentation" aria-hidden="true" className="my-1 h-px bg-hairline" />
        {environments.map((environment, index) => (
          <EnvironmentRow
            key={environment.id}
            environment={environment}
            active={environment.id === activeId}
            open={environment.id === openTarget}
            renaming={renamingId === environment.id}
            rowIndex={FIXED_ROWS + index + 1}
            rowProps={rowProps(FIXED_ROWS + index)}
            onStartRename={() => {
              // Deferred: selecting "Rename" from the context menu closes it, and Radix's own
              // close sequence briefly contests focus; queuing the switch to the input lets that
              // settle first, so the input's autofocus is the last thing to claim it.
              setTimeout(() => {
                setRenamingId(environment.id);
              }, 0);
            }}
            onFinishRename={(name) => {
              setRenamingId(undefined);
              const trimmed = name?.trim();
              if (trimmed !== undefined && trimmed.length > 0 && trimmed !== environment.name) {
                void mutate({
                  kind: 'update-workspace-environment',
                  environmentId: environment.id,
                  patch: { name: trimmed },
                });
              }
            }}
            onDelete={() => {
              setPendingDeleteId(environment.id);
            }}
          />
        ))}
      </ul>
      {environments.length === 0 && (
        <p className="px-3 py-1 text-sm text-fg-subtle">
          {hasWorkspace ? 'No environments yet.' : 'Open a workspace to add environments.'}
        </p>
      )}

      <ConfirmDialog
        open={pendingDeleteId !== undefined}
        onOpenChange={(next) => {
          if (!next) {
            setPendingDeleteId(undefined);
          }
        }}
        title="Delete environment?"
        description={
          pendingDelete !== undefined
            ? `"${pendingDelete.name}" and its endpoint overrides and properties will be deleted.`
            : 'This cannot be undone.'
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (pendingDeleteId !== undefined) {
            void mutate({ kind: 'remove-workspace-environment', environmentId: pendingDeleteId });
          }
        }}
      />
    </section>
  );
}
