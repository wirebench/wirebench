import { describe, expect, it } from 'vitest';
import {
  ABILITY_LABELS,
  ABILITY_MIN_ROLE,
  DEFAULT_ROLES,
  WORKSPACE_ABILITIES,
  roleCan,
  ROLE_LABELS,
  SOURCE_LABELS,
  TEAM_ROLES,
  WORKSPACE_ROLES,
  roleWithSource,
} from '../../src/renderer/features/team/roles.js';
import {
  defaultRoleWireSchema,
  roleSourceWireSchema,
  teamRoleWireSchema,
  workspaceRoleWireSchema,
} from '@wirebench/wire/wire-base';

describe('team role labels (teams-access §3.5)', () => {
  it('restates the wire enums exactly', () => {
    expect(TEAM_ROLES).toEqual(teamRoleWireSchema.options);
    expect(WORKSPACE_ROLES).toEqual(workspaceRoleWireSchema.options);
    expect(DEFAULT_ROLES).toEqual(defaultRoleWireSchema.options);
    expect(Object.keys(SOURCE_LABELS).sort()).toEqual([...roleSourceWireSchema.options].sort());
  });

  it('labels every role, and names where a role comes from', () => {
    for (const role of [...TEAM_ROLES, ...WORKSPACE_ROLES, ...DEFAULT_ROLES]) expect(ROLE_LABELS[role]).toBeTruthy();
    expect(ROLE_LABELS.none).toBe('No access');
    expect(roleWithSource('editor', 'grant')).toBe('Editor (granted)');
    expect(roleWithSource('admin', 'team-admin')).toBe('Admin (team admin)');
    expect(roleWithSource('viewer', 'default')).toBe('Viewer (workspace default)');
    expect(roleWithSource('admin', 'server-admin')).toBe('Admin (server admin)');
  });

  it('ABILITY_MIN_ROLE matches the server’s route guards', () => {
    expect(ABILITY_MIN_ROLE).toEqual({
      // sync/routes/head.ts, log.ts, snapshot.ts, changes.ts: requireWorkspaceRole('viewer')
      read: 'viewer',
      // the same pull routes: anyone who can read the workspace sends from it
      send: 'viewer',
      // sync/routes/commits.ts: requireWorkspaceRole('editor'); CI tokens and catch URLs follow it
      edit: 'editor',
      // teams/routes/access.ts: requireWorkspaceRole('admin')
      share: 'admin',
      // teams/routes/workspaces.ts (update, delete): requireWorkspaceRole('admin')
      'manage-workspace': 'admin',
    });
    for (const ability of WORKSPACE_ABILITIES) expect(ABILITY_LABELS[ability]).toBeTruthy();
  });

  it('roleCan ranks viewer < editor < admin and refuses none', () => {
    expect(roleCan('viewer', 'send')).toBe(true);
    expect(roleCan('viewer', 'edit')).toBe(false);
    expect(roleCan('editor', 'edit')).toBe(true);
    expect(roleCan('editor', 'share')).toBe(false);
    expect(roleCan('admin', 'manage-workspace')).toBe(true);
    expect(roleCan('none', 'read')).toBe(false);
    expect(roleCan(undefined, 'read')).toBe(false);
  });
});
