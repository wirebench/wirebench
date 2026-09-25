// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerAccount } from '@wirebench/engine';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { registerAccountChannels, toAccountWire } = await import('../src/main/ipc/account.js');

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
    cancelSignIn: vi.fn(() => ({ cancelled: true })),
    lookupInvitation: vi.fn().mockResolvedValue({ email: 'alice@example.com', methods: { local: true, oidc: false } }),
    acceptInvitation: vi.fn().mockResolvedValue(ACCOUNT),
    signOut: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

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
    registerAccountChannels({ accounts });
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
    registerAccountChannels({ accounts });
    const result = await invoke('account.signInLocal', { url: 'https://wb.test', email: 'a', password: 'p' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('identity-invalid-credentials');
  });
});
