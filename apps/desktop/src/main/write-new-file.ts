/**
 * Writing a file that must not replace anything already at its name.
 *
 * Checking for the name and then writing leaves a window in which another process can put a file
 * (or a link) there, which the write would then replace or follow. Here the name is taken by the
 * write itself: the data goes to a fresh temp file beside the target, created exclusively, and the
 * temp file is hard-linked to the target name. A link never replaces an existing name, so it fails
 * with `EEXIST` instead, and the target appears whole or not at all, as an atomic rename would make it.
 */

import { randomBytes } from 'node:crypto';
import { link, rm, writeFile } from 'node:fs/promises';

/** Link errors that mean the file system has no hard links (FAT, some network shares), not a clash. */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * Writes `data` to `path` when nothing is at that name, never replacing or following what is.
 *
 * Where the file system has no hard links, the file is created with an exclusive open (`wx`)
 * instead: still never replacing anything, though a crash mid-write could leave it short.
 *
 * @returns `false` when something already exists at `path`; nothing is written then
 * @throws the write or link error for anything else
 */
export async function writeNewFile(path: string, data: Buffer): Promise<boolean> {
  const temp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temp, data, { flag: 'wx' });
    try {
      await link(temp, path);
      return true;
    } catch (error) {
      if (codeOf(error) === 'EEXIST') return false;
      if (!NO_HARD_LINKS.has(codeOf(error) ?? '')) throw error;
    }
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
  try {
    await writeFile(path, data, { flag: 'wx' });
    return true;
  } catch (error) {
    if (codeOf(error) === 'EEXIST') return false;
    throw error;
  }
}
