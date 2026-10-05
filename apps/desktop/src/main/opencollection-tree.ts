/**
 * Reading an OpenCollection directory for the importer: every YAML file under the picked root
 * document's folder, and the companion files (its `.proto` files) the collection names.
 *
 * The walk reads files the renderer never named, so it is held to more than the picked-path check
 * (ADR-0005): the root must pass {@link checkedImportSource}, no symbolic link is followed — a file
 * or a folder — every file and folder is checked to stay inside the root's real folder, and the
 * walk stops at {@link OC_TREE_LIMITS}. The root document and its own folder must not be links either.
 */

import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { OpenCollectionError, WirebenchError } from '@wirebench/engine';
import type { ReadPicks } from './dialog-picks.js';
import { checkedCompanionPaths, checkedImportSource, readCompanionFile, readNoFollow } from './path-access.js';
import { isInsideReal } from './path-containment.js';

/** The limits of one directory walk. */
export interface OcTreeLimits {
  /** YAML files read. */
  readonly files: number;
  /** Folders deep below the root's folder. */
  readonly depth: number;
  /** Bytes on disk of the files read, together. */
  readonly bytes: number;
  /** Folder entries looked at, of any kind, so a huge tree of non-YAML files is not walked whole. */
  readonly entries: number;
}

/** The most a collection directory may hold. */
export const OC_TREE_LIMITS: OcTreeLimits = {
  files: 5000,
  depth: 64,
  bytes: 50 * 1024 * 1024,
  entries: 50_000,
};

const YAML_FILE = /\.ya?ml$/i;
/** Folders no collection keeps its items in, and that can hold more entries than the whole cap. */
const SKIPPED_FOLDERS = new Set(['node_modules', '.git']);

function tooLarge(bytes: number): OpenCollectionError {
  return new OpenCollectionError('oc-too-large', `The collection is larger than ${formatBytes(bytes)}`);
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${String(bytes / (1024 * 1024))} MB` : `${String(bytes)} bytes`;
}

function tooManyFiles(limit: number): OpenCollectionError {
  return new OpenCollectionError('oc-too-many-files', `The collection holds more than ${String(limit)} files`);
}

function posixRelative(base: string, path: string): string {
  return relative(base, path).split(sep).join('/');
}

/**
 * The picked root document of a directory collection, checked before anything under it is read:
 * picked or inside an open project ({@link checkedImportSource}), and neither the file nor its own
 * folder a symbolic link, so the walk cannot be pointed at a folder the user never chose. Only the
 * immediate folder is checked: a linked ancestor (macOS `/var`) moves the whole path, not the root.
 *
 * @returns the resolved path of the root document
 * @throws WirebenchError `import-path-refused`; OpenCollectionError `oc-read-failed` when it cannot be checked
 */
export async function checkedOpenCollectionRoot(
  rootFile: string,
  roots: readonly string[],
  picks: ReadPicks | undefined,
): Promise<string> {
  const checked = await checkedImportSource(roots, picks, { kind: 'file', path: rootFile });
  if (checked.kind !== 'file') throw new WirebenchError('invalid-argument', 'Expected a file');
  for (const [path, what] of [
    [checked.path, 'file'],
    [dirname(checked.path), 'folder'],
  ] as const) {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      throw new OpenCollectionError(
        'oc-read-failed',
        `Failed to read OpenCollection file "${rootFile}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (info.isSymbolicLink()) {
      throw new WirebenchError(
        'import-path-refused',
        `Wirebench will not read the collection at "${rootFile}": its ${what} is a symbolic link and is not followed`,
        { details: { path: rootFile } },
      );
    }
  }
  return checked.path;
}

/**
 * Every `*.yml`/`*.yaml` under the picked root file's folder, keyed by POSIX path relative to that
 * folder. Links are skipped, as are `node_modules` and `.git`; other files are not read. `limits`
 * exists for tests; callers pass nothing.
 *
 * @throws WirebenchError `import-path-refused` when the root was neither picked nor inside an open
 *   project, or it or its folder is a symbolic link
 * @throws OpenCollectionError `oc-too-many-files` (files or entries), `oc-too-deep` or `oc-too-large`
 *   past the limits, `oc-read-failed` when a folder or file cannot be read
 */
export async function readOpenCollectionTree(
  rootFile: string,
  roots: readonly string[],
  picks: ReadPicks | undefined,
  limits: OcTreeLimits = OC_TREE_LIMITS,
): Promise<Map<string, string>> {
  const root = await checkedOpenCollectionRoot(rootFile, roots, picks);
  try {
    return await walk(dirname(root), limits);
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
async function walk(base: string, limits: OcTreeLimits): Promise<Map<string, string>> {
  const realBase = await realpath(base);
  const files = new Map<string, string>();
  let bytes = 0;
  let entriesSeen = 0;
  const queue: { dir: string; depth: number }[] = [{ dir: base, depth: 0 }];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { dir, depth } = next;
    if (depth > limits.depth) {
      throw new OpenCollectionError(
        'oc-too-deep',
        `The collection is nested more than ${String(limits.depth)} folders deep`,
      );
    }
    const entries = await readdir(dir, { withFileTypes: true });
    entriesSeen += entries.length;
    if (entriesSeen > limits.entries) throw tooManyFiles(limits.entries);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of entries) {
      if (dirent.isSymbolicLink()) continue;
      const path = join(dir, dirent.name);
      const isYaml = dirent.isFile() && YAML_FILE.test(dirent.name);
      const isFolder = dirent.isDirectory() && !SKIPPED_FOLDERS.has(dirent.name);
      if (!isFolder && !isYaml) continue;
      if (isYaml && files.size >= limits.files) throw tooManyFiles(limits.files);
      // A folder mounted or swapped in under the root would leave it without being a link.
      const real = await realpath(path).catch(() => undefined);
      if (real === undefined || !isInsideReal(realBase, real)) continue;
      if (isFolder) {
        queue.push({ dir: path, depth: depth + 1 });
        continue;
      }
      const read = await readNoFollow(path, limits.bytes - bytes, () => tooLarge(limits.bytes));
      if (read === undefined) continue;
      bytes += read.length;
      files.set(posixRelative(base, path), read.toString('utf8'));
    }
  }
  return files;
}

/**
 * Exactly the named files beside the root (its `.proto` files), checked by
 * {@link checkedCompanionPaths} — relative names only, inside the root's folder, no links — and read
 * through {@link readCompanionFile}, so a file swapped after its check is not read. A name with
 * nothing at it is left out, so the caller can say which were missing.
 *
 * @returns each file's text, keyed by POSIX path relative to the root's folder
 * @throws WirebenchError `import-path-refused` when the root is not readable, a name is refused, or
 *   a file changed after it was checked
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
    const read = await readCompanionFile(path, OC_TREE_LIMITS.bytes - bytes, () => tooLarge(OC_TREE_LIMITS.bytes));
    bytes += read.length;
    texts.set(posixRelative(base, path), read.toString('utf8'));
  }
  return texts;
}
