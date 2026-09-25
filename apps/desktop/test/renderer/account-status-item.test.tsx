import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AccountStatusItem } from '../../src/renderer/features/account/account-status-item.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { AccountWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const account = (url: string, signedOut = false): AccountWire => ({
  url,
  userId: 'u',
  email: `a@${new URL(url).host}`,
  displayName: 'A',
  deviceName: 'd',
  signedOut,
  addedAt: '2026-09-24T12:00:00.000Z',
});

describe('AccountStatusItem', () => {
  beforeEach(() => {
    installWirebenchApi();
    usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE });
    useAccountStore.setState({ servers: [], loaded: true });
    useUiStore.setState({
      signInDialog: { open: false, url: undefined },
      preferences: { open: false, section: undefined },
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

  it('shows the email of the signed-in server, and Sign out of it in the menu', async () => {
    const signOut = vi.fn().mockResolvedValue({ ok: true, value: { servers: [account('https://wb.test', true)] } });
    installWirebenchApi({ account: { signOut } });
    useAccountStore.setState({ servers: [account('https://wb.test')] });
    render(<AccountStatusItem />);
    const item = screen.getByTestId('status-bar-account');
    expect(item.textContent).toContain('a@wb.test');
    fireEvent.pointerDown(item, { button: 0, ctrlKey: false });
    fireEvent.click(item);
    const signOutItem = await screen.findByTestId('account-sign-out-wb.test');
    expect(signOutItem.textContent).toBe('Sign out of https://wb.test');
    fireEvent.click(signOutItem);
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledWith({ url: 'https://wb.test' }));
  });

  it('a known but signed-out server shows Sign in, which opens the dialog on that URL', () => {
    useAccountStore.setState({ servers: [account('https://wb.test', true)] });
    render(<AccountStatusItem />);
    const item = screen.getByTestId('status-bar-account');
    expect(item.textContent).toContain('Sign in');
    fireEvent.click(item);
    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: 'https://wb.test' });
  });

  it('with several signed-in servers the label counts them and the menu lists each', async () => {
    useAccountStore.setState({ servers: [account('https://one.test'), account('https://two.test')] });
    render(<AccountStatusItem />);
    const item = screen.getByTestId('status-bar-account');
    expect(item.textContent).toContain('a@one.test +1');
    fireEvent.pointerDown(item, { button: 0, ctrlKey: false });
    fireEvent.click(item);
    await screen.findByTestId('account-sign-out-one.test');
    await screen.findByTestId('account-sign-out-two.test');
    fireEvent.click(screen.getByTestId('account-manage'));
    expect(useUiStore.getState().preferences).toEqual({ open: true, section: 'accounts' });
  });
});
