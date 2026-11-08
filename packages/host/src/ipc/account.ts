/**
 * The `account.*` channels over {@link AccountService}. The renderer sends a password to sign in, to
 * accept an invitation or to change it, and gets an account or `done` back; the password is passed
 * straight to the server, never logged or kept. The token and its secret-store ref stay in main.
 */
import { WirebenchError, type AccountRef, type MeResponse, type ServerAccount } from '@wirebench/engine';
import { channels } from '@wirebench/wire/ipc';
import type { AccountListResponse, AccountProfileWire, AccountWire } from '@wirebench/wire/wire-base';
import { profileFieldsOf, type AccountService, type AccountTarget } from '../account-service.js';
import { normalizeServerUrl, type ServerClient } from '../server-client.js';
import { withToken } from '../server-token.js';
import { registerHandler, type HandlerTable } from './register.js';

export interface AccountChannelDeps {
  readonly accounts: Pick<
    AccountService,
    | 'list'
    | 'active'
    | 'setActive'
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
    | 'setProfile'
    | 'verifyTwoFactor'
    | 'startTwoFactorPasskey'
    | 'cancelTwoFactor'
    | 'twoFactorSetupStart'
    | 'twoFactorSetupConfirm'
  >;
  /** User settings' calls (settings split spec §4, user profile spec §7), each with the account's token. */
  readonly client: Pick<
    ServerClient,
    | 'me'
    | 'meta'
    | 'updateMe'
    | 'changePassword'
    | 'listDevices'
    | 'revokeDevice'
    | 'putImage'
    | 'deleteImage'
    | 'image'
    | 'profile'
    | 'twoFactorStatus'
    | 'setUpTotp'
    | 'confirmTotp'
    | 'removeTotp'
    | 'regenerateRecoveryCodes'
    | 'renamePasskey'
    | 'removePasskey'
    | 'passkeyRegistrationOptions'
    | 'addPasskey'
    | 'listUsers'
    | 'resetTwoFactor'
  >;
}

const DONE = { done: true } as const;

/** Everything but the secret-store ref; `signedOut` becomes a plain boolean, and `active` says whether it is. */
export function toAccountWire(account: ServerAccount, active: AccountRef | null = null): AccountWire {
  return {
    url: account.url,
    userId: account.userId,
    email: account.email,
    displayName: account.displayName,
    deviceName: account.deviceName,
    signedOut: account.signedOut === true,
    addedAt: account.addedAt,
    username: account.username ?? null,
    photo: account.photo ?? null,
    active: active !== null && active.url === account.url && active.userId === account.userId,
    lastActiveAt: account.lastActiveAt ?? null,
  };
}

/** Every account and the active one: `account.list`, the answer to a sign-out or a switch, and `account.changed`. */
export function accountList(
  accounts: Pick<AccountService, 'list' | 'active'>,
): AccountListResponse & { active: AccountRef | null } {
  const active = accounts.active();
  return {
    servers: accounts.list().map((account) => toAccountWire(account, active)),
    active,
  };
}

/**
 * The account a request names: `account`, else (for one release, ruling 1) its `url`, which stands for that
 * server's active-or-only account. The request schema refuses one with neither.
 */
function targetOf(request: {
  readonly account?: AccountRef | undefined;
  readonly url?: string | undefined;
}): AccountTarget {
  if (request.account !== undefined)
    return { url: normalizeServerUrl(request.account.url), userId: request.account.userId };
  if (request.url !== undefined) return normalizeServerUrl(request.url);
  throw new WirebenchError('invalid-argument', 'Name the account');
}

/** `/me` plus the server's `auth.local`; the profile fields a server older than profiles leaves out read as none. */
function toProfileWire(me: MeResponse, localPasswords: boolean): AccountProfileWire {
  const { user } = me;
  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      serverAdmin: user.serverAdmin,
      username: user.username ?? null,
      about: user.about ?? '',
      photo: user.photo ?? null,
      cover: user.cover ?? null,
    },
    methods: me.methods,
    localPasswords,
  };
}

export function registerAccountChannels(table: HandlerTable, deps: AccountChannelDeps): void {
  const servers = (): AccountListResponse => accountList(deps.accounts);

  // Inside a server, the other accounts the browser holds are not listed here: only the page's cookie can ask for
  // them (`env.rememberedAccounts`), and one host may serve the same person in several browsers.
  registerHandler(table, channels.account.list, () => Promise.resolve(servers()));
  registerHandler(table, channels.account.active, () => Promise.resolve(deps.accounts.active()));
  registerHandler(table, channels.account.setActive, async (request) => {
    await deps.accounts.setActive(request.account);
    return servers();
  });
  registerHandler(table, channels.account.probe, (request) => deps.accounts.probe(request.url));
  registerHandler(table, channels.account.signInLocal, async (request) => {
    const signed = await deps.accounts.signInLocal({
      url: request.url,
      identifier: request.identifier,
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
    await deps.accounts.signOut(targetOf(request));
    return servers();
  });
  registerHandler(table, channels.account.remove, async (request) => {
    await deps.accounts.remove(targetOf(request));
    return servers();
  });

  const c = deps.client;
  registerHandler(table, channels.account.profile, (r) =>
    withToken(deps, targetOf(r), async (url, token) => {
      const [me, meta] = await Promise.all([c.me(url, token), c.meta(url)]);
      // A fresh `/me` is as good as a refresh: the account menu picks up a photo set on another device.
      await deps.accounts.setProfile(targetOf(r), profileFieldsOf(me.user));
      return toProfileWire(me, meta.auth.local);
    }),
  );
  registerHandler(table, channels.account.updateProfile, (r) =>
    withToken(deps, targetOf(r), async (url, token) => {
      const patch = {
        ...(r.name !== undefined ? { name: r.name } : {}),
        ...(r.username !== undefined ? { username: r.username } : {}),
        ...(r.about !== undefined ? { about: r.about } : {}),
      };
      const [me, meta] = await Promise.all([c.updateMe(url, token, patch), c.meta(url)]);
      // What the server stored (trimmed, lower-cased), so the Accounts list and the account menu show the same.
      await deps.accounts.setProfile(targetOf(r), profileFieldsOf(me.user));
      return toProfileWire(me, meta.auth.local);
    }),
  );
  registerHandler(table, channels.account.image, (r) =>
    withToken(deps, targetOf(r), async (url, token) => ({ dataUrl: await c.image(url, token, r.userId, r.kind) })),
  );
  registerHandler(table, channels.account.setImage, (r) =>
    withToken(deps, targetOf(r), async (url, token) => {
      const ref = await c.putImage(url, token, r.kind, r.data);
      if (r.kind === 'photo') await deps.accounts.setProfile(targetOf(r), { photo: ref });
      return { version: ref.version };
    }),
  );
  registerHandler(table, channels.account.removeImage, (r) =>
    withToken(deps, targetOf(r), async (url, token) => {
      await c.deleteImage(url, token, r.kind);
      if (r.kind === 'photo') await deps.accounts.setProfile(targetOf(r), { photo: null });
      return DONE;
    }),
  );
  registerHandler(table, channels.account.person, (r) =>
    withToken(deps, targetOf(r), (url, token) => c.profile(url, token, r.userId)),
  );
  registerHandler(table, channels.account.changePassword, (r) =>
    withToken(deps, targetOf(r), async (url, token) => {
      await c.changePassword(url, token, {
        ...(r.currentPassword !== undefined ? { currentPassword: r.currentPassword } : {}),
        newPassword: r.newPassword,
      });
      return DONE;
    }),
  );
  registerHandler(table, channels.account.devices, (r) =>
    withToken(deps, targetOf(r), async (url, token) => ({ devices: await c.listDevices(url, token) })),
  );
  registerHandler(table, channels.account.signOutDevice, (r) =>
    withToken(deps, targetOf(r), async (url, token) => {
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
  registerHandler(table, channels.account.passkeyOptions, (r) =>
    withToken(deps, r.url, (url, token) => c.passkeyRegistrationOptions(url, token, r.password)),
  );
  registerHandler(table, channels.account.addPasskey, (r) =>
    withToken(deps, r.url, async (url, token) => {
      const added = await c.addPasskey(url, token, { name: r.name, response: r.response });
      return {
        passkey: added.passkey,
        ...(added.recoveryCodes !== undefined ? { recoveryCodes: added.recoveryCodes } : {}),
      };
    }),
  );
  registerHandler(table, channels.account.serverPeople, (r) =>
    withToken(deps, r.url, async (url, token) => ({
      people: (await c.listUsers(url, token)).map((user) => ({
        userId: user.id,
        password: user.methods.local,
        twoFactor: user.twoFactor === true,
        disabled: user.disabledAt !== undefined,
      })),
    })),
  );
  registerHandler(table, channels.account.resetTwoFactor, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.resetTwoFactor(url, token, r.userId);
      return DONE;
    }),
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
