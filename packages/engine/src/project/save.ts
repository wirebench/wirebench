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
import { ENVIRONMENTS_DIR, INTERFACES_DIR, OPERATIONS_DIR, REQUEST_SUFFIX, WSS_DIR } from './paths.js';
import type { FsLike } from './fs.js';
import { nodeFs, readFileIfExists, readdirIfExists, writeFileAtomic } from './fs.js';
import type { ProjectFiles } from './serialize.js';
import { KEYSTORES_PATH, MANIFEST_PATH, projectFiles } from './serialize.js';

/** What a {@link saveProject} call did, as relative `/`-separated paths. */
export interface SaveResult {
  /** Files created or whose content changed. */
  readonly written: readonly string[];
  /** Files (and empty entity folders) deleted because their entity is gone. */
  readonly removed: readonly string[];
  /** Files that were already byte-identical and therefore left alone. */
  readonly unchanged: readonly string[];
  /**
   * The `.bak` files actually written for this save's {@link SaveProjectOptions.backups}
   * request, one per requested `<slug>.xml.bak`, timestamped and in the same order. Empty when
   * `backups` was omitted or every requested source was missing.
   */
  readonly backups: readonly string[];
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
  /** Recorded in the manifest as `writtenBy`. Defaults to `'wirebench'`. */
  readonly writer?: string;
  /**
   * Relative `<slug>.xml.bak` paths naming the requests to back up before this save overwrites
   * their `<slug>.xml`, as produced by `wsdl/update-definition.ts`'s `applyUpdate`. The bytes
   * copied are whatever is on disk *now*, so the backup is the envelope as the user last saw it
   * — and one is written whenever its source exists, even if this save turns out not to change
   * it, so that ticking "Create backups" always produces the file the user was promised. A path
   * whose `.xml` does not exist is skipped silently.
   *
   * Each backup is actually written as `<slug>.<YYYYMMDD-HHmmss>.xml.bak` (UTC), never
   * overwriting a previous backup of the same request — every Update Definition run gets its
   * own file, kept next to the request file, one per update. The timestamped paths actually
   * written are returned as {@link SaveResult.backups}. `.bak` files are not part of the
   * managed file set, so nothing ever deletes them again.
   */
  readonly backups?: Iterable<string>;
  /** Clock the backup timestamp is read from. Defaults to `() => new Date()`; tests inject it. */
  readonly now?: () => Date;
}

function toAbsolute(root: string, relative: string): string {
  return join(root, ...relative.split('/'));
}

/**
 * Lists every file Wirebench manages under `root` — i.e. every file that
 * matches one of the format's own patterns:
 *
 * - `wirebench.yaml`
 * - `environments/*.yaml`
 * - `interfaces/*\/interface.yaml`
 * - `interfaces/*\/operations/*\/*.request.yaml`, plus the sibling `*.xml` of
 *   any such file
 * - `wss/{outgoing,incoming}/*.yaml`
 * - `wss/keystores.yaml`
 *
 * Anything else on disk — a README, a `.gitkeep`, notes, an orphan `.xml`
 * with no matching `.request.yaml` — is a foreign file and is never a
 * deletion candidate, even when it sits inside a directory Wirebench
 * otherwise manages.
 */
async function listManagedFiles(fs: FsLike, root: string): Promise<string[]> {
  const managed: string[] = [];
  if ((await readFileIfExists(fs, toAbsolute(root, MANIFEST_PATH))) !== undefined) {
    managed.push(MANIFEST_PATH);
  }

  for (const entry of await readdirIfExists(fs, toAbsolute(root, ENVIRONMENTS_DIR))) {
    if (entry.isFile && entry.name.endsWith('.yaml')) {
      managed.push(`${ENVIRONMENTS_DIR}/${entry.name}`);
    }
  }

  for (const direction of ['outgoing', 'incoming'] as const) {
    const dir = `${WSS_DIR}/${direction}`;
    for (const entry of await readdirIfExists(fs, toAbsolute(root, dir))) {
      if (entry.isFile && entry.name.endsWith('.yaml')) {
        managed.push(`${dir}/${entry.name}`);
      }
    }
  }
  if ((await readFileIfExists(fs, toAbsolute(root, KEYSTORES_PATH))) !== undefined) {
    managed.push(KEYSTORES_PATH);
  }

  for (const entry of await readdirIfExists(fs, toAbsolute(root, INTERFACES_DIR))) {
    if (!entry.isDirectory) {
      continue;
    }
    const base = `${INTERFACES_DIR}/${entry.name}`;
    const ifaceFile = `${base}/interface.yaml`;
    if ((await readFileIfExists(fs, toAbsolute(root, ifaceFile))) !== undefined) {
      managed.push(ifaceFile);
    }

    const opsDir = `${base}/${OPERATIONS_DIR}`;
    for (const opEntry of await readdirIfExists(fs, toAbsolute(root, opsDir))) {
      if (!opEntry.isDirectory) {
        continue;
      }
      const opDir = `${opsDir}/${opEntry.name}`;
      const requestSlugs = new Set<string>();
      const opFiles = await readdirIfExists(fs, toAbsolute(root, opDir));
      for (const fileEntry of opFiles) {
        if (fileEntry.isFile && fileEntry.name.endsWith(REQUEST_SUFFIX)) {
          requestSlugs.add(fileEntry.name.slice(0, -REQUEST_SUFFIX.length));
          managed.push(`${opDir}/${fileEntry.name}`);
        }
      }
      for (const fileEntry of opFiles) {
        if (fileEntry.isFile && fileEntry.name.endsWith('.xml')) {
          const slug = fileEntry.name.slice(0, -'.xml'.length);
          if (requestSlugs.has(slug)) {
            managed.push(`${opDir}/${fileEntry.name}`);
          }
        }
      }
    }
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
  const desired = projectFiles(project, options?.writer !== undefined ? { writer: options.writer } : undefined);
  const existing = await listManagedFiles(fs, root);

  const backupsWritten: string[] = [];
  for (const backup of options?.backups ?? []) {
    if (!backup.endsWith('.xml.bak')) {
      continue;
    }
    const source = backup.slice(0, -'.bak'.length);
    const current = await readFileIfExists(fs, toAbsolute(root, source));
    if (current === undefined) {
      continue;
    }
    const timestamped = await timestampedBackupPath(fs, root, backup, options?.now ?? (() => new Date()));
    await writeFileAtomic(fs, toAbsolute(root, timestamped), current);
    backupsWritten.push(timestamped);
  }

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
  backupsWritten.sort();
  return { written, removed, unchanged, backups: backupsWritten };
}

/** UTC `YYYYMMDD-HHmmss` for `date`, the backup timestamp format. */
function backupStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${String(date.getUTCFullYear())}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/**
 * Turns a requested `<slug>.xml.bak` path into `<slug>.<stamp>.xml.bak`, picking a stamp from
 * `now` and, in the vanishingly unlikely case that path is already taken (two backups of the
 * same request within the same second), appending a counter so it never overwrites a previous
 * backup.
 */
async function timestampedBackupPath(fs: FsLike, root: string, backup: string, now: () => Date): Promise<string> {
  const base = backup.slice(0, -'.xml.bak'.length);
  const stamp = backupStamp(now());
  let candidate = `${base}.${stamp}.xml.bak`;
  let n = 2;
  while ((await readFileIfExists(fs, toAbsolute(root, candidate))) !== undefined) {
    candidate = `${base}.${stamp}-${String(n)}.xml.bak`;
    n += 1;
  }
  return candidate;
}
