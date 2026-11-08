import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  MAX_ABOUT_LENGTH as ENGINE_MAX_ABOUT,
  MAX_USERNAME_LENGTH as ENGINE_MAX_USERNAME,
  MIN_USERNAME_LENGTH as ENGINE_MIN_USERNAME,
  USERNAME_PATTERN as ENGINE_USERNAME_PATTERN,
} from '@wirebench/engine';
import type { AccountProfileWire, AccountWire } from '@wirebench/wire/wire-base';
import { UserSettings } from '../../src/renderer/features/preferences/user/user-settings.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { clearPersonImages } from '../../src/renderer/state/person-images.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import {
  MAX_ABOUT_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_USERNAME_LENGTH,
  USERNAME_PATTERN,
  useUserSettingsStore,
} from '../../src/renderer/state/user-settings.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

// jsdom has no image decoder or canvas: the dialog is replaced by one that saves a fixed WebP at once.
vi.mock('../../src/renderer/features/preferences/user/crop-dialog.js', () => ({
  CropDialog: ({
    open,
    kind,
    file,
    onCancel,
    onSave,
  }: {
    open: boolean;
    kind: string;
    file: File | undefined;
    onCancel: () => void;
    onSave: (data: string) => Promise<void>;
  }) =>
    open ? (
      <div data-testid="crop-dialog" data-kind={kind} data-file={file?.name}>
        <button
          type="button"
          data-testid="crop-save"
          onClick={() => {
            onSave('UklGRg==').catch((error: unknown) => {
              document.body.dataset['cropError'] = (error as Error).message;
            });
          }}
        >
          Save
        </button>
        <button type="button" data-testid="crop-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    ) : null,
}));

const ONE = 'https://one.test';

const account: AccountWire = {
  url: ONE,
  userId: 'u1',
  email: 'ada@one.test',
  displayName: 'Ada',
  deviceName: 'Mac',
  signedOut: false,
  addedAt: '2026-11-01T10:00:00.000Z',
};

type User = AccountProfileWire['user'];

const profileOf = (user: Partial<User> = {}): AccountProfileWire => ({
  user: {
    id: 'u1',
    email: 'ada@one.test',
    displayName: 'Ada',
    serverAdmin: false,
    username: null,
    about: '',
    photo: null,
    cover: null,
    ...user,
  },
  methods: { local: true, oidc: [] },
  localPasswords: true,
});

const ok = <T,>(value: T) => ({ ok: true as const, value });
const refusal = (code: string, message: string) => ({ ok: false as const, error: { code, message } });

function api(start: AccountProfileWire = profileOf(), overrides: Record<string, unknown> = {}) {
  let current = start;
  const calls = {
    list: vi.fn(() => Promise.resolve(ok({ servers: useAccountStore.getState().servers }))),
    profile: vi.fn(() => Promise.resolve(ok(current))),
    devices: vi.fn().mockResolvedValue(ok({ devices: [] })),
    updateProfile: vi.fn((request: { username?: string | null; about?: string }) => {
      current = {
        ...current,
        user: {
          ...current.user,
          ...(request.username !== undefined ? { username: request.username?.toLowerCase() ?? null } : {}),
          ...(request.about !== undefined ? { about: request.about } : {}),
        },
      };
      return Promise.resolve(ok(current));
    }),
    image: vi.fn(({ kind, version }: { kind: string; version: string }) =>
      Promise.resolve(ok({ dataUrl: `data:image/webp;base64,${kind}-${version}` })),
    ),
    setImage: vi.fn().mockResolvedValue(ok({ version: 'p1' })),
    removeImage: vi.fn().mockResolvedValue(ok({ done: true })),
    ...overrides,
  };
  installWirebenchApi({ account: calls as never });
  return calls;
}

beforeEach(() => {
  clearPersonImages();
  useAccountStore.setState({ servers: [account], loaded: true });
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE, loaded: true });
  useUserSettingsStore.getState().reset();
  delete document.body.dataset['cropError'];
});

afterEach(() => {
  cleanup();
});

describe('Profile page: username (user profile spec §3)', () => {
  it('shows the @ prefix and the hint, saves on Enter and reloads the account list', async () => {
    const calls = api();
    render(<UserSettings />);
    const input = await screen.findByTestId<HTMLInputElement>('user-profile-username');
    expect(screen.getByTestId('user-profile-username-box').textContent).toContain('@');
    expect(screen.getByText('Sign in with this or your email.')).toBeTruthy();
    fireEvent.change(input, { target: { value: '  Ada.L  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(calls.updateProfile).toHaveBeenCalledWith({ url: ONE, username: 'Ada.L' });
    });
    // The stored, lower-cased form replaces the draft.
    await waitFor(() => {
      expect(input.value).toBe('ada.l');
    });
    expect(calls.updateProfile).toHaveBeenCalledTimes(1);
    expect(calls.list).toHaveBeenCalled();
  });

  it('refuses a malformed username without asking the server', async () => {
    const calls = api();
    render(<UserSettings />);
    const input = await screen.findByTestId('user-profile-username');
    fireEvent.change(input, { target: { value: 'a@b' } });
    fireEvent.blur(input);
    expect((await screen.findByTestId('user-profile-username-error')).textContent).toContain('3 to 30');
    expect(calls.updateProfile).not.toHaveBeenCalled();
  });

  it('shows a taken username under the field in the server’s words and keeps the draft', async () => {
    api(profileOf(), {
      updateProfile: vi
        .fn()
        .mockResolvedValue(refusal('identity-username-taken', 'Someone on this server already has this username.')),
    });
    render(<UserSettings />);
    const input = await screen.findByTestId<HTMLInputElement>('user-profile-username');
    fireEvent.change(input, { target: { value: 'grace' } });
    fireEvent.blur(input);
    expect((await screen.findByTestId('user-profile-username-error')).textContent).toBe(
      'Someone on this server already has this username.',
    );
    expect(input.value).toBe('grace');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(useUserSettingsStore.getState().errors.username).toBe('Someone on this server already has this username.');
  });

  it('an emptied username is cleared with null; an unchanged one sends nothing', async () => {
    const calls = api(profileOf({ username: 'ada' }));
    render(<UserSettings />);
    const input = await screen.findByTestId<HTMLInputElement>('user-profile-username');
    expect(input.value).toBe('ada');
    fireEvent.change(input, { target: { value: 'ADA' } });
    fireEvent.blur(input);
    expect(calls.updateProfile).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(calls.updateProfile).toHaveBeenCalledWith({ url: ONE, username: null });
    });
  });
});

describe('Profile page: about you', () => {
  it('counts characters, saves on leaving the field, and keeps a refusal under it', async () => {
    const calls = api();
    render(<UserSettings />);
    const about = await screen.findByTestId<HTMLTextAreaElement>('user-profile-about');
    expect(about.getAttribute('placeholder')).toBe('Tell people more about you…');
    expect(about.getAttribute('rows')).toBe('4');
    expect(screen.getByTestId('user-profile-about-count').textContent).toBe('0 / 500');
    fireEvent.change(about, { target: { value: 'Line one\nLine two ' } });
    expect(screen.getByTestId('user-profile-about-count').textContent).toBe('18 / 500');
    fireEvent.blur(about);
    await waitFor(() => {
      expect(calls.updateProfile).toHaveBeenCalledWith({ url: ONE, about: 'Line one\nLine two' });
    });

    calls.updateProfile.mockResolvedValueOnce(refusal('identity-about-invalid', 'Keep it to 500 characters.') as never);
    fireEvent.change(about, { target: { value: 'Something else' } });
    fireEvent.blur(about);
    expect((await screen.findByTestId('user-profile-about-error')).textContent).toBe('Keep it to 500 characters.');
    expect(about.value).toBe('Something else');
  });
});

describe('Profile page: photo and cover', () => {
  const pick = (kind: 'photo' | 'cover', name = 'me.png') => {
    const input = screen.getByTestId<HTMLInputElement>(`user-profile-${kind}-input`);
    expect(input.getAttribute('accept')).toBe('image/png,image/jpeg,image/webp,image/gif');
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], name, { type: 'image/png' })] } });
  };

  it('uploads a cropped photo, shows it and offers Remove, which removes it', async () => {
    const calls = api();
    render(<UserSettings />);
    await screen.findByTestId('user-profile-photo');
    expect(screen.getByTestId('user-profile-photo').textContent).toBe('AD');
    expect(screen.queryByTestId('user-profile-photo-remove')).toBeNull();
    pick('photo');
    const dialog = await screen.findByTestId('crop-dialog');
    expect(dialog.dataset['kind']).toBe('photo');
    expect(dialog.dataset['file']).toBe('me.png');
    fireEvent.click(screen.getByTestId('crop-save'));
    await waitFor(() => {
      expect(calls.setImage).toHaveBeenCalledWith({ url: ONE, kind: 'photo', data: 'UklGRg==' });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('crop-dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId('user-profile-photo').getAttribute('src')).toBe('data:image/webp;base64,photo-p1');
    });
    expect(calls.list).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('user-profile-photo-remove'));
    await waitFor(() => {
      expect(calls.removeImage).toHaveBeenCalledWith({ url: ONE, kind: 'photo' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('user-profile-photo').textContent).toBe('AD');
    });
  });

  it('a refused upload stays in the dialog and under the field', async () => {
    api(profileOf(), {
      setImage: vi.fn().mockResolvedValue(refusal('identity-image-too-large', 'A photo may be at most 512 KB.')),
    });
    render(<UserSettings />);
    await screen.findByTestId('user-profile-photo');
    pick('photo');
    fireEvent.click(await screen.findByTestId('crop-save'));
    await waitFor(() => {
      expect(document.body.dataset['cropError']).toBe('A photo may be at most 512 KB.');
    });
    expect(screen.getByTestId('crop-dialog')).toBeTruthy();
    expect(screen.getByTestId('user-profile-photo-error').textContent).toBe('A photo may be at most 512 KB.');
    fireEvent.click(screen.getByTestId('crop-cancel'));
    expect(screen.queryByTestId('crop-dialog')).toBeNull();
    expect(screen.queryByTestId('user-profile-photo-error')).toBeNull();
  });

  it('shows the cover in the band, opens the cover crop and removes it', async () => {
    const calls = api(profileOf({ cover: { version: 'c1' } }));
    render(<UserSettings />);
    const image = await screen.findByTestId('user-profile-cover-image');
    expect(image.getAttribute('src')).toBe('data:image/webp;base64,cover-c1');
    expect(image.getAttribute('alt')).toBe('');
    pick('cover', 'wide.jpg');
    expect((await screen.findByTestId('crop-dialog')).dataset['kind']).toBe('cover');
    fireEvent.click(screen.getByTestId('crop-cancel'));
    fireEvent.click(screen.getByTestId('user-profile-cover-remove'));
    await waitFor(() => {
      expect(calls.removeImage).toHaveBeenCalledWith({ url: ONE, kind: 'cover' });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('user-profile-cover-image')).toBeNull();
    });
    expect(screen.queryByTestId('user-profile-cover-remove')).toBeNull();
  });
});

describe('the renderer’s profile limits equal the engine’s', () => {
  it('username pattern and lengths, and the about limit', () => {
    expect(MIN_USERNAME_LENGTH).toBe(ENGINE_MIN_USERNAME);
    expect(MAX_USERNAME_LENGTH).toBe(ENGINE_MAX_USERNAME);
    expect(USERNAME_PATTERN.source).toBe(ENGINE_USERNAME_PATTERN.source);
    expect(USERNAME_PATTERN.flags).toBe(ENGINE_USERNAME_PATTERN.flags);
    expect(MAX_ABOUT_LENGTH).toBe(ENGINE_MAX_ABOUT);
  });
});
