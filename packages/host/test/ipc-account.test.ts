// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerAccount } from '@wirebench/engine';
import { tableInto } from './helpers/ipc-table.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
const table = tableInto(handlers);
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { registerAccountChannels, toAccountWire } = await import('../src/ipc/account.js');

type Envelope =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: { code: string } };
const invoke = (channel: string, payload: unknown): Promise<Envelope> =>
  handlers.get(channel)!({ sender: {} }, payload) as Promise<Envelope>;

const ACCOUNT: ServerAccount = {
  url: 'https://wb.test',
  userId: 'u1',
  email: 'alice@example.com',
  displayName: 'Alice',
  deviceName: 'Mac',
  tokenRef: 'sec_00000000000000000000000001',
  addedAt: '2026-09-24T12:00:00.000Z',
};

function fakeService() {
  return {
    list: vi.fn(() => [ACCOUNT]),
    probe: vi.fn().mockResolvedValue({
      url: 'https://wb.test',
      meta: {
        name: 'wirebench-server',
        version: '1',
        apiVersion: 1,
        publicUrl: 'https://wb.test',
        auth: { local: true, oidc: false },
        capabilities: [],
      },
    }),
    signInLocal: vi.fn().mockResolvedValue(ACCOUNT),
    startOidc: vi.fn().mockResolvedValue(ACCOUNT),
    startSaml: vi.fn().mockResolvedValue(ACCOUNT),
    cancelSignIn: vi.fn(() => ({ cancelled: true })),
    lookupInvitation: vi.fn().mockResolvedValue({ email: 'alice@example.com', methods: { local: true, oidc: false } }),
    acceptInvitation: vi.fn().mockResolvedValue(ACCOUNT),
    signOut: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    tokenFor: vi.fn().mockResolvedValue(TOKEN),
    markSignedOut: vi.fn(),
    setDisplayName: vi.fn().mockResolvedValue(undefined),
  };
}

const TOKEN = `wbs_${'A'.repeat(43)}`;
const USER = { id: 'u1', email: 'alice@example.com', displayName: 'Alice', serverAdmin: false };
const METHODS = { local: true, oidc: [{ issuer: 'https://idp.test' }] };
const DEVICE = {
  id: 'd1',
  name: 'Mac',
  createdAt: '2026-11-01T10:00:00.000Z',
  lastUsedAt: '2026-11-07T10:00:00.000Z',
  current: true,
};

/** The server calls the profile, password and devices channels make. */
function fakeClient() {
  return {
    me: vi.fn().mockResolvedValue({ user: USER, methods: METHODS }),
    meta: vi.fn().mockResolvedValue({ auth: { local: false, oidc: true }, capabilities: [] }),
    updateMe: vi.fn().mockResolvedValue({ user: { ...USER, displayName: 'Alice B' }, methods: METHODS }),
    changePassword: vi.fn().mockResolvedValue(undefined),
    listDevices: vi.fn().mockResolvedValue([DEVICE]),
    revokeDevice: vi.fn().mockResolvedValue(undefined),
  };
}

const deps = (accounts = fakeService(), client = fakeClient()) => ({ accounts, client });

describe('account.* channels', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('never lets the token ref across the bridge', () => {
    expect(toAccountWire(ACCOUNT)).toEqual({
      url: 'https://wb.test',
      userId: 'u1',
      email: 'alice@example.com',
      displayName: 'Alice',
      deviceName: 'Mac',
      signedOut: false,
      addedAt: '2026-09-24T12:00:00.000Z',
    });
    expect(toAccountWire({ ...ACCOUNT, signedOut: true }).signedOut).toBe(true);
  });

  it('registers every channel and answers with wire shapes', async () => {
    const accounts = fakeService();
    registerAccountChannels(table, deps(accounts));
    expect(await invoke('account.list', undefined)).toEqual({ ok: true, value: { servers: [toAccountWire(ACCOUNT)] } });
    expect(await invoke('account.probe', { url: 'https://wb.test' })).toMatchObject({
      ok: true,
      value: { url: 'https://wb.test', meta: { apiVersion: 1 } },
    });
    expect(await invoke('account.signInLocal', { url: 'https://wb.test', email: 'a', password: 'p' })).toEqual({
      ok: true,
      value: { account: toAccountWire(ACCOUNT) },
    });
    expect(accounts.signInLocal).toHaveBeenCalledWith({ url: 'https://wb.test', email: 'a', password: 'p' });
    expect(await invoke('account.startOidc', { url: 'https://wb.test' })).toMatchObject({ ok: true });
    expect(await invoke('account.startSaml', { url: 'https://wb.test' })).toMatchObject({ ok: true });
    expect(accounts.startSaml).toHaveBeenCalledWith({ url: 'https://wb.test' });
    expect(await invoke('account.cancelSignIn', undefined)).toEqual({ ok: true, value: { cancelled: true } });
    expect(await invoke('account.lookupInvitation', { url: 'https://wb.test', secret: 's' })).toMatchObject({
      ok: true,
      value: { email: 'alice@example.com' },
    });
    expect(
      await invoke('account.acceptInvitation', {
        url: 'https://wb.test',
        secret: 's',
        displayName: 'A',
        password: 'p',
      }),
    ).toMatchObject({ ok: true });
    expect(await invoke('account.signOut', { url: 'https://wb.test' })).toEqual({
      ok: true,
      value: { servers: [toAccountWire(ACCOUNT)] },
    });
    expect(await invoke('account.remove', { url: 'https://wb.test' })).toEqual({
      ok: true,
      value: { servers: [toAccountWire(ACCOUNT)] },
    });
  });

  it('answers a WirebenchError from the service as a failed envelope with its code', async () => {
    const { WirebenchError } = await import('@wirebench/engine');
    const accounts = fakeService();
    accounts.signInLocal.mockRejectedValue(new WirebenchError('identity-invalid-credentials', 'nope'));
    registerAccountChannels(table, deps(accounts));
    const result = await invoke('account.signInLocal', { url: 'https://wb.test', email: 'a', password: 'p' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('identity-invalid-credentials');
  });

  it('account.profile joins /me and /meta’s auth.local', async () => {
    const d = deps();
    registerAccountChannels(table, d);
    expect(await invoke('account.profile', { url: 'https://WB.test/x' })).toEqual({
      ok: true,
      value: { user: USER, methods: METHODS, localPasswords: false },
    });
    expect(d.accounts.tokenFor).toHaveBeenCalledWith('https://wb.test');
    expect(d.client.me).toHaveBeenCalledWith('https://wb.test', TOKEN);
    expect(d.client.meta).toHaveBeenCalledWith('https://wb.test');
  });

  it('account.updateProfile updates the stored account’s display name', async () => {
    const d = deps();
    registerAccountChannels(table, d);
    expect(await invoke('account.updateProfile', { url: 'https://wb.test', name: 'Alice B' })).toEqual({
      ok: true,
      value: { user: { ...USER, displayName: 'Alice B' }, methods: METHODS, localPasswords: false },
    });
    expect(d.client.updateMe).toHaveBeenCalledWith('https://wb.test', TOKEN, 'Alice B');
    expect(d.accounts.setDisplayName).toHaveBeenCalledWith('https://wb.test', 'Alice B');
  });

  it('account.updateProfile leaves the stored account alone when the server refuses', async () => {
    const { WirebenchError } = await import('@wirebench/engine');
    const d = deps();
    d.client.updateMe.mockRejectedValue(new WirebenchError('identity-name-invalid', 'no'));
    registerAccountChannels(table, d);
    const result = await invoke('account.updateProfile', { url: 'https://wb.test', name: ' ' });
    expect(!result.ok && result.error.code).toBe('identity-name-invalid');
    expect(d.accounts.setDisplayName).not.toHaveBeenCalled();
  });

  it('account.changePassword sends both passwords and answers done; a refusal keeps the server’s code', async () => {
    const { WirebenchError } = await import('@wirebench/engine');
    const d = deps();
    registerAccountChannels(table, d);
    const request = { url: 'https://wb.test', currentPassword: 'old-password-1', newPassword: 'new-password-2' };
    expect(await invoke('account.changePassword', request)).toEqual({ ok: true, value: { done: true } });
    expect(d.client.changePassword).toHaveBeenCalledWith('https://wb.test', TOKEN, {
      currentPassword: 'old-password-1',
      newPassword: 'new-password-2',
    });
    // No current password (an account that never had one) sends none.
    await invoke('account.changePassword', { url: 'https://wb.test', newPassword: 'new-password-2' });
    expect(d.client.changePassword).toHaveBeenLastCalledWith('https://wb.test', TOKEN, {
      newPassword: 'new-password-2',
    });
    d.client.changePassword.mockRejectedValue(new WirebenchError('identity-invalid-credentials', 'Wrong password'));
    const refused = await invoke('account.changePassword', request);
    expect(!refused.ok && refused.error.code).toBe('identity-invalid-credentials');
    // Neither password reaches the answer.
    expect(JSON.stringify(refused)).not.toContain('old-password-1');
    expect(JSON.stringify(refused)).not.toContain('new-password-2');
  });

  it('account.devices and signOutDevice call /me/devices', async () => {
    const d = deps();
    registerAccountChannels(table, d);
    expect(await invoke('account.devices', { url: 'https://wb.test' })).toEqual({
      ok: true,
      value: { devices: [DEVICE] },
    });
    expect(d.client.listDevices).toHaveBeenCalledWith('https://wb.test', TOKEN);
    expect(await invoke('account.signOutDevice', { url: 'https://wb.test', id: 'd2' })).toEqual({
      ok: true,
      value: { done: true },
    });
    expect(d.client.revokeDevice).toHaveBeenCalledWith('https://wb.test', TOKEN, 'd2');
  });

  it.each([
    ['account.profile', { url: 'https://wb.test' }, 'me'],
    ['account.updateProfile', { url: 'https://wb.test', name: 'A' }, 'updateMe'],
    ['account.changePassword', { url: 'https://wb.test', newPassword: 'new-password-2' }, 'changePassword'],
    ['account.devices', { url: 'https://wb.test' }, 'listDevices'],
    ['account.signOutDevice', { url: 'https://wb.test', id: 'd1' }, 'revokeDevice'],
  ] as const)('%s: a signed-out answer marks the account signed out', async (channel, request, call) => {
    const { WirebenchError } = await import('@wirebench/engine');
    const d = deps();
    d.client[call].mockRejectedValue(new WirebenchError('identity-unauthenticated', 'Sign in again'));
    registerAccountChannels(table, d);
    const result = await invoke(channel, request);
    expect(!result.ok && result.error.code).toBe('identity-unauthenticated');
    expect(d.accounts.markSignedOut).toHaveBeenCalledWith('https://wb.test');
  });

  it('with no token the new channels answer account-signed-out and never call the server', async () => {
    const d = deps();
    d.accounts.tokenFor.mockResolvedValue(undefined);
    registerAccountChannels(table, d);
    const result = await invoke('account.devices', { url: 'https://wb.test' });
    expect(!result.ok && result.error.code).toBe('account-signed-out');
    expect(d.client.listDevices).not.toHaveBeenCalled();
  });
});
