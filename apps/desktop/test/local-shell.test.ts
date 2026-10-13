// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { localShell, localShellCwd, localShellEnv } from '../src/main/local-shell.js';

const none = (): boolean => false;

describe('localShell', () => {
  it('runs $SHELL as a login shell on macOS and Linux', () => {
    expect(
      localShell({ platform: 'darwin', env: { SHELL: '/opt/homebrew/bin/fish' }, preference: '', exists: none }),
    ).toEqual({ file: '/opt/homebrew/bin/fish', args: ['-l'], name: 'fish' });
    expect(localShell({ platform: 'linux', env: { SHELL: '/bin/bash' }, preference: '', exists: none })).toEqual({
      file: '/bin/bash',
      args: ['-l'],
      name: 'bash',
    });
  });

  it('falls back to zsh on macOS and sh elsewhere when $SHELL is unset', () => {
    expect(localShell({ platform: 'darwin', env: {}, preference: '', exists: none }).file).toBe('/bin/zsh');
    expect(localShell({ platform: 'linux', env: { SHELL: '  ' }, preference: '', exists: none }).file).toBe('/bin/sh');
  });

  it('opens PowerShell 7 on Windows when it is on the PATH', () => {
    const env = { PATH: 'C:\\Windows;C:\\Program Files\\PowerShell\\7', SystemRoot: 'C:\\Windows' };
    const shell = localShell({
      platform: 'win32',
      env,
      preference: '',
      exists: (path) => path === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    });
    expect(shell).toEqual({ file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: [], name: 'pwsh' });
  });

  it('opens Windows PowerShell when pwsh is not installed', () => {
    const shell = localShell({
      platform: 'win32',
      env: { Path: 'C:\\Windows', SystemRoot: 'D:\\Win' },
      preference: '',
      exists: none,
    });
    expect(shell).toEqual({
      file: 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: [],
      name: 'powershell',
    });
  });

  it('runs the preference instead when one is set: login on Unix, as given on Windows', () => {
    expect(
      localShell({ platform: 'linux', env: { SHELL: '/bin/bash' }, preference: ' /usr/bin/zsh ', exists: none }),
    ).toEqual({ file: '/usr/bin/zsh', args: ['-l'], name: 'zsh' });
    expect(
      localShell({ platform: 'win32', env: {}, preference: 'C:\\Windows\\System32\\cmd.exe', exists: none }),
    ).toEqual({ file: 'C:\\Windows\\System32\\cmd.exe', args: [], name: 'cmd' });
    expect(localShell({ platform: 'win32', env: {}, preference: 'wsl.exe', exists: none }).name).toBe('wsl');
  });
});

describe('localShellCwd', () => {
  const home = '/Users/ada';
  const userData = '/Users/ada/Library/Application Support/Wirebench';

  it('starts in a shared workspace tree kept outside app data', () => {
    expect(localShellCwd({ tree: '/Users/ada/src/payments-api', userData, home, platform: 'darwin' })).toBe(
      '/Users/ada/src/payments-api',
    );
  });

  it('starts in the home folder for a workspace whose files live in app data, or with none open', () => {
    expect(localShellCwd({ tree: `${userData}/workspaces/w1`, userData, home, platform: 'darwin' })).toBe(home);
    expect(localShellCwd({ tree: undefined, userData, home, platform: 'darwin' })).toBe(home);
  });

  it('compares Windows paths without regard to case', () => {
    expect(
      localShellCwd({
        tree: 'c:\\users\\ada\\appdata\\roaming\\wirebench\\workspaces\\w1',
        userData: 'C:\\Users\\Ada\\AppData\\Roaming\\Wirebench',
        home: 'C:\\Users\\Ada',
        platform: 'win32',
      }),
    ).toBe('C:\\Users\\Ada');
  });

  it('does not take a sibling folder that only starts with the app-data path', () => {
    expect(localShellCwd({ tree: `${userData}-old/w1`, userData, home, platform: 'darwin' })).toBe(
      `${userData}-old/w1`,
    );
  });
});

describe('localShellEnv', () => {
  it('names the terminal and drops what would turn the child into Electron or Node', () => {
    const env = localShellEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', TERM: 'dumb' });
    expect(env).toEqual({ PATH: '/bin', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Wirebench' });
  });

  it('leaves out variables that are unset', () => {
    expect(Object.values(localShellEnv({ A: undefined, B: 'b' }))).not.toContain(undefined);
  });
});
