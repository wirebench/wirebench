/**
 * The portable Windows build (#68): a zip that runs from wherever it is unpacked — a USB stick, a
 * network share, a folder on a machine where nothing may be installed — and keeps everything it
 * writes beside itself.
 *
 * The switch is a folder named `data` next to `Wirebench.exe`. The portable zip ships one, so
 * unpacking it is all it takes; the installers never create one. When the folder is there it
 * becomes Electron's `userData`: workspaces, preferences, history, saved secrets and Chromium's own
 * caches all go under it, and nothing is written to `%APPDATA%`. Deleting the folder turns the copy
 * back into an ordinary one that uses `%APPDATA%\Wirebench`.
 *
 * Only a packaged Windows app looks for the folder. On macOS the executable sits inside the signed
 * `.app` bundle, where nothing may be written, and a development run must never pick up a stray
 * `data` folder next to `electron.exe` in `node_modules`.
 *
 * Saved secrets are still encrypted with the Windows user's key (`safeStorage`, DPAPI), so they open
 * only for the same Windows user on the same machine. Everything else in the folder travels.
 *
 * No `electron` import: the caller passes the platform and executable path in, which keeps this
 * unit-testable.
 */

import { statSync } from 'node:fs';
import { win32 } from 'node:path';

/** Name of the folder beside the executable that makes a copy portable. */
export const PORTABLE_DATA_DIR = 'data';

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The portable data folder of this copy of the app, or `undefined` when it is not portable.
 *
 * @param input.exePath - `process.execPath`, the running `Wirebench.exe`
 */
export function portableDataDir(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly exePath: string;
  readonly isDirectory?: (path: string) => boolean;
}): string | undefined {
  if (input.platform !== 'win32' || !input.isPackaged) {
    return undefined;
  }
  const dir = win32.join(win32.dirname(input.exePath), PORTABLE_DATA_DIR);
  return (input.isDirectory ?? isDirectory)(dir) ? dir : undefined;
}
