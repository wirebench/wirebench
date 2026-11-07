import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MIN_PASSWORD_LENGTH as ENGINE_MIN } from '@wirebench/engine';
import type { AccountDeviceWire, AccountProfileWire, AccountWire } from '@wirebench/wire/wire-base';
import { UserSettings } from '../../src/renderer/features/preferences/user/user-settings.js';
import { MIN_PASSWORD_LENGTH } from '../../src/renderer/features/account/password-rules.js';
import { SettingsPage } from '../../src/renderer/features/preferences/settings-page.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useUserSettingsStore } from '../../src/renderer/state/user-settings.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const ONE = 'https://one.test';
const TWO = 'https://two.test';

const account = (url: string, displayName = 'Ada'): AccountWire => ({
  url,
  userId: 'u1',
  email: `ada@${new URL(url).host}`,
  displayName,
  deviceName: 'Mac',
  signedOut: false,
  addedAt: '2026-11-01T10:00:00.000Z',
});

const profile = (url: string, overrides: Partial<AccountProfileWire> = {}): AccountProfileWire => ({
  user: { id: 'u1', email: `ada@${new URL(url).host}`, displayName: `Ada ${new URL(url).host}`, serverAdmin: false },
  methods: { local: true, oidc: [{ issuer: 'https://idp.test' }] },
  localPasswords: true,
  ...overrides,
});

const DEVICES: AccountDeviceWire[] = [
  {
    id: 'd1',
    name: 'Mac',
    createdAt: '2026-11-01T10:00:00.000Z',
    lastUsedAt: '2026-11-07T10:00:00.000Z',
    current: true,
  },
  {
    id: 'd2',
    name: 'Laptop',
    createdAt: '2026-10-01T10:00:00.000Z',
    lastUsedAt: '2026-10-02T10:00:00.000Z',
    current: false,
  },
];

const ok = <T,>(value: T) => ({ ok: true as const, value });

function api(overrides: Record<string, unknown> = {}) {
  const account = {
    list: vi.fn(() => Promise.resolve(ok({ servers: useAccountStore.getState().servers }))),
    profile: vi.fn(({ url }: { url: string }) => Promise.resolve(ok(profile(url)))),
    devices: vi.fn().mockResolvedValue(ok({ devices: DEVICES })),
    updateProfile: vi.fn(({ url, name }: { url: string; name: string }) =>
      Promise.resolve(ok({ ...profile(url), user: { ...profile(url).user, displayName: name } })),
    ),
    changePassword: vi.fn().mockResolvedValue(ok({ done: true })),
    signOutDevice: vi.fn().mockResolvedValue(ok({ done: true })),
    ...overrides,
  };
  installWirebenchApi({ account: account as never });
  return account;
}

beforeEach(() => {
  useAccountStore.setState({ servers: [account(ONE)], loaded: true });
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE, loaded: true });
  useUserSettingsStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ preferences: { open: false, area: 'app', section: undefined } });
});

describe('User settings (settings split spec §4)', () => {
  it('opens on Profile with the account’s name and email', async () => {
    const calls = api();
    render(<UserSettings />);
    expect(screen.getByTestId('user-settings')).toBeTruthy();
    expect(screen.getByTestId('user-settings-nav-profile').getAttribute('aria-current')).toBe('page');
    await waitFor(() => {
      expect(screen.getByTestId<HTMLInputElement>('user-profile-name').value).toBe('Ada one.test');
    });
    expect(screen.getByTestId<HTMLInputElement>('user-profile-email').value).toBe('ada@one.test');
    const methods = screen.getByTestId('user-profile-methods').textContent;
    expect(methods).toContain('Password');
    expect(methods).toContain('Single sign-on · https://idp.test');
    expect(calls.profile).toHaveBeenCalledWith({ url: ONE });
  });

  it('opens through the settings page in the user area', async () => {
    api();
    render(<SettingsPage />);
    useUiStore.getState().openUserSettings('devices');
    expect(await screen.findByTestId('user-settings')).toBeTruthy();
    await screen.findByTestId('user-device-d1');
  });

  it('renames on blur and reloads the account list', async () => {
    const calls = api();
    render(<UserSettings />);
    const name = await screen.findByDisplayValue('Ada one.test');
    fireEvent.change(name, { target: { value: '  Ada Lovelace  ' } });
    fireEvent.blur(name);
    await waitFor(() => {
      expect(calls.updateProfile).toHaveBeenCalledTimes(1);
    });
    expect(calls.updateProfile).toHaveBeenCalledWith({ url: ONE, name: 'Ada Lovelace' });
    await waitFor(() => {
      expect(calls.list).toHaveBeenCalled();
    });
    expect(screen.getByTestId<HTMLInputElement>('user-profile-name').value).toBe('Ada Lovelace');
  });

  it('refuses a blank name without asking the server, and shows a server refusal under the field', async () => {
    const calls = api({
      updateProfile: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'identity-name-invalid', message: 'bad name' },
      }),
    });
    render(<UserSettings />);
    const name = await screen.findByDisplayValue('Ada one.test');
    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    fireEvent.blur(name);
    expect(await screen.findByTestId('user-profile-name-error')).toBeTruthy();
    expect(calls.updateProfile).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: 'x'.repeat(121) } });
    fireEvent.blur(name);
    expect(calls.updateProfile).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: 'Ada B' } });
    fireEvent.blur(name);
    await waitFor(() => {
      expect(screen.getByTestId('user-profile-name-error').textContent).toContain('1 to 120');
    });
    expect(calls.updateProfile).toHaveBeenCalledTimes(1);
  });

  it('hides Password where local passwords are off', async () => {
    api({ profile: vi.fn().mockResolvedValue(ok(profile(ONE, { localPasswords: false }))) });
    render(<UserSettings initialPage="password" />);
    await screen.findByDisplayValue('Ada one.test');
    expect(screen.queryByTestId('user-settings-nav-password')).toBeNull();
    expect(screen.queryByTestId('user-password-new')).toBeNull();
  });

  it('changes the password, says other devices were signed out, and clears the fields', async () => {
    const calls = api();
    render(<UserSettings initialPage="password" />);
    const current = await screen.findByTestId<HTMLInputElement>('user-password-current');
    const next = screen.getByTestId<HTMLInputElement>('user-password-new');
    const repeat = screen.getByTestId<HTMLInputElement>('user-password-repeat');
    const submit = screen.getByTestId<HTMLButtonElement>('user-password-submit');
    fireEvent.change(current, { target: { value: 'old-password-1' } });
    fireEvent.change(next, { target: { value: 'short' } });
    fireEvent.change(repeat, { target: { value: 'short' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(next, { target: { value: 'new-password-2' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(repeat, { target: { value: 'new-password-2' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => {
      expect(screen.getByTestId('user-password-result').textContent).toBe(
        'Password changed. Your other devices were signed out.',
      );
    });
    expect(calls.changePassword).toHaveBeenCalledWith({
      url: ONE,
      currentPassword: 'old-password-1',
      newPassword: 'new-password-2',
    });
    expect([current.value, next.value, repeat.value]).toEqual(['', '', '']);
  });

  it('asks for no current password when the account has none yet', async () => {
    const calls = api({
      profile: vi.fn().mockResolvedValue(ok(profile(ONE, { methods: { local: false, oidc: [] } }))),
    });
    render(<UserSettings initialPage="password" />);
    const next = await screen.findByTestId('user-password-new');
    expect(screen.queryByTestId('user-password-current')).toBeNull();
    fireEvent.change(next, { target: { value: 'new-password-2' } });
    fireEvent.change(screen.getByTestId('user-password-repeat'), { target: { value: 'new-password-2' } });
    fireEvent.click(screen.getByTestId('user-password-submit'));
    await waitFor(() => {
      expect(calls.changePassword).toHaveBeenCalledWith({ url: ONE, newPassword: 'new-password-2' });
    });
  });

  it('shows a refused change and clears the fields; the store never holds a password', async () => {
    api({
      changePassword: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'identity-rate-limited', message: 'Too many attempts. Wait a minute.' },
      }),
    });
    render(<UserSettings initialPage="password" />);
    const current = await screen.findByTestId<HTMLInputElement>('user-password-current');
    const next = screen.getByTestId<HTMLInputElement>('user-password-new');
    const repeat = screen.getByTestId<HTMLInputElement>('user-password-repeat');
    fireEvent.change(current, { target: { value: 'old-password-1' } });
    fireEvent.change(next, { target: { value: 'new-password-2' } });
    fireEvent.change(repeat, { target: { value: 'new-password-2' } });
    fireEvent.click(screen.getByTestId('user-password-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('user-password-result').textContent).toBe('Too many attempts. Wait a minute.');
    });
    expect([current.value, next.value, repeat.value]).toEqual(['', '', '']);
    const held = JSON.stringify(useUserSettingsStore.getState());
    expect(held).not.toContain('old-password-1');
    expect(held).not.toContain('new-password-2');
  });

  it('lists devices; this device has no Sign out; another signs out after confirming', async () => {
    const calls = api();
    render(<UserSettings initialPage="devices" />);
    const mine = await screen.findByTestId('user-device-d1');
    expect(mine.textContent).toContain('This device');
    expect(screen.queryByTestId('user-device-sign-out-d1')).toBeNull();
    const other = screen.getByTestId('user-device-d2');
    expect(other.textContent).toContain('Laptop');
    fireEvent.click(screen.getByTestId('user-device-sign-out-d2'));
    expect(calls.signOutDevice).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => {
      expect(calls.signOutDevice).toHaveBeenCalledWith({ url: ONE, id: 'd2' });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('user-device-d2')).toBeNull();
    });
  });

  it('with two servers signed in, the picker changes which server Profile reads', async () => {
    useAccountStore.setState({ servers: [account(ONE), account(TWO)], loaded: true });
    const calls = api();
    render(<UserSettings />);
    await screen.findByDisplayValue('Ada one.test');
    const picker = screen.getByTestId<HTMLSelectElement>('user-settings-server');
    fireEvent.change(picker, { target: { value: TWO } });
    await screen.findByDisplayValue('Ada two.test');
    expect(calls.profile).toHaveBeenLastCalledWith({ url: TWO });
  });

  it('shows no picker with one server signed in', async () => {
    api();
    render(<UserSettings />);
    await screen.findByDisplayValue('Ada one.test');
    expect(screen.queryByTestId('user-settings-server')).toBeNull();
  });

  it('Servers you’re signed in to is the Accounts list, with the status bar switch', async () => {
    api();
    const update = vi.fn().mockResolvedValue(undefined);
    const reset = vi.fn().mockResolvedValue(undefined);
    usePreferencesStore.setState({
      preferences: { ...DEFAULT_PREFERENCES_WIRE, accounts: { showInStatusBar: false } },
      update,
      reset,
    });
    render(<UserSettings initialPage="servers" />);
    const section = await screen.findByTestId('accounts-section');
    expect(within(section).getByTestId('account-row-one.test')).toBeTruthy();
    expect(screen.getByTestId('user-settings-nav-servers').getAttribute('data-modified')).toBe('true');
    fireEvent.click(screen.getByTestId('accounts-show-in-status-bar'));
    expect(update).toHaveBeenCalledWith({ accounts: { showInStatusBar: true } });
    fireEvent.click(screen.getByTestId('user-servers-reset'));
    expect(reset).toHaveBeenCalledWith('accounts');
  });

  it('keeps the renderer’s minimum password length equal to the engine’s', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(ENGINE_MIN);
  });
});
