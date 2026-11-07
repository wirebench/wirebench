/**
 * User settings' state (settings split spec §4): you on one server — your profile and signed-in devices — read when
 * the page opens or the server picker changes, never persisted. A password typed on the Password page goes out
 * through {@link UserSettingsStore.changePassword} and is not kept here: the refusal goes back to the form.
 */
import { create } from 'zustand';
import type { IpcError } from '@shared/ipc.js';
import type { AccountDeviceWire, AccountProfileWire } from '@shared/wire-base.js';
import { showToast } from '../components/toast.js';
import { MIN_PASSWORD_LENGTH } from '../features/account/password-rules.js';
import { useAccountStore } from './account.js';
import { ipc } from './ipc-client.js';

/** The server's display-name limit (`MAX_DISPLAY_NAME_LENGTH`), restated: the renderer imports no engine values. */
export const MAX_DISPLAY_NAME_LENGTH = 120;

export type UserSettingsAnswer = { readonly ok: true } | { readonly ok: false; readonly message: string };

interface UserSettingsState {
  readonly url: string | undefined;
  readonly profile: AccountProfileWire | undefined;
  readonly devices: readonly AccountDeviceWire[];
  readonly loading: boolean;
  readonly error: string | undefined;
}

interface UserSettingsStore extends UserSettingsState {
  /** Profile and devices for `url`; an answer for a server the page has since left is dropped. */
  readonly load: (url: string) => Promise<void>;
  /** `account.updateProfile`; on success the account list reloads, so the status bar shows the new name. */
  readonly rename: (name: string) => Promise<UserSettingsAnswer>;
  readonly changePassword: (currentPassword: string | undefined, newPassword: string) => Promise<UserSettingsAnswer>;
  readonly signOutDevice: (id: string) => Promise<boolean>;
  readonly reset: () => void;
}

const INITIAL: UserSettingsState = {
  url: undefined,
  profile: undefined,
  devices: [],
  loading: false,
  error: undefined,
};

const NAME_MESSAGES: Readonly<Record<string, string>> = {
  'identity-name-invalid': `Enter a name of 1 to ${String(MAX_DISPLAY_NAME_LENGTH)} characters.`,
};

const PASSWORD_MESSAGES: Readonly<Record<string, string>> = {
  'identity-invalid-credentials': 'The current password is not right.',
  'identity-password-too-short': `Choose a password of at least ${String(MIN_PASSWORD_LENGTH)} characters.`,
  'identity-method-disabled': 'This server does not sign in with passwords.',
};

const messageOf = (messages: Readonly<Record<string, string>>, error: IpcError): string =>
  messages[error.code] ?? error.message;

export const useUserSettingsStore = create<UserSettingsStore>((set, get) => ({
  ...INITIAL,

  load: async (url) => {
    // Another server's profile is never shown under this one's name, even for a moment.
    const same = get().url === url;
    set({ url, loading: true, error: undefined, ...(same ? {} : { profile: undefined, devices: [] }) });
    const [profile, devices] = await Promise.all([ipc().account.profile({ url }), ipc().account.devices({ url })]);
    if (get().url !== url) return;
    set({
      loading: false,
      profile: profile.ok ? profile.value : undefined,
      devices: devices.ok ? devices.value.devices : [],
      error: !profile.ok ? profile.error.message : !devices.ok ? devices.error.message : undefined,
    });
  },

  rename: async (name) => {
    const url = get().url;
    if (url === undefined) return { ok: false, message: 'Sign in to a server first.' };
    const result = await ipc().account.updateProfile({ url, name });
    if (!result.ok) return { ok: false, message: messageOf(NAME_MESSAGES, result.error) };
    if (get().url === url) set({ profile: result.value });
    await useAccountStore.getState().load();
    return { ok: true };
  },

  changePassword: async (currentPassword, newPassword) => {
    const url = get().url;
    if (url === undefined) return { ok: false, message: 'Sign in to a server first.' };
    const result = await ipc().account.changePassword({
      url,
      ...(currentPassword === undefined ? {} : { currentPassword }),
      newPassword,
    });
    return result.ok ? { ok: true } : { ok: false, message: messageOf(PASSWORD_MESSAGES, result.error) };
  },

  signOutDevice: async (id) => {
    const url = get().url;
    if (url === undefined) return false;
    const result = await ipc().account.signOutDevice({ url, id });
    if (!result.ok) {
      showToast(`Could not sign the device out: ${result.error.message}`);
      return false;
    }
    if (get().url === url) set({ devices: get().devices.filter((device) => device.id !== id) });
    return true;
  },

  reset: () => {
    set(INITIAL);
  },
}));
