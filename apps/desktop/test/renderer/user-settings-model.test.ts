import { describe, expect, it } from 'vitest';
import { USER_PAGES, resolveUserPage, userNav } from '../../src/renderer/features/preferences/user-settings-model.js';

const ids = (localPasswords: boolean) =>
  userNav({ localPasswords }).map((group) => [group.title, group.pages.map((page) => page.id)]);

describe('User settings menu (settings split spec §2, §4)', () => {
  it('lists every page with local passwords on', () => {
    expect(ids(true)).toEqual([
      ['You', ['profile', 'password']],
      ['Access', ['servers', 'devices', 'tokens']],
    ]);
    expect(
      userNav({ localPasswords: true })
        .flatMap((group) => group.pages)
        .map((page) => page.label),
    ).toEqual(['Profile', 'Password', 'Servers you’re signed in to', 'Signed-in devices', 'CI tokens']);
    expect(USER_PAGES).toEqual(['profile', 'password', 'servers', 'devices', 'tokens']);
  });

  it('hides Password with local passwords off', () => {
    expect(ids(false)).toEqual([
      ['You', ['profile']],
      ['Access', ['servers', 'devices', 'tokens']],
    ]);
  });

  it('an unknown page, or Password where it is hidden, resolves to Profile', () => {
    expect(resolveUserPage(undefined, { localPasswords: true })).toBe('profile');
    expect(resolveUserPage('nope', { localPasswords: true })).toBe('profile');
    expect(resolveUserPage('password', { localPasswords: false })).toBe('profile');
    expect(resolveUserPage('password', { localPasswords: true })).toBe('password');
    expect(resolveUserPage('devices', { localPasswords: false })).toBe('devices');
  });
});
