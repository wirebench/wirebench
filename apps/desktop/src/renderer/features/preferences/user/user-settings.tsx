/**
 * User settings (settings split spec §4): you, on every server. Profile, Password and Signed-in devices are about you
 * on one server — the picker's, shown when more than one is signed in — while Servers and CI tokens are this app's.
 */
import { useEffect, useState } from 'react';
import { CircleUser, KeyRound, MonitorSmartphone, Server, Smartphone, type LucideIcon } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { SettingsVariantProvider } from '../../../components/settings-grid.js';
import { signedInServers, useAccountStore } from '../../../state/account.js';
import { usePreferencesStore } from '../../../state/preferences.js';
import { useSyncStore } from '../../../state/sync.js';
import { useUiStore } from '../../../state/ui.js';
import { useUserSettingsStore } from '../../../state/user-settings.js';
import { TokensSection } from '../sections/tokens-section.js';
import { settingsServerUrl } from '../server/server-settings-store.js';
import { storedSectionModified } from '../settings-model.js';
import { SettingsNavGroup, SettingsNavItem, SettingsPageHeader, SettingsShell } from '../settings-shell.js';
import { USER_NAV, resolveUserPage, userNav, type UserSettingsPageId } from '../user-settings-model.js';
import { DevicesPage } from './devices-page.js';
import { PasswordPage } from './password-page.js';
import { ProfilePage } from './profile-page.js';
import { ServersPage } from './servers-page.js';

const ICONS: Readonly<Record<UserSettingsPageId, LucideIcon>> = {
  profile: CircleUser,
  password: KeyRound,
  servers: Server,
  devices: MonitorSmartphone,
  tokens: Smartphone,
};

/** The pages that read the picked server's profile. */
const PER_SERVER: ReadonlySet<UserSettingsPageId> = new Set<UserSettingsPageId>(['profile', 'password', 'devices']);

const PAGES = USER_NAV.flatMap((group) => group.pages);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function UserSettings({ initialPage }: { readonly initialPage?: UserSettingsPageId }) {
  const [requested, setRequested] = useState<UserSettingsPageId | undefined>(initialPage);
  const close = useUiStore((state) => state.setPreferencesOpen);
  const servers = useAccountStore((state) => state.servers);
  const signedIn = signedInServers(servers);
  const linked = useSyncStore((state) => (state.status.kind === 'server' ? state.status.remote : undefined));
  const [picked, setPicked] = useState<string | undefined>(undefined);
  // The picked server while it is still signed in; else the open workspace's, else the first.
  const url = signedIn.some((server) => server.url === picked) ? picked : settingsServerUrl(signedIn, linked);

  const profile = useUserSettingsStore((state) => (state.url === url ? state.profile : undefined));
  const loading = useUserSettingsStore((state) => state.loading);
  const error = useUserSettingsStore((state) => state.error);
  const preferences = usePreferencesStore((state) => state.preferences);
  const resetPreferences = usePreferencesStore((state) => state.reset);

  useEffect(() => {
    if (url === undefined) useUserSettingsStore.getState().reset();
    else void useUserSettingsStore.getState().load(url);
  }, [url]);
  useEffect(() => () => useUserSettingsStore.getState().reset(), []);

  // Password shows once the server says it signs in with passwords; a request for it waits for that answer.
  const facts = { localPasswords: profile?.localPasswords ?? false };
  const page = resolveUserPage(requested, facts);
  const entry = PAGES.find((candidate) => candidate.id === page)!;
  const serversModified = storedSectionModified(preferences, 'accounts');

  const nav = userNav(facts).map((group) => (
    <SettingsNavGroup key={group.title} title={group.title}>
      {group.pages.map((item) => (
        <SettingsNavItem
          key={item.id}
          label={item.label}
          icon={ICONS[item.id]}
          current={item.id === page}
          modified={item.id === 'servers' && serversModified}
          testId={`user-settings-nav-${item.id}`}
          onSelect={() => {
            setRequested(item.id);
          }}
        />
      ))}
    </SettingsNavGroup>
  ));

  const header =
    signedIn.length > 1 ? (
      <label className="block text-xs text-fg-subtle">
        Server
        <select
          data-testid="user-settings-server"
          value={url}
          onChange={(event) => {
            setPicked(event.target.value);
          }}
          className="mt-1 h-7 w-full rounded-md border border-hairline bg-surface-raised px-2 text-sm text-fg-default focus:border-accent focus:outline-none"
        >
          {signedIn.map((server) => (
            <option key={server.url} value={server.url}>
              {hostOf(server.url)}
            </option>
          ))}
        </select>
      </label>
    ) : undefined;

  const body = (() => {
    if (PER_SERVER.has(page)) {
      if (url === undefined) {
        return (
          <p data-testid="user-settings-signed-out" className="text-sm text-fg-subtle">
            Sign in to a Wirebench Server to see this page.
          </p>
        );
      }
      if (profile === undefined) {
        return error !== undefined && !loading ? (
          <p role="alert" data-testid="user-settings-error" className="text-sm text-status-danger">
            {error}
          </p>
        ) : (
          <p className="text-sm text-fg-subtle">Loading…</p>
        );
      }
    }
    switch (page) {
      case 'profile':
        // Keyed by server and name, so a new answer replaces the field's draft.
        return <ProfilePage key={`${url ?? ''}:${profile!.user.displayName}`} profile={profile!} />;
      case 'password':
        return <PasswordPage key={url} profile={profile!} />;
      case 'devices':
        return <DevicesPage />;
      case 'servers':
        return <ServersPage />;
      case 'tokens':
        return <TokensSection />;
    }
  })();

  return (
    <SettingsVariantProvider variant="card">
      <SettingsShell
        area="user"
        nav={nav}
        {...(header === undefined ? {} : { header })}
        onBack={() => {
          close(false);
        }}
      >
        <SettingsPageHeader
          title={entry.label}
          subtitle={entry.subtitle}
          actions={
            page === 'servers' ? (
              <Button
                variant="ghost"
                data-testid="user-servers-reset"
                disabled={!serversModified}
                onClick={() => {
                  void resetPreferences('accounts');
                }}
              >
                Reset to defaults
              </Button>
            ) : undefined
          }
        />
        <div data-testid={`user-settings-page-${page}`}>{body}</div>
      </SettingsShell>
    </SettingsVariantProvider>
  );
}
