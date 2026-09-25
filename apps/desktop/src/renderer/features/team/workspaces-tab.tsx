import { useMemo, useEffect, useState } from 'react';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useTeamStore } from '../../state/team.js';
import type { DefaultRoleWire, TeamWorkspaceWire } from '../../../shared/wire-types.js';
import { AccessPanel } from './access-panel.js';
import { DEFAULT_ROLES, INPUT_CLASS, ROLE_LABELS, SELECT_CLASS, roleWithSource } from './roles.js';

const defaultOptions = DEFAULT_ROLES.map((role) => (
  <option key={role} value={role}>
    {role === 'none' ? 'No access by default' : `${ROLE_LABELS[role]} by default`}
  </option>
));

interface WorkspaceRowProps {
  readonly workspace: TeamWorkspaceWire;
  readonly onDelete: () => void;
}

function WorkspaceRow({ workspace, onDelete }: WorkspaceRowProps) {
  const updateWorkspace = useTeamStore((state) => state.updateWorkspace);
  const openAccess = useTeamStore((state) => state.openAccess);
  const [name, setName] = useState(workspace.name);
  const isAdmin = workspace.myRole === 'admin';

  useEffect(() => {
    setName(workspace.name);
  }, [workspace.name]);

  const submitRename = (): void => {
    if (isAdmin && name.trim().length > 0 && name.trim() !== workspace.name) {
      void updateWorkspace(workspace.id, { name: name.trim() });
    }
  };

  return (
    <li data-testid={`workspace-row-${workspace.id}`} className="flex items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <input
          data-testid={`workspace-name-${workspace.id}`}
          aria-label="Workspace name"
          readOnly={!isAdmin}
          className={`${INPUT_CLASS} w-full`}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          onBlur={submitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitRename();
          }}
        />
        <div data-testid={`workspace-role-${workspace.id}`} className="truncate px-2 text-xs text-fg-subtle">
          {roleWithSource(workspace.myRole, workspace.source)}
        </div>
      </div>
      {isAdmin && (
        <>
          <select
            data-testid={`workspace-default-${workspace.id}`}
            aria-label={`Default role in ${workspace.name}`}
            className={SELECT_CLASS}
            value={workspace.defaultRole}
            onChange={(event) => {
              void updateWorkspace(workspace.id, { defaultRole: event.target.value as DefaultRoleWire });
            }}
          >
            {defaultOptions}
          </select>
          <Button
            data-testid={`workspace-access-${workspace.id}`}
            onClick={() => {
              void openAccess(workspace.id);
            }}
          >
            Access…
          </Button>
          <Button variant="ghost" data-testid={`workspace-delete-${workspace.id}`} onClick={onDelete}>
            Delete
          </Button>
        </>
      )}
    </li>
  );
}

/**
 * The Workspaces tab (teams-access §3.5): the team's workspaces the caller can see, each with the
 * caller's role and its source. Admins of a workspace manage it here; any member can create one.
 * *Access…* swaps the list for {@link AccessPanel}.
 */
export function WorkspacesTab() {
  const teamId = useTeamStore((state) => state.teamId);
  const allWorkspaces = useTeamStore((state) => state.workspaces);
  const workspaces = useMemo(
    () => allWorkspaces.filter((workspace) => workspace.teamId === teamId),
    [allWorkspaces, teamId],
  );
  const accessId = useTeamStore((state) => state.access?.workspaceId);
  const createWorkspace = useTeamStore((state) => state.createWorkspace);
  const deleteWorkspace = useTeamStore((state) => state.deleteWorkspace);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [defaultRole, setDefaultRole] = useState<DefaultRoleWire>('viewer');
  const [deleting, setDeleting] = useState<TeamWorkspaceWire | undefined>(undefined);

  const inAccess = workspaces.find((workspace) => workspace.id === accessId);
  if (inAccess !== undefined) return <AccessPanel workspaceName={inAccess.name} />;

  const submitNew = async (): Promise<void> => {
    if (name.trim().length === 0) return;
    if (await createWorkspace(name.trim(), defaultRole)) {
      setCreating(false);
      setName('');
      setDefaultRole('viewer');
    }
  };

  return (
    <div data-testid="workspaces-tab" className="flex flex-col gap-3">
      {workspaces.length === 0 ? (
        <p className="text-sm text-fg-subtle">No workspaces you can open in this team yet.</p>
      ) : (
        <ul className="divide-y divide-hairline">
          {workspaces.map((workspace) => (
            <WorkspaceRow
              key={workspace.id}
              workspace={workspace}
              onDelete={() => {
                setDeleting(workspace);
              }}
            />
          ))}
        </ul>
      )}

      {creating ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitNew();
          }}
        >
          <input
            data-testid="workspace-new-name"
            aria-label="Workspace name"
            placeholder="Workspace name"
            autoFocus
            className={`${INPUT_CLASS} flex-1`}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <select
            data-testid="workspace-new-default"
            aria-label="Default role"
            className={SELECT_CLASS}
            value={defaultRole}
            onChange={(event) => {
              setDefaultRole(event.target.value as DefaultRoleWire);
            }}
          >
            {defaultOptions}
          </select>
          <Button type="submit" variant="primary" data-testid="workspace-new-submit">
            Create
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setCreating(false);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <div>
          <Button
            data-testid="workspace-new"
            onClick={() => {
              setCreating(true);
            }}
          >
            New workspace…
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(next) => {
          if (!next) setDeleting(undefined);
        }}
        title={`Delete ${deleting?.name ?? 'workspace'}?`}
        description="Its repository is removed from the server. Copies already on members' machines stay, but stop syncing."
        confirmLabel="Delete workspace"
        destructive
        testId="workspace-delete-confirm"
        confirmTestId="workspace-delete-confirm-ok"
        onConfirm={() => {
          if (deleting !== undefined) void deleteWorkspace(deleting.id);
        }}
      />
    </div>
  );
}
