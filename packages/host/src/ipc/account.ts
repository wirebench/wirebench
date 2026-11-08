/**
 * The `account.*` channels over {@link AccountService}. The renderer sends a password to sign in, to
 * accept an invitation or to change it, and gets an account or `done` back; the password is passed
 * straight to the server, never logged or kept. The token and its secret-store ref stay in main.
 */
import type { MeResponse, ServerAccount } from '@wirebench/engine';
import { channels } from '@wirebench/wire/ipc';
import type { AccountProfileWire, AccountWire } from '@wirebench/wire/wire-base';
import { profileFieldsOf, type AccountService } from '../account-service.js';
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
    | 'setProfile'
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
    username: account.username ?? null,
    photo: account.photo ?? null,
  };
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
  const servers = (): { servers: AccountWire[] } => ({ servers: deps.accounts.list().map(toAccountWire) });

  registerHandler(table, channels.account.list, () => Promise.resolve(servers()));
  registerHandler(table, channels.account.probe, (request) => deps.accounts.probe(request.url));
  registerHandler(table, channels.account.signInLocal, async (request) => ({
    account: toAccountWire(
      await deps.accounts.signInLocal({
        url: request.url,
        identifier: request.identifier,
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
      // A fresh `/me` is as good as a refresh: the account menu picks up a photo set on another device.
      await deps.accounts.setProfile(url, profileFieldsOf(me.user));
      return toProfileWire(me, meta.auth.local);
    }),
  );
  registerHandler(table, channels.account.updateProfile, (r) =>
    withToken(deps, r.url, async (url, token) => {
      const patch = {
        ...(r.name !== undefined ? { name: r.name } : {}),
        ...(r.username !== undefined ? { username: r.username } : {}),
        ...(r.about !== undefined ? { about: r.about } : {}),
      };
      const [me, meta] = await Promise.all([c.updateMe(url, token, patch), c.meta(url)]);
      // What the server stored (trimmed, lower-cased), so the Accounts list and the account menu show the same.
      await deps.accounts.setProfile(url, profileFieldsOf(me.user));
      return toProfileWire(me, meta.auth.local);
    }),
  );
  registerHandler(table, channels.account.image, (r) =>
    withToken(deps, r.url, async (url, token) => ({ dataUrl: await c.image(url, token, r.userId, r.kind) })),
  );
  registerHandler(table, channels.account.setImage, (r) =>
    withToken(deps, r.url, async (url, token) => {
      const ref = await c.putImage(url, token, r.kind, r.data);
      if (r.kind === 'photo') await deps.accounts.setProfile(url, { photo: ref });
      return { version: ref.version };
    }),
  );
  registerHandler(table, channels.account.removeImage, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.deleteImage(url, token, r.kind);
      if (r.kind === 'photo') await deps.accounts.setProfile(url, { photo: null });
      return DONE;
    }),
  );
  registerHandler(table, channels.account.person, (r) =>
    withToken(deps, r.url, (url, token) => c.profile(url, token, r.userId)),
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
