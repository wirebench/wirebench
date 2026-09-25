import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AccountsSection } from '../../src/renderer/features/preferences/sections/accounts-section.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { AccountWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

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
    useUiStore.setState({ signInDialog: { open: false, url: undefined } });
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

  it('says so when no server is known', () => {
    render(<AccountsSection preferences={DEFAULT_PREFERENCES_WIRE} update={vi.fn()} />);
    expect(screen.getByTestId('accounts-section').textContent).toContain('No servers yet');
  });
});
