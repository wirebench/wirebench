/**
 * Role names and labels for the teams dialog (teams-access §3.5). Restated rather than read from
 * the wire enums: the dialog needs values, and a value import from `shared/wire-types.ts` pulls
 * zod into the renderer, which the CSP forbids. `team-roles.test.ts` keeps the copies honest.
 */
import type { DefaultRoleWire, RoleSourceWire, TeamRoleWire, WorkspaceRoleWire } from '../../../shared/wire-types.js';

export const TEAM_ROLES: readonly TeamRoleWire[] = ['member', 'admin'];
export const WORKSPACE_ROLES: readonly WorkspaceRoleWire[] = ['viewer', 'editor', 'admin'];
export const DEFAULT_ROLES: readonly DefaultRoleWire[] = ['none', 'viewer', 'editor'];

export const ROLE_LABELS: Readonly<Record<TeamRoleWire | WorkspaceRoleWire | DefaultRoleWire, string>> = {
  member: 'Member',
  admin: 'Admin',
  viewer: 'Viewer',
  editor: 'Editor',
  none: 'No access',
};

export const SOURCE_LABELS: Readonly<Record<RoleSourceWire, string>> = {
  'server-admin': 'server admin',
  'team-admin': 'team admin',
  grant: 'granted',
  default: 'workspace default',
};

/** `Editor (granted)`: a role and where it comes from, as the Workspaces tab and the access panel show it. */
export function roleWithSource(role: WorkspaceRoleWire, source: RoleSourceWire): string {
  return `${ROLE_LABELS[role]} (${SOURCE_LABELS[source]})`;
}

export const SELECT_CLASS =
  'h-row min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60';
export const INPUT_CLASS =
  'h-row min-w-0 rounded-md border border-hairline-strong bg-surface-base px-2 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent read-only:border-transparent read-only:bg-transparent';
