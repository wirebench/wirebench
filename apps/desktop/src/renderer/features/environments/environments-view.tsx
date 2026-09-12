import { useState } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { Check, Globe, Layers, PanelLeftClose, Plus } from 'lucide-react';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { IconButton } from '../../components/icon-button.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { WorkspaceEnvironmentWire } from '../../../shared/wire-types.js';
import { duplicateEnvironment, nextEnvironmentName, openEnvironmentTab } from './environment-actions.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

const NAME_INPUT_CLASS =
  'h-6 min-w-0 flex-1 rounded bg-surface-base px-1 text-sm text-fg-default outline-none ring-1 ring-accent';

const ROW_CLASS =
  'group flex items-center gap-1.5 rounded px-2 py-1 text-sm outline-none focus-visible:ring-1 focus-visible:ring-accent';

/** A stable empty list, so the view does not rerender while no workspace is open. */
const NO_ENVIRONMENTS: readonly WorkspaceEnvironmentWire[] = [];

/** The Globals and Workspace rows: fixed scopes that only ever offer "Open". */
function ScopeRow({
  kind,
  label,
  icon: Icon,
  onOpen,
}: {
  readonly kind: 'globals' | 'workspace';
  readonly label: string;
  readonly icon: typeof Globe;
  readonly onOpen: () => void;
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <li
          data-testid="environment-row"
          data-kind={kind}
          data-active="false"
          role="row"
          tabIndex={0}
          className={`${ROW_CLASS} text-fg-default hover:bg-surface-raised`}
          onDoubleClick={onOpen}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onOpen();
            }
          }}
        >
          <Icon size={13} aria-hidden="true" className="shrink-0 text-fg-subtle" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </li>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-40 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg">
          <ContextMenu.Item className={ITEM_CLASS} onSelect={onOpen}>
            Open
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

interface EnvironmentRowProps {
  readonly environment: WorkspaceEnvironmentWire;
  readonly active: boolean;
  readonly renaming: boolean;
  readonly onStartRename: () => void;
  readonly onFinishRename: (name: string | undefined) => void;
  readonly onDelete: () => void;
}

function EnvironmentRow({
  environment,
  active,
  renaming,
  onStartRename,
  onFinishRename,
  onDelete,
}: EnvironmentRowProps) {
  const setActiveEnvironment = useWorkspaceStore((state) => state.setActiveEnvironment);

  const setActive = (): void => {
    void setActiveEnvironment(active ? null : environment.id);
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <li
          data-testid="environment-row"
          data-kind="environment"
          data-active={active}
          role="row"
          tabIndex={0}
          className={`${ROW_CLASS} ${active ? 'bg-accent-muted text-fg-default' : 'text-fg-default hover:bg-surface-raised'}`}
          onDoubleClick={() => {
            openEnvironmentTab({ kind: 'environment', id: environment.id });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !renaming) {
              openEnvironmentTab({ kind: 'environment', id: environment.id });
            }
          }}
        >
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
          <ContextMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              openEnvironmentTab({ kind: 'environment', id: environment.id });
            }}
          >
            Open
          </ContextMenu.Item>
          <ContextMenu.Item className={ITEM_CLASS} onSelect={setActive}>
            {active ? 'Deactivate' : 'Set active'}
          </ContextMenu.Item>
          <ContextMenu.Item className={ITEM_CLASS} onSelect={onStartRename}>
            Rename
          </ContextMenu.Item>
          <ContextMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              void duplicateEnvironment(environment.id);
            }}
          >
            Duplicate
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
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);

  const [renamingId, setRenamingId] = useState<string | undefined>(undefined);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | undefined>(undefined);

  const pendingDelete = environments.find((candidate) => candidate.id === pendingDeleteId);

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
        <IconButton label="Collapse sidebar" onClick={toggleSidebar}>
          <PanelLeftClose size={14} aria-hidden="true" />
        </IconButton>
      </div>

      <ul aria-label="Environments" role="grid" className="flex flex-col gap-0.5 px-1 pb-2">
        <ScopeRow
          kind="globals"
          label="Globals"
          icon={Globe}
          onOpen={() => {
            openEnvironmentTab({ kind: 'globals' });
          }}
        />
        <ScopeRow
          kind="workspace"
          label="Workspace"
          icon={Layers}
          onOpen={() => {
            openEnvironmentTab({ kind: 'workspace' });
          }}
        />
        <li role="separator" aria-orientation="horizontal" className="my-1 h-px bg-hairline" />
        {environments.length === 0 && (
          <li className="px-2 py-1 text-sm text-fg-subtle">
            {hasWorkspace ? 'No environments yet.' : 'Open a workspace to add environments.'}
          </li>
        )}
        {environments.map((environment) => (
          <EnvironmentRow
            key={environment.id}
            environment={environment}
            active={environment.id === activeId}
            renaming={renamingId === environment.id}
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
