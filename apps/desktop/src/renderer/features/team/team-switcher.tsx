import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Users } from 'lucide-react';
import { activeTeam, inTeam, ofOtherTeam, useActiveTeamStore } from '../../state/active-team.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { workspaceActions } from '../workspace/workspace-actions.js';
import { manageTeam } from './team-link.js';

/**
 * Makes `teamId` the active team and moves the window with it: a workspace of another team gives way to the new
 * team's most recently opened workspace here, or, when it has none yet, to the workspace list, which then offers
 * that team's workspaces. A local workspace, or one of the new team, stays open.
 */
export async function switchTeam(teamId: string): Promise<void> {
  useActiveTeamStore.getState().setTeam(teamId);
  const teams = useActiveTeamStore.getState();
  const { workspace, workspaces } = useWorkspaceStore.getState();
  if (workspace === null || !ofOtherTeam(teams, workspace)) return;
  // `workspace.list` answers newest-opened first.
  const next = workspaces.find((row) => row.id !== workspace.id && row.unreadable !== true && inTeam(teams, row));
  if (next !== undefined) {
    await workspaceActions.open(next.id);
  } else {
    await useWorkspaceStore.getState().close();
  }
}

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

/**
 * The title bar's team switcher: the team you are working in, before the workspace's name. Its menu lists the
 * active account's teams and *Manage team…* for the active one. Hidden while the account has no team (or no
 * account is signed in).
 */
export function TitleTeamSwitcher() {
  const teams = useActiveTeamStore((state) => state.teams);
  const url = useActiveTeamStore((state) => state.url);
  const current = useActiveTeamStore(activeTeam);

  if (current === undefined || url === undefined) return null;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid="title-team-switcher"
          aria-label={`Team: ${current.name}`}
          className="wb-no-drag inline-flex items-center gap-1 rounded px-1 text-sm text-fg-muted hover:bg-surface-hover hover:text-fg-default"
        >
          <Users size={12} aria-hidden="true" />
          {current.name}
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-dropdown min-w-48 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
        >
          {teams.map((team) => (
            <DropdownMenu.Item
              key={team.id}
              data-testid="title-team-switcher-item"
              data-team-id={team.id}
              className={ITEM_CLASS}
              onSelect={() => {
                void switchTeam(team.id);
              }}
            >
              <Check
                size={12}
                aria-hidden="true"
                className={team.id === current.id ? 'text-accent' : 'text-transparent'}
              />
              <span className="min-w-0 flex-1 truncate">{team.name}</span>
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
          <DropdownMenu.Item
            data-testid="title-team-switcher-manage"
            className={ITEM_CLASS}
            onSelect={() => {
              void manageTeam(url, current.id);
            }}
          >
            <span className="w-3" aria-hidden="true" />
            Manage team…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
