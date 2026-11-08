import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { CircleUser, LogOut, Settings, UserPlus, UserRound } from 'lucide-react';
import type { AccountWire } from '@shared/wire-base.js';
import { PersonAvatar } from '../../components/person-avatar.js';
import { tabAddAccount, tabSignOut } from '../../lib/capabilities.js';
import { activeAccount, hostOf, otherAccounts, serversDiffer, useAccountStore } from '../../state/account.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { useUiStore } from '../../state/ui.js';

const ITEM_CLASS =
  'flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-surface-hover';

/** `name@username · email`, or the email alone. */
function handleOf(account: AccountWire): string {
  return account.username ? `@${account.username} · ${account.email}` : account.email;
}

/**
 * The account menu at the top right of the title bar (identity spec §3.8, switch accounts spec §3). Hidden until an
 * account is known and while `accounts.showInStatusBar` is off (the setting keeps its stored name). With none signed
 * in it shows *Sign in*, which reopens the dialog on the last server. Signed in, the trigger is the active account's
 * photo alone (the email is its tooltip), and the menu holds, in order (plan ruling 10): a header (photo, name, `@username · email`, and the
 * host when your accounts are on more than one server), *View profile*, *Settings*, *Sign out* of the active account,
 * then *Switch accounts* — every other account, most recently active first, signed-out desktop ones dimmed with
 * *Sign in* — and *Add account*. *Manage team…* and the other User settings pages are in Settings and the palette.
 */
export function AccountStatusItem() {
  const servers = useAccountStore((state) => state.servers);
  const activeRef = useAccountStore((state) => state.active);
  const show = usePreferencesStore((state) => state.preferences.accounts.showInStatusBar);
  const openSignInDialog = useUiStore((state) => state.openSignInDialog);
  const openUserSettings = useUiStore((state) => state.openUserSettings);
  const signOut = useAccountStore((state) => state.signOut);
  const setActive = useAccountStore((state) => state.setActive);
  const [open, setOpen] = useState(false);

  if (!show || servers.length === 0) return null;

  const current = activeAccount(servers, activeRef);
  if (current === undefined) {
    const known = servers[0]!;
    return (
      <button
        type="button"
        data-testid="status-bar-account"
        data-state="signed-out"
        title={`Sign in to ${known.url}`}
        className="flex h-row items-center gap-1.5 rounded-md px-2 text-sm text-fg-muted hover:bg-surface-hover hover:text-fg-default focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        onClick={() => {
          openSignInDialog(known.url);
        }}
      >
        <UserRound size={14} aria-hidden="true" />
        Sign in
      </button>
    );
  }

  const others = otherAccounts(servers, current);
  const showHosts = serversDiffer(servers);
  const label = current.email;
  const addInBrowser = tabAddAccount();
  const endTab = tabSignOut();

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid="status-bar-account"
          data-state="signed-in"
          title={label}
          aria-label={`Account: ${label}`}
          className="flex h-row items-center rounded-md px-1 hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          <PersonAvatar
            url={current.url}
            userId={current.userId}
            name={current.displayName}
            photo={current.photo ?? null}
            size="sm"
            testId="status-bar-account-avatar"
          />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={6}
          data-testid="status-bar-account-menu"
          className="z-dropdown w-72 rounded-lg border border-hairline-strong bg-surface-overlay p-1 shadow-lg"
        >
          <div data-testid="account-menu-header" className="flex items-center gap-2.5 px-2 py-2">
            <PersonAvatar
              url={current.url}
              userId={current.userId}
              name={current.displayName}
              photo={current.photo ?? null}
              size="md"
              testId="account-menu-avatar"
            />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-fg-default">{current.displayName}</div>
              <div className="truncate text-xs text-fg-subtle">{handleOf(current)}</div>
              {showHosts && (
                <div data-testid="account-menu-host" className="truncate text-xs text-fg-faint">
                  {hostOf(current.url)}
                </div>
              )}
            </div>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
          <DropdownMenu.Item
            data-testid="account-view-profile"
            className={ITEM_CLASS}
            onSelect={() => {
              openUserSettings('profile');
            }}
          >
            <CircleUser size={14} aria-hidden="true" className="text-fg-subtle" />
            View profile
          </DropdownMenu.Item>
          <DropdownMenu.Item
            data-testid="account-settings"
            className={ITEM_CLASS}
            onSelect={() => {
              openUserSettings();
            }}
          >
            <Settings size={14} aria-hidden="true" className="text-fg-subtle" />
            Settings
          </DropdownMenu.Item>
          <DropdownMenu.Item
            data-testid="account-sign-out"
            className={ITEM_CLASS}
            onSelect={() => {
              // A browser tab ends its active session (`env.signOut`); the desktop revokes this account's token.
              if (endTab !== undefined) endTab();
              else void signOut({ url: current.url, userId: current.userId });
            }}
          >
            <LogOut size={14} aria-hidden="true" className="text-fg-subtle" />
            <span className="truncate">Sign out</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
          <DropdownMenu.Label className="px-2 pt-1 pb-0.5 text-xs font-medium text-fg-subtle">
            Switch accounts
          </DropdownMenu.Label>
          {others.map((account) => {
            const signedOut = account.signedOut;
            return (
              <DropdownMenu.Item
                key={`${account.url}#${account.userId}`}
                data-testid={`account-switch-${account.userId}`}
                data-state={signedOut ? 'signed-out' : 'signed-in'}
                className={ITEM_CLASS}
                onSelect={() => {
                  if (signedOut) openSignInDialog(account.url);
                  else void setActive({ url: account.url, userId: account.userId });
                }}
              >
                <span className={signedOut ? 'opacity-50' : undefined}>
                  <PersonAvatar
                    url={account.url}
                    userId={account.userId}
                    name={account.displayName}
                    photo={account.photo ?? null}
                    size="sm"
                    testId={`account-switch-avatar-${account.userId}`}
                  />
                </span>
                <span className={`min-w-0 flex-1 ${signedOut ? 'opacity-60' : ''}`}>
                  <span className="block truncate">{account.displayName}</span>
                  <span className="block truncate text-xs text-fg-subtle">
                    {showHosts ? `${account.email} · ${hostOf(account.url)}` : account.email}
                  </span>
                </span>
                {signedOut && <span className="shrink-0 text-xs text-accent">Sign in</span>}
              </DropdownMenu.Item>
            );
          })}
          <DropdownMenu.Item
            data-testid="account-add"
            className={ITEM_CLASS}
            onSelect={() => {
              // The browser's sign-in page adds without signing the active person out; the desktop's dialog
              // starts on the active server, editable.
              if (addInBrowser !== undefined) addInBrowser();
              else openSignInDialog(current.url);
            }}
          >
            <UserPlus size={14} aria-hidden="true" className="text-fg-subtle" />
            Add account
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
