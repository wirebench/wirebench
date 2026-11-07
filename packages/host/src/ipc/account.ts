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
    | 'verifyTwoFactor'
    | 'startTwoFactorPasskey'
    | 'cancelTwoFactor'
    | 'twoFactorSetupStart'
    | 'twoFactorSetupConfirm'
  >;
  /** User settings' calls (settings split spec §4), each with the account's token. */
  readonly client: Pick<
    ServerClient,
    | 'me'
    | 'meta'
    | 'updateMe'
    | 'changePassword'
    | 'listDevices'
    | 'revokeDevice'
    | 'twoFactorStatus'
    | 'setUpTotp'
    | 'confirmTotp'
    | 'removeTotp'
    | 'regenerateRecoveryCodes'
    | 'renamePasskey'
    | 'removePasskey'
  >;
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
  registerHandler(table, channels.account.signInLocal, async (request) => {
    const signed = await deps.accounts.signInLocal({
      url: request.url,
      email: request.email,
      password: request.password,
      ...(request.deviceName !== undefined ? { deviceName: request.deviceName } : {}),
    });
    // The second step: its methods only; the challenge stays in main (two-step sign-in spec §3.2).
    if ('twoFactor' in signed)
      return { twoFactor: { methods: [...signed.twoFactor.methods], setup: signed.twoFactor.setup } };
    return { account: toAccountWire(signed) };
  });
  registerHandler(table, channels.account.verifyTwoFactor, async (request) => ({
    account: toAccountWire(await deps.accounts.verifyTwoFactor({ method: request.method, code: request.code })),
  }));
  registerHandler(table, channels.account.startTwoFactorPasskey, async () => ({
    account: toAccountWire(await deps.accounts.startTwoFactorPasskey()),
  }));
  registerHandler(table, channels.account.cancelTwoFactor, () => {
    deps.accounts.cancelTwoFactor();
    return Promise.resolve(DONE);
  });
  registerHandler(table, channels.account.twoFactorSetupStart, () => deps.accounts.twoFactorSetupStart());
  registerHandler(table, channels.account.twoFactorSetupConfirm, async (request) => {
    const done = await deps.accounts.twoFactorSetupConfirm(request.code);
    return { account: toAccountWire(done.account), recoveryCodes: done.recoveryCodes };
  });
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

  // User settings → Password, two-step sign-in (two-step sign-in spec §5); the password goes to the server only.
  registerHandler(table, channels.account.twoFactorStatus, (r) =>
    withToken(deps, r.url, (url, token) => c.twoFactorStatus(url, token)),
  );
  registerHandler(table, channels.account.setUpTotp, (r) =>
    withToken(deps, r.url, (url, token) => c.setUpTotp(url, { token, password: r.password })),
  );
  registerHandler(table, channels.account.confirmTotp, (r) =>
    withToken(deps, r.url, async (url, token) => {
      const confirmed = await c.confirmTotp(url, token, r.code);
      return confirmed.recoveryCodes !== undefined ? { recoveryCodes: confirmed.recoveryCodes } : {};
    }),
  );
  registerHandler(table, channels.account.removeTotp, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.removeTotp(url, token, r.password);
      return DONE;
    }),
  );
  registerHandler(table, channels.account.regenerateRecoveryCodes, (r) =>
    withToken(deps, r.url, (url, token) => c.regenerateRecoveryCodes(url, token, r.password)),
  );
  registerHandler(table, channels.account.renamePasskey, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.renamePasskey(url, token, r.id, r.name);
      return DONE;
    }),
  );
  registerHandler(table, channels.account.removePasskey, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.removePasskey(url, token, r.id, r.password);
      return DONE;
    }),
  );
}
