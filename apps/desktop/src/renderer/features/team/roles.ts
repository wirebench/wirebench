/**
 * Role names and labels for the teams dialog (teams-access §3.5). Restated rather than read from
 * the wire enums: the dialog needs values, and a value import from `shared/wire-types.ts` pulls
 * zod into the renderer, which the CSP forbids. `team-roles.test.ts` keeps the copies honest.
 */
import type { DefaultRoleWire, RoleSourceWire, TeamRoleWire, WorkspaceRoleWire } from '@shared/wire-base.js';

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

/** What a workspace role lets its holder do (settings split ruling 15); *Manage people* is a team role. */
export const WORKSPACE_ABILITIES = ['read', 'send', 'edit', 'share', 'manage-workspace'] as const;
export type WorkspaceAbility = (typeof WORKSPACE_ABILITIES)[number];

/** The least workspace role that may do each (ruling 15): the server's route guards, restated. */
export const ABILITY_MIN_ROLE: Readonly<Record<WorkspaceAbility, WorkspaceRoleWire>> = {
  read: 'viewer',
  send: 'viewer',
  edit: 'editor',
  share: 'admin',
  'manage-workspace': 'admin',
};

export const ABILITY_LABELS: Readonly<Record<WorkspaceAbility, string>> = {
  read: 'Open the workspace and read its requests',
  send: 'Send requests',
  edit: 'Change requests and sync them, CI tokens, catch URLs',
  share: 'Give people access',
  'manage-workspace': 'Rename, set the default role, delete',
};

const RANK: Readonly<Record<WorkspaceRoleWire, number>> = { viewer: 1, editor: 2, admin: 3 };

/** Whether `role` may do `ability`; no role (or `none`) may do nothing. */
export function roleCan(role: WorkspaceRoleWire | 'none' | undefined, ability: WorkspaceAbility): boolean {
  if (role === undefined || role === 'none') return false;
  return RANK[role] >= RANK[ABILITY_MIN_ROLE[ability]];
}

export const SELECT_CLASS =
  'h-row min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60';
export const INPUT_CLASS =
  'h-row min-w-0 rounded-md border border-hairline-strong bg-surface-base px-2 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent read-only:border-transparent read-only:bg-transparent';
