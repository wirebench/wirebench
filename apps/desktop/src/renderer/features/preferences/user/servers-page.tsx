import { useCallback, useMemo } from 'react';
import { Button } from '../../../components/button.js';
import { hasCapability, tabSignOut, tabSignOutAll } from '../../../lib/capabilities.js';
import {
  BooleanSetting,
  SettingsGroup,
  SettingsItem,
  SettingsRowsControllerProvider,
  type SettingsRowsController,
} from '../../../components/settings-grid.js';
import { isLockedByPolicy, usePreferencesStore } from '../../../state/preferences.js';
import { accountKey, useActiveAccount, useAccountStore } from '../../../state/account.js';
import { useUiStore } from '../../../state/ui.js';
import { LicenseBanner } from '../../team/license-banner.js';
import { manageTeam } from '../../team/team-link.js';
import type { SectionProps } from '../sections/section-props.js';
import { canReset, isModified, resetPatch } from '../settings-model.js';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Accounts (identity spec §3.9), shown as User settings → Servers you're signed in to and, until the App settings
 * Account group goes, there too: every known server, its state, and the two
 * actions per row. The list itself is not a preference — it lives in `accounts.yaml` in main and
 * arrives through the account store — only the status bar toggle is.
 *
 * Without `accounts` (a browser tab, whose accounts the server holds) it shows only the active account's row, signed
 * out through `env.signOut`, and *Sign out of all accounts in this browser* (`env.signOutAll`, switch accounts spec
 * §5.4); adding, removing and signing in to servers is the desktop's. Two accounts may share a server, so a row and
 * its actions are about one account.
 */
export function AccountsSection({ preferences, update }: SectionProps) {
  const known = useAccountStore((state) => state.servers);
  const manage = hasCapability('accounts');
  const endTab = tabSignOut();
  const endAll = tabSignOutAll();
  const session = useActiveAccount() ?? known.find((server) => server.remembered !== true);
  // The browser's other accounts are the account menu's to switch to; this page lists the desktop's accounts.
  const servers = manage
    ? known.filter((server) => server.remembered !== true)
    : session === undefined
      ? []
      : [session];
  const signOut = useAccountStore((state) => state.signOut);
  const remove = useAccountStore((state) => state.remove);
  const openSignInDialog = useUiStore((state) => state.openSignInDialog);

  return (
    <div data-testid="accounts-section">
      <SettingsGroup
        title="Servers"
        hint={
          manage
            ? 'Where you are signed in. Removing a server also signs out of it.'
            : 'The server this tab is signed in to. Add other servers in the desktop app.'
        }
      >
        <SettingsItem>
          {servers.length === 0 ? (
            <p className="text-sm text-fg-subtle">No servers yet.</p>
          ) : (
            <ul className="divide-y divide-hairline">
              {servers.map((server) => (
                <li
                  key={accountKey(server)}
                  data-testid={`account-row-${hostOf(server.url)}`}
                  className="flex items-center gap-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-fg-default">{server.url}</div>
                    <div className="truncate text-xs text-fg-subtle">
                      {server.email} · {server.displayName} · {server.signedOut ? 'Signed out' : 'Signed in'} ·{' '}
                      {server.deviceName}
                    </div>
                    {!server.signedOut && <LicenseBanner url={server.url} />}
                  </div>
                  {server.signedOut ? (
                    manage && (
                      <Button
                        data-testid="account-row-sign-in"
                        onClick={() => {
                          openSignInDialog(server.url);
                        }}
                      >
                        Sign in
                      </Button>
                    )
                  ) : (
                    <>
                      <Button
                        data-testid="account-row-manage-teams"
                        onClick={() => {
                          void manageTeam(server.url);
                        }}
                      >
                        Manage team…
                      </Button>
                      {(manage || endTab !== undefined) && (
                        <Button
                          data-testid="account-row-sign-out"
                          onClick={() => {
                            // A tab ends its own session; `account.signOut` is the desktop's.
                            if (manage) void signOut({ url: server.url, userId: server.userId });
                            else endTab?.();
                          }}
                        >
                          Sign out
                        </Button>
                      )}
                    </>
                  )}
                  {manage && (
                    <Button
                      variant="ghost"
                      data-testid="account-row-remove"
                      onClick={() => {
                        void remove({ url: server.url, userId: server.userId });
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!manage && endAll !== undefined && (
            <div className="mt-2">
              <Button
                data-testid="accounts-sign-out-all"
                onClick={() => {
                  endAll();
                }}
              >
                Sign out of all accounts in this browser
              </Button>
            </div>
          )}
          {manage && (
            <div className="mt-2">
              <Button
                variant="primary"
                data-testid="accounts-add-server"
                onClick={() => {
                  openSignInDialog();
                }}
              >
                Add server…
              </Button>
            </div>
          )}
        </SettingsItem>
      </SettingsGroup>
      <SettingsGroup title="Title bar">
        <BooleanSetting
          label="Show your account at the top right"
          setting="accounts.showInStatusBar"
          value={preferences.accounts.showInStatusBar}
          testId="accounts-show-in-status-bar"
          onChange={(showInStatusBar) => {
            update({ accounts: { showInStatusBar } });
          }}
          hint="Once a server is known, the title bar shows who you are signed in as, with your account menu."
        />
      </SettingsGroup>
    </div>
  );
}

/**
 * User settings → Servers you're signed in to: the Accounts list and its *Status bar* switch (ruling 14), wired to
 * the preferences store, since this page is not inside App settings' editor.
 */
export function ServersPage() {
  const preferences = usePreferencesStore((state) => state.preferences);
  const update = usePreferencesStore((state) => state.update);
  const policy = usePreferencesStore((state) => state.policy);
  const locked = useCallback((key: string) => isLockedByPolicy(policy, key), [policy]);
  const controller: SettingsRowsController = useMemo(
    () => ({
      isModified: (key) => isModified(preferences, key),
      canReset: (key) => canReset(preferences, key),
      reset: (key) => {
        void update(resetPatch(preferences, [key]));
      },
      locked,
    }),
    [preferences, update, locked],
  );
  return (
    <SettingsRowsControllerProvider controller={controller}>
      <AccountsSection
        preferences={preferences}
        update={(patch) => {
          void update(patch);
        }}
        locked={locked}
      />
    </SettingsRowsControllerProvider>
  );
}
