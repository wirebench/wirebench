// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { findMoshClient, moshClientEnv } from '../src/mosh-client.js';

describe('findMoshClient', () => {
  const find = (platform: NodeJS.Platform, path: string, present: string[]) =>
    findMoshClient({ platform, env: { PATH: path }, home: '/home/me', isExecutable: (p) => present.includes(p) });

  it('takes the first one on PATH', () => {
    expect(find('linux', '/a:/b', ['/b/mosh-client', '/usr/bin/mosh-client'])).toBe('/b/mosh-client');
  });
  it('looks in the usual install folders after PATH, which a Dock-started app keeps short', () => {
    expect(find('darwin', '/usr/bin:/bin', ['/opt/homebrew/bin/mosh-client'])).toBe('/opt/homebrew/bin/mosh-client');
    expect(find('linux', '', ['/home/me/.nix-profile/bin/mosh-client'])).toBe('/home/me/.nix-profile/bin/mosh-client');
  });
  it('is undefined when there is none', () => {
    expect(find('linux', '/a', [])).toBeUndefined();
  });
  it('looks for mosh-client.exe on PATH only, on Windows', () => {
    expect(find('win32', 'C:\\cygwin\\bin;C:\\x', ['C:\\cygwin\\bin\\mosh-client.exe'])).toBe(
      'C:\\cygwin\\bin\\mosh-client.exe',
    );
    expect(find('win32', 'C:\\x', ['/usr/bin/mosh-client'])).toBeUndefined();
  });
});

describe('moshClientEnv', () => {
  it('sets the key, the terminal and a UTF-8 locale when there is none', () => {
    expect(moshClientEnv({ HOME: '/h' }, 'k', 'darwin')).toEqual({
      HOME: '/h',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      MOSH_KEY: 'k',
    });
    expect(moshClientEnv({}, 'k', 'linux')['LANG']).toBe('C.UTF-8');
  });
  it('keeps a UTF-8 locale, and drops a non-UTF-8 LC_ALL that would override it', () => {
    expect(moshClientEnv({ LANG: 'de_DE.UTF-8' }, 'k', 'linux')['LANG']).toBe('de_DE.UTF-8');
    const env = moshClientEnv({ LANG: 'de_DE.UTF-8', LC_ALL: 'C' }, 'k', 'linux');
    expect(env['LC_ALL']).toBeUndefined();
    expect(env['LANG']).toBe('de_DE.UTF-8');
  });
});
