/**
 * Writes a {@link Project} to a project folder.
 *
 * Saving is incremental and atomic: only files whose bytes actually changed are
 * rewritten (so an autosave produces a one-file git diff, and file watchers
 * stay quiet), and every write goes through a temp file plus `rename`.
 *
 * Only Wirebench's own subtrees are managed. The definition cache
 * (`interfaces/<slug>/definition/`) and `attachments/` belong to other
 * components and are never read or removed here — except when their owning
 * interface is deleted, in which case the whole interface folder goes.
 */

import { dirname, join } from 'node:path';
import type { Project } from './model.js';
import { ATTACHMENTS_DIR, DEFINITION_DIR, ENVIRONMENTS_DIR, INTERFACES_DIR, OPERATIONS_DIR, WSS_DIR } from './paths.js';
import type { FsLike } from './fs.js';
import { nodeFs, readFileIfExists, readdirIfExists, writeFileAtomic } from './fs.js';
import type { ProjectFiles } from './serialize.js';
import { MANIFEST_PATH, projectFiles } from './serialize.js';

/** What a {@link saveProject} call did, as relative `/`-separated paths. */
export interface SaveResult {
  /** Files created or whose content changed. */
  readonly written: readonly string[];
  /** Files (and empty entity folders) deleted because their entity is gone. */
  readonly removed: readonly string[];
  /** Files that were already byte-identical and therefore left alone. */
  readonly unchanged: readonly string[];
}

/** Options for {@link saveProject}. */
export interface SaveProjectOptions {
  /**
   * The files as they were last written. When supplied, unchanged files are
   * detected without reading them back from disk; when omitted, the current
   * on-disk bytes are read and compared instead.
   */
  readonly previous?: ProjectFiles;
  readonly fs?: FsLike;
}

function toAbsolute(root: string, relative: string): string {
  return join(root, ...relative.split('/'));
}

/** Recursively lists the files below `relativeDir`, skipping `skip`-named directories. */
async function listFiles(fs: FsLike, root: string, relativeDir: string, skip: ReadonlySet<string>): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdirIfExists(fs, toAbsolute(root, relativeDir));
  for (const entry of entries) {
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory) {
      if (!skip.has(entry.name)) {
        found.push(...(await listFiles(fs, root, relative, skip)));
      }
    } else if (entry.isFile) {
      found.push(relative);
    }
  }
  return found;
}

/** Lists every file Wirebench manages under `root`, ignoring foreign subtrees. */
async function listManagedFiles(fs: FsLike, root: string): Promise<string[]> {
  const skip = new Set([DEFINITION_DIR, ATTACHMENTS_DIR]);
  const managed: string[] = [];
  if ((await readFileIfExists(fs, toAbsolute(root, MANIFEST_PATH))) !== undefined) {
    managed.push(MANIFEST_PATH);
  }
  managed.push(...(await listFiles(fs, root, ENVIRONMENTS_DIR, skip)));
  managed.push(...(await listFiles(fs, root, WSS_DIR, skip)));
  for (const entry of await readdirIfExists(fs, toAbsolute(root, INTERFACES_DIR))) {
    if (!entry.isDirectory) {
      continue;
    }
    const base = `${INTERFACES_DIR}/${entry.name}`;
    const ifaceFile = `${base}/interface.yaml`;
    if ((await readFileIfExists(fs, toAbsolute(root, ifaceFile))) !== undefined) {
      managed.push(ifaceFile);
    }
    managed.push(...(await listFiles(fs, root, `${base}/${OPERATIONS_DIR}`, skip)));
  }
  return managed;
}

/**
 * Removes directories that became empty after their files were deleted, walking
 * upward but never past the project root or into a foreign subtree.
 */
async function pruneEmptyDirs(fs: FsLike, root: string, relativeDirs: ReadonlySet<string>): Promise<string[]> {
  const pruned: string[] = [];
  // Deepest first, so a parent is considered after its children are gone.
  for (const relative of [...relativeDirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
    let current = relative;
    while (current !== '' && current !== '.') {
      const entries = await readdirIfExists(fs, toAbsolute(root, current));
      if (entries.length > 0) {
        break;
      }
      await fs.rm(toAbsolute(root, current), { recursive: true, force: true });
      pruned.push(current);
      const parent = dirname(current);
      current = parent === '.' ? '' : parent;
    }
  }
  return pruned;
}

/**
 * Saves `project` into the directory `root`, creating it if needed.
 *
 * @returns which files were written, removed and left untouched.
 */
export async function saveProject(project: Project, root: string, options?: SaveProjectOptions): Promise<SaveResult> {
  const fs = options?.fs ?? nodeFs;
  const desired = projectFiles(project);
  const existing = await listManagedFiles(fs, root);

  const written: string[] = [];
  const unchanged: string[] = [];
  for (const [relative, content] of desired) {
    const absolute = toAbsolute(root, relative);
    const previous =
      options?.previous?.get(relative) ??
      (options?.previous !== undefined ? undefined : (await readFileIfExists(fs, absolute))?.toString('utf8'));
    if (previous === content) {
      unchanged.push(relative);
      continue;
    }
    await writeFileAtomic(fs, absolute, Buffer.from(content, 'utf8'));
    written.push(relative);
  }

  const removed: string[] = [];
  const touchedDirs = new Set<string>();

  // A deleted interface takes its whole folder with it, definition cache included.
  const liveSlugs = new Set(project.interfaces.map((i) => i.slug));
  const goneInterfaces = new Set<string>();
  for (const entry of await readdirIfExists(fs, toAbsolute(root, INTERFACES_DIR))) {
    if (entry.isDirectory && !liveSlugs.has(entry.name)) {
      const relative = `${INTERFACES_DIR}/${entry.name}`;
      await fs.rm(toAbsolute(root, relative), { recursive: true, force: true });
      removed.push(relative);
      goneInterfaces.add(`${relative}/`);
    }
  }

  for (const relative of existing) {
    if (desired.has(relative) || [...goneInterfaces].some((prefix) => relative.startsWith(prefix))) {
      continue;
    }
    await fs.rm(toAbsolute(root, relative), { force: true });
    removed.push(relative);
    const parent = dirname(relative);
    if (parent !== '.' && parent !== '') {
      touchedDirs.add(parent);
    }
  }
  removed.push(...(await pruneEmptyDirs(fs, root, touchedDirs)));

  written.sort();
  removed.sort();
  unchanged.sort();
  return { written, removed, unchanged };
}
