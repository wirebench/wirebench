/**
 * The `account.*` channels over {@link AccountService}. The renderer sends a password to sign in, to
 * accept an invitation or to change it, and gets an account or `done` back; the password is passed
 * straight to the server, never logged or kept. The token and its secret-store ref stay in main.
 */
import { WirebenchError, type AccountRef, type MeResponse, type ServerAccount } from '@wirebench/engine';
import { channels } from '@wirebench/wire/ipc';
import type { AccountListResponse, AccountProfileWire, AccountWire } from '@wirebench/wire/wire-base';
import {
  profileFieldsOf,
  type AccountService,
  type AccountTarget,
  type RememberedAccount,
} from '../account-service.js';
import { normalizeServerUrl, type ServerClient } from '../server-client.js';
import { withToken } from '../server-token.js';
import { registerHandler, type HandlerTable } from './register.js';

export interface AccountChannelDeps {
  readonly accounts: Pick<
    AccountService,
    | 'list'
    | 'active'
    | 'setActive'
    | 'remembered'
    | 'refreshRemembered'
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

/** Another account the browser holds (switch accounts ruling 6): signed in, never active here. */
export function toRememberedWire(account: RememberedAccount): AccountWire {
  return {
    url: account.url,
    userId: account.userId,
    email: account.email,
    displayName: account.displayName,
    deviceName: 'Web browser',
    signedOut: false,
    addedAt: '',
    username: account.username,
    photo: account.photo,
    active: false,
    lastActiveAt: null,
    remembered: true,
  };
}

/** Every account and the active one: `account.list`, the answer to a sign-out or a switch, and `account.changed`. */
export function accountList(
  accounts: Pick<AccountService, 'list' | 'active' | 'remembered'>,
): AccountListResponse & { active: AccountRef | null } {
  const active = accounts.active();
  return {
    servers: [
      ...accounts.list().map((account) => toAccountWire(account, active)),
      ...accounts.remembered().map(toRememberedWire),
    ],
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

  registerHandler(table, channels.account.list, async () => {
    // Inside a server, the other accounts the browser holds are asked for afresh: the menu is about to show them.
    await deps.accounts.refreshRemembered();
    return servers();
  });
  registerHandler(table, channels.account.active, () => Promise.resolve(deps.accounts.active()));
  registerHandler(table, channels.account.setActive, async (request) => {
    await deps.accounts.setActive(request.account);
    return servers();
  });
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
}
