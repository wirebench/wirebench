import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountWire } from '@wirebench/wire/wire-base';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));

const { otherAccounts, signedInServers, signInErrorMessage, subscribeToAccounts, useAccountStore } =
  await import('../../src/renderer/state/account.js');
const { useUiStore } = await import('../../src/renderer/state/ui.js');
const { useWorkspaceStore } = await import('../../src/renderer/state/workspace.js');

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
    useAccountStore.setState({ servers: [], active: null, loaded: false });
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
    expect(signOut).toHaveBeenCalledWith({ account: { url: 'https://wb.test', userId: 'u1' } });
    // The event main broadcasts arrives after the reply; still no surprise toast.
    useAccountStore.getState().applyChanged([account({ signedOut: true })]);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0]?.[0]).toBe('Signed out of https://wb.test');
    expect(useAccountStore.getState().servers[0]?.signedOut).toBe(true);
  });

  it('in a browser tab (env.signOut set), sign-out ends the tab session instead of calling the account channel', async () => {
    const ipcSignOut = vi.fn();
    const api = installWirebenchApi({ account: { signOut: ipcSignOut } });
    const envSignOut = vi.fn();
    Object.defineProperty(api, 'env', {
      configurable: true,
      value: { e2e: false, osTheme: 'dark', host: 'browser', capabilities: ['send:public'], signOut: envSignOut },
    });
    useAccountStore.getState().applyChanged([account()]);
    expect(await useAccountStore.getState().signOut('https://wb.test')).toBe(true);
    expect(envSignOut).toHaveBeenCalledTimes(1);
    expect(ipcSignOut).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
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

  describe('switch accounts (spec §2–§5)', () => {
    const work = account({ userId: 'u1', active: true, lastActiveAt: '2026-11-07T10:00:00.000Z' });
    const test = account({ userId: 'u2', email: 'test@example.com', displayName: 'Tess', active: false });
    const ACTIVE = { url: 'https://wb.test', userId: 'u1' };

    /** A browser tab's env: the bootstrap's account actions. */
    const browserEnv = (api: object, extra: Record<string, unknown>) => {
      Object.defineProperty(api, 'env', {
        configurable: true,
        value: { e2e: false, osTheme: 'dark', host: 'browser', capabilities: ['send:public'], ...extra },
      });
    };

    it('keeps two accounts on one server apart and knows the active one', async () => {
      const list = vi.fn().mockResolvedValue({ ok: true, value: { servers: [work, test], active: ACTIVE } });
      installWirebenchApi({ account: { list } });
      await useAccountStore.getState().load();
      expect(useAccountStore.getState().active).toEqual(ACTIVE);
      expect(signedInServers(useAccountStore.getState().servers)).toHaveLength(2);
      // One signed out on the same server is toasted for that account only.
      useAccountStore.getState().applyChanged([work, { ...test, signedOut: true }], ACTIVE);
      expect(showToast).toHaveBeenCalledTimes(1);
      expect(useAccountStore.getState().servers.map((row) => [row.userId, row.signedOut])).toEqual([
        ['u1', false],
        ['u2', true],
      ]);
    });

    it('orders the other accounts signed in first, most recently active first, never the active one', () => {
      const older = account({ userId: 'old', lastActiveAt: '2026-11-01T00:00:00.000Z' });
      const newer = account({ userId: 'new', url: 'https://two.test', lastActiveAt: '2026-11-06T00:00:00.000Z' });
      const gone = account({ userId: 'gone', signedOut: true, lastActiveAt: '2026-11-07T00:00:00.000Z' });
      expect(otherAccounts([gone, older, work, newer], work).map((row) => row.userId)).toEqual(['new', 'old', 'gone']);
    });

    it('on the desktop, setActive calls account.setActive and toasts who you are now', async () => {
      const setActive = vi.fn().mockResolvedValue({
        ok: true,
        value: {
          servers: [
            { ...work, active: false },
            { ...test, active: true },
          ],
          active: { url: 'https://wb.test', userId: 'u2' },
        },
      });
      installWirebenchApi({ account: { setActive } });
      useAccountStore.setState({ servers: [work, test], active: ACTIVE });
      expect(await useAccountStore.getState().setActive({ url: 'https://wb.test', userId: 'u2' })).toBe(true);
      expect(setActive).toHaveBeenCalledWith({ account: { url: 'https://wb.test', userId: 'u2' } });
      expect(useAccountStore.getState().active).toEqual({ url: 'https://wb.test', userId: 'u2' });
      expect(showToast).toHaveBeenCalledWith('Now signed in as Tess on wb.test.');
    });

    it('says an open workspace of the previous account’s server keeps syncing as that account (spec ruling 4)', async () => {
      const setActive = vi.fn().mockResolvedValue({
        ok: true,
        value: {
          servers: [
            { ...work, active: false },
            { ...test, active: true },
          ],
          active: { url: 'https://wb.test', userId: 'u2' },
        },
      });
      installWirebenchApi({ account: { setActive } });
      useAccountStore.setState({ servers: [work, test], active: ACTIVE });
      useWorkspaceStore.setState({
        workspace: {
          share: {
            kind: 'server',
            managed: true,
            server: { url: 'https://wb.test/', workspaceId: 'W', recording: false },
          },
        } as never,
      });
      try {
        await useAccountStore.getState().setActive({ url: 'https://wb.test', userId: 'u2' });
        expect(showToast).toHaveBeenCalledWith(
          'The open workspace keeps syncing as Alice, the account it was opened with.',
        );
      } finally {
        useWorkspaceStore.setState({ workspace: null });
      }
    });

    it('a refused switch is toasted and leaves the active account', async () => {
      const setActive = vi.fn().mockResolvedValue({ ok: false, error: { code: 'account-signed-out', message: 'no' } });
      installWirebenchApi({ account: { setActive } });
      useAccountStore.setState({ servers: [work, test], active: ACTIVE });
      expect(await useAccountStore.getState().setActive({ url: 'https://wb.test', userId: 'u2' })).toBe(false);
      expect(useAccountStore.getState().active).toEqual(ACTIVE);
      expect(showToast).toHaveBeenCalledWith('Could not switch accounts: no');
    });

    it('in a browser tab, lists the browser’s other accounts from env and switches to one with env.switchAccount', async () => {
      const list = vi.fn().mockResolvedValue({ ok: true, value: { servers: [work], active: ACTIVE } });
      const setActive = vi.fn();
      const api = installWirebenchApi({ account: { list, setActive } });
      const switchAccount = vi.fn();
      const rememberedAccounts = vi.fn().mockResolvedValue([
        { userId: 'u2', displayName: 'Tess', email: 'test@example.com', username: null, photo: null },
        // The tab's own account is never listed twice.
        { userId: 'u1', displayName: 'Alice', email: 'alice@example.com', username: null, photo: null },
      ]);
      browserEnv(api, { switchAccount, rememberedAccounts, signOut: vi.fn() });
      await useAccountStore.getState().load();
      const rows = useAccountStore.getState().servers;
      expect(rows.map((row) => [row.userId, row.remembered === true])).toEqual([
        ['u1', false],
        ['u2', true],
      ]);
      expect(rows[1]).toMatchObject({ url: 'https://wb.test', email: 'test@example.com', signedOut: false });
      // An account.changed from the host keeps the remembered rows.
      useAccountStore.getState().applyChanged([work], ACTIVE);
      expect(useAccountStore.getState().servers).toHaveLength(2);

      expect(await useAccountStore.getState().setActive({ url: 'https://wb.test', userId: 'u2' })).toBe(true);
      expect(switchAccount).toHaveBeenCalledWith('u2');
      expect(setActive).not.toHaveBeenCalled();
    });

    it('in a browser tab, a host answering account-switch-in-browser hands the switch to the browser', async () => {
      const setActive = vi
        .fn()
        .mockResolvedValue({ ok: false, error: { code: 'account-switch-in-browser', message: 'browser' } });
      const api = installWirebenchApi({ account: { setActive } });
      const switchAccount = vi.fn();
      browserEnv(api, { switchAccount });
      useAccountStore.setState({ servers: [work, test], active: ACTIVE });
      expect(await useAccountStore.getState().setActive({ url: 'https://wb.test', userId: 'u2' })).toBe(true);
      expect(switchAccount).toHaveBeenCalledWith('u2');
      expect(showToast).not.toHaveBeenCalled();
    });
  });

  it('maps the codes a sign-in can fail with to copy, and falls back to the message', () => {
    expect(signInErrorMessage({ code: 'identity-invalid-credentials', message: 'x' })).toBe(
      'Wrong email, username or password.',
    );
    expect(signInErrorMessage({ code: 'server-not-wirebench', message: 'x' })).toBe(
      'That address is not a Wirebench Server.',
    );
    expect(signInErrorMessage({ code: 'identity-not-invited', message: 'x' })).toContain('invite you');
    expect(signInErrorMessage({ code: 'licensing-seat-limit', message: 'This server has 5 enabled accounts.' })).toBe(
      'This server has 5 enabled accounts. Ask a server admin.',
    );
    expect(signInErrorMessage({ code: 'something-else', message: 'the message' })).toBe('the message');
  });
});
