import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLES,
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
} from '../../src/shared/wire-types.js';

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
});
