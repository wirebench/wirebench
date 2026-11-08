/**
 * User settings' state (settings split spec §4): you on one server — your profile and signed-in devices — read when
 * the page opens or the server picker changes, never persisted. A password typed on the Password page goes out
 * through {@link UserSettingsStore.changePassword} and is not kept here: the refusal goes back to the form.
 */
import { create } from 'zustand';
import type { IpcError } from '@shared/ipc.js';
import type { AccountDeviceWire, AccountImageKindWire, AccountProfileWire } from '@shared/wire-base.js';
import { showToast } from '../components/toast.js';
import { MIN_PASSWORD_LENGTH } from '../features/account/password-rules.js';
import { useAccountStore } from './account.js';
import { ipc } from './ipc-client.js';

/** The server's display-name limit (`MAX_DISPLAY_NAME_LENGTH`), restated: the renderer imports no engine values. */
export const MAX_DISPLAY_NAME_LENGTH = 120;

/** The server's username rules (`USERNAME_PATTERN`, `MIN_`/`MAX_USERNAME_LENGTH`), restated like the name's. */
export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 30;
export const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,29}$/;
/** The server's about limit (`MAX_ABOUT_LENGTH`), restated. */
export const MAX_ABOUT_LENGTH = 500;

export const USERNAME_HINT = 'Sign in with this or your email.';

/**
 * What is wrong with a typed username before the server is asked, in the server's own words; `undefined` when the
 * pattern holds. The reserved names are the server's to refuse.
 */
export function usernameProblem(username: string): string | undefined {
  return USERNAME_PATTERN.test(username)
    ? undefined
    : `A username is ${String(MIN_USERNAME_LENGTH)} to ${String(MAX_USERNAME_LENGTH)} letters, digits, dots, dashes or underscores, starting with a letter or digit.`;
}

/** The profile fields whose refusals the store keeps, each shown under its own field. */
export type ProfileField = 'username' | 'about' | AccountImageKindWire;

export type UserSettingsAnswer = { readonly ok: true } | { readonly ok: false; readonly message: string };

interface UserSettingsState {
  readonly url: string | undefined;
  readonly profile: AccountProfileWire | undefined;
  readonly devices: readonly AccountDeviceWire[];
  readonly loading: boolean;
  readonly error: string | undefined;
  /** The last refusal of each profile field; cleared when that field saves or is reset. */
  readonly errors: Readonly<Partial<Record<ProfileField, string>>>;
}

interface UserSettingsStore extends UserSettingsState {
  /** Profile and devices for `url`; an answer for a server the page has since left is dropped. */
  readonly load: (url: string) => Promise<void>;
  /** `account.updateProfile`; on success the account list reloads, so the status bar shows the new name. */
  readonly rename: (name: string) => Promise<UserSettingsAnswer>;
  /** `account.updateProfile { username }`; `null` clears it. Reloads the account list for the account menu. */
  readonly setUsername: (username: string | null) => Promise<UserSettingsAnswer>;
  readonly setAbout: (about: string) => Promise<UserSettingsAnswer>;
  /** `account.setImage` with the cropped WebP (base64); the photo also reloads the account list. */
  readonly setImage: (kind: AccountImageKindWire, data: string) => Promise<UserSettingsAnswer>;
  readonly removeImage: (kind: AccountImageKindWire) => Promise<UserSettingsAnswer>;
  readonly clearError: (field: ProfileField) => void;
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
  errors: {},
};

const NOT_SIGNED_IN: UserSettingsAnswer = { ok: false, message: 'Sign in to a server first.' };

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

function without(
  errors: UserSettingsState['errors'],
  field: ProfileField,
): Readonly<Partial<Record<ProfileField, string>>> {
  const next = { ...errors };
  delete next[field];
  return next;
}

/** Keeps a refusal under its field, unless the page has moved to another server meanwhile. */
function refused(url: string, field: ProfileField, error: IpcError): UserSettingsAnswer {
  const store = useUserSettingsStore;
  if (store.getState().url === url) store.setState({ errors: { ...store.getState().errors, [field]: error.message } });
  return { ok: false, message: error.message };
}

/** The profile with one image changed, as the server now holds it. */
function withImage(url: string, kind: AccountImageKindWire, ref: { readonly version: string } | null): void {
  const store = useUserSettingsStore;
  const { profile, errors } = store.getState();
  if (store.getState().url !== url || profile === undefined) return;
  store.setState({ profile: { ...profile, user: { ...profile.user, [kind]: ref } }, errors: without(errors, kind) });
}

export const useUserSettingsStore = create<UserSettingsStore>((set, get) => ({
  ...INITIAL,

  load: async (url) => {
    // Another server's profile is never shown under this one's name, even for a moment.
    const same = get().url === url;
    set({ url, loading: true, error: undefined, ...(same ? {} : { profile: undefined, devices: [], errors: {} }) });
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
    if (url === undefined) return NOT_SIGNED_IN;
    const result = await ipc().account.updateProfile({ url, name });
    if (!result.ok) return { ok: false, message: messageOf(NAME_MESSAGES, result.error) };
    if (get().url === url) set({ profile: result.value });
    await useAccountStore.getState().load();
    return { ok: true };
  },

  setUsername: async (username) => {
    const url = get().url;
    if (url === undefined) return NOT_SIGNED_IN;
    const result = await ipc().account.updateProfile({ url, username });
    if (!result.ok) return refused(url, 'username', result.error);
    if (get().url === url) set({ profile: result.value, errors: without(get().errors, 'username') });
    await useAccountStore.getState().load();
    return { ok: true };
  },

  setAbout: async (about) => {
    const url = get().url;
    if (url === undefined) return NOT_SIGNED_IN;
    const result = await ipc().account.updateProfile({ url, about });
    if (!result.ok) return refused(url, 'about', result.error);
    if (get().url === url) set({ profile: result.value, errors: without(get().errors, 'about') });
    return { ok: true };
  },

  setImage: async (kind, data) => {
    const url = get().url;
    if (url === undefined) return NOT_SIGNED_IN;
    const result = await ipc().account.setImage({ url, kind, data });
    if (!result.ok) return refused(url, kind, result.error);
    withImage(url, kind, { version: result.value.version });
    if (kind === 'photo') await useAccountStore.getState().load();
    return { ok: true };
  },

  removeImage: async (kind) => {
    const url = get().url;
    if (url === undefined) return NOT_SIGNED_IN;
    const result = await ipc().account.removeImage({ url, kind });
    if (!result.ok) return refused(url, kind, result.error);
    withImage(url, kind, null);
    if (kind === 'photo') await useAccountStore.getState().load();
    return { ok: true };
  },

  clearError: (field) => {
    if (get().errors[field] !== undefined) set({ errors: without(get().errors, field) });
  },

  changePassword: async (currentPassword, newPassword) => {
    const url = get().url;
    if (url === undefined) return NOT_SIGNED_IN;
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
