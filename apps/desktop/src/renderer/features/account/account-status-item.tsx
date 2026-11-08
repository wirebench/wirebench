import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, LogOut, MonitorSmartphone, UserRound, Users } from 'lucide-react';
import { PersonAvatar } from '../../components/person-avatar.js';
import { tabSignOut } from '../../lib/capabilities.js';
import { signedInServers, useAccountStore } from '../../state/account.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { useUiStore } from '../../state/ui.js';
import { manageTeam } from '../team/team-link.js';

const ITEM_CLASS =
  'flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-surface-hover';

/** `https://wb.test:8443` → `wb.test:8443`, for test ids and short labels. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The account menu at the top right of the title bar (identity spec §3.8). Hidden until a server is known and while
 * `accounts.showInStatusBar` is off (the setting keeps its stored name). A signed-out server shows *Sign in*, which
 * reopens the dialog on that URL; a signed-in one shows an avatar and the email, with a menu holding *Account
 * settings…* and *Signed-in devices…* (User settings, settings split ruling 13), *Manage team…* (team management in
 * the browser §2.1) and *Sign out of <server>* per server. In a browser tab (`env.signOut` set) the per-server items
 * give way to one *Sign out*, which ends the tab's session.
 */
export function AccountStatusItem() {
  const servers = useAccountStore((state) => state.servers);
  const show = usePreferencesStore((state) => state.preferences.accounts.showInStatusBar);
  const openSignInDialog = useUiStore((state) => state.openSignInDialog);
  const openUserSettings = useUiStore((state) => state.openUserSettings);
  const signOut = useAccountStore((state) => state.signOut);
  const [open, setOpen] = useState(false);
  const endTab = tabSignOut();

  if (!show || servers.length === 0) return null;

  const signedIn = signedInServers(servers);
  const first = signedIn[0];
  if (first === undefined) {
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

  const label = signedIn.length === 1 ? first.email : `${first.email} +${String(signedIn.length - 1)}`;
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid="status-bar-account"
          data-state="signed-in"
          title={label}
          aria-label={`Account: ${label}`}
          className="flex h-row max-w-64 items-center gap-1.5 rounded-md pr-1.5 pl-1 text-sm text-fg-muted hover:bg-surface-hover hover:text-fg-default focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          <PersonAvatar
            url={first.url}
            userId={first.userId}
            name={first.displayName}
            photo={first.photo ?? null}
            size="sm"
            testId="status-bar-account-avatar"
          />
          <span className="truncate">{label}</span>
          <ChevronDown size={12} aria-hidden="true" className="shrink-0 text-fg-subtle" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={6}
          data-testid="status-bar-account-menu"
          className="z-dropdown w-64 rounded-lg border border-hairline-strong bg-surface-overlay p-1 shadow-lg"
        >
          <div data-testid="account-menu-header" className="flex items-center gap-2.5 px-2 py-2">
            <PersonAvatar
              url={first.url}
              userId={first.userId}
              name={first.displayName}
              photo={first.photo ?? null}
              size="md"
              testId="account-menu-avatar"
            />
            <div className="min-w-0">
              <div className="truncate text-sm text-fg-default">{first.displayName}</div>
              <div className="truncate text-xs text-fg-subtle">
                {first.username ? `@${first.username} · ${first.email}` : first.email}
              </div>
              <div className="truncate text-xs text-fg-faint">
                {signedIn.length === 1 ? hostOf(first.url) : `Signed in to ${String(signedIn.length)} servers`}
              </div>
            </div>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
          <DropdownMenu.Item
            data-testid="account-manage"
            className={ITEM_CLASS}
            onSelect={() => {
              openUserSettings('servers');
            }}
          >
            <UserRound size={14} aria-hidden="true" className="text-fg-subtle" />
            Account settings…
          </DropdownMenu.Item>
          <DropdownMenu.Item
            data-testid="account-devices"
            className={ITEM_CLASS}
            onSelect={() => {
              openUserSettings('devices');
            }}
          >
            <MonitorSmartphone size={14} aria-hidden="true" className="text-fg-subtle" />
            Signed-in devices…
          </DropdownMenu.Item>
          <DropdownMenu.Item
            data-testid="account-manage-teams"
            className={ITEM_CLASS}
            onSelect={() => {
              void manageTeam();
            }}
          >
            <Users size={14} aria-hidden="true" className="text-fg-subtle" />
            Manage team…
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
          {endTab !== undefined ? (
            // A browser tab: the server holds its account, so the tab signs its session out.
            <DropdownMenu.Item
              data-testid="account-sign-out"
              className={ITEM_CLASS}
              onSelect={() => {
                endTab();
              }}
            >
              <LogOut size={14} aria-hidden="true" className="text-fg-subtle" />
              Sign out
            </DropdownMenu.Item>
          ) : (
            signedIn.map((server) => (
              <DropdownMenu.Item
                key={server.url}
                data-testid={`account-sign-out-${hostOf(server.url)}`}
                className={ITEM_CLASS}
                onSelect={() => {
                  void signOut(server.url);
                }}
              >
                <LogOut size={14} aria-hidden="true" className="text-fg-subtle" />
                <span className="truncate">Sign out of {server.url}</span>
              </DropdownMenu.Item>
            ))
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
