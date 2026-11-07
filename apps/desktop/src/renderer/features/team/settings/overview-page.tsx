/**
 * Team settings › Overview (settings split spec §3.2): the team's name (a team admin edits it, saved on blur or
 * Enter), how many members and workspaces it has and when it was made; for a server admin, *Delete this team*.
 */
import { useEffect, useState } from 'react';
import { Button } from '../../../components/button.js';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { selectedTeam, teamWorkspaces, useTeamStore } from '../../../state/team.js';
import { INPUT_CLASS } from '../roles.js';

const plural = (count: number, one: string): string => `${String(count)} ${one}${count === 1 ? '' : 's'}`;

export function OverviewPage() {
  const store = useTeamStore();
  const team = selectedTeam(store);
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setName(team?.name ?? '');
  }, [team?.id, team?.name]);
  if (team === undefined) return null;
  const isAdmin = team.myRole === 'admin';
  const submitRename = (): void => {
    if (isAdmin && name.trim().length > 0 && name.trim() !== team.name) void store.renameTeam(name.trim());
  };

  return (
    <div data-testid="team-overview" className="flex flex-col gap-6">
      <label className="flex flex-col gap-1 text-xs text-fg-subtle">
        Name
        <input
          data-testid="team-name"
          aria-label="Team name"
          readOnly={!isAdmin}
          className={`${INPUT_CLASS} text-md font-medium`}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          onBlur={submitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitRename();
          }}
        />
      </label>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-fg-subtle">People</dt>
        <dd data-testid="team-overview-members" className="text-fg-default">
          {plural(store.members.length, 'member')}
        </dd>
        <dt className="text-fg-subtle">Workspaces</dt>
        <dd data-testid="team-overview-workspaces" className="text-fg-default">
          {plural(teamWorkspaces(store).length, 'workspace')}
        </dd>
        <dt className="text-fg-subtle">Created</dt>
        <dd data-testid="team-overview-created" className="text-fg-default">
          {new Date(team.createdAt).toLocaleDateString()}
        </dd>
      </dl>
      {store.serverAdmin && (
        <section
          data-testid="team-danger-zone"
          className="flex items-center justify-between gap-4 rounded-lg border border-status-danger px-4 py-3"
        >
          <div className="text-sm">
            <h2 className="font-medium text-fg-default">Delete this team</h2>
            <p className="text-fg-subtle">Only a team with no workspaces can be deleted.</p>
          </div>
          <Button
            variant="danger"
            data-testid="team-delete"
            onClick={() => {
              setConfirmDelete(true);
            }}
          >
            Delete this team
          </Button>
        </section>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${team.name}?`}
        description="Only a team with no workspaces can be deleted. Its members and invitations go with it."
        confirmLabel="Delete team"
        destructive
        testId="team-delete-confirm"
        confirmTestId="team-delete-confirm-ok"
        onConfirm={() => {
          void store.deleteTeam();
        }}
      />
    </div>
  );
}
