/**
 * What a local terminal tab runs, and where (issue #410). Pure: the caller passes the platform, the
 * environment and a file check in, which keeps every OS testable from any OS.
 */

import { posix, win32 } from 'node:path';

/** The program a local terminal starts, its arguments, and the short name the tab shows. */
export interface LocalShell {
  readonly file: string;
  readonly args: readonly string[];
  readonly name: string;
}

/** The shell's own name: `pwsh` for `C:\…\pwsh.exe`, `zsh` for `/bin/zsh`. */
function shellName(file: string, platform: NodeJS.Platform): string {
  const base = platform === 'win32' ? win32.basename(file) : posix.basename(file);
  return base.replace(/\.exe$/i, '');
}

/** The PATH entries, read whichever case Windows stored the name in. */
function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  const value = key === undefined ? undefined : env[key];
  return (value ?? '').split(';').filter((entry) => entry.trim() !== '');
}

/**
 * The shell a local terminal runs. The preference (Preferences → Terminal → Local shell) wins on every OS.
 * Otherwise: `$SHELL` on macOS and Linux (zsh or sh without one), and PowerShell 7 on Windows when it is on
 * the PATH, else the Windows PowerShell every Windows ships. A Unix shell starts as a login shell, so it
 * reads the profile that sets PATH; a Windows program takes no arguments, as `cmd.exe` would not know one.
 */
export function localShell(input: {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** `terminal.localShell`: empty for the default. */
  readonly preference: string;
  readonly exists: (path: string) => boolean;
}): LocalShell {
  const { platform, env } = input;
  const login = (file: string): LocalShell => ({ file, args: ['-l'], name: shellName(file, platform) });
  const plain = (file: string): LocalShell => ({ file, args: [], name: shellName(file, platform) });
  const preference = input.preference.trim();
  if (platform === 'win32') {
    if (preference !== '') return plain(preference);
    const pwsh = pathEntries(env)
      .map((dir) => win32.join(dir, 'pwsh.exe'))
      .find((candidate) => input.exists(candidate));
    if (pwsh !== undefined) return plain(pwsh);
    const root = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows';
    return plain(win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  }
  if (preference !== '') return login(preference);
  const shell = env['SHELL']?.trim();
  if (shell !== undefined && shell !== '') return login(shell);
  return login(platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
}

/** Whether `child` is `parent` or inside it; Windows paths compare without regard to case. */
function isWithin(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? win32 : posix;
  const fold = (value: string): string => (platform === 'win32' ? value.toLowerCase() : value);
  const relative = path.relative(fold(parent), fold(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Where a local terminal starts: the open workspace's tree when it is a folder of the user's own (a shared
 * workspace kept in a git clone or a synced folder), otherwise the home folder. A local workspace's files
 * live in app data, which is no place to run `git` or a build.
 */
export function localShellCwd(input: {
  /** The open workspace's tree root, `undefined` with none open. */
  readonly tree: string | undefined;
  readonly userData: string;
  readonly home: string;
  readonly platform: NodeJS.Platform;
}): string {
  const { tree } = input;
  if (tree === undefined || isWithin(tree, input.userData, input.platform)) return input.home;
  return tree;
}

/** Variables that would make the shell's own programs run as Electron or Node with the app's options. */
const DROPPED: ReadonlySet<string> = new Set(['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS']);

/** The environment a local shell starts with: the app's own, minus {@link DROPPED}, naming the terminal. */
export function localShellEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !DROPPED.has(name.toUpperCase())) out[name] = value;
  }
  out['TERM'] = 'xterm-256color';
  out['COLORTERM'] = 'truecolor';
  out['TERM_PROGRAM'] = 'Wirebench';
  return out;
}
