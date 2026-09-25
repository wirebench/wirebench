import { Button } from '../../components/button.js';
import { useTeamStore } from '../../state/team.js';
import type { AccessEntryWire, WorkspaceRoleWire } from '../../../shared/wire-types.js';
import { ROLE_LABELS, SELECT_CLASS, WORKSPACE_ROLES, roleWithSource } from './roles.js';

/** A grant can neither lower nor raise these; the select says so by being disabled. */
const FIXED_SOURCES = new Set(['team-admin', 'server-admin']);

function effectiveLabel(entry: AccessEntryWire): string {
  return entry.effectiveRole === 'none' || entry.source === undefined
    ? ROLE_LABELS.none
    : roleWithSource(entry.effectiveRole, entry.source);
}

/**
 * *Access…* for one workspace (teams-access §3.5): every team member, the role they end up with and
 * why, and a grant select. *Use default* clears the grant, so the member falls back to the default role.
 */
export function AccessPanel({ workspaceName }: { readonly workspaceName: string }) {
  const entries = useTeamStore((state) => state.access?.entries ?? []);
  const closeAccess = useTeamStore((state) => state.closeAccess);
  const setAccess = useTeamStore((state) => state.setAccess);
  const clearAccess = useTeamStore((state) => state.clearAccess);

  return (
    <div data-testid="access-panel" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" data-testid="access-back" onClick={closeAccess}>
          ← Workspaces
        </Button>
        <span className="text-sm font-medium text-fg-default">Access to {workspaceName}</span>
      </div>
      <ul className="divide-y divide-hairline">
        {entries.map((entry) => {
          const fixed = entry.source !== undefined && FIXED_SOURCES.has(entry.source);
          return (
            <li key={entry.userId} data-testid={`access-row-${entry.userId}`} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-fg-default">
                  {entry.displayName}
                  {entry.disabled && <span className="ml-2 text-xs text-fg-faint">disabled</span>}
                </div>
                <div className="truncate text-xs text-fg-subtle">
                  {entry.email} · team {ROLE_LABELS[entry.teamRole].toLowerCase()}
                </div>
              </div>
              <span data-testid={`access-effective-${entry.userId}`} className="text-sm text-fg-muted">
                {effectiveLabel(entry)}
              </span>
              <select
                data-testid={`access-grant-${entry.userId}`}
                aria-label={`Grant for ${entry.email}`}
                className={SELECT_CLASS}
                disabled={fixed}
                title={fixed ? 'Admins always administer the workspace.' : undefined}
                value={entry.grant ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === '') void clearAccess(entry.userId);
                  else void setAccess(entry.userId, value as WorkspaceRoleWire);
                }}
              >
                <option value="">Use default</option>
                {WORKSPACE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
