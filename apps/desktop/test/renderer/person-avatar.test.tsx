import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AccountWire } from '@wirebench/wire/wire-base';
import { PersonAvatar, initials } from '../../src/renderer/components/person-avatar.js';
import { AccountStatusItem } from '../../src/renderer/features/account/account-status-item.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { clearPersonImages, loadPersonImage } from '../../src/renderer/state/person-images.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const URL_ONE = 'https://wb.test';
const dataUrl = (version: string) => `data:image/webp;base64,${version}`;

function imageApi() {
  const image = vi.fn(({ version }: { version: string }) =>
    Promise.resolve({ ok: true as const, value: { dataUrl: dataUrl(version) } }),
  );
  installWirebenchApi({ account: { image } });
  return image;
}

beforeEach(() => {
  clearPersonImages();
});
afterEach(() => {
  cleanup();
});

describe('initials', () => {
  it('takes the first and last word, or the first two letters of one word', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('  ada  byron lovelace ')).toBe('AL');
    expect(initials('ada')).toBe('AD');
    expect(initials('')).toBe('?');
  });
});

describe('person images (plan ruling 6)', () => {
  it('fetches once per version and again for a new one', async () => {
    const image = imageApi();
    const ref = { url: URL_ONE, userId: 'u1', kind: 'photo' as const, version: 'v1' };
    expect(await loadPersonImage(ref)).toBe(dataUrl('v1'));
    expect(await loadPersonImage(ref)).toBe(dataUrl('v1'));
    expect(image).toHaveBeenCalledTimes(1);
    expect(await loadPersonImage({ ...ref, version: 'v2' })).toBe(dataUrl('v2'));
    expect(image).toHaveBeenCalledTimes(2);
    // Another kind, person or server is another image.
    await loadPersonImage({ ...ref, kind: 'cover' });
    await loadPersonImage({ ...ref, userId: 'u2' });
    await loadPersonImage({ ...ref, url: 'https://two.test' });
    expect(image).toHaveBeenCalledTimes(5);
  });

  it('forgets a failed load, so the next one asks again', async () => {
    const image = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'not-found', message: 'gone' } })
      .mockResolvedValueOnce({ ok: true, value: { dataUrl: dataUrl('v1') } });
    installWirebenchApi({ account: { image } });
    const ref = { url: URL_ONE, userId: 'u1', kind: 'photo' as const, version: 'v1' };
    await expect(loadPersonImage(ref)).rejects.toThrow('gone');
    expect(await loadPersonImage(ref)).toBe(dataUrl('v1'));
    expect(image).toHaveBeenCalledTimes(2);
  });
});

describe('PersonAvatar', () => {
  it('shows initials when the person has no photo, without asking the host', () => {
    const image = imageApi();
    render(<PersonAvatar url={URL_ONE} userId="u1" name="Ada Lovelace" photo={null} testId="avatar" />);
    const avatar = screen.getByTestId('avatar');
    expect(avatar.tagName).toBe('SPAN');
    expect(avatar.textContent).toBe('AL');
    expect(image).not.toHaveBeenCalled();
  });

  it('shows the photo with an empty alt once it loads, and the new one after a version change', async () => {
    const image = imageApi();
    const { rerender } = render(
      <PersonAvatar url={URL_ONE} userId="u1" name="Ada" photo={{ version: 'v1' }} size="lg" testId="avatar" />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('avatar').tagName).toBe('IMG');
    });
    const img = screen.getByTestId<HTMLImageElement>('avatar');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('src')).toBe(dataUrl('v1'));
    expect(img.className).toContain('h-24');
    rerender(<PersonAvatar url={URL_ONE} userId="u1" name="Ada" photo={{ version: 'v2' }} testId="avatar" />);
    await waitFor(() => {
      expect(screen.getByTestId('avatar').getAttribute('src')).toBe(dataUrl('v2'));
    });
    expect(image).toHaveBeenCalledTimes(2);
  });

  it('a cached photo shows on the first render', async () => {
    imageApi();
    await loadPersonImage({ url: URL_ONE, userId: 'u1', kind: 'photo', version: 'v1' });
    render(<PersonAvatar url={URL_ONE} userId="u1" name="Ada" photo={{ version: 'v1' }} testId="avatar" />);
    expect(screen.getByTestId('avatar').tagName).toBe('IMG');
  });

  it('falls back to initials when the photo cannot be loaded', async () => {
    const image = vi.fn().mockResolvedValue({ ok: false, error: { code: 'not-found', message: 'gone' } });
    installWirebenchApi({ account: { image } });
    render(<PersonAvatar url={URL_ONE} userId="u1" name="Ada" photo={{ version: 'v1' }} testId="avatar" />);
    await waitFor(() => {
      expect(image).toHaveBeenCalled();
    });
    expect(screen.getByTestId('avatar').textContent).toBe('AD');
  });
});

describe('the account menu shows the photo (user profile spec §4)', () => {
  const account: AccountWire = {
    url: URL_ONE,
    userId: 'u1',
    email: 'ada@wb.test',
    displayName: 'Ada Lovelace',
    deviceName: 'Mac',
    signedOut: false,
    addedAt: '2026-11-01T10:00:00.000Z',
    username: 'ada',
    photo: { version: 'v1' },
  };

  it('in the trigger and the menu header, with @username beside the email', async () => {
    imageApi();
    usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE });
    useAccountStore.setState({ servers: [account], loaded: true });
    render(<AccountStatusItem />);
    await waitFor(() => {
      expect(screen.getByTestId('status-bar-account-avatar').tagName).toBe('IMG');
    });
    const trigger = screen.getByTestId('status-bar-account');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    const header = await screen.findByTestId('account-menu-header');
    expect(header.textContent).toContain('Ada Lovelace');
    expect(header.textContent).toContain('@ada · ada@wb.test');
    expect(screen.getByTestId('account-menu-avatar').tagName).toBe('IMG');
  });

  it('shows initials for an account without a photo', () => {
    installWirebenchApi();
    usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE });
    useAccountStore.setState({ servers: [{ ...account, photo: null, username: null }], loaded: true });
    render(<AccountStatusItem />);
    expect(screen.getByTestId('status-bar-account-avatar').textContent).toBe('AL');
  });
});
