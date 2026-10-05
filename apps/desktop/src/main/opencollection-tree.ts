/**
 * Reading an OpenCollection directory for the importer: every YAML file under the picked root
 * document's folder, and the companion files (its `.proto` files) the collection names.
 *
 * The walk reads files the renderer never named, so it is held to more than the picked-path check
 * (ADR-0005): the root must pass {@link checkedImportSource}, no symbolic link is followed — a file
 * or a folder — every file and folder is checked to stay inside the root's real folder, and the
 * walk stops at {@link OC_TREE_LIMITS}.
 */

import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { OpenCollectionError, WirebenchError } from '@wirebench/engine';
import type { ReadPicks } from './dialog-picks.js';
import { checkedCompanionPaths, checkedImportSource } from './path-access.js';
import { isInsideReal } from './path-containment.js';

/** The most a collection directory may hold: files read, folders deep, and bytes on disk together. */
export const OC_TREE_LIMITS = { files: 5000, depth: 64, bytes: 50 * 1024 * 1024 } as const;

const YAML_FILE = /\.ya?ml$/i;
/** Read-only, never through a link, never blocking on a FIFO; Windows defines neither extra flag. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function tooLarge(): OpenCollectionError {
  return new OpenCollectionError(
    'oc-too-large',
    `The collection is larger than ${String(OC_TREE_LIMITS.bytes / (1024 * 1024))} MB`,
  );
}

function posixRelative(base: string, path: string): string {
  return relative(base, path).split(sep).join('/');
}

/**
 * The bytes of the regular file `path`, opened without following a link and checked to be the file
 * `lstat` saw, so a swap between the check and the read is refused rather than followed.
 * `undefined` when it is no longer a regular file. `budget` is the most it may hold.
 */
async function readRegularFile(path: string, budget: number): Promise<Buffer | undefined> {
  const seen = await lstat(path);
  if (!seen.isFile()) return undefined;
  if (seen.size > budget) throw tooLarge();
  const handle = await open(path, OPEN_FLAGS).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') return undefined;
    throw error;
  });
  if (handle === undefined) return undefined;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== seen.dev || opened.ino !== seen.ino) return undefined;
    const bytes = await handle.readFile();
    // The file may have grown since the `lstat`: what was read is what counts.
    if (bytes.length > budget) throw tooLarge();
    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * Every `*.yml`/`*.yaml` under the picked root file's folder, keyed by POSIX path relative to that
 * folder. Links are skipped; other files are not read.
 *
 * @throws WirebenchError `import-path-refused` when the root was neither picked nor inside an open project
 * @throws OpenCollectionError `oc-too-many-files`, `oc-too-deep` or `oc-too-large` past {@link OC_TREE_LIMITS},
 *   `oc-read-failed` when a folder or file cannot be read
 */
export async function readOpenCollectionTree(
  rootFile: string,
  roots: readonly string[],
  picks: ReadPicks | undefined,
): Promise<Map<string, string>> {
  const checked = await checkedImportSource(roots, picks, { kind: 'file', path: rootFile });
  if (checked.kind !== 'file') throw new WirebenchError('invalid-argument', 'Expected a file');
  try {
    return await walk(dirname(checked.path));
  } catch (error) {
    if (error instanceof WirebenchError) throw error;
    throw new OpenCollectionError(
      'oc-read-failed',
      `Failed to read the collection folder: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** The walk itself, below a root folder already checked. */
async function walk(base: string): Promise<Map<string, string>> {
  const realBase = await realpath(base);
  const files = new Map<string, string>();
  let bytes = 0;
  const queue: { dir: string; depth: number }[] = [{ dir: base, depth: 0 }];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { dir, depth } = next;
    if (depth > OC_TREE_LIMITS.depth) {
      throw new OpenCollectionError(
        'oc-too-deep',
        `The collection is nested more than ${String(OC_TREE_LIMITS.depth)} folders deep`,
      );
    }
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of entries) {
      if (dirent.isSymbolicLink()) continue;
      const path = join(dir, dirent.name);
      const isYaml = dirent.isFile() && YAML_FILE.test(dirent.name);
      if (!dirent.isDirectory() && !isYaml) continue;
      if (isYaml && files.size >= OC_TREE_LIMITS.files) {
        throw new OpenCollectionError(
          'oc-too-many-files',
          `The collection holds more than ${String(OC_TREE_LIMITS.files)} files`,
        );
      }
      // A folder mounted or swapped in under the root would leave it without being a link.
      const real = await realpath(path).catch(() => undefined);
      if (real === undefined || !isInsideReal(realBase, real)) continue;
      if (dirent.isDirectory()) {
        queue.push({ dir: path, depth: depth + 1 });
        continue;
      }
      const read = await readRegularFile(path, OC_TREE_LIMITS.bytes - bytes);
      if (read === undefined) continue;
      bytes += read.length;
      files.set(posixRelative(base, path), read.toString('utf8'));
    }
  }
  return files;
}

/**
 * Exactly the named files beside the root (its `.proto` files), read through
 * {@link checkedCompanionPaths}: relative names only, inside the root's folder, no links. A name with
 * nothing at it is left out, so the caller can say which were missing.
 *
 * @returns each file's text, keyed by POSIX path relative to the root's folder
 * @throws WirebenchError `import-path-refused` when the root is not readable or a name is refused
 * @throws OpenCollectionError `oc-too-large` when the files together pass the byte limit
 */
export async function readCompanionTexts(
  rootFile: string,
  roots: readonly string[],
  picks: ReadPicks | undefined,
  names: readonly string[],
): Promise<Map<string, string>> {
  const base = dirname(resolve(rootFile));
  const paths = await checkedCompanionPaths(roots, picks, rootFile, names);
  const texts = new Map<string, string>();
  let bytes = 0;
  for (const path of paths) {
    const read = await readRegularFile(path, OC_TREE_LIMITS.bytes - bytes);
    if (read === undefined) continue;
    bytes += read.length;
    texts.set(posixRelative(base, path), read.toString('utf8'));
  }
  return texts;
}
