/**
 * The narrow file-system surface the project loader/saver needs, so callers can
 * substitute an in-memory or instrumented implementation in tests.
 */

import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import {
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  rename as nodeRename,
  rm as nodeRm,
  stat as nodeStat,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';

/** One entry of a directory listing. */
export interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
}

/** Minimal metadata about a path. */
export interface FileStat {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly size: number;
}

/** The file-system operations `loadProject`/`saveProject` depend on. */
export interface FsLike {
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer | string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, options: { readonly recursive: true }): Promise<void>;
  readdir(path: string): Promise<readonly DirEntry[]>;
  stat(path: string): Promise<FileStat>;
  rm(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): Promise<void>;
}

/** The default {@link FsLike}, backed by `node:fs/promises`. */
export const nodeFs: FsLike = {
  async readFile(path) {
    return nodeReadFile(path);
  },
  async writeFile(path, data) {
    await nodeWriteFile(path, data);
  },
  async rename(from, to) {
    await nodeRename(from, to);
  },
  async mkdir(path, options) {
    await nodeMkdir(path, options);
  },
  async readdir(path) {
    const entries = await nodeReaddir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
  },
  async stat(path) {
    const s = await nodeStat(path);
    return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size };
  },
  async rm(path, options) {
    await nodeRm(path, options);
  },
};

/** True when the error is a "no such file or directory" error. */
export function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

/** Reads a file, returning `undefined` instead of throwing when it does not exist. */
export async function readFileIfExists(fs: FsLike, path: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(path);
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Lists a directory, returning `[]` instead of throwing when it does not exist. */
export async function readdirIfExists(fs: FsLike, path: string): Promise<readonly DirEntry[]> {
  try {
    return await fs.readdir(path);
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
}

/**
 * Writes `data` to `path` atomically: the bytes land in a sibling temp file that
 * is then renamed over the target, so a crash mid-write can never leave a
 * half-written project file behind.
 */
export async function writeFileAtomic(fs: FsLike, path: string, data: Buffer | string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await fs.writeFile(temp, data);
    await fs.rename(temp, path);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
