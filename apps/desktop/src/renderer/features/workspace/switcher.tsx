import { useEffect, useRef } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { WorkspaceSummaryWire } from '../../../shared/wire-types.js';
import { workspaceActions } from './workspace-actions.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50';

/** A stable empty list, so the switcher does not rerender while the picker is loading. */
const NO_WORKSPACES: readonly WorkspaceSummaryWire[] = [];

/**
 * The title bar's workspace dropdown: every workspace on disk (newest-opened first, the order
 * `workspace.list` already returns), then the two ways to get another one. Rendered only with a
 * workspace open — the picker is the switcher when there is none.
 */
export function WorkspaceSwitcher() {
  const workspace = useWorkspaceStore((state) => state.workspace);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const open = useUiStore((state) => state.workspaceSwitcherOpen);
  const setOpen = useUiStore((state) => state.setWorkspaceSwitcherOpen);
  const setCreateOpen = useUiStore((state) => state.setWorkspaceCreateOpen);
  const setManageOpen = useUiStore((state) => state.setWorkspaceManageOpen);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Opened from the command palette, the menu mounts while the palette is still closing, and
  // the palette hands focus back to whatever held it before as it goes — which would leave an
  // open menu the keyboard could not drive. Claiming the focus on the next frame settles that,
  // and does nothing at all when the menu already has it (every other way of opening it).
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const handle = requestAnimationFrame(() => {
      const content = contentRef.current;
      if (content !== null && !content.contains(document.activeElement)) {
        content.focus();
      }
    });
    return () => {
      cancelAnimationFrame(handle);
    };
  }, [open]);

  if (workspace === null) {
    return null;
  }
  const rows = workspaces.length > 0 ? workspaces : NO_WORKSPACES;

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid="workspace-switcher"
          aria-label={`Workspace: ${workspace.name}`}
          className="wb-no-drag inline-flex items-center gap-1 rounded px-1 text-sm text-fg-default hover:bg-surface-hover"
        >
          {workspace.name}
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={contentRef}
          align="start"
          sideOffset={4}
          className="min-w-56 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
        >
          {rows.map((row) => (
            <DropdownMenu.Item
              key={row.id}
              data-testid="workspace-switcher-item"
              data-workspace-id={row.id}
              disabled={row.unreadable === true}
              title={row.unreadable === true ? `${row.dir} (unreadable)` : row.dir}
              className={ITEM_CLASS}
              onSelect={() => {
                if (row.id === workspace.id) {
                  return;
                }
                void workspaceActions.open(row.id);
              }}
            >
              <Check
                size={12}
                aria-hidden="true"
                className={row.id === workspace.id ? 'text-accent' : 'text-transparent'}
              />
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
          <DropdownMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              setCreateOpen(true);
            }}
          >
            <span className="w-3" aria-hidden="true" />
            Create workspace…
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              setManageOpen(true);
            }}
          >
            <span className="w-3" aria-hidden="true" />
            Manage workspaces…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
