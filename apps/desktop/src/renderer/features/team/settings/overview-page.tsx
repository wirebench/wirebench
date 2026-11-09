/**
 * Team settings › Overview (settings split spec §3.2): where picking a team lands. The team's mark and name (a
 * team admin renames it, saved on blur or Enter), your role and when it was made; tiles for its people, its
 * workspaces and, for a server admin, the server's seats, each opening its page; the workspaces with your role on
 * each; for a team admin, *Add people*, *New workspace…*, the invitations still waiting and, while the team is new,
 * a setup list. A server admin also gets *Delete this team*.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, Circle, CircleCheck, FolderKanban, Mail, Plus, UserPlus } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { useLicenseStore } from '../../../state/license.js';
import { selectedTeam, teamWorkspaces, useTeamStore } from '../../../state/team.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { INPUT_CLASS, ROLE_LABELS } from '../roles.js';
import type { TeamSettingsPageId } from '../team-settings-model.js';
import { NewWorkspaceForm } from '../workspaces-tab.js';
import { AddPeopleDialog } from './add-people-dialog.js';
import { createdLabel, peopleDetail, setupSteps, type SetupStepId, type TeamCounts } from './overview.js';
import { peopleRows } from './people.js';

const days = (count: number): string => (count === 1 ? '1 day' : `${String(count)} days`);

/** A count that opens its page. */
function Tile({
  label,
  value,
  detail,
  page,
  testId,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly detail: string;
  readonly page: TeamSettingsPageId;
  readonly testId: string;
}) {
  const setPage = useTeamStore((s) => s.setPage);
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => {
        setPage(page);
      }}
      className="flex flex-col items-start gap-0.5 rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-left hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
    >
      <span className="text-xs text-fg-subtle">{label}</span>
      <span className="text-[20px] leading-tight font-semibold text-fg-default">{value}</span>
      <span className="flex items-center gap-0.5 text-xs text-fg-subtle">
        {detail}
        <ChevronRight size={12} aria-hidden="true" />
      </span>
    </button>
  );
}

const STEP_LABELS: Readonly<Record<SetupStepId, string>> = {
  name: 'Name the team',
  people: 'Add the people who work with you',
  workspace: 'Make a workspace to share requests in',
};

function SetupList({
  name,
  counts,
  onAddPeople,
  onNewWorkspace,
}: {
  readonly name: string;
  readonly counts: TeamCounts;
  readonly onAddPeople: () => void;
  readonly onNewWorkspace: () => void;
}) {
  const steps = setupSteps(counts);
  if (steps === undefined) return null;
  const done = steps.filter((step) => step.done).length;
  return (
    <section data-testid="team-overview-setup" className="rounded-lg border border-hairline bg-surface-raised">
      <h2 className="px-3 py-2 text-sm font-medium text-fg-default">
        Get {name} ready{' '}
        <span className="font-normal text-fg-subtle">
          · {String(done)} of {String(steps.length)} done
        </span>
      </h2>
      <ul>
        {steps.map((step) => (
          <li
            key={step.id}
            data-testid={`team-overview-step-${step.id}`}
            data-done={step.done}
            className="flex items-center gap-2 border-t border-hairline px-3 py-2 text-sm"
          >
            {step.done ? (
              <CircleCheck size={14} aria-label="Done" className="shrink-0 text-status-success" />
            ) : (
              <Circle size={14} aria-label="To do" className="shrink-0 text-fg-subtle" />
            )}
            <span className={`flex-1 ${step.done ? 'text-fg-subtle' : 'text-fg-default'}`}>{STEP_LABELS[step.id]}</span>
            {!step.done && step.id === 'people' && (
              <Button data-testid="team-overview-step-add-people" onClick={onAddPeople}>
                Add people
              </Button>
            )}
            {!step.done && step.id === 'workspace' && (
              <Button data-testid="team-overview-step-new-workspace" onClick={onNewWorkspace}>
                New workspace…
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function OverviewPage() {
  const store = useTeamStore();
  const team = selectedTeam(store);
  const seats = useLicenseStore((s) => s.state?.seats);
  const share = useWorkspaceStore((s) => s.workspace?.share);
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dialog, setDialog] = useState<'add' | 'renewed' | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    setName(team?.name ?? '');
  }, [team?.id, team?.name]);
  const { url, serverAdmin } = store;
  useEffect(() => {
    if (url !== undefined && serverAdmin) void useLicenseStore.getState().load(url);
  }, [url, serverAdmin]);
  if (team === undefined) return null;

  const isAdmin = team.myRole === 'admin';
  const workspaces = teamWorkspaces(store);
  const counts: TeamCounts = {
    members: store.members.length,
    invitations: store.invitations.length,
    workspaces: workspaces.length,
  };
  const waiting = peopleRows([], store.invitations, undefined, new Date()).flatMap((row) =>
    row.kind === 'invitation' ? [row] : [],
  );
  const openNow = share?.kind === 'server' ? share.server?.workspaceId : undefined;
  const created = createdLabel(team.createdAt, new Date());
  const submitRename = (): void => {
    if (isAdmin && name.trim().length > 0 && name.trim() !== team.name) void store.renameTeam(name.trim());
  };
  const addPeople = (): void => {
    setDialog('add');
  };
  const newWorkspace = (): void => {
    setCreating(true);
  };
  const renew = async (invitationId: string): Promise<void> => {
    setDialog('renewed');
    if (!(await store.renewInvitation(invitationId))) setDialog(undefined);
  };

  return (
    <div data-testid="team-overview" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent-muted text-lg font-semibold text-fg-default"
        >
          {team.name.trim().charAt(0).toUpperCase() || '?'}
        </span>
        <div className="flex min-w-48 flex-1 flex-col">
          <input
            data-testid="team-name"
            aria-label="Team name"
            readOnly={!isAdmin}
            title={isAdmin ? 'Rename the team' : undefined}
            className={
              isAdmin
                ? `${INPUT_CLASS} -ml-2 border-transparent bg-transparent text-lg font-semibold hover:border-hairline focus:border-hairline`
                : 'bg-transparent text-lg font-semibold text-fg-default outline-none'
            }
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            onBlur={submitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitRename();
            }}
          />
          <p data-testid="team-overview-role" className="text-sm text-fg-subtle">
            You’re {isAdmin ? 'an admin' : 'a member'}
            {created === '' ? '' : ` · created ${created}`}
          </p>
        </div>
        {isAdmin && (
          <div className="flex gap-2">
            <Button variant="primary" data-testid="team-overview-add-people" onClick={addPeople}>
              <UserPlus size={14} aria-hidden="true" />
              Add people
            </Button>
            <Button data-testid="team-overview-new-workspace" onClick={newWorkspace}>
              <Plus size={14} aria-hidden="true" />
              New workspace…
            </Button>
          </div>
        )}
      </div>

      {isAdmin && <SetupList name={team.name} counts={counts} onAddPeople={addPeople} onNewWorkspace={newWorkspace} />}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-2">
        <Tile
          testId="team-overview-members"
          label="People"
          value={counts.members + counts.invitations}
          detail={peopleDetail(counts)}
          page="people"
        />
        <Tile
          testId="team-overview-workspaces"
          label="Workspaces"
          value={counts.workspaces}
          detail={counts.workspaces === 0 ? 'none yet' : 'roles and access'}
          page="workspaces"
        />
        {serverAdmin && seats !== undefined && (
          <Tile
            testId="team-overview-seats"
            label="Seats on this server"
            value={
              <>
                {seats.used}
                {seats.limit !== null && (
                  <span className="text-sm font-normal text-fg-subtle"> of {String(seats.limit)}</span>
                )}
              </>
            }
            detail="License and seats"
            page="license"
          />
        )}
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-fg-default">Workspaces</h2>
        {creating && (
          <NewWorkspaceForm
            onDone={() => {
              setCreating(false);
            }}
          />
        )}
        {workspaces.length === 0 ? (
          <p data-testid="team-overview-no-workspaces" className="text-sm text-fg-subtle">
            {isAdmin ? 'No workspaces yet.' : 'No workspaces you can open in this team yet.'}
          </p>
        ) : (
          <ul className="overflow-hidden rounded-lg border border-hairline bg-surface-raised">
            {workspaces.map((workspace, index) => (
              <li
                key={workspace.id}
                data-testid="team-overview-workspace"
                className={`flex items-center gap-2 px-3 py-2 text-sm ${index > 0 ? 'border-t border-hairline' : ''}`}
              >
                <FolderKanban size={14} aria-hidden="true" className="shrink-0 text-fg-subtle" />
                <span className="min-w-0 flex-1 truncate text-fg-default">{workspace.name}</span>
                {workspace.id === openNow && (
                  <span className="rounded-full bg-accent-muted px-2 text-xs text-fg-default">Open now</span>
                )}
                <span className="rounded-full bg-surface-hover px-2 text-xs text-fg-subtle">
                  {ROLE_LABELS[workspace.myRole]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isAdmin && waiting.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-fg-default">Waiting to join</h2>
          <ul className="overflow-hidden rounded-lg border border-hairline bg-surface-raised">
            {waiting.map(({ invitation, expiresInDays }, index) => (
              <li
                key={invitation.id}
                data-testid="team-overview-invitation"
                className={`flex items-center gap-2 px-3 py-2 text-sm ${index > 0 ? 'border-t border-hairline' : ''}`}
              >
                <Mail size={14} aria-hidden="true" className="shrink-0 text-fg-subtle" />
                <span className="min-w-0 flex-1 truncate text-fg-default">
                  {invitation.email}{' '}
                  <span className="text-fg-subtle">
                    · invited as {ROLE_LABELS[invitation.role]} · link expires in {days(expiresInDays)}
                  </span>
                </span>
                <Button
                  data-testid="team-overview-invitation-renew"
                  onClick={() => {
                    void renew(invitation.id);
                  }}
                >
                  New link
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {serverAdmin && (
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

      <AddPeopleDialog
        open={dialog !== undefined}
        view={dialog ?? 'add'}
        onOpenChange={(next) => {
          if (!next) setDialog(undefined);
        }}
      />
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
