import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AccountStatusItem } from '../../src/renderer/features/account/account-status-item.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { AccountWire } from '@wirebench/wire/wire-base';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const account = (url: string, signedOut = false, patch: Partial<AccountWire> = {}): AccountWire => ({
  url,
  userId: 'u',
  email: `a@${new URL(url).host}`,
  displayName: 'A',
  deviceName: 'd',
  signedOut,
  addedAt: '2026-09-24T12:00:00.000Z',
  ...patch,
});

describe('AccountStatusItem', () => {
  beforeEach(() => {
    installWirebenchApi();
    usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE });
    useAccountStore.setState({ servers: [], active: null, loaded: true });
    useUiStore.setState({
      signInDialog: { open: false, url: undefined },
      teamDialog: { open: false, url: undefined },
      preferences: { open: false, area: 'app', section: undefined },
    });
  });
  afterEach(() => {
    cleanup();
  });

  it('renders nothing while no server is known, and nothing when the preference is off', () => {
    const { rerender } = render(<AccountStatusItem />);
    expect(screen.queryByTestId('status-bar-account')).toBeNull();
    useAccountStore.setState({ servers: [account('https://wb.test')] });
    usePreferencesStore.setState({
      preferences: { ...DEFAULT_PREFERENCES_WIRE, accounts: { showInStatusBar: false } },
    });
    rerender(<AccountStatusItem />);
    expect(screen.queryByTestId('status-bar-account')).toBeNull();
  });

  /** Opens the menu the way a pointer does. */
  const openMenu = async () => {
    const item = screen.getByTestId('status-bar-account');
    fireEvent.pointerDown(item, { button: 0, ctrlKey: false });
    fireEvent.click(item);
    return await screen.findByTestId('status-bar-account-menu');
  };

  it('shows the active account’s email, and a menu in the order of ruling 10', async () => {
    useAccountStore.setState({
      servers: [account('https://wb.test', false, { displayName: 'Alice', username: 'alice' })],
    });
    render(<AccountStatusItem />);
    expect(screen.getByTestId('status-bar-account').getAttribute('title')).toBe('a@wb.test');
    const menu = await openMenu();
    const header = screen.getByTestId('account-menu-header');
    expect(header.textContent).toContain('Alice');
    expect(header.textContent).toContain('@alice · a@wb.test');
    // One server: no host in the header.
    expect(screen.queryByTestId('account-menu-host')).toBeNull();
    const ids = [...menu.querySelectorAll('[data-testid]')]
      .map((node) => node.getAttribute('data-testid'))
      .filter((id) => id !== null && !id.includes('avatar'));
    expect(ids).toEqual([
      'account-menu-header',
      'account-view-profile',
      'account-settings',
      'account-sign-out',
      'account-add',
    ]);
    expect(menu.textContent).toContain('Switch accounts');
    // Manage team…, Account settings… and Signed-in devices… left the menu.
    for (const gone of ['account-manage', 'account-devices', 'account-manage-teams'])
      expect(screen.queryByTestId(gone)).toBeNull();
  });

  it('View profile opens User settings on Profile, Settings on its default page', async () => {
    useAccountStore.setState({ servers: [account('https://wb.test')] });
    render(<AccountStatusItem />);
    await openMenu();
    fireEvent.click(screen.getByTestId('account-view-profile'));
    expect(useUiStore.getState().preferences).toEqual({ open: true, area: 'user', section: 'profile' });
    useUiStore.setState({ preferences: { open: false, area: 'app', section: undefined } });
    await openMenu();
    fireEvent.click(await screen.findByTestId('account-settings'));
    expect(useUiStore.getState().preferences).toEqual({ open: true, area: 'user', section: undefined });
  });

  it('Sign out signs the active account out, by account', async () => {
    const signOut = vi.fn().mockResolvedValue({ ok: true, value: { servers: [], active: null } });
    installWirebenchApi({ account: { signOut } });
    useAccountStore.setState({
      servers: [account('https://one.test'), account('https://two.test', false, { userId: 'v' })],
      active: { url: 'https://two.test', userId: 'v' },
    });
    render(<AccountStatusItem />);
    expect(screen.getByTestId('status-bar-account').getAttribute('title')).toBe('a@two.test');
    await openMenu();
    fireEvent.click(screen.getByTestId('account-sign-out'));
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledWith({ account: { url: 'https://two.test', userId: 'v' } }));
  });

  it('a known but signed-out server shows Sign in, which opens the dialog on that URL', () => {
    useAccountStore.setState({ servers: [account('https://wb.test', true)] });
    render(<AccountStatusItem />);
    const item = screen.getByTestId('status-bar-account');
    expect(item.textContent).toContain('Sign in');
    fireEvent.click(item);
    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: 'https://wb.test' });
  });

  it('lists the other accounts under Switch accounts, with hosts when servers differ, and switches on the desktop', async () => {
    const setActive = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        servers: [
          account('https://one.test', false, { userId: 'u1', active: false }),
          account('https://two.test', false, { userId: 'u2', displayName: 'Bob', active: true }),
        ],
        active: { url: 'https://two.test', userId: 'u2' },
      },
    });
    installWirebenchApi({ account: { setActive } });
    useAccountStore.setState({
      servers: [
        account('https://one.test', false, { userId: 'u1', active: true }),
        account('https://two.test', false, { userId: 'u2', displayName: 'Bob' }),
      ],
      active: { url: 'https://one.test', userId: 'u1' },
    });
    render(<AccountStatusItem />);
    await openMenu();
    expect(screen.getByTestId('account-menu-host').textContent).toBe('one.test');
    expect(screen.queryByTestId('account-switch-u1')).toBeNull();
    const row = screen.getByTestId('account-switch-u2');
    expect(row.textContent).toContain('Bob');
    expect(row.textContent).toContain('a@two.test · two.test');
    expect(screen.getByTestId('account-switch-avatar-u2')).toBeTruthy();
    fireEvent.click(row);
    await vi.waitFor(() =>
      expect(setActive).toHaveBeenCalledWith({ account: { url: 'https://two.test', userId: 'u2' } }),
    );
    await vi.waitFor(() => expect(screen.getByTestId('status-bar-account').getAttribute('title')).toBe('a@two.test'));
  });

  it('a signed-out account shows dimmed with Sign in, which opens the dialog on its server', async () => {
    useAccountStore.setState({
      servers: [
        account('https://wb.test', false, { userId: 'u1' }),
        account('https://wb.test', true, { userId: 'u2', email: 'old@wb.test' }),
      ],
      active: { url: 'https://wb.test', userId: 'u1' },
    });
    render(<AccountStatusItem />);
    await openMenu();
    const row = screen.getByTestId('account-switch-u2');
    expect(row.getAttribute('data-state')).toBe('signed-out');
    expect(row.textContent).toContain('Sign in');
    // Same server: no host on the row.
    expect(row.textContent).not.toContain('wb.test ·');
    fireEvent.click(row);
    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: 'https://wb.test' });
  });

  it('Add account opens the sign-in dialog on the active server', async () => {
    useAccountStore.setState({
      servers: [account('https://one.test'), account('https://two.test', false, { userId: 'v' })],
      active: { url: 'https://two.test', userId: 'v' },
    });
    render(<AccountStatusItem />);
    await openMenu();
    fireEvent.click(screen.getByTestId('account-add'));
    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: 'https://two.test' });
  });

  describe('in a browser tab, whose env carries the account actions', () => {
    const browserEnv = (api: object, extra: Record<string, unknown>) => {
      Object.defineProperty(api, 'env', {
        configurable: true,
        value: { e2e: false, osTheme: 'dark', host: 'browser', capabilities: ['send:public'], ...extra },
      });
    };

    it('Sign out calls env.signOut, never the account channel', async () => {
      const ipcSignOut = vi.fn();
      const api = installWirebenchApi({ account: { signOut: ipcSignOut } });
      const signOut = vi.fn();
      browserEnv(api, { signOut });
      useAccountStore.setState({ servers: [account('https://wb.test')] });
      render(<AccountStatusItem />);
      await openMenu();
      const signOutItem = screen.getByTestId('account-sign-out');
      expect(signOutItem.textContent).toBe('Sign out');
      fireEvent.click(signOutItem);
      expect(signOut).toHaveBeenCalledTimes(1);
      expect(ipcSignOut).not.toHaveBeenCalled();
    });

    it('switches to a remembered account with env.switchAccount, and adds one with env.addAccount', async () => {
      const ipcSetActive = vi.fn();
      const api = installWirebenchApi({ account: { setActive: ipcSetActive } });
      const switchAccount = vi.fn();
      const addAccount = vi.fn();
      browserEnv(api, { signOut: vi.fn(), switchAccount, addAccount });
      useAccountStore.setState({
        servers: [
          account('https://wb.test', false, { userId: 'u1', active: true }),
          account('https://wb.test', false, { userId: 'u2', displayName: 'Bob', remembered: true }),
        ],
        active: { url: 'https://wb.test', userId: 'u1' },
      });
      render(<AccountStatusItem />);
      await openMenu();
      fireEvent.click(screen.getByTestId('account-switch-u2'));
      await vi.waitFor(() => expect(switchAccount).toHaveBeenCalledWith('u2'));
      expect(ipcSetActive).not.toHaveBeenCalled();
      await openMenu();
      fireEvent.click(await screen.findByTestId('account-add'));
      expect(addAccount).toHaveBeenCalledTimes(1);
      expect(useUiStore.getState().signInDialog.open).toBe(false);
    });
  });
});
