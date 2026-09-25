import { describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '@wirebench/engine';
import { atLeast, CAPABILITIES, resolveRole, type Effective, type RoleFacts } from '../../../src/teams/roles.js';

const BASE: RoleFacts = {
  disabled: false,
  serverAdmin: false,
  teamRole: undefined,
  grant: undefined,
  defaultRole: 'viewer',
};

describe('resolveRole — the §3.1 table, first match wins', () => {
  const rows: readonly [string, Partial<RoleFacts>, Effective][] = [
    [
      'a disabled user has nothing, even a server admin who is team admin',
      { disabled: true, serverAdmin: true, teamRole: 'admin' },
      { role: 'none' },
    ],
    [
      'a server admin is admin everywhere, on no team',
      { serverAdmin: true },
      { role: 'admin', source: 'server-admin' },
    ],
    [
      'a team admin is admin of every team workspace, whatever the grant',
      { teamRole: 'admin', grant: 'viewer' },
      { role: 'admin', source: 'team-admin' },
    ],
    [
      'a grant raises a member above the default',
      { teamRole: 'member', grant: 'editor' },
      { role: 'editor', source: 'grant' },
    ],
    [
      'a grant lowers a member below the default',
      { teamRole: 'member', grant: 'viewer', defaultRole: 'editor' },
      { role: 'viewer', source: 'grant' },
    ],
    [
      'a grant still applies when the default is none',
      { teamRole: 'member', grant: 'viewer', defaultRole: 'none' },
      { role: 'viewer', source: 'grant' },
    ],
    [
      'a member without a grant gets the default role',
      { teamRole: 'member', defaultRole: 'editor' },
      { role: 'editor', source: 'default' },
    ],
    ['default none hides the workspace from a member', { teamRole: 'member', defaultRole: 'none' }, { role: 'none' }],
    ['someone on no team has nothing', {}, { role: 'none' }],
    ['a grant without membership grants nothing', { grant: 'admin' }, { role: 'none' }],
  ];
  for (const [name, facts, expected] of rows) {
    it(name, () => {
      expect(resolveRole({ ...BASE, ...facts })).toEqual(expected);
    });
  }
});

describe('ranks and capabilities', () => {
  const ROLES: readonly WorkspaceRole[] = ['viewer', 'editor', 'admin'];

  it('atLeast orders viewer < editor < admin', () => {
    expect(ROLES.map((role) => ROLES.map((min) => atLeast(role, min)))).toEqual([
      [true, false, false],
      [true, true, false],
      [true, true, true],
    ]);
  });

  it('the capability table agrees with the ranks the guards compare', () => {
    for (const role of ROLES) {
      expect(CAPABILITIES[role].pull && CAPABILITIES[role].send).toBe(true);
      expect(CAPABILITIES[role].push).toBe(atLeast(role, 'editor'));
      expect(CAPABILITIES[role].manage).toBe(atLeast(role, 'admin'));
      expect(CAPABILITIES[role].delete).toBe(atLeast(role, 'admin'));
    }
  });
});
