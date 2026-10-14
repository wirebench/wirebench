import { accessSync, constants, statSync } from 'node:fs';
import { posix } from 'node:path';

/**
 * Where an installed `mosh-client` usually lives, looked at after PATH: an app started from the Dock or a
 * desktop launcher gets a short PATH that leaves out the package managers' folders.
 */
const FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin', '/snap/bin'];

/** The first `mosh-client` on PATH, then in the usual install folders; undefined when there is none (#419). */
export function findMoshClient(options: {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly isExecutable: (path: string) => boolean;
}): string | undefined {
  const windows = options.platform === 'win32';
  const name = windows ? 'mosh-client.exe' : 'mosh-client';
  const path = options.env['PATH'] ?? options.env['Path'] ?? '';
  // The platform's own separators, not this process's: tests run every platform's rules on any host.
  const dirs = path.split(windows ? ';' : ':').filter((d) => d.length > 0);
  if (!windows) dirs.push(...FALLBACK_DIRS, posix.join(options.home, '.nix-profile', 'bin'));
  for (const dir of dirs) {
    const candidate = windows ? `${dir.replace(/[\\/]+$/, '')}\\${name}` : posix.join(dir, name);
    if (options.isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** A regular file this process may run. */
export function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const UTF8 = /utf-?8/i;

/**
 * The client's environment: the session key, xterm-256color, and a UTF-8 locale, without which
 * `mosh-client` refuses to start. A non-UTF-8 `LC_ALL` or `LC_CTYPE` would override `LANG`, so it goes.
 */
export function moshClientEnv(
  base: Readonly<Record<string, string>>,
  key: string,
  platform: NodeJS.Platform,
): Record<string, string> {
  const env: Record<string, string> = { ...base };
  for (const name of ['LC_ALL', 'LC_CTYPE']) {
    if (env[name] !== undefined && !UTF8.test(env[name])) delete env[name];
  }
  const effective = env['LC_ALL'] ?? env['LC_CTYPE'] ?? env['LANG'] ?? '';
  if (!UTF8.test(effective)) env['LANG'] = platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  env['TERM'] = 'xterm-256color';
  env['MOSH_KEY'] = key;
  return env;
}
