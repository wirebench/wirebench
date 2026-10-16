/**
 * The folder walk every folder import shares (a folder collection, a Bruno collection, a
 * `thunder-tests/` folder), for the hosts: the CLI, and the desktop once it has checked the picked
 * path. It follows no symbolic link — a file or a folder — keeps every entry inside the root's real
 * path, opens each file with no-follow, and stops at {@link IMPORT_FOLDER_LIMITS}. `.git` and
 * `node_modules` are always skipped; which other files and folders are read is the caller's.
 */

import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** The limits of one folder walk. */
export interface ImportFolderLimits {
  /** Files read. */
  readonly files: number;
  /** Folders deep below the root. */
  readonly depth: number;
  /** Bytes of the files read, together. */
  readonly bytes: number;
  /** Folder entries looked at, of any kind. */
  readonly entries: number;
}

export const IMPORT_FOLDER_LIMITS: ImportFolderLimits = {
  files: 5000,
  depth: 64,
  bytes: 50 * 1024 * 1024,
  entries: 50_000,
};

/** Why a walk stopped; the caller turns each into its own format's error. */
export type ImportFolderErrorCode = 'not-a-folder' | 'too-many-files' | 'too-deep' | 'too-large' | 'read-failed';

export interface ImportFolderOptions {
  /** Whether a file is read, by its name. */
  readonly readFile: (name: string) => boolean;
  /** Whether a folder is left out with everything below it, by its root-relative POSIX path. */
  readonly skipFolder?: (relPath: string) => boolean;
  readonly limits?: ImportFolderLimits;
  /** The error a stopped walk throws. */
  readonly error: (code: ImportFolderErrorCode, message: string, cause?: unknown) => Error;
}

const SKIPPED_FOLDERS = new Set(['node_modules', '.git']);

function inside(base: string, path: string): boolean {
  return path === base || path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/** A walk's own refusal, told apart from a failure of the file system so it is not rewrapped. */
class Stop extends Error {
  constructor(readonly made: Error) {
    super(made.message);
  }
}

type Fail = (code: ImportFolderErrorCode, message: string) => Stop;

/**
 * Every file under `root` that `options.readFile` accepts, keyed by POSIX path relative to it.
 * `root` must be a folder and not a link.
 *
 * @throws the error `options.error` builds: `not-a-folder`, `too-many-files` (files or entries),
 *   `too-deep`, `too-large`, `read-failed`
 */
export async function readImportFolder(root: string, options: ImportFolderOptions): Promise<Map<string, string>> {
  const readFailed = (path: string, error: unknown): Error =>
    options.error(
      'read-failed',
      `Failed to read the collection at "${path}": ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    throw readFailed(root, error);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw options.error('not-a-folder', `"${root}" is not a folder (a linked folder is not followed)`);
  }
  const fail: Fail = (code, message) => new Stop(options.error(code, message));
  try {
    return await walk(root, options, options.limits ?? IMPORT_FOLDER_LIMITS, fail);
  } catch (error) {
    if (error instanceof Stop) throw error.made;
    throw readFailed(root, error);
  }
}

/** One file's text, opened without following a link, refused past the bytes left. */
async function readNoFollow(path: string, budget: number, limit: number, fail: Fail): Promise<string | undefined> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    if (info.size > budget) {
      throw fail('too-large', `The collection is larger than ${String(limit / (1024 * 1024))} MB`);
    }
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

async function walk(
  base: string,
  options: ImportFolderOptions,
  limits: ImportFolderLimits,
  fail: Fail,
): Promise<Map<string, string>> {
  const realBase = await realpath(base);
  const files = new Map<string, string>();
  let bytes = 0;
  let entriesSeen = 0;
  const tooMany = (): Stop => fail('too-many-files', `The collection holds more than ${String(limits.files)} files`);
  const queue: { dir: string; depth: number }[] = [{ dir: base, depth: 0 }];
  for (let at = 0; at < queue.length; at += 1) {
    const { dir, depth } = queue[at]!;
    if (depth > limits.depth) {
      throw fail('too-deep', `The collection is nested more than ${String(limits.depth)} folders deep`);
    }
    const entries = await readdir(dir, { withFileTypes: true });
    entriesSeen += entries.length;
    if (entriesSeen > limits.entries) throw tooMany();
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of entries) {
      if (dirent.isSymbolicLink()) continue;
      const path = join(dir, dirent.name);
      const relPath = relative(base, path).split(sep).join('/');
      const isFile = dirent.isFile() && options.readFile(dirent.name);
      const isFolder =
        dirent.isDirectory() && !SKIPPED_FOLDERS.has(dirent.name) && options.skipFolder?.(relPath) !== true;
      if (!isFile && !isFolder) continue;
      if (isFile && files.size >= limits.files) throw tooMany();
      // A folder mounted or swapped in under the root would leave it without being a link.
      const real = await realpath(path).catch(() => undefined);
      if (real === undefined || !inside(realBase, real)) continue;
      if (isFolder) {
        queue.push({ dir: path, depth: depth + 1 });
        continue;
      }
      const text = await readNoFollow(path, limits.bytes - bytes, limits.bytes, fail);
      if (text === undefined) continue;
      bytes += Buffer.byteLength(text, 'utf8');
      files.set(relPath, text);
    }
  }
  return files;
}
