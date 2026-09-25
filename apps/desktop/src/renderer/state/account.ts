/**
 * The renderer's mirror of the known servers (identity spec §5.4): the list main keeps in
 * `accounts.yaml`, minus anything secret. Fed by `account.changed`; the dialog performs the
 * sign-in steps itself so a password never enters a store.
 */
import { create } from 'zustand';
import type { IpcError } from '../../shared/ipc.js';
import type { AccountChangedEvent, AccountWire } from '../../shared/wire-types.js';
import { showToast } from '../components/toast.js';
import { ipc } from './ipc-client.js';
import { useUiStore } from './ui.js';

export interface AccountStore {
  readonly servers: readonly AccountWire[];
  /** True once `account.list` has answered, so the status bar does not flash "no account". */
  readonly loaded: boolean;
  readonly load: () => Promise<void>;
  /** Applies an `account.changed` payload; toasts a sign-out the user did not ask for. */
  readonly applyChanged: (servers: readonly AccountWire[]) => void;
  /** Signs out of `url`; resolves `true` when main did. */
  readonly signOut: (url: string) => Promise<boolean>;
  readonly remove: (url: string) => Promise<boolean>;
}

/** The servers with a live session. */
export function signedInServers(servers: readonly AccountWire[]): readonly AccountWire[] {
  return servers.filter((server) => !server.signedOut);
}

/** Sign-outs the user asked for, so the resulting `account.changed` is not reported as a surprise. */
const expectedSignOuts = new Set<string>();

export const useAccountStore = create<AccountStore>((set, get) => ({
  servers: [],
  loaded: false,

  load: async () => {
    const result = await ipc().account.list(undefined);
    if (result.ok) set({ servers: result.value.servers, loaded: true });
    else set({ loaded: true });
  },

  applyChanged: (servers) => {
    const before = new Map(get().servers.map((server) => [server.url, server]));
    for (const server of servers) {
      const previous = before.get(server.url);
      if (server.signedOut && previous !== undefined && !previous.signedOut) {
        if (expectedSignOuts.delete(server.url)) {
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
    set({ servers, loaded: true });
  },

  signOut: async (url) => {
    expectedSignOuts.add(url);
    const result = await ipc().account.signOut({ url });
    if (!result.ok) {
      expectedSignOuts.delete(url);
      showToast(`Could not sign out: ${result.error.message}`);
      return false;
    }
    get().applyChanged(result.value.servers);
    return true;
  },

  remove: async (url) => {
    expectedSignOuts.add(url);
    const result = await ipc().account.remove({ url });
    expectedSignOuts.delete(url);
    if (!result.ok) {
      showToast(`Could not remove the server: ${result.error.message}`);
      return false;
    }
    set({ servers: result.value.servers });
    return true;
  },
}));

/** Called once from the shell, next to `subscribeToSync`; returns the unsubscribe. */
export function subscribeToAccounts(): () => void {
  return window.wirebench.on('account.changed', ((payload: AccountChangedEvent) => {
    useAccountStore.getState().applyChanged(payload.servers);
  }) as (payload: unknown) => void);
}

/** What the Sign in dialog shows for each way a step can fail; the server's message otherwise. */
const SIGN_IN_MESSAGES: Readonly<Record<string, string>> = {
  'server-url-invalid': 'Enter the server address as a URL, such as https://wirebench.example.com.',
  'server-unreachable': 'Could not reach that address. Check the URL, your network and the proxy settings.',
  'server-not-wirebench': 'That address is not a Wirebench Server.',
  'server-api-version': 'This server needs a newer Wirebench. Update the app and try again.',
  'server-bad-response': 'The server answered in a way Wirebench did not understand.',
  'identity-invalid-credentials': 'Wrong email or password.',
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
};

export function signInErrorMessage(error: IpcError): string {
  return SIGN_IN_MESSAGES[error.code] ?? error.message;
}
