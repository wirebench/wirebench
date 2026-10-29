import { Button } from '../../../components/button.js';
import { hasCapability, tabSignOut } from '../../../lib/capabilities.js';
import { BooleanSetting, SettingsGroup, SettingsItem } from '../../../components/settings-grid.js';
import { signedInServers, useAccountStore } from '../../../state/account.js';
import { useUiStore } from '../../../state/ui.js';
import { LicenseBanner } from '../../team/license-banner.js';
import type { SectionProps } from './section-props.js';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Preferences → Accounts (identity spec §3.9): every known server, its state, and the two
 * actions per row. The list itself is not a preference — it lives in `accounts.yaml` in main and
 * arrives through the account store — only the status bar toggle is.
 *
 * Without `accounts` (a browser tab, whose one account the server holds) it shows only the session's
 * row, signed out through `env.signOut`; adding, removing and signing in to servers is the desktop's.
 */
export function AccountsSection({ preferences, update }: SectionProps) {
  const known = useAccountStore((state) => state.servers);
  const manage = hasCapability('accounts');
  const endTab = tabSignOut();
  const session = signedInServers(known)[0] ?? known[0];
  const servers = manage ? known : session === undefined ? [] : [session];
  const signOut = useAccountStore((state) => state.signOut);
  const remove = useAccountStore((state) => state.remove);
  const openSignInDialog = useUiStore((state) => state.openSignInDialog);
  const openTeamDialog = useUiStore((state) => state.openTeamDialog);

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
                  key={server.url}
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
                          openTeamDialog(server.url);
                        }}
                      >
                        Manage teams…
                      </Button>
                      {(manage || endTab !== undefined) && (
                        <Button
                          data-testid="account-row-sign-out"
                          onClick={() => {
                            // A tab ends its own session; `account.signOut` is the desktop's.
                            if (manage) void signOut(server.url);
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
                        void remove(server.url);
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
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
      <SettingsGroup title="Status bar">
        <BooleanSetting
          label="Show sign-in in the status bar"
          setting="accounts.showInStatusBar"
          value={preferences.accounts.showInStatusBar}
          testId="accounts-show-in-status-bar"
          onChange={(showInStatusBar) => {
            update({ accounts: { showInStatusBar } });
          }}
          hint="Once a server is known, the status bar shows who you are signed in as."
        />
      </SettingsGroup>
    </div>
  );
}
