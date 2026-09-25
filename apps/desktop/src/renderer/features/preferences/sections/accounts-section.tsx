import { Button } from '../../../components/button.js';
import { BooleanSetting, SettingsGroup } from '../../../components/settings-grid.js';
import { useAccountStore } from '../../../state/account.js';
import { useUiStore } from '../../../state/ui.js';
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
 */
export function AccountsSection({ preferences, update }: SectionProps) {
  const servers = useAccountStore((state) => state.servers);
  const signOut = useAccountStore((state) => state.signOut);
  const remove = useAccountStore((state) => state.remove);
  const openSignInDialog = useUiStore((state) => state.openSignInDialog);

  return (
    <div data-testid="accounts-section">
      <SettingsGroup title="Servers" hint="Where you are signed in. Removing a server also signs out of it.">
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
                </div>
                {server.signedOut ? (
                  <Button
                    data-testid="account-row-sign-in"
                    onClick={() => {
                      openSignInDialog(server.url);
                    }}
                  >
                    Sign in
                  </Button>
                ) : (
                  <Button
                    data-testid="account-row-sign-out"
                    onClick={() => {
                      void signOut(server.url);
                    }}
                  >
                    Sign out
                  </Button>
                )}
                <Button
                  variant="ghost"
                  data-testid="account-row-remove"
                  onClick={() => {
                    void remove(server.url);
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
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
      </SettingsGroup>
      <SettingsGroup title="Status bar">
        <BooleanSetting
          label="Show sign-in in the status bar"
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
