/**
 * Team settings' Server group (settings split spec §3; rulings 7, 8 and 9): the server's own pages, for its server
 * admins. Settings › Server's pages keep their bodies; the team dialog's License, Provisioning, Domain and Audit tabs
 * become pages here with a header each. A hosted team's deletion banner shows on every page but the one that closes
 * the account.
 */
import { DeletionBanner } from '../../preferences/server/close-account-section.js';
import { ServerPage } from '../../preferences/server/server-page.js';
import { isHosted, useServerSettingsStore, type ServerPageId } from '../../preferences/server/server-settings-store.js';
import { SettingsPageHeader } from '../../preferences/settings-shell.js';
import { ProvisioningSection } from '../../preferences/server/provisioning-section.js';
import { AuditTab } from '../audit-tab.js';
import { DomainTab } from '../domain-tab.js';
import { LicenseTab } from '../license-tab.js';
import { ProvisioningTab } from '../provisioning-tab.js';
import { SERVER_GROUP_PAGES, TEAM_PAGE_LABELS, type TeamSettingsPageId } from '../team-settings-model.js';

export type ServerGroupPageId = (typeof SERVER_GROUP_PAGES)[number];

/** The pages that were Settings › Server's: `ServerPage` draws them, header included. */
const SETTINGS_PAGES: ReadonlySet<ServerGroupPageId> = new Set<ServerPageId>([
  'sign-in',
  'email',
  'audit-forwarding',
  'retention',
  'export',
  'billing',
  'close-account',
]);

const SUBTITLES: Readonly<Record<'license' | 'provisioning' | 'domain' | 'audit', string>> = {
  license: 'This server’s license and its seats.',
  provisioning: 'How an identity provider creates people and puts them on teams.',
  domain: 'The address the team’s server answers on.',
  audit: 'What happened on this server, in every team: who did it and when.',
};

export function isServerGroupPage(page: TeamSettingsPageId): page is ServerGroupPageId {
  return (SERVER_GROUP_PAGES as readonly string[]).includes(page);
}

export function ServerGroupPage({
  page,
  url,
  settingsAvailable,
  teams,
  workspaces,
}: {
  readonly page: ServerGroupPageId;
  readonly url: string;
  /** The server answered its settings read: without it, Provisioning has no SCIM card of its own (ruling 8). */
  readonly settingsAvailable: boolean;
  readonly teams: readonly { readonly id: string; readonly name: string }[];
  readonly workspaces: readonly { readonly id: string; readonly name: string }[];
}) {
  const hosted = useServerSettingsStore((s) => s.url === url && isHosted(s.settings));
  if (SETTINGS_PAGES.has(page)) return <ServerPage page={page as ServerPageId} />;
  const own = page as keyof typeof SUBTITLES;
  return (
    <div data-testid={`team-page-${page}`}>
      <SettingsPageHeader title={TEAM_PAGE_LABELS[page]} subtitle={SUBTITLES[own]} />
      {hosted && <DeletionBanner />}
      {page === 'license' && <LicenseTab url={url} />}
      {page === 'provisioning' && (
        // SCIM first, then the groups (ruling 7).
        <div className="flex flex-col gap-6">
          {settingsAvailable && <ProvisioningSection />}
          <ProvisioningTab url={url} teams={teams} scim={!settingsAvailable} />
        </div>
      )}
      {page === 'domain' && <DomainTab url={url} />}
      {page === 'audit' && <AuditTab url={url} teamId={undefined} workspaces={workspaces} />}
    </div>
  );
}
