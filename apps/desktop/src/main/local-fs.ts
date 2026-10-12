import { createReadStream, createWriteStream } from 'node:fs';
import type { ReadStream, Stats, WriteStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { WirebenchError } from '@wirebench/engine';
import type { SftpEntryWire } from '../shared/sftp-wire.js';

/**
 * This machine's side of the Files tab. Every path is used as the renderer gave it (spec R5): the `sftp.*`
 * channels are the one deliberate exception to main's containment rule, registered only while the SSH area
 * is on. No other channel reaches these functions.
 */

/** `lstat`s in flight at once while listing, so a folder of thousands of entries never opens thousands of handles. */
const LIST_CONCURRENCY = 32;

type LocalOp = 'list' | 'stat' | 'mkdir' | 'rename' | 'remove' | 'read' | 'write';

/** A Node error as `local-fs-failed` with the path and the `errno` code; never a file's content. */
export function localFsError(error: unknown, op: LocalOp, path: string): WirebenchError {
  if (error instanceof WirebenchError) return error;
  const errno = (error as NodeJS.ErrnoException | null)?.code ?? 'EUNKNOWN';
  return new WirebenchError('local-fs-failed', `${op} on ${path} failed (${errno})`, {
    details: { path, op, errno },
    cause: error,
  });
}

const existsError = (path: string, op: LocalOp): WirebenchError =>
  new WirebenchError('sftp-exists', `${path} already exists`, { details: { path, op } });

const typeOf = (stats: Stats): SftpEntryWire['type'] =>
  stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other';

/** The entry from `lstat`; a symlink is followed once for `targetType` (a dangling one is `other`). */
async function entryOf(path: string, name: string): Promise<SftpEntryWire> {
  const stats = await lstat(path);
  const entry: SftpEntryWire = { name, type: typeOf(stats), size: stats.size, mtime: stats.mtimeMs };
  if (!stats.isSymbolicLink()) return entry;
  try {
    const target = await stat(path);
    return { ...entry, targetType: target.isDirectory() ? 'dir' : target.isFile() ? 'file' : 'other' };
  } catch {
    return { ...entry, targetType: 'other' };
  }
}

/**
 * One `readdir`, then one `lstat` per entry, at most {@link LIST_CONCURRENCY} at a time. Hidden files are
 * listed (hiding them is the renderer's choice); an entry gone since the `readdir` is left out.
 */
export async function localList(path: string): Promise<{ path: string; entries: SftpEntryWire[] }> {
  const absolute = resolve(path);
  let names: string[];
  try {
    names = await readdir(absolute);
  } catch (error) {
    throw localFsError(error, 'list', absolute);
  }
  const entries = new Array<SftpEntryWire | undefined>(names.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < names.length) {
      const index = next;
      next += 1;
      const name = names[index] as string;
      try {
        entries[index] = await entryOf(join(absolute, name), name);
      } catch {
        entries[index] = undefined;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, names.length) }, worker));
  return { path: absolute, entries: entries.filter((e): e is SftpEntryWire => e !== undefined) };
}

/** The entry for `path` itself; a symlink is not followed for its type. */
export async function localStat(path: string): Promise<SftpEntryWire> {
  const absolute = resolve(path);
  try {
    return await entryOf(absolute, basename(absolute) || absolute);
  } catch (error) {
    throw localFsError(error, 'stat', absolute);
  }
}

/**
 * For a copy: the entry for `path` with its permission bits (an upload keeps them), or `undefined` when
 * nothing is there.
 */
export async function localEntry(path: string): Promise<SftpEntryWire | undefined> {
  try {
    const entry = await entryOf(path, basename(path) || path);
    const { mode } = await lstat(path);
    return { ...entry, mode: mode & 0o7777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw localFsError(error, 'stat', path);
  }
}

/** One folder; an existing path is `sftp-exists`. */
export async function localMkdir(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw existsError(path, 'mkdir');
    throw localFsError(error, 'mkdir', path);
  }
}

/** Never replaces: an existing `to` (anything, a dangling symlink included) is `sftp-exists`. */
export async function localRename(from: string, to: string): Promise<void> {
  let taken = true;
  try {
    await lstat(to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw localFsError(error, 'rename', to);
    taken = false;
  }
  if (taken) throw existsError(to, 'rename');
  try {
    await rename(from, to);
  } catch (error) {
    throw localFsError(error, 'rename', from);
  }
}

/**
 * A file, a symlink (never what it points at), or a folder: with `recursive` its content goes too; without,
 * a folder that is not empty is refused (`ENOTEMPTY`).
 */
export async function localRemove(path: string, options: { readonly recursive: boolean }): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory()) await rm(path);
    else if (options.recursive) await rm(path, { recursive: true });
    else await rmdir(path);
  } catch (error) {
    throw localFsError(error, 'remove', path);
  }
}

export function localReadStream(path: string): ReadStream {
  return createReadStream(path);
}

/** Creates or truncates `path`; `exclusive` refuses one that exists (`wx`). */
export function localWriteStream(path: string, options: { readonly exclusive?: boolean } = {}): WriteStream {
  return createWriteStream(path, { flags: options.exclusive ? 'wx' : 'w' });
}

/** The local pane's first places: the user's home folder and its Downloads. */
export function localHome(): { home: string; downloads: string } {
  const home = homedir();
  return { home, downloads: join(home, 'Downloads') };
}
