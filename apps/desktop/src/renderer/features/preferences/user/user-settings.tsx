/**
 * User settings (settings split spec §4): you. Profile, Password and Signed-in devices are about the **active**
 * account (switch accounts spec §4), which the account menu switches; Servers and CI tokens are this app's.
 */
import { useEffect, useState } from 'react';
import { CircleUser, KeyRound, MonitorSmartphone, Server, Smartphone, type LucideIcon } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { SettingsVariantProvider } from '../../../components/settings-grid.js';
import { accountKey, useActiveAccount } from '../../../state/account.js';
import { usePreferencesStore } from '../../../state/preferences.js';
import { useUiStore } from '../../../state/ui.js';
import { useUserSettingsStore } from '../../../state/user-settings.js';
import { TokensSection } from '../sections/tokens-section.js';
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

/** The pages that read the active account's profile. */
const PER_SERVER: ReadonlySet<UserSettingsPageId> = new Set<UserSettingsPageId>(['profile', 'password', 'devices']);

const PAGES = USER_NAV.flatMap((group) => group.pages);

export function UserSettings({ initialPage }: { readonly initialPage?: UserSettingsPageId }) {
  const [requested, setRequested] = useState<UserSettingsPageId | undefined>(initialPage);
  const close = useUiStore((state) => state.setPreferencesOpen);
  const current = useActiveAccount();
  const url = current?.url;
  // Two accounts may share a server: switching between them must read afresh, so the page is keyed by account.
  const key = current === undefined ? undefined : accountKey(current);

  const profile = useUserSettingsStore((state) => (state.url === url ? state.profile : undefined));
  const loading = useUserSettingsStore((state) => state.loading);
  const error = useUserSettingsStore((state) => state.error);
  const preferences = usePreferencesStore((state) => state.preferences);
  const resetPreferences = usePreferencesStore((state) => state.reset);

  useEffect(() => {
    // Reset first, so another account's profile is never shown under this one, even on the same server. The host
    // reads a URL as that server's active account.
    useUserSettingsStore.getState().reset();
    if (url !== undefined) void useUserSettingsStore.getState().load(url);
  }, [key, url]);
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
        // Keyed by account and name, so a new answer replaces the field's draft.
        return <ProfilePage key={`${key ?? ''}:${profile!.user.displayName}`} profile={profile!} />;
      case 'password':
        return <PasswordPage key={key} profile={profile!} />;
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
