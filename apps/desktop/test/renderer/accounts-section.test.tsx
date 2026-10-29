import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AccountsSection } from '../../src/renderer/features/preferences/sections/accounts-section.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { AccountWire } from '@wirebench/wire/wire-base';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { useBrowserEnv } from '../helpers/browser-env.js';

const account = (url: string, signedOut = false): AccountWire => ({
  url,
  userId: 'u',
  email: `a@${new URL(url).host}`,
  displayName: 'Ada',
  deviceName: 'Mac',
  signedOut,
  addedAt: '2026-09-24T12:00:00.000Z',
});

describe('AccountsSection', () => {
  beforeEach(() => {
    installWirebenchApi();
    useAccountStore.setState({ servers: [], loaded: true });
    useUiStore.setState({ signInDialog: { open: false, url: undefined }, teamDialog: { open: false, url: undefined } });
  });
  afterEach(() => {
    cleanup();
  });

  it('lists each server with its state and offers Add server…', () => {
    useAccountStore.setState({ servers: [account('https://one.test'), account('https://two.test', true)] });
    render(<AccountsSection preferences={DEFAULT_PREFERENCES_WIRE} update={vi.fn()} />);
    const one = screen.getByTestId('account-row-one.test');
    expect(one.textContent).toContain('a@one.test');
    expect(one.textContent).toContain('Ada');
    expect(one.textContent).toContain('Signed in');
    expect(one.querySelector('[data-testid="account-row-sign-out"]')).not.toBeNull();
    const two = screen.getByTestId('account-row-two.test');
    expect(two.textContent).toContain('Signed out');
    expect(two.querySelector('[data-testid="account-row-sign-out"]')).toBeNull();
    fireEvent.click(two.querySelector('[data-testid="account-row-sign-in"]')!);
    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: 'https://two.test' });
    fireEvent.click(screen.getByTestId('accounts-add-server'));
    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: undefined });
  });

  it('Sign out and Remove call the store, and the toggle patches the preference', async () => {
    const signOut = vi.fn().mockResolvedValue({ ok: true, value: { servers: [account('https://one.test', true)] } });
    const remove = vi.fn().mockResolvedValue({ ok: true, value: { servers: [] } });
    installWirebenchApi({ account: { signOut, remove } });
    useAccountStore.setState({ servers: [account('https://one.test')] });
    const update = vi.fn();
    render(<AccountsSection preferences={DEFAULT_PREFERENCES_WIRE} update={update} />);
    fireEvent.click(screen.getByTestId('account-row-sign-out'));
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledWith({ url: 'https://one.test' }));
    fireEvent.click(screen.getByTestId('account-row-remove'));
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith({ url: 'https://one.test' }));
    fireEvent.click(screen.getByTestId('accounts-show-in-status-bar'));
    expect(update).toHaveBeenCalledWith({ accounts: { showInStatusBar: false } });
  });

  it('without accounts shows only the tab session, signed out through env.signOut, and nothing to add or remove', () => {
    const signOut = vi.fn();
    const endTab = vi.fn();
    const api = installWirebenchApi({ account: { signOut } });
    useBrowserEnv(api);
    Object.defineProperty(api, 'env', { configurable: true, value: { ...api.env, signOut: endTab } });
    useAccountStore.setState({ servers: [account('https://old.test', true), account('https://wb.test')] });
    render(<AccountsSection preferences={DEFAULT_PREFERENCES_WIRE} update={vi.fn()} />);

    expect(screen.queryByTestId('account-row-old.test')).toBeNull();
    const row = screen.getByTestId('account-row-wb.test');
    for (const testId of ['account-row-remove', 'account-row-sign-in', 'accounts-add-server']) {
      expect(screen.queryByTestId(testId)).toBeNull();
    }
    fireEvent.click(row.querySelector('[data-testid="account-row-sign-out"]')!);
    expect(endTab).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('says so when no server is known', () => {
    render(<AccountsSection preferences={DEFAULT_PREFERENCES_WIRE} update={vi.fn()} />);
    expect(screen.getByTestId('accounts-section').textContent).toContain('No servers yet');
  });

  it('a signed-in row offers Manage teams… for that server; a signed-out row does not', () => {
    useAccountStore.setState({ servers: [account('https://wb.test'), account('https://old.test', true)] });
    render(<AccountsSection preferences={DEFAULT_PREFERENCES_WIRE} update={vi.fn()} />);
    const old = screen.getByTestId('account-row-old.test');
    expect(old.querySelector('[data-testid="account-row-manage-teams"]')).toBeNull();
    const live = screen.getByTestId('account-row-wb.test');
    fireEvent.click(live.querySelector('[data-testid="account-row-manage-teams"]')!);
    expect(useUiStore.getState().teamDialog).toEqual({ open: true, url: 'https://wb.test' });
  });

  it('shows the expiry banner under a server whose license has lapsed', async () => {
    installWirebenchApi({
      license: {
        get: vi.fn().mockResolvedValue({
          ok: true,
          value: { edition: 'community', status: 'expired', seats: { used: 7, limit: 5 }, features: [] },
        }),
      },
    });
    useAccountStore.setState({ servers: [account('https://one.test')] });
    render(<AccountsSection preferences={DEFAULT_PREFERENCES_WIRE} update={vi.fn()} />);
    expect((await screen.findByTestId('license-banner')).textContent).toContain('7 of 5 seats are in use');
  });
});
