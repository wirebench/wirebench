import { useState } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { ChevronDown, ChevronRight, Circle, Plus } from 'lucide-react';
import { IconButton } from '../../components/icon-button.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { WorkspaceEnvironmentWire } from '../../../shared/wire-types.js';
import { duplicateEnvironment, openEnvironmentTab } from './environment-actions.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

/** A stable empty list, so the section does not rerender while no workspace is open. */
const NO_ENVIRONMENTS: readonly WorkspaceEnvironmentWire[] = [];

const NAME_INPUT_CLASS =
  'h-6 min-w-0 flex-1 rounded bg-surface-base px-1 text-sm text-fg-default outline-none ring-1 ring-accent';

interface RowProps {
  readonly environment: WorkspaceEnvironmentWire;
  readonly active: boolean;
  readonly renaming: boolean;
  readonly onStartRename: () => void;
  readonly onFinishRename: (name: string | undefined) => void;
  readonly onDelete: () => void;
}

function EnvironmentRow({ environment, active, renaming, onStartRename, onFinishRename, onDelete }: RowProps) {
  const setActiveEnvironment = useWorkspaceStore((state) => state.setActiveEnvironment);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <li
          data-testid="environment-row"
          data-active={active}
          tabIndex={0}
          className={`flex items-center gap-1.5 rounded px-2 py-1 text-sm outline-none focus-visible:ring-1 focus-visible:ring-accent ${
            active ? 'bg-accent-muted text-fg-default' : 'text-fg-default hover:bg-surface-raised'
          }`}
          onDoubleClick={() => {
            openEnvironmentTab(environment.id);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !renaming) {
              openEnvironmentTab(environment.id);
            }
          }}
        >
          <Circle size={8} aria-hidden="true" className={active ? 'fill-current text-accent' : 'text-transparent'} />
          {renaming ? (
            <input
              autoFocus
              aria-label={`Rename ${environment.name}`}
              defaultValue={environment.name}
              className={NAME_INPUT_CLASS}
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
          {active && <span className="shrink-0 text-xs text-fg-subtle">active</span>}
        </li>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-40 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg">
          <ContextMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              openEnvironmentTab(environment.id);
            }}
          >
            Open
          </ContextMenu.Item>
          <ContextMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              void setActiveEnvironment(active ? null : environment.id);
            }}
          >
            {active ? 'Deactivate' : 'Set active'}
          </ContextMenu.Item>
          <ContextMenu.Item className={ITEM_CLASS} onSelect={onStartRename}>
            Rename…
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
 * The Explorer sidebar's Environments section: the workspace's environments, which one is active,
 * and the add/rename/duplicate/delete actions. Double-click (or Enter) opens an environment's
 * editor tab; everything else lives on the right-click menu, mirroring the interfaces tree.
 */
export function EnvironmentsSection() {
  const environments = useWorkspaceStore((state) => state.workspace?.environments ?? NO_ENVIRONMENTS);
  const activeId = useWorkspaceStore((state) => state.workspace?.activeEnvironmentId);
  const hasWorkspace = useWorkspaceStore((state) => state.workspace !== null);
  const mutate = useWorkspaceStore((state) => state.mutate);

  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | undefined>(undefined);

  const pendingDelete = environments.find((candidate) => candidate.id === pendingDeleteId);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <section data-testid="environments-section" className="shrink-0 border-t border-hairline">
      <div className="flex h-8 items-center gap-1 pr-2 pl-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 text-xs font-medium tracking-wider text-fg-subtle uppercase hover:text-fg-default"
        >
          <Chevron size={12} aria-hidden="true" />
          Environments
        </button>
        <IconButton
          label="Add environment"
          disabled={!hasWorkspace}
          onClick={() => {
            setOpen(true);
            setAdding(true);
          }}
        >
          <Plus size={14} aria-hidden="true" />
        </IconButton>
      </div>

      {open && (
        <ul aria-label="Environments" className="flex flex-col gap-0.5 px-1 pb-2">
          {environments.length === 0 && !adding && (
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
                setRenamingId(environment.id);
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
          {adding && (
            <li className="flex items-center gap-1.5 px-2 py-1">
              <input
                autoFocus
                aria-label="New environment name"
                placeholder="Environment name"
                className={NAME_INPUT_CLASS}
                onBlur={(event) => {
                  const name = event.currentTarget.value.trim();
                  setAdding(false);
                  if (name.length > 0) {
                    void mutate({ kind: 'add-workspace-environment', name });
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    const name = event.currentTarget.value.trim();
                    setAdding(false);
                    if (name.length > 0) {
                      void mutate({ kind: 'add-workspace-environment', name });
                    }
                  }
                  if (event.key === 'Escape') {
                    setAdding(false);
                  }
                }}
              />
            </li>
          )}
        </ul>
      )}

      <AlertDialog.Root
        open={pendingDeleteId !== undefined}
        onOpenChange={(next) => {
          if (!next) {
            setPendingDeleteId(undefined);
          }
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/40" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 w-80 -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg">
            <AlertDialog.Title className="text-md font-medium text-fg-default">Delete environment?</AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm text-fg-subtle">
              {pendingDelete !== undefined
                ? `"${pendingDelete.name}" and its endpoint overrides and properties will be deleted.`
                : 'This cannot be undone.'}
            </AlertDialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button type="button" className="rounded px-3 py-1.5 text-sm text-fg-default hover:bg-surface-base">
                  Cancel
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  className="rounded bg-status-danger px-3 py-1.5 text-sm text-fg-on-accent"
                  onClick={() => {
                    if (pendingDeleteId !== undefined) {
                      void mutate({ kind: 'remove-workspace-environment', environmentId: pendingDeleteId });
                    }
                  }}
                >
                  Delete
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}
