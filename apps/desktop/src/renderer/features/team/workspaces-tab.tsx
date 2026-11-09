import { useMemo, useEffect, useState, type ReactNode } from 'react';
import { FolderKanban, Plus } from 'lucide-react';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useTeamStore } from '../../state/team.js';
import { ipc } from '../../state/ipc-client.js';
import type { DefaultRoleWire, TeamWorkspaceWire } from '@shared/wire-base.js';
import { AccessPanel } from './access-panel.js';
import { DEFAULT_ROLES, INPUT_CLASS, ROLE_LABELS, SELECT_CLASS, roleCan, roleWithSource } from './roles.js';

const defaultOptions = DEFAULT_ROLES.map((role) => (
  <option key={role} value={role}>
    {role === 'none' ? 'No access by default' : `${ROLE_LABELS[role]} by default`}
  </option>
));

/** One labelled setting in a workspace card: the label and its hint on the left, the control on the right. */
function SettingRow({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-2.5">
      <div className="min-w-0 flex-1 basis-56">
        <div className="text-sm text-fg-default">{label}</div>
        <div className="text-xs text-fg-subtle">{hint}</div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1">{children}</div>
    </div>
  );
}

interface WorkspaceRowProps {
  readonly workspace: TeamWorkspaceWire;
  readonly onDelete: () => void;
}

/**
 * One workspace as a card: its name (editable by its admins), your role in it, Access… and Delete in the header;
 * below, for its admins, who may open it by default, what is recorded and which features are off.
 */
function WorkspaceRow({ workspace, onDelete }: WorkspaceRowProps) {
  const updateWorkspace = useTeamStore((state) => state.updateWorkspace);
  const openAccess = useTeamStore((state) => state.openAccess);
  const desktopActivity = useTeamStore((state) => state.desktopActivity);
  const sessionLogs = useTeamStore((state) => state.sessionLogs);
  const featurePolicy = useTeamStore((state) => state.featurePolicy);
  const [name, setName] = useState(workspace.name);
  const [policyOpen, setPolicyOpen] = useState(false);
  const isAdmin = roleCan(workspace.myRole, 'manage-workspace');
  const canShare = roleCan(workspace.myRole, 'share');
  const offCount = workspace.disabledFeatures?.length ?? 0;
  const offText = offCount === 1 ? '1 feature off by policy' : `${String(offCount)} features off by policy`;

  useEffect(() => {
    setName(workspace.name);
  }, [workspace.name]);

  const submitRename = (): void => {
    if (isAdmin && name.trim().length > 0 && name.trim() !== workspace.name) {
      void updateWorkspace(workspace.id, { name: name.trim() });
    }
  };

  const notes: ReactNode[] = [];
  if (desktopActivity && workspace.recordDesktopActivity) {
    notes.push(
      <span key="desktop" data-testid={`workspace-recorded-${workspace.id}`}>
        Desktop activity is recorded
      </span>,
    );
  }
  if (sessionLogs && workspace.recordSessionLogs === true) {
    notes.push(
      <span key="ssh" data-testid={`workspace-recorded-ssh-${workspace.id}`}>
        SSH sessions are recorded
      </span>,
    );
  }
  if (offCount > 0) {
    notes.push(
      <span key="features" data-testid={`workspace-features-off-${workspace.id}`}>
        {offText}
      </span>,
    );
  }

  return (
    <li data-testid={`workspace-row-${workspace.id}`} className="rounded-lg border border-hairline bg-surface-raised">
      <div className="flex items-center gap-3 px-4 py-3">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-muted text-fg-default"
        >
          <FolderKanban size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <input
            data-testid={`workspace-name-${workspace.id}`}
            aria-label="Workspace name"
            readOnly={!isAdmin}
            title={isAdmin ? 'Rename' : undefined}
            className={`${INPUT_CLASS} -ml-2 w-full max-w-sm font-medium ${
              isAdmin ? 'border-transparent bg-transparent hover:border-hairline-strong focus:bg-surface-base' : ''
            }`}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            onBlur={submitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitRename();
            }}
          />
          <div className="truncate text-xs text-fg-subtle">
            Your role:{' '}
            <span data-testid={`workspace-role-${workspace.id}`}>
              {roleWithSource(workspace.myRole, workspace.source)}
            </span>
          </div>
        </div>
        {canShare && (
          <Button
            data-testid={`workspace-access-${workspace.id}`}
            onClick={() => {
              void openAccess(workspace.id);
            }}
          >
            Access…
          </Button>
        )}
        {isAdmin && (
          <Button
            variant="ghost"
            data-testid={`workspace-delete-${workspace.id}`}
            className="text-status-danger"
            onClick={onDelete}
          >
            Delete
          </Button>
        )}
      </div>

      {isAdmin ? (
        <div className="divide-y divide-hairline border-t border-hairline px-4">
          <SettingRow label="Default access" hint="What a team member without a grant of their own can do.">
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
          </SettingRow>
          {(desktopActivity || sessionLogs) && (
            <SettingRow label="Recording" hint="What the server keeps about the work done in this workspace.">
              {desktopActivity && (
                <label className="flex items-center gap-1.5 text-sm whitespace-nowrap text-fg-muted">
                  <input
                    type="checkbox"
                    data-testid={`workspace-record-${workspace.id}`}
                    aria-label="Record desktop activity"
                    checked={workspace.recordDesktopActivity}
                    onChange={(event) => {
                      void updateWorkspace(workspace.id, { recordDesktopActivity: event.target.checked });
                    }}
                  />
                  Desktop activity
                </label>
              )}
              {sessionLogs && (
                <label className="flex items-center gap-1.5 text-sm whitespace-nowrap text-fg-muted">
                  <input
                    type="checkbox"
                    data-testid={`workspace-record-ssh-${workspace.id}`}
                    aria-label="Record SSH sessions"
                    checked={workspace.recordSessionLogs === true}
                    onChange={(event) => {
                      void updateWorkspace(workspace.id, { recordSessionLogs: event.target.checked });
                    }}
                  />
                  SSH sessions
                </label>
              )}
            </SettingRow>
          )}
          {featurePolicy && (
            <div>
              <SettingRow
                label="Features"
                hint={offCount === 0 ? 'Nothing is switched off for this workspace.' : offText}
              >
                <Button
                  data-testid={`workspace-features-${workspace.id}`}
                  aria-expanded={policyOpen}
                  onClick={() => {
                    setPolicyOpen((open) => !open);
                  }}
                >
                  {offCount === 0 ? 'Features' : `Features (${String(offCount)} off)`}
                </Button>
              </SettingRow>
              {policyOpen && (
                <div className="pb-3">
                  <FeaturePolicyEditor
                    workspace={workspace}
                    onSave={(disabledFeatures) => {
                      setPolicyOpen(false);
                      void updateWorkspace(workspace.id, { disabledFeatures });
                    }}
                    onCancel={() => {
                      setPolicyOpen(false);
                    }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        notes.length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-hairline px-4 py-2 text-xs text-fg-subtle">
            {notes}
          </div>
        )
      )}
    </li>
  );
}

/**
 * The workspace's team feature policy (phase 4 spec §6.3): one checkbox per switch this desktop knows,
 * ticked when the policy switches it off. An id the policy holds that this desktop does not know (a
 * newer version's, a plugin's) is kept on save: the list is merged, never replaced from the known ids.
 */
function FeaturePolicyEditor({
  workspace,
  onSave,
  onCancel,
}: {
  readonly workspace: TeamWorkspaceWire;
  readonly onSave: (disabledFeatures: string[]) => void;
  readonly onCancel: () => void;
}) {
  const [known, setKnown] = useState<readonly { readonly id: string; readonly title: string }[] | undefined>(undefined);
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set(workspace.disabledFeatures ?? []));
  useEffect(() => {
    let cancelled = false;
    void ipc()
      .app.features(undefined)
      .then((result) => {
        if (!cancelled && result.ok)
          setKnown(result.value.states.map((state) => ({ id: state.id, title: state.title })));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const unknown = [...off].filter((id) => known?.every((feature) => feature.id !== id) === true);
  return (
    <div
      data-testid={`workspace-policy-${workspace.id}`}
      className="rounded-md border border-hairline bg-surface-base p-3 text-sm"
    >
      <p className="mb-2 text-xs text-fg-subtle">
        Off for everyone in this workspace. A policy only switches features off; what it leaves alone stays each
        person's own setting.
      </p>
      {known === undefined ? (
        <p className="text-xs text-fg-subtle">Loading…</p>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {known.map((feature) => (
            <label key={feature.id} className="flex items-center gap-1 text-xs text-fg-muted">
              <input
                type="checkbox"
                data-testid={`workspace-policy-${workspace.id}-${feature.id}`}
                checked={off.has(feature.id)}
                onChange={(event) => {
                  setOff((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(feature.id);
                    else next.delete(feature.id);
                    return next;
                  });
                }}
              />
              {feature.title} off
            </label>
          ))}
        </div>
      )}
      {unknown.length > 0 && (
        <p className="mt-2 text-xs text-fg-subtle">Also off, from another version: {unknown.join(', ')}</p>
      )}
      <div className="mt-2 flex gap-2">
        <Button
          variant="primary"
          data-testid={`workspace-policy-save-${workspace.id}`}
          disabled={known === undefined}
          onClick={() => {
            onSave([...off].sort());
          }}
        >
          Save
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** *New workspace…*'s form: a name and a default role. The Workspaces page and the Overview both show it. */
export function NewWorkspaceForm({ onDone }: { readonly onDone: () => void }) {
  const createWorkspace = useTeamStore((state) => state.createWorkspace);
  const [name, setName] = useState('');
  const [defaultRole, setDefaultRole] = useState<DefaultRoleWire>('viewer');

  const submitNew = async (): Promise<void> => {
    if (name.trim().length === 0) return;
    if (await createWorkspace(name.trim(), defaultRole)) onDone();
  };

  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded-lg border border-hairline bg-surface-raised p-3"
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
        className={`${INPUT_CLASS} min-w-40 flex-1`}
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
      <Button variant="ghost" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}

/**
 * The Workspaces page (teams-access §3.5): the team's workspaces the caller can see, one card each with the
 * caller's role and its source. Admins of a workspace manage it in its card; any member can create one.
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
  const deleteWorkspace = useTeamStore((state) => state.deleteWorkspace);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<TeamWorkspaceWire | undefined>(undefined);

  const inAccess = workspaces.find((workspace) => workspace.id === accessId);
  if (inAccess !== undefined) return <AccessPanel workspaceName={inAccess.name} />;

  return (
    <div data-testid="workspaces-tab" className="flex flex-col gap-3">
      {creating ? (
        <NewWorkspaceForm
          onDone={() => {
            setCreating(false);
          }}
        />
      ) : (
        <div className="flex justify-end">
          <Button
            variant="primary"
            data-testid="workspace-new"
            onClick={() => {
              setCreating(true);
            }}
          >
            <Plus size={14} aria-hidden="true" />
            New workspace…
          </Button>
        </div>
      )}

      {workspaces.length === 0 ? (
        <p className="py-6 text-center text-sm text-fg-subtle">No workspaces you can open in this team yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
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
