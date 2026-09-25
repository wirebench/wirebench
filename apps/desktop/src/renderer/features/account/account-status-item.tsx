import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { UserRound } from 'lucide-react';
import { signedInServers, useAccountStore } from '../../state/account.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { useUiStore } from '../../state/ui.js';

const ITEM_CLASS =
  'flex cursor-default select-none items-center rounded-sm px-2 py-1 text-sm text-fg-default outline-none data-[highlighted]:bg-surface-hover';

/** `https://wb.test:8443` → `wb.test:8443`, for test ids and short labels. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The `·` separator the status bar uses between items; carried by the item itself so none
 * dangles when the item renders `null`. */
function Separator() {
  return (
    <span aria-hidden="true" className="text-fg-faint">
      ·
    </span>
  );
}

/**
 * The status bar's account item (identity spec §3.8). Hidden until a server is known and while
 * `accounts.showInStatusBar` is off. A signed-out server shows *Sign in*, which reopens the
 * dialog on that URL; a signed-in one shows the email with a menu holding *Sign out of <server>*
 * per server, *Manage teams…* and *Manage accounts…*.
 */
export function AccountStatusItem() {
  const servers = useAccountStore((state) => state.servers);
  const show = usePreferencesStore((state) => state.preferences.accounts.showInStatusBar);
  const openSignInDialog = useUiStore((state) => state.openSignInDialog);
  const openPreferences = useUiStore((state) => state.openPreferences);
  const openTeamDialog = useUiStore((state) => state.openTeamDialog);
  const signOut = useAccountStore((state) => state.signOut);
  const [open, setOpen] = useState(false);

  if (!show || servers.length === 0) return null;

  const signedIn = signedInServers(servers);
  const first = signedIn[0];
  if (first === undefined) {
    const known = servers[0]!;
    return (
      <>
        <Separator />
        <button
          type="button"
          data-testid="status-bar-account"
          data-state="signed-out"
          title={`Sign in to ${known.url}`}
          className="flex items-center gap-1 rounded-sm px-1 hover:bg-surface-hover hover:text-fg-default"
          onClick={() => {
            openSignInDialog(known.url);
          }}
        >
          <UserRound size={12} aria-hidden="true" />
          Sign in
        </button>
      </>
    );
  }

  const label = signedIn.length === 1 ? first.email : `${first.email} +${String(signedIn.length - 1)}`;
  return (
    <>
      <Separator />
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            data-testid="status-bar-account"
            data-state="signed-in"
            title="Account"
            aria-label={`Account: ${label}`}
            className="flex items-center gap-1 rounded-sm px-1 hover:bg-surface-hover hover:text-fg-default"
          >
            <UserRound size={12} aria-hidden="true" />
            {label}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="top"
            align="start"
            sideOffset={4}
            data-testid="status-bar-account-menu"
            className="z-50 min-w-48 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
          >
            {signedIn.map((server) => (
              <DropdownMenu.Item
                key={server.url}
                data-testid={`account-sign-out-${hostOf(server.url)}`}
                className={ITEM_CLASS}
                onSelect={() => {
                  void signOut(server.url);
                }}
              >
                Sign out of {server.url}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
            <DropdownMenu.Item
              data-testid="account-manage-teams"
              className={ITEM_CLASS}
              onSelect={() => {
                openTeamDialog();
              }}
            >
              Manage teams…
            </DropdownMenu.Item>
            <DropdownMenu.Item
              data-testid="account-manage"
              className={ITEM_CLASS}
              onSelect={() => {
                openPreferences('accounts');
              }}
            >
              Manage accounts…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  );
}
