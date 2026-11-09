import { describe, expect, it } from 'vitest';
import {
  resolveTeamPage,
  teamNav,
  TEAM_PAGE_LABELS,
  TEAM_PAGES,
  SERVER_GROUP_PAGES,
  type TeamNavFacts,
} from '../../src/renderer/features/team/team-settings-model.js';

const facts = (over: Partial<TeamNavFacts> = {}): TeamNavFacts => ({
  hasTeam: true,
  teamAdmin: false,
  serverAdmin: false,
  settingsAvailable: false,
  hosted: false,
  domain: false,
  ...over,
});

const TEAM = ['overview', 'people', 'workspaces', 'roles'];

describe('Team settings menu (settings split spec §2, rulings 6 and 8)', () => {
  it.each([
    ['a member', facts(), [{ title: 'This team', pages: TEAM }]],
    ['a team admin', facts({ teamAdmin: true }), [{ title: 'This team', pages: [...TEAM, 'audit'] }]],
    [
      'a self-hosted server admin on a team with settings',
      facts({ teamAdmin: true, serverAdmin: true, settingsAvailable: true }),
      [
        { title: 'This team', pages: TEAM },
        {
          title: 'Server',
          pages: ['license', 'sign-in', 'provisioning', 'email', 'audit', 'audit-forwarding', 'retention', 'export'],
        },
      ],
    ],
    [
      'a hosted server admin with a domain',
      facts({ serverAdmin: true, settingsAvailable: true, hosted: true, domain: true }),
      [
        { title: 'This team', pages: TEAM },
        {
          title: 'Server',
          pages: [
            'license',
            'sign-in',
            'provisioning',
            'domain',
            'email',
            'audit',
            'audit-forwarding',
            'retention',
            'export',
            'billing',
            'close-account',
          ],
        },
      ],
    ],
    [
      'a server admin of an older server',
      facts({ serverAdmin: true }),
      [
        { title: 'This team', pages: TEAM },
        { title: 'Server', pages: ['license', 'provisioning', 'audit'] },
      ],
    ],
  ])('%s', (_who, given, expected) => {
    expect(teamNav(given)).toEqual(expected);
  });

  it('a server admin with no team has the Server group only', () => {
    expect(teamNav(facts({ hasTeam: false, serverAdmin: true }))).toEqual([
      { title: 'Server', pages: ['license', 'provisioning', 'audit'] },
    ]);
  });

  it('resolveTeamPage falls back to Overview, to the first page without a team, and to undefined for a member with no team', () => {
    expect(resolveTeamPage('workspaces', facts())).toBe('workspaces');
    expect(resolveTeamPage(undefined, facts())).toBe('overview');
    expect(resolveTeamPage('nope', facts())).toBe('overview');
    // Listed only for a server admin.
    expect(resolveTeamPage('sign-in', facts())).toBe('overview');
    expect(resolveTeamPage('people', facts({ hasTeam: false, serverAdmin: true }))).toBe('license');
    expect(resolveTeamPage('audit', facts({ hasTeam: false, serverAdmin: true }))).toBe('audit');
    expect(resolveTeamPage('people', facts({ hasTeam: false }))).toBeUndefined();
  });

  it('labels every page', () => {
    for (const page of [...TEAM_PAGES, ...SERVER_GROUP_PAGES]) expect(TEAM_PAGE_LABELS[page]).toBeTruthy();
    expect(TEAM_PAGE_LABELS['close-account']).toBe('Close this account');
  });
});
