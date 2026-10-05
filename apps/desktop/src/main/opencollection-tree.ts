/**
 * Reading an OpenCollection directory for the importer: every YAML file under the picked root
 * document's folder, and the companion files the collection names: its `.proto` files and the files
 * they import.
 *
 * The walk reads files the renderer never named, so it is held to more than the picked-path check
 * (ADR-0005): the root must pass {@link checkedImportSource}, no symbolic link is followed — a file
 * or a folder — every file and folder is checked to stay inside the root's real folder, and the
 * walk stops at {@link OC_TREE_LIMITS}. The root document and its own folder must not be links either.
 */

import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { OpenCollectionError, protoPathSegments, WirebenchError } from '@wirebench/engine';
import type { ReadPicks } from './dialog-picks.js';
import { checkedCompanionPaths, checkedImportSource, readCompanionFile, readNoFollow } from './path-access.js';
import { isInsideReal } from './path-containment.js';
import { protoImportsOf } from './proto-imports-of.js';

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
  for (let at = 0; at < queue.length; at += 1) {
    const next = queue[at]!;
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

/** The `.proto` files of a folder collection's gRPC API, as {@link readCompanionProtos} read them. */
export interface CompanionProtos {
  /** Every file read, the named ones and those they import, keyed by POSIX path relative to the root's folder. */
  readonly sources: Map<string, string>;
  /** The keys of the named files that were there: the files a load starts from. */
  readonly roots: string[];
  /**
   * Imports found nowhere in the collection's folder, each with the key of the file that names it:
   * the first {@link MISSING_IMPORTS_LISTED}, in the order met.
   */
  readonly missing: { readonly name: string; readonly importedBy: string }[];
  /** How many more distinct missing imports there were past those listed. */
  readonly missingMore: number;
}

/** The most missing imports {@link readCompanionProtos} lists; any one already leaves the API without a definition. */
export const MISSING_IMPORTS_LISTED = 20;

/** The folder part of a POSIX key, with its trailing `/`; empty for a key at the top. */
function keyDir(key: string): string {
  const slash = key.lastIndexOf('/');
  return slash === -1 ? '' : key.slice(0, slash + 1);
}

/**
 * The named `.proto` files beside the root, and — transitively — every file they import, as a
 * compiler run from the collection's folder would find them: an import is looked for first
 * relative to that folder (the import-root reading), then relative to the importing file's folder.
 * The bundled `google/protobuf/*` imports are left to the engine.
 *
 * Every file goes through {@link checkedCompanionPaths} — relative names only, inside the root's
 * folder, no links — and is read through {@link readCompanionFile}, so a file swapped after its check
 * is not read. An import that is not a plain relative path (a `..` or `.` segment, a leading `/`, a
 * backslash) is refused before anything is read for it. Each file is read once, which also ends a
 * cycle, and the walk stops at the file and byte limits, and at the entry limit counting each path
 * looked for. A named file with nothing at it is left out of `roots`, so the caller can say which
 * were missing; an import with nothing at it is listed in `missing`, up to a cap, and counted past it. Keys are paths relative to the
 * root's folder: under the import-root reading that is the import string itself, and under the
 * importer-relative one it is the path the engine's loader tries second, so it finds either without
 * two importers' same-named neighbours colliding. `limits` exists for tests; callers pass nothing.
 *
 * @throws WirebenchError `import-path-refused` when the root is not readable, a name or import is
 *   refused, or a file changed after it was checked
 * @throws OpenCollectionError `oc-too-many-files` or `oc-too-large` past the limits
 */
export async function readCompanionProtos(
  rootFile: string,
  roots: readonly string[],
  picks: ReadPicks | undefined,
  names: readonly string[],
  limits: Pick<OcTreeLimits, 'files' | 'bytes' | 'entries'> = OC_TREE_LIMITS,
): Promise<CompanionProtos> {
  const base = dirname(resolve(rootFile));
  const sources = new Map<string, string>();
  const missing: { name: string; importedBy: string }[] = [];
  const missingSeen = new Set<string>();
  const queue: { readonly key: string; readonly path: string }[] = [];
  const seen = new Set<string>();
  // Paths looked for and not there, so a name imported again is not looked for again; together
  // with the files found, held to the entry limit so a file of many imports cannot cost a lookup each.
  const absent = new Set<string>();
  const enqueue = (key: string, path: string): void => {
    seen.add(key);
    queue.push({ key, path });
  };
  for (const path of await checkedCompanionPaths(roots, picks, rootFile, names)) {
    const key = posixRelative(base, path);
    if (!seen.has(key)) enqueue(key, path);
  }
  const listed = [...seen];
  let bytes = 0;
  for (let at = 0; at < queue.length; at += 1) {
    const next = queue[at]!;
    if (sources.size >= limits.files) throw tooManyFiles(limits.files);
    const read = await readCompanionFile(next.path, limits.bytes - bytes, () => tooLarge(limits.bytes));
    bytes += read.length;
    const text = read.toString('utf8');
    sources.set(next.key, text);
    for (const name of protoImportsOf(text)) {
      if (name.startsWith('google/protobuf/')) continue;
      try {
        protoPathSegments(name);
      } catch {
        throw new WirebenchError(
          'import-path-refused',
          `"${name}", imported by ${next.key}, is not a relative path inside the collection's folder`,
          { details: { path: name, importedBy: next.key } },
        );
      }
      // Root-relative first, then beside the importer: the first that is there wins, whatever order
      // the walk met the files in.
      let found = false;
      for (const candidate of new Set([name, `${keyDir(next.key)}${name}`])) {
        if (seen.has(candidate)) {
          found = true;
          break;
        }
        if (absent.has(candidate)) continue;
        if (seen.size + absent.size >= limits.entries) throw tooManyFiles(limits.entries);
        const [path] = await checkedCompanionPaths(roots, picks, rootFile, [candidate]);
        if (path !== undefined) {
          enqueue(candidate, path);
          found = true;
          break;
        }
        absent.add(candidate);
      }
      const pair = `${next.key}\u0000${name}`;
      if (!found && !missingSeen.has(pair)) {
        missingSeen.add(pair);
        if (missing.length < MISSING_IMPORTS_LISTED) missing.push({ name, importedBy: next.key });
      }
    }
  }
  return { sources, roots: listed, missing, missingMore: missingSeen.size - missing.length };
}
