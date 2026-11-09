import { useEffect, useRef } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Folder, GitBranch, Server } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { showToast } from '../../components/toast.js';
import { ofOtherTeam, pickActive, useActiveTeamStore, type ActiveTeamState } from '../../state/active-team.js';
import { useUiStore } from '../../state/ui.js';
import { hasCapability } from '../../lib/capabilities.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { TeamWorkspaceWire, WorkspaceSummaryWire } from '@shared/wire-base.js';
import { workspaceActions } from './workspace-actions.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50';

/** The team a server workspace belongs to; `undefined` for a local, folder or git one. */
function teamOf(workspace: { readonly share?: WorkspaceSummaryWire['share'] }): string | undefined {
  return workspace.share?.kind === 'server' ? workspace.share.server?.teamName : undefined;
}

/**
 * The active team's workspaces with no copy here yet: the menu's *Not opened yet* group, by name. Picking one opens
 * it from the server.
 */
export function notOpenedYet(
  teams: ActiveTeamState,
  rows: readonly WorkspaceSummaryWire[],
): readonly TeamWorkspaceWire[] {
  if (teams.teamId === undefined) return [];
  const here = new Set(
    rows.flatMap((row) =>
      row.share?.kind === 'server' && row.share.server !== undefined ? [row.share.server.workspaceId] : [],
    ),
  );
  return teams.workspaces
    .filter((workspace) => workspace.teamId === teams.teamId && !here.has(workspace.id))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Opens a team workspace from the server; one already here opens, and a refusal is a toast. */
async function openFromServer(url: string, workspaceId: string): Promise<void> {
  const outcome = await workspaceActions.joinFromServer(url, workspaceId);
  if (outcome === true) return;
  if ('workspaceId' in outcome) await workspaceActions.open(outcome.workspaceId);
  else showToast(outcome.message);
}

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
  const setTeamDialogOpen = useUiStore((state) => state.setTeamWorkspaceDialogOpen);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const activeTeams = useActiveTeamStore(useShallow((state) => pickActive(state)));

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
  // The menu follows the title bar's active team: another team's workspaces are one team switch away.
  const rows = (workspaces.length > 0 ? workspaces : NO_WORKSPACES).filter(
    (row) => row.id === workspace.id || !ofOtherTeam(activeTeams, row),
  );
  const team = teamOf(workspace);
  const notOpened = notOpenedYet(activeTeams, workspaces);
  const serverUrl = activeTeams.url;

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid="workspace-switcher"
          aria-label={
            team === undefined ? `Workspace: ${workspace.name}` : `Workspace: ${workspace.name}, team ${team}`
          }
          className="wb-no-drag inline-flex items-center gap-1 rounded px-1 text-sm text-fg-default hover:bg-surface-hover"
        >
          {workspace.share !== undefined &&
            (workspace.share.kind === 'folder' ? (
              <Folder data-testid="workspace-switcher-share" size={12} aria-hidden="true" />
            ) : workspace.share.kind === 'server' ? (
              <Server data-testid="workspace-switcher-share" size={12} aria-hidden="true" />
            ) : (
              <GitBranch data-testid="workspace-switcher-share" size={12} aria-hidden="true" />
            ))}
          {/* A team workspace says whose it is, unless the title bar's team switcher already does. */}
          {team !== undefined && activeTeams.teamId === undefined && (
            <>
              <span data-testid="workspace-switcher-team" className="text-fg-muted">
                {team}
              </span>
              <span className="text-fg-faint" aria-hidden="true">
                /
              </span>
            </>
          )}
          {workspace.name}
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={contentRef}
          align="start"
          sideOffset={4}
          className="z-dropdown min-w-56 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
        >
          {rows.map((row) => (
            <DropdownMenu.Item
              key={row.id}
              data-testid="workspace-switcher-item"
              data-workspace-id={row.id}
              disabled={row.unreadable === true}
              // Without the machine's files the folder is the server's own (#880): never shown.
              title={
                hasCapability('files') ? (row.unreadable === true ? `${row.dir} (unreadable)` : row.dir) : undefined
              }
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
              {teamOf(row) !== undefined && (
                <span data-testid="workspace-switcher-item-team" className="shrink-0 text-xs text-fg-faint">
                  {teamOf(row)}
                </span>
              )}
            </DropdownMenu.Item>
          ))}
          {notOpened.length > 0 && serverUrl !== undefined && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
              <DropdownMenu.Label className="px-2 py-1 text-xs text-fg-subtle">Not opened yet</DropdownMenu.Label>
              {notOpened.map((row) => (
                <DropdownMenu.Item
                  key={row.id}
                  data-testid="workspace-switcher-not-opened"
                  data-workspace-id={row.id}
                  className={ITEM_CLASS}
                  onSelect={() => {
                    void openFromServer(serverUrl, row.id);
                  }}
                >
                  <span className="w-3" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                </DropdownMenu.Item>
              ))}
            </>
          )}
          <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
          {/* A new workspace is a local folder; without the machine's files only server workspaces open. */}
          {hasCapability('files') && (
            <DropdownMenu.Item
              className={ITEM_CLASS}
              onSelect={() => {
                setCreateOpen(true);
              }}
            >
              <span className="w-3" aria-hidden="true" />
              Create workspace…
            </DropdownMenu.Item>
          )}
          {/* The active team's workspaces not opened here yet are a click away. */}
          {activeTeams.teamId !== undefined && (
            <DropdownMenu.Item
              data-testid="workspace-switcher-open-team"
              className={ITEM_CLASS}
              onSelect={() => {
                setTeamDialogOpen(true);
              }}
            >
              <span className="w-3" aria-hidden="true" />
              Open a team workspace…
            </DropdownMenu.Item>
          )}
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
