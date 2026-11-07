/**
 * Team settings' menu (settings split spec §2, §3; rulings 6 and 8): which pages a caller sees, from what the
 * server said about them. Pure, so every caller's menu is tested; a page the caller may not see is never resolved
 * to, even when the address names it. The server checks every write again regardless.
 */

export const TEAM_PAGES = ['overview', 'people', 'workspaces', 'roles', 'audit'] as const;
/** The Server group, in the nav's order (spec §2). */
export const SERVER_GROUP_PAGES = [
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
] as const;
export type TeamSettingsPageId = (typeof TEAM_PAGES)[number] | (typeof SERVER_GROUP_PAGES)[number];

export interface TeamNavFacts {
  readonly hasTeam: boolean;
  readonly teamAdmin: boolean;
  readonly serverAdmin: boolean;
  /** The server answered its settings read (`serverSettings.get`). */
  readonly settingsAvailable: boolean;
  readonly hosted: boolean;
  /** The domain read answered. */
  readonly domain: boolean;
}

export interface TeamNavGroup {
  readonly title: 'This team' | 'Server';
  readonly pages: readonly TeamSettingsPageId[];
}

/** Server pages that need only `serverAdmin` (ruling 8); the rest wait for the settings read. */
const ADMIN_ONLY: ReadonlySet<TeamSettingsPageId> = new Set(['license', 'provisioning', 'audit']);
const HOSTED_ONLY: ReadonlySet<TeamSettingsPageId> = new Set(['billing', 'close-account']);

function serverPageShown(page: (typeof SERVER_GROUP_PAGES)[number], facts: TeamNavFacts): boolean {
  if (ADMIN_ONLY.has(page)) return true;
  if (page === 'domain') return facts.domain;
  if (!facts.settingsAvailable) return false;
  return !HOSTED_ONLY.has(page) || facts.hosted;
}

export function teamNav(facts: TeamNavFacts): readonly TeamNavGroup[] {
  const groups: TeamNavGroup[] = [];
  if (facts.hasTeam) {
    // A team admin who is not a server admin keeps their team's Audit log here (ruling 6).
    const audit = facts.teamAdmin && !facts.serverAdmin;
    groups.push({
      title: 'This team',
      pages: ['overview', 'people', 'workspaces', 'roles', ...(audit ? (['audit'] as const) : [])],
    });
  }
  if (facts.serverAdmin) {
    groups.push({ title: 'Server', pages: SERVER_GROUP_PAGES.filter((page) => serverPageShown(page, facts)) });
  }
  return groups;
}

export const DEFAULT_TEAM_PAGE: TeamSettingsPageId = 'people';

/** A page `teamNav(facts)` lists, else People, else the first listed page when there is no team. */
export function resolveTeamPage(page: string | undefined, facts: TeamNavFacts): TeamSettingsPageId | undefined {
  const listed = teamNav(facts).flatMap((group) => group.pages);
  return listed.find((id) => id === page) ?? listed.find((id) => id === DEFAULT_TEAM_PAGE) ?? listed[0];
}

export const TEAM_PAGE_LABELS: Readonly<Record<TeamSettingsPageId, string>> = {
  overview: 'Overview',
  people: 'People',
  workspaces: 'Workspaces',
  roles: 'What roles can do',
  audit: 'Audit log',
  license: 'License and seats',
  'sign-in': 'Sign-in',
  provisioning: 'Provisioning',
  domain: 'Domain',
  email: 'Email',
  'audit-forwarding': 'Audit forwarding',
  retention: 'Retention',
  export: 'Export',
  billing: 'Billing',
  'close-account': 'Close this account',
};
