/**
 * A team's workspaces as rows, on Overview and on Workspaces: the name, when and by whom it was made, who may open it
 * (the default role and how many have a grant), your role, and an *Open now* mark on the one open here. A row opens
 * that workspace's overview.
 */
import { ChevronRight, FolderKanban } from 'lucide-react';
import type { TeamWorkspaceWire } from '@shared/wire-base.js';
import { useTeamStore } from '../../../state/team.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { ROLE_LABELS } from '../roles.js';
import { accessSummary, createdSummary } from './overview.js';

export function WorkspaceList({ workspaces }: { readonly workspaces: readonly TeamWorkspaceWire[] }) {
  const openWorkspacePage = useTeamStore((s) => s.openWorkspacePage);
  const share = useWorkspaceStore((s) => s.workspace?.share);
  const openNow = share?.kind === 'server' ? share.server?.workspaceId : undefined;
  const now = new Date();

  return (
    <ul className="overflow-hidden rounded-lg border border-hairline bg-surface-raised">
      {workspaces.map((workspace, index) => {
        const created = createdSummary(workspace.createdAt, workspace.createdByName, now);
        return (
          <li key={workspace.id} className={index > 0 ? 'border-t border-hairline' : ''}>
            <button
              type="button"
              data-testid="team-workspace-row"
              data-workspace-id={workspace.id}
              onClick={() => {
                openWorkspacePage(workspace.id);
              }}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none focus-visible:ring-inset"
            >
              <FolderKanban size={14} aria-hidden="true" className="shrink-0 text-fg-subtle" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-fg-default">{workspace.name}</span>
                <span data-testid="team-workspace-row-detail" className="truncate text-xs text-fg-subtle">
                  {[created, accessSummary(workspace.defaultRole, workspace.grantCount)]
                    .filter((part) => part !== '')
                    .join(' · ')}
                </span>
              </span>
              {workspace.id === openNow && (
                <span className="shrink-0 rounded-full bg-accent-muted px-2 text-xs text-fg-default">Open now</span>
              )}
              <span className="shrink-0 rounded-full bg-surface-hover px-2 text-xs text-fg-subtle">
                {ROLE_LABELS[workspace.myRole]}
              </span>
              <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-fg-subtle" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
