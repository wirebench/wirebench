/**
 * Team settings (settings split spec §3): the team and its server, as a page in the window. The browser client's
 * way to manage a team; the desktop keeps the Team dialog only for a server without the browser client.
 *
 * Which pages show comes from `teamNav` over what the server said about the caller, and a page the caller may not
 * see is never rendered, even when the address names it. The server checks every write again regardless.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  Archive,
  BadgeCheck,
  CreditCard,
  Download,
  Globe,
  LayoutDashboard,
  LogIn,
  Mail,
  ScrollText,
  Send,
  ShieldCheck,
  Trash2,
  Users,
  UsersRound,
  FolderKanban,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '../../../components/button.js';
import { useActiveAccount } from '../../../state/account.js';
import { useDomainStore } from '../../../state/domain.js';
import { useLicenseStore } from '../../../state/license.js';
import { selectedTeam, teamWorkspaces, useTeamStore } from '../../../state/team.js';
import { useUiStore, type TeamSettingsTarget } from '../../../state/ui.js';
import { isHosted, useServerSettingsStore } from '../../preferences/server/server-settings-store.js';
import {
  SettingsNavGroup,
  SettingsNavItem,
  SettingsPageHeader,
  SettingsShell,
} from '../../preferences/settings-shell.js';
import { AuditTab } from '../audit-tab.js';
import { LicenseBanner } from '../license-banner.js';
import {
  TEAM_PAGE_LABELS,
  resolveTeamPage,
  teamNav,
  type TeamNavFacts,
  type TeamSettingsPageId,
} from '../team-settings-model.js';
import { WorkspacesTab } from '../workspaces-tab.js';
import { OverviewPage } from './overview-page.js';
import { PeoplePage } from './people-page.js';
import { RolesPage } from './roles-page.js';
import { isServerGroupPage, ServerGroupPage } from './server-pages.js';
import { NewTeamDialog, TeamSwitcher } from './team-switcher.js';
import { useTeamAddress } from './use-team-address.js';

const ICONS: Readonly<Record<TeamSettingsPageId, LucideIcon>> = {
  overview: LayoutDashboard,
  people: Users,
  workspaces: FolderKanban,
  roles: ShieldCheck,
  audit: ScrollText,
  license: BadgeCheck,
  'sign-in': LogIn,
  provisioning: UsersRound,
  domain: Globe,
  email: Mail,
  'audit-forwarding': Send,
  retention: Archive,
  export: Download,
  billing: CreditCard,
  'close-account': Trash2,
};

const SUBTITLES: Readonly<Partial<Record<TeamSettingsPageId, string>>> = {
  overview: 'The team at a glance: its people, its workspaces and what’s left to set up.',
  people: 'Everyone on the team, and the invitations still open.',
  workspaces: 'The team’s workspaces and who can open them.',
  roles: 'What Viewer, Editor and Admin may do in a workspace.',
  audit: 'What happened, who did it and when.',
};

function PageBody({
  page,
  url,
}: {
  readonly page: TeamSettingsPageId;
  readonly url: string;
  readonly facts: TeamNavFacts;
}): ReactNode {
  const store = useTeamStore();
  const team = selectedTeam(store);
  switch (page) {
    case 'overview':
      return <OverviewPage />;
    case 'people':
      return <PeoplePage />;
    case 'workspaces':
      return <WorkspacesTab />;
    case 'roles':
      return <RolesPage />;
    case 'audit':
      return (
        <AuditTab
          url={url}
          teamId={store.serverAdmin ? undefined : team?.id}
          workspaces={teamWorkspaces(store).map((workspace) => ({ id: workspace.id, name: workspace.name }))}
        />
      );
    default:
      return null;
  }
}

/** A page: a server admin's Server pages are `ServerGroupPage`'s (the This team Audit log is a team admin's). */
function Page({
  page,
  url,
  facts,
}: {
  readonly page: TeamSettingsPageId;
  readonly url: string;
  readonly facts: TeamNavFacts;
}) {
  const store = useTeamStore();
  if (facts.serverAdmin && isServerGroupPage(page)) {
    return (
      <ServerGroupPage
        page={page}
        url={url}
        settingsAvailable={facts.settingsAvailable}
        teams={store.teams.map((item) => ({ id: item.id, name: item.name }))}
        workspaces={teamWorkspaces(store).map((workspace) => ({ id: workspace.id, name: workspace.name }))}
      />
    );
  }
  return (
    <div data-testid={`team-page-${page}`}>
      <SettingsPageHeader title={TEAM_PAGE_LABELS[page]} subtitle={SUBTITLES[page] ?? ''} />
      <PageBody page={page} url={url} facts={facts} />
    </div>
  );
}

export function TeamSettings({ target }: { readonly target: TeamSettingsTarget }) {
  // Unless asked for a server, the active account's (switch accounts spec §4).
  const activeUrl = useActiveAccount()?.url;
  const url = target.url ?? activeUrl;
  const store = useTeamStore();
  const team = selectedTeam(store);
  const license = useLicenseStore((s) => s.state);
  const [creating, setCreating] = useState(false);

  // Loads the team on its server, and lets go of it on the way out.
  useEffect(() => {
    if (url === undefined) return undefined;
    void useTeamStore.getState().open(url, target);
    return () => {
      useTeamStore.getState().reset();
    };
  }, [url, target]);

  // The Server group's reads (ruling 8): the domain and the server's own settings, a server admin's only.
  const admin = store.serverAdmin && !store.signedOut;
  useEffect(() => {
    if (url === undefined || !admin) return undefined;
    void useDomainStore.getState().load(url);
    void useServerSettingsStore.getState().load(url);
    return () => {
      useDomainStore.getState().reset();
      useServerSettingsStore.getState().reset();
    };
  }, [url, admin]);

  // Primitive selectors: a read counts only once it is of this server.
  const domainAvailable = useDomainStore((s) => s.url === url && s.available);
  const domainLoaded = useDomainStore((s) => s.url === url && s.loaded);
  const settingsAvailable = useServerSettingsStore((s) => s.url === url && s.available);
  const settingsLoaded = useServerSettingsStore((s) => s.url === url && s.loaded);
  const hosted = useServerSettingsStore((s) => s.url === url && isHosted(s.settings));
  const facts: TeamNavFacts = {
    hasTeam: team !== undefined,
    teamAdmin: team?.myRole === 'admin',
    serverAdmin: store.serverAdmin,
    settingsAvailable,
    hosted,
    domain: domainAvailable,
  };
  // A server admin's menu waits for the Server group's reads, so a Server page the address names is not dropped
  // before they answer.
  // …and a selected team that is not in the list (mid-switch) is no state to settle the page on.
  const ready =
    !store.loading &&
    (store.teamId === undefined || team !== undefined) &&
    (!store.serverAdmin || (settingsLoaded && domainLoaded));
  const shown = !facts.hasTeam && store.page === undefined ? undefined : resolveTeamPage(store.page, facts);

  useEffect(() => {
    if (ready && shown !== undefined && shown !== store.page) useTeamStore.getState().setPage(shown);
  }, [ready, shown, store.page]);
  useTeamAddress(store.teamId, ready ? shown : undefined);

  const leave = (): void => {
    useUiStore.getState().setPreferencesOpen(false);
  };

  const nav = teamNav(facts).map((group) => (
    <SettingsNavGroup key={group.title} title={group.title}>
      {group.pages.map((page) => (
        <SettingsNavItem
          key={page}
          label={TEAM_PAGE_LABELS[page]}
          icon={ICONS[page]}
          current={ready && page === shown}
          danger={page === 'close-account'}
          testId={`team-settings-nav-${page}`}
          onSelect={() => {
            store.setPage(page);
          }}
        />
      ))}
    </SettingsNavGroup>
  ));

  let body: ReactNode;
  if (store.signedOut) {
    body = (
      <div data-testid="team-signed-out" className="flex flex-col items-start gap-3 text-sm text-fg-subtle">
        <p>{url} no longer accepts this session.</p>
        <Button
          variant="primary"
          data-testid="team-sign-in-again"
          onClick={() => {
            leave();
            useUiStore.getState().openSignInDialog(url);
          }}
        >
          Sign in again
        </Button>
      </div>
    );
  } else if (url === undefined) {
    body = <p className="text-sm text-fg-subtle">Sign in to a server to manage its teams.</p>;
  } else if (!ready) {
    body = <p className="text-sm text-fg-subtle">Loading…</p>;
  } else if (shown === undefined) {
    body = store.serverAdmin ? (
      <div data-testid="team-settings-empty" className="flex flex-col items-start gap-3">
        <h1 className="text-[22px] leading-tight font-semibold text-fg-default">Create your first team</h1>
        <p className="text-sm text-fg-subtle">A team holds people and the workspaces they share.</p>
        <Button
          variant="primary"
          onClick={() => {
            setCreating(true);
          }}
        >
          New team…
        </Button>
      </div>
    ) : (
      <p data-testid="team-settings-empty" className="text-sm text-fg-subtle">
        You’re not on a team on this server yet. A server admin can add you.
      </p>
    );
  } else {
    body = (
      <>
        {store.serverAdmin && <LicenseBanner url={url} {...(license !== undefined ? { state: license } : {})} />}
        <Page page={shown} url={url} facts={facts} />
      </>
    );
  }

  return (
    <>
      <SettingsShell
        area="team"
        header={
          store.signedOut || url === undefined ? undefined : (
            <TeamSwitcher
              onNewTeam={() => {
                setCreating(true);
              }}
            />
          )
        }
        nav={store.signedOut ? null : nav}
        onBack={leave}
      >
        {body}
      </SettingsShell>
      <NewTeamDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
