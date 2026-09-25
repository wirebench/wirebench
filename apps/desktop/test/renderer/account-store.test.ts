import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));

const { signedInServers, signInErrorMessage, subscribeToAccounts, useAccountStore } =
  await import('../../src/renderer/state/account.js');
const { useUiStore } = await import('../../src/renderer/state/ui.js');

const account = (patch: Partial<AccountWire> = {}): AccountWire => ({
  url: 'https://wb.test',
  userId: 'u1',
  email: 'alice@example.com',
  displayName: 'Alice',
  deviceName: 'Mac',
  signedOut: false,
  addedAt: '2026-09-24T12:00:00.000Z',
  ...patch,
});

describe('account store', () => {
  beforeEach(() => {
    useAccountStore.setState({ servers: [], loaded: false });
    showToast.mockReset();
  });
  afterEach(() => {
    useUiStore.setState({ signInDialog: { open: false, url: undefined } });
  });

  it('load reads account.list once and marks itself loaded', async () => {
    const list = vi.fn().mockResolvedValue({ ok: true, value: { servers: [account()] } });
    installWirebenchApi({ account: { list } });
    await useAccountStore.getState().load();
    expect(useAccountStore.getState().servers).toEqual([account()]);
    expect(useAccountStore.getState().loaded).toBe(true);
    expect(signedInServers(useAccountStore.getState().servers)).toHaveLength(1);
    expect(signedInServers([account({ signedOut: true })])).toEqual([]);
  });

  it('an account the server stopped accepting is toasted once, with Sign in again opening the dialog', () => {
    installWirebenchApi();
    useAccountStore.getState().applyChanged([account()]);
    useAccountStore.getState().applyChanged([account({ signedOut: true })]);
    expect(showToast).toHaveBeenCalledTimes(1);
    const [message, action] = showToast.mock.calls[0] as [string, { label: string; onClick: () => void }];
    expect(message).toContain('https://wb.test');
    expect(action.label).toBe('Sign in again');
    action.onClick();
    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: 'https://wb.test' });
    // The same state again is not news.
    useAccountStore.getState().applyChanged([account({ signedOut: true })]);
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('a sign-out the user asked for is not toasted as a surprise', async () => {
    const signOut = vi.fn().mockResolvedValue({ ok: true, value: { servers: [account({ signedOut: true })] } });
    installWirebenchApi({ account: { signOut } });
    useAccountStore.getState().applyChanged([account()]);
    expect(await useAccountStore.getState().signOut('https://wb.test')).toBe(true);
    // The event main broadcasts arrives after the reply; still no surprise toast.
    useAccountStore.getState().applyChanged([account({ signedOut: true })]);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0]?.[0]).toBe('Signed out of https://wb.test');
    expect(useAccountStore.getState().servers[0]?.signedOut).toBe(true);
  });

  it('remove drops the entry and a failed call is toasted and reported', async () => {
    const remove = vi.fn().mockResolvedValue({ ok: false, error: { code: 'server-unreachable', message: 'down' } });
    installWirebenchApi({ account: { remove } });
    useAccountStore.getState().applyChanged([account()]);
    expect(await useAccountStore.getState().remove('https://wb.test')).toBe(false);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('down'));
  });

  it('subscribeToAccounts feeds account.changed into the store', () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    installWirebenchApi();
    Object.defineProperty(window, 'wirebench', {
      configurable: true,
      value: {
        ...window.wirebench,
        on: (name: string, handler: (payload: unknown) => void) => {
          handlers.set(name, handler);
          return () => handlers.delete(name);
        },
      },
    });
    const off = subscribeToAccounts();
    handlers.get('account.changed')?.({ servers: [account()] });
    expect(useAccountStore.getState().servers).toHaveLength(1);
    off();
    expect(handlers.has('account.changed')).toBe(false);
  });

  it('maps the codes a sign-in can fail with to copy, and falls back to the message', () => {
    expect(signInErrorMessage({ code: 'identity-invalid-credentials', message: 'x' })).toBe('Wrong email or password.');
    expect(signInErrorMessage({ code: 'server-not-wirebench', message: 'x' })).toBe(
      'That address is not a Wirebench Server.',
    );
    expect(signInErrorMessage({ code: 'identity-not-invited', message: 'x' })).toContain('invite you');
    expect(signInErrorMessage({ code: 'something-else', message: 'the message' })).toBe('the message');
  });
});
