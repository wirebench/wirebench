/**
 * The renderer's mirror of the accounts (identity spec §5.4, switch accounts spec §2): the list main keeps in
 * `accounts.yaml`, minus anything secret, and which one is **active**. Fed by `account.changed`; the dialog performs
 * the sign-in steps itself so a password never enters a store.
 *
 * An account is one person on one server, so two may share a URL: everything here is keyed by `url` and `userId`.
 * In a browser tab the host lists only the tab's own account; the other accounts the browser holds are read by the
 * page itself (`env.rememberedAccounts`, with its cookie) and kept beside it as `remembered` rows, which only the
 * browser can switch to.
 */
import { create } from 'zustand';
import type { IpcError } from '@shared/ipc.js';
import type { AccountChangedEvent, AccountRefWire, AccountWire } from '@shared/wire-base.js';
import { showToast } from '../components/toast.js';
import { tabRememberedAccounts, tabSignOut, tabSwitchAccount, type TabRememberedAccount } from '../lib/capabilities.js';
import { ipc } from './ipc-client.js';
import { useUiStore } from './ui.js';
import { useWorkspaceStore } from './workspace.js';

/** What the account menu, User settings and the team surfaces act as: a URL alone stands for that server's account. */
export type AccountTarget = string | AccountRefWire;

export interface AccountStore {
  /** Every account main knows, then (in a browser tab) the other accounts the browser holds. */
  readonly servers: readonly AccountWire[];
  /** The active account (switch accounts spec §2); `null` when none is signed in. */
  readonly active: AccountRefWire | null;
  /** True once `account.list` has answered, so the status bar does not flash "no account". */
  readonly loaded: boolean;
  readonly load: () => Promise<void>;
  /**
   * Applies an `account.changed` payload (main's accounts, and the active one when it says); toasts a sign-out the
   * user did not ask for. The browser's remembered rows are kept: main does not list them.
   */
  readonly applyChanged: (servers: readonly AccountWire[], active?: AccountRefWire | null) => void;
  /**
   * Makes `account` active: through `account.setActive` on the desktop, and for another account a browser tab's
   * browser holds through `env.switchAccount`, which reloads the tab as them. Toasts who you are now.
   */
  readonly setActive: (account: AccountRefWire) => Promise<boolean>;
  /** Signs `target` out; resolves `true` when main did. In a browser tab, ends the tab's active session instead. */
  readonly signOut: (target: AccountTarget) => Promise<boolean>;
  readonly remove: (target: AccountTarget) => Promise<boolean>;
}

/** The accounts with a live session. */
export function signedInServers(servers: readonly AccountWire[]): readonly AccountWire[] {
  return servers.filter((server) => !server.signedOut);
}

/** One key per account: two accounts may share a server. */
export function accountKey(account: AccountRefWire): string {
  return `${account.url}#${account.userId}`;
}

export function sameAccount(a: AccountRefWire, b: AccountRefWire): boolean {
  return a.url === b.url && a.userId === b.userId;
}

/** `https://wb.test:8443` → `wb.test:8443`, for short labels. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The active account's row; `undefined` when none is signed in. A list without an active one (a host from before
 * switching) reads its first signed-in account as active, as there always is one while any is signed in.
 */
export function activeAccount(servers: readonly AccountWire[], active: AccountRefWire | null): AccountWire | undefined {
  const named =
    active === null ? undefined : servers.find((server) => sameAccount(server, active) && !server.signedOut);
  return named ?? servers.find((server) => !server.signedOut && server.remembered !== true);
}

/**
 * *Switch accounts*' rows (spec §2): every account but `current`, signed in first, each group most recently active
 * first. Rows with no `lastActiveAt` (the browser's remembered ones) keep the order they came in, which is the
 * server's: most recent first.
 */
export function otherAccounts(
  servers: readonly AccountWire[],
  current: AccountRefWire | undefined,
): readonly AccountWire[] {
  const rank = (account: AccountWire): number => (account.signedOut ? 1 : 0);
  return servers
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => current === undefined || !sameAccount(account, current))
    .sort(
      (a, b) =>
        rank(a.account) - rank(b.account) ||
        (b.account.lastActiveAt ?? '').localeCompare(a.account.lastActiveAt ?? '') ||
        a.index - b.index,
    )
    .map(({ account }) => account);
}

/** Whether the accounts are on more than one server, when the menu names each one's host. */
export function serversDiffer(servers: readonly AccountWire[]): boolean {
  return new Set(servers.map((server) => server.url)).size > 1;
}

/** The active account a list says: its `active` flag, else none. */
function activeOf(servers: readonly AccountWire[]): AccountRefWire | null {
  const row = servers.find((server) => server.active === true && !server.signedOut);
  return row === undefined ? null : { url: row.url, userId: row.userId };
}

/** The account `target` names among `servers`: exactly, or for a URL alone the active one there, else the first. */
function resolve(
  servers: readonly AccountWire[],
  active: AccountRefWire | null,
  target: AccountTarget,
): AccountRefWire | undefined {
  if (typeof target !== 'string') return target;
  const current = activeAccount(servers, active);
  if (current !== undefined && current.url === target) return { url: current.url, userId: current.userId };
  const row = servers.find((server) => server.url === target);
  return row === undefined ? undefined : { url: row.url, userId: row.userId };
}

/** The other accounts a browser tab's browser holds, as rows beside the tab's own; never the active one. */
function rememberedRows(
  rows: readonly TabRememberedAccount[],
  url: string,
  hostRows: readonly AccountWire[],
): AccountWire[] {
  return rows
    .filter((row) => !hostRows.some((server) => server.url === url && server.userId === row.userId))
    .map((row) => ({
      url,
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
      deviceName: 'Web browser',
      signedOut: false,
      addedAt: '',
      username: row.username,
      photo: row.photo,
      active: false,
      lastActiveAt: null,
      remembered: true,
    }));
}

/** Sign-outs the user asked for, so the resulting `account.changed` is not reported as a surprise. */
const expectedSignOuts = new Set<string>();

/** "Now signed in as Bob on wb.test.", and that an open workspace keeps syncing as the account it was opened with. */
function toastSwitched(now: AccountWire, previous: AccountWire | undefined): void {
  showToast(`Now signed in as ${now.displayName} on ${hostOf(now.url)}.`);
  const share = useWorkspaceStore.getState().workspace?.share;
  const shared = share?.kind === 'server' ? share.server : undefined;
  if (previous === undefined || shared === undefined) return;
  let sameServer: boolean;
  try {
    sameServer = new URL(shared.url).origin === new URL(previous.url).origin;
  } catch {
    sameServer = shared.url === previous.url;
  }
  // Spec ruling 4: the workspace never changes account; say so when it was the previous account's.
  if (sameServer)
    showToast(`The open workspace keeps syncing as ${previous.displayName}, the account it was opened with.`);
}

export const useAccountStore = create<AccountStore>((set, get) => {
  /** Main's rows plus the browser's remembered ones (read afresh by {@link AccountStore.load}). */
  let remembered: readonly TabRememberedAccount[] = [];
  const merged = (hostRows: readonly AccountWire[], active: AccountRefWire | null): readonly AccountWire[] => {
    if (remembered.length === 0) return hostRows;
    const url = active?.url ?? hostRows[0]?.url;
    return url === undefined ? hostRows : [...hostRows, ...rememberedRows(remembered, url, hostRows)];
  };
  const hostRowsOf = (servers: readonly AccountWire[]): readonly AccountWire[] =>
    servers.filter((server) => server.remembered !== true);

  return {
    servers: [],
    active: null,
    loaded: false,

    load: async () => {
      const readRemembered = tabRememberedAccounts();
      const [result, rows] = await Promise.all([
        ipc().account.list(undefined),
        readRemembered === undefined ? Promise.resolve(undefined) : readRemembered(),
      ]);
      if (rows !== undefined) remembered = rows;
      if (!result.ok) {
        set({ loaded: true });
        return;
      }
      const hostRows = result.value.servers;
      const active = result.value.active ?? activeOf(hostRows);
      set({ servers: merged(hostRows, active), active, loaded: true });
    },

    applyChanged: (servers, activeArg) => {
      const hostRows = hostRowsOf(servers);
      const active = activeArg !== undefined ? activeArg : activeOf(hostRows);
      const before = new Map(get().servers.map((server) => [accountKey(server), server]));
      for (const server of hostRows) {
        const key = accountKey(server);
        const previous = before.get(key);
        if (server.signedOut && previous !== undefined && !previous.signedOut) {
          if (expectedSignOuts.delete(key)) {
            showToast(`Signed out of ${server.url}`);
          } else {
            showToast(`Signed out of ${server.url}: the server no longer accepts this session.`, {
              label: 'Sign in again',
              onClick: () => {
                useUiStore.getState().openSignInDialog(server.url);
              },
            });
          }
        }
      }
      set({ servers: merged(hostRows, active), active, loaded: true });
    },

    setActive: async (account) => {
      const { servers, active } = get();
      const previous = activeAccount(servers, active);
      if (previous !== undefined && sameAccount(previous, account)) return true;
      const row = servers.find((server) => sameAccount(server, account));
      const switchInBrowser = tabSwitchAccount();
      // Another account the browser holds: the browser switches, and the tab reloads as them.
      if (row?.remembered === true && switchInBrowser !== undefined) {
        switchInBrowser(account.userId);
        return true;
      }
      const result = await ipc().account.setActive({ account });
      if (!result.ok) {
        if (result.error.code === 'account-switch-in-browser' && switchInBrowser !== undefined) {
          switchInBrowser(account.userId);
          return true;
        }
        showToast(`Could not switch accounts: ${result.error.message}`);
        return false;
      }
      get().applyChanged(result.value.servers, result.value.active ?? activeOf(result.value.servers));
      const now = activeAccount(get().servers, get().active);
      if (now !== undefined) toastSwitched(now, previous);
      return true;
    },

    signOut: async (target) => {
      // A browser tab ends its active session; another account the browser holds becomes active, else none.
      const endTab = tabSignOut();
      if (endTab !== undefined) {
        endTab();
        return true;
      }
      const account = resolve(get().servers, get().active, target);
      const key = account === undefined ? undefined : accountKey(account);
      if (key !== undefined) expectedSignOuts.add(key);
      const result = await ipc().account.signOut(account === undefined ? { url: target as string } : { account });
      if (!result.ok) {
        if (key !== undefined) expectedSignOuts.delete(key);
        showToast(`Could not sign out: ${result.error.message}`);
        return false;
      }
      get().applyChanged(result.value.servers, result.value.active);
      return true;
    },

    remove: async (target) => {
      const account = resolve(get().servers, get().active, target);
      const key = account === undefined ? undefined : accountKey(account);
      if (key !== undefined) expectedSignOuts.add(key);
      const result = await ipc().account.remove(account === undefined ? { url: target as string } : { account });
      if (key !== undefined) expectedSignOuts.delete(key);
      if (!result.ok) {
        showToast(`Could not remove the server: ${result.error.message}`);
        return false;
      }
      const hostRows = result.value.servers;
      const active = result.value.active !== undefined ? result.value.active : activeOf(hostRows);
      set({ servers: merged(hostRows, active), active });
      return true;
    },
  };
});

/** The active account's row, live; `undefined` when none is signed in. */
export function useActiveAccount(): AccountWire | undefined {
  const servers = useAccountStore((state) => state.servers);
  const active = useAccountStore((state) => state.active);
  return activeAccount(servers, active);
}

/** Called once from the shell, next to `subscribeToSync`; returns the unsubscribe. */
export function subscribeToAccounts(): () => void {
  return window.wirebench.on('account.changed', ((payload: AccountChangedEvent) => {
    useAccountStore.getState().applyChanged(payload.servers, payload.active);
  }) as (payload: unknown) => void);
}

/** What the Sign in dialog shows for each way a step can fail; the server's message otherwise. */
const SIGN_IN_MESSAGES: Readonly<Record<string, string>> = {
  'server-url-invalid': 'Enter the server address as a URL, such as https://wirebench.example.com.',
  'server-unreachable': 'Could not reach that address. Check the URL, your network and the proxy settings.',
  'server-not-wirebench': 'That address is not a Wirebench Server.',
  'server-api-version': 'This server needs a newer Wirebench. Update the app and try again.',
  'server-bad-response': 'The server answered in a way Wirebench did not understand.',
  'identity-invalid-credentials': 'Wrong email, username or password.',
  'identity-user-disabled': 'This account is disabled. Ask a server admin.',
  'identity-method-disabled': 'The server does not allow this way of signing in.',
  'identity-rate-limited': 'Too many attempts. Wait a minute and try again.',
  'identity-invitation-invalid': 'This invitation code is not valid, was already used, or has expired.',
  'identity-password-too-short': 'Choose a password of at least 12 characters.',
  'identity-user-exists': 'An account with this email already exists. Sign in instead.',
  'identity-not-invited': 'No account or open invitation exists for this email. Ask a server admin to invite you.',
  'identity-email-unverified': 'The identity provider did not confirm your email address, so it cannot be linked.',
  'identity-oidc-refused': 'The identity provider refused the sign-in.',
  'identity-oidc-failed': 'The identity provider did not complete the sign-in.',
  'account-sign-in-pending': 'A sign-in is already waiting for the browser.',
  'account-sign-in-timeout': 'The browser did not come back in time. Try again.',
  'account-sign-in-cancelled': 'Sign-in cancelled.',
  'external-url-refused': 'The server returned a sign-in address that is not http(s); nothing was opened.',
  'identity-flow-invalid': 'The sign-in took too long or was already used. Try again.',
  'identity-saml-refused': "The identity provider's response was not accepted.",
  'identity-saml-no-email': 'The identity provider did not send an email address for this account.',
  'identity-saml-transient-nameid':
    'The identity provider sent a one-time identifier. Ask your admin to send a persistent NameID.',
  'licensing-feature-required': 'SAML sign-in needs an Enterprise license on this server. Ask a server admin.',
};

export function signInErrorMessage(error: IpcError): string {
  // licensing §3.8: the server's message, then who can fix it. No other text.
  if (error.code === 'licensing-seat-limit') return `${error.message} Ask a server admin.`;
  return SIGN_IN_MESSAGES[error.code] ?? error.message;
}
