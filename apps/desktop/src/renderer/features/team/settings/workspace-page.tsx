/**
 * Team settings › a workspace's overview, opened from a workspace row: the way back (Overview › Workspaces), its
 * card (name, your role, Access… and Delete, and for its admins who may open it by default, recording and features),
 * when and by whom it was made, and who can open it with which role, which those who may share it can change.
 */
import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { teamWorkspaces, useTeamStore } from '../../../state/team.js';
import { AccessPanel } from '../access-panel.js';
import { roleCan } from '../roles.js';
import { WorkspaceRow } from '../workspaces-tab.js';
import { accessSummary, createdSummary } from './overview.js';

const CRUMB_CLASS =
  'rounded px-1 text-fg-subtle hover:bg-surface-hover hover:text-fg-default focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none';

export function WorkspacePage() {
  const store = useTeamStore();
  const workspace = teamWorkspaces(store).find((item) => item.id === store.workspaceId);
  const [deleting, setDeleting] = useState(false);
  const canShare = workspace !== undefined && roleCan(workspace.myRole, 'share');
  const id = workspace?.id;

  // Who can open it: the access list, for those who may change it.
  useEffect(() => {
    if (id !== undefined && canShare) void useTeamStore.getState().openAccess(id);
  }, [id, canShare]);

  const crumbs = (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm">
      <button
        type="button"
        className={CRUMB_CLASS}
        onClick={() => {
          store.setPage('overview');
        }}
      >
        Overview
      </button>
      <ChevronRight size={12} aria-hidden="true" className="text-fg-subtle" />
      <button
        type="button"
        data-testid="workspace-page-back"
        className={CRUMB_CLASS}
        onClick={() => {
          store.setPage('workspaces');
        }}
      >
        Workspaces
      </button>
      {workspace !== undefined && (
        <>
          <ChevronRight size={12} aria-hidden="true" className="text-fg-subtle" />
          <span className="px-1 text-fg-default">{workspace.name}</span>
        </>
      )}
    </nav>
  );

  if (workspace === undefined) {
    return (
      <div data-testid="workspace-page" className="flex flex-col gap-4">
        {crumbs}
        <p data-testid="workspace-page-missing" className="text-sm text-fg-subtle">
          This workspace is not in the team any more, or you can’t open it.
        </p>
      </div>
    );
  }

  const created = createdSummary(workspace.createdAt, workspace.createdByName, new Date());
  return (
    <div data-testid="workspace-page" className="flex flex-col gap-5">
      {crumbs}
      <ul>
        <WorkspaceRow
          workspace={workspace}
          onDelete={() => {
            setDeleting(true);
          }}
        />
      </ul>
      <p data-testid="workspace-page-facts" className="text-sm text-fg-subtle">
        {[created, accessSummary(workspace.defaultRole, workspace.grantCount)]
          .filter((part) => part !== '')
          .join(' · ')}
      </p>
      {canShare && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-fg-default">Who can open it</h2>
          <AccessPanel workspaceName={workspace.name} embedded />
        </section>
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${workspace.name}?`}
        description="Its repository is removed from the server. Copies already on members' machines stay, but stop syncing."
        confirmLabel="Delete workspace"
        destructive
        testId="workspace-delete-confirm"
        confirmTestId="workspace-delete-confirm-ok"
        onConfirm={() => {
          void store.deleteWorkspace(workspace.id).then((done) => {
            if (done) useTeamStore.getState().setPage('workspaces');
          });
        }}
      />
    </div>
  );
}
