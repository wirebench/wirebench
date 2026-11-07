/**
 * The `account.*` channels over {@link AccountService}. The renderer sends a password to sign in, to
 * accept an invitation or to change it, and gets an account or `done` back; the password is passed
 * straight to the server, never logged or kept. The token and its secret-store ref stay in main.
 */
import type { ServerAccount } from '@wirebench/engine';
import { channels } from '@wirebench/wire/ipc';
import type { AccountWire } from '@wirebench/wire/wire-base';
import type { AccountService } from '../account-service.js';
import type { ServerClient } from '../server-client.js';
import { withToken } from '../server-token.js';
import { registerHandler, type HandlerTable } from './register.js';

export interface AccountChannelDeps {
  readonly accounts: Pick<
    AccountService,
    | 'list'
    | 'probe'
    | 'signInLocal'
    | 'startOidc'
    | 'startSaml'
    | 'cancelSignIn'
    | 'lookupInvitation'
    | 'acceptInvitation'
    | 'signOut'
    | 'remove'
    | 'tokenFor'
    | 'markSignedOut'
    | 'setDisplayName'
  >;
  /** User settings' calls (settings split spec §4), each with the account's token. */
  readonly client: Pick<ServerClient, 'me' | 'meta' | 'updateMe' | 'changePassword' | 'listDevices' | 'revokeDevice'>;
}

const DONE = { done: true } as const;

/** Everything but the secret-store ref; `signedOut` becomes a plain boolean. */
export function toAccountWire(account: ServerAccount): AccountWire {
  return {
    url: account.url,
    userId: account.userId,
    email: account.email,
    displayName: account.displayName,
    deviceName: account.deviceName,
    signedOut: account.signedOut === true,
    addedAt: account.addedAt,
  };
}

export function registerAccountChannels(table: HandlerTable, deps: AccountChannelDeps): void {
  const servers = (): { servers: AccountWire[] } => ({ servers: deps.accounts.list().map(toAccountWire) });

  registerHandler(table, channels.account.list, () => Promise.resolve(servers()));
  registerHandler(table, channels.account.probe, (request) => deps.accounts.probe(request.url));
  registerHandler(table, channels.account.signInLocal, async (request) => ({
    account: toAccountWire(
      await deps.accounts.signInLocal({
        url: request.url,
        email: request.email,
        password: request.password,
        ...(request.deviceName !== undefined ? { deviceName: request.deviceName } : {}),
      }),
    ),
  }));
  registerHandler(table, channels.account.startOidc, async (request) => ({
    account: toAccountWire(
      await deps.accounts.startOidc({
        url: request.url,
        ...(request.deviceName !== undefined ? { deviceName: request.deviceName } : {}),
      }),
    ),
  }));
  registerHandler(table, channels.account.startSaml, async (request) => ({
    account: toAccountWire(
      await deps.accounts.startSaml({
        url: request.url,
        ...(request.deviceName !== undefined ? { deviceName: request.deviceName } : {}),
      }),
    ),
  }));
  registerHandler(table, channels.account.cancelSignIn, () => Promise.resolve(deps.accounts.cancelSignIn()));
  registerHandler(table, channels.account.lookupInvitation, (request) => deps.accounts.lookupInvitation(request));
  registerHandler(table, channels.account.acceptInvitation, async (request) => ({
    account: toAccountWire(
      await deps.accounts.acceptInvitation({
        url: request.url,
        secret: request.secret,
        displayName: request.displayName,
        password: request.password,
        ...(request.deviceName !== undefined ? { deviceName: request.deviceName } : {}),
      }),
    ),
  }));
  registerHandler(table, channels.account.signOut, async (request) => {
    await deps.accounts.signOut(request.url);
    return servers();
  });
  registerHandler(table, channels.account.remove, async (request) => {
    await deps.accounts.remove(request.url);
    return servers();
  });

  const c = deps.client;
  registerHandler(table, channels.account.profile, (r) =>
    withToken(deps, r.url, async (url, token) => {
      const [me, meta] = await Promise.all([c.me(url, token), c.meta(url)]);
      return { user: me.user, methods: me.methods, localPasswords: meta.auth.local };
    }),
  );
  registerHandler(table, channels.account.updateProfile, (r) =>
    withToken(deps, r.url, async (url, token) => {
      const [me, meta] = await Promise.all([c.updateMe(url, token, r.name), c.meta(url)]);
      // What the server stored (trimmed), so the Accounts list and the status bar show the same name.
      await deps.accounts.setDisplayName(url, me.user.displayName);
      return { user: me.user, methods: me.methods, localPasswords: meta.auth.local };
    }),
  );
  registerHandler(table, channels.account.changePassword, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.changePassword(url, token, {
        ...(r.currentPassword !== undefined ? { currentPassword: r.currentPassword } : {}),
        newPassword: r.newPassword,
      });
      return DONE;
    }),
  );
  registerHandler(table, channels.account.devices, (r) =>
    withToken(deps, r.url, async (url, token) => ({ devices: await c.listDevices(url, token) })),
  );
  registerHandler(table, channels.account.signOutDevice, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.revokeDevice(url, token, r.id);
      return DONE;
    }),
  );
}
