/**
 * Writes a {@link Project} to a project folder.
 *
 * Saving is incremental and atomic: only files whose bytes actually changed are
 * rewritten (so an autosave produces a one-file git diff, and file watchers
 * stay quiet), and every write goes through a temp file plus `rename`.
 *
 * Only Wirebench's own subtrees are managed: core lists its own files, and each
 * protocol module lists those of its containers. The definition cache
 * (`interfaces/<slug>/definition/`) and `attachments/` belong to other
 * components and are never read or removed here — except when their owning
 * interface is deleted, in which case the whole interface folder goes.
 */

import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { ProjectError } from '../errors.js';
import type { ContainerDir } from '../protocol/module.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocols.js';
import { SEQUENCES_DIR } from '../sequence/file.js';
import { readSequences } from '../sequence/load.js';
import type { FsLike } from './fs.js';
import { nodeFs, readFileIfExists, readdirIfExists, writeFileAtomic } from './fs.js';
import { listApiTreeFiles, toAbsolute } from './managed-files.js';
import { takenContainerSlugs, unsupportedOf } from './model.js';
import type { Project } from './model.js';
import {
  APIS_DIR,
  ENVIRONMENTS_DIR,
  INTERFACES_DIR,
  REQUESTS_DIR,
  WEBHOOKS_DIR,
  WEBHOOKS_FEATURE,
  WEBHOOKS_FILE,
  WSS_DIR,
} from './paths.js';
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
   * The protocols this save can write: their containers are what is written, and their files what
   * is managed. A container the project holds whose kind has no enabled module here is left on
   * disk exactly as it is, as a placeholder is. Defaults to the built-in ones, all switched on.
   */
  readonly registry?: ProtocolRegistry;
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

/**
 * Lists the files core itself manages under `root` — every file that matches one of these
 * patterns:
 *
 * - `wirebench.yaml`
 * - `environments/*.yaml`
 * - `wss/{outgoing,incoming}/*.yaml`
 * - `wss/keystores.yaml`
 * - `webhooks/webhooks.yaml`, while the `rest` feature is on
 * - `webhooks/requests/**` (the collection's own request tree, same layout as an API's), while the
 *   `rest` feature is on
 * - the `sequences/*.sequence.yaml` this build loaded
 *
 * A container's files are its protocol's to list (`storage.managed`). Anything else on disk — a
 * README, a `.gitkeep`, notes — is a foreign file and is never a deletion candidate, even when it
 * sits inside a directory Wirebench otherwise manages.
 */
async function listCoreManagedFiles(fs: FsLike, root: string, registry: ProtocolRegistry): Promise<string[]> {
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

  // The request tree is managed only beside its `webhooks.yaml`, as an API's is beside its `api.yaml`,
  // and only while REST is on: with it off the collection was not loaded, and is not this save's.
  const webhooksFile = `${WEBHOOKS_DIR}/${WEBHOOKS_FILE}`;
  if (
    registry.features.isEnabled(WEBHOOKS_FEATURE) &&
    (await readFileIfExists(fs, toAbsolute(root, webhooksFile))) !== undefined
  ) {
    managed.push(webhooksFile);
    managed.push(...(await listApiTreeFiles(fs, root, `${WEBHOOKS_DIR}/${REQUESTS_DIR}`)));
  }

  // Only the sequence files this build loaded: one it refused (too new, malformed, a duplicate id) is
  // foreign, so a save can never delete a sequence the user has not seen (`sequence/load.ts`).
  for (const { file } of (await readSequences(fs, root)).loaded) {
    managed.push(file);
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
 * Refuses a save that would write over a sequence file this build did not load. A new sequence whose
 * slug matches a file from a newer build (or one mid-merge) would otherwise replace it unseen; the
 * mutation layer picks slugs around such files, so this is the backstop, not the usual path.
 *
 * @throws ProjectError `sequence-file-conflict`
 */
async function refuseOverwritingForeignSequences(
  fs: FsLike,
  root: string,
  desired: ReadonlyMap<string, string>,
  managed: readonly string[],
): Promise<void> {
  const loaded = new Set(managed);
  for (const relative of desired.keys()) {
    if (
      relative.startsWith(`${SEQUENCES_DIR}/`) &&
      !loaded.has(relative) &&
      (await readFileIfExists(fs, toAbsolute(root, relative))) !== undefined
    ) {
      throw new ProjectError(
        'sequence-file-conflict',
        `${relative} exists but could not be loaded by this build; rename the sequence instead of replacing it`,
        { details: { file: relative } },
      );
    }
  }
}

/**
 * Refuses a save that would write a container into a placeholder's directory (spec §6): the files
 * there belong to a container this build could not read, and none of them may be replaced. Slugs
 * are compared without case, as `uniqueSlug` compares them, because on most machines two names
 * that differ only in case are one directory. A host that names containers with
 * `takenContainerSlugs` never gets here.
 *
 * @throws ProjectError `container-slug-conflict`
 */
function refusePlaceholderConflicts(project: Project, registry: ProtocolRegistry): void {
  const placeholders = unsupportedOf(project);
  if (placeholders.length === 0) {
    return;
  }
  for (const { storage } of registry.modules) {
    for (const container of storage.containers(project)) {
      const placeholder = placeholders.find(
        (candidate) => candidate.dir === storage.dir && candidate.slug.toLowerCase() === container.slug.toLowerCase(),
      );
      if (placeholder !== undefined) {
        throw new ProjectError(
          'container-slug-conflict',
          `"${container.name}" would be saved to ${storage.dir}/${placeholder.slug}, which holds a "${placeholder.kind}" container this build did not load; give it another name`,
          {
            details: {
              dir: storage.dir,
              slug: container.slug,
              kind: placeholder.kind,
              reason: placeholder.reason,
            },
          },
        );
      }
    }
  }
}

/**
 * Saves `project` into the directory `root`, creating it if needed.
 *
 * @returns which files were written, removed and left untouched.
 * @throws ProjectError `container-slug-conflict` when a container has the slug of a placeholder in
 * its directory; `sequence-file-conflict`; what {@link projectFiles} throws
 */
export async function saveProject(project: Project, root: string, options?: SaveProjectOptions): Promise<SaveResult> {
  const fs = options?.fs ?? nodeFs;
  const registry = options?.registry ?? defaultRegistry();
  const desired = projectFiles(project, {
    registry,
    ...(options?.writer !== undefined ? { writer: options.writer } : {}),
  });
  refusePlaceholderConflicts(project, registry);

  // Which container directories are alive: every container the project holds and every placeholder,
  // whatever this save's registry can write (spec R6). A save never deletes what it cannot write.
  const live: Record<ContainerDir, ReadonlySet<string>> = {
    interfaces: takenContainerSlugs(project, 'interfaces'),
    apis: takenContainerSlugs(project, 'apis'),
  };
  // An API whose slug an interface has is skipped on load (`api-slug-conflict`), so it is in no list
  // above; its folder is still the user's and stays.
  const interfaceKeys = new Set([...live.interfaces].map((slug) => slug.toLowerCase()));
  const keptApiDir = (name: string): boolean => interfaceKeys.has(name.toLowerCase());

  // On a file system that does not tell `Graph` from `graph`, a container renamed only by case still
  // sits in its old folder; give the folder its new name before anything is written into it.
  const foldsCase = await foldsCaseUnder(fs, root);
  if (foldsCase) {
    await renameContainersByCase(fs, root, live);
  }
  // What this save may delete: core's own files, then each module's word on each of its containers
  // (spec §5.2). A placeholder, and a container no enabled module answers for, has no managed file,
  // so nothing under its directory is removed or touched (spec §6).
  const existing = await listCoreManagedFiles(fs, root, registry);
  for (const { storage } of registry.modules) {
    for (const container of storage.containers(project)) {
      existing.push(...(await storage.managed(fs, root, container.slug)));
    }
  }
  await refuseOverwritingForeignSequences(fs, root, desired, existing);

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

  // A deleted interface or API takes its whole folder with it, definition cache included.
  const goneEntities = new Set<string>();
  for (const dir of [INTERFACES_DIR, APIS_DIR] as const) {
    for (const entry of await readdirIfExists(fs, toAbsolute(root, dir))) {
      if (entry.isDirectory && !live[dir].has(entry.name) && !(dir === APIS_DIR && keptApiDir(entry.name))) {
        const relative = `${dir}/${entry.name}`;
        await fs.rm(toAbsolute(root, relative), { recursive: true, force: true });
        removed.push(relative);
        goneEntities.add(`${relative}/`);
      }
    }
  }

  // The written path, by its case-folded form, for a file renamed only by case.
  const desiredByKey = new Map([...desired.keys()].map((path) => [path.toLowerCase(), path]));
  const renamedByCase = new Set<string>();
  for (const relative of existing) {
    if (desired.has(relative) || [...goneEntities].some((prefix) => relative.startsWith(prefix))) {
      continue;
    }
    const sameFile = foldsCase ? desiredByKey.get(relative.toLowerCase()) : undefined;
    if (sameFile !== undefined) {
      // The write above went into this very file and kept its old name; removing it would remove
      // the new content. Give it the new name instead.
      await renamePathByCase(fs, root, relative, sameFile, renamedByCase);
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

/**
 * Whether the file system under `root` treats two names that differ only by case as one entry, as
 * the default ones on macOS and Windows do. Probed with an entry `root` already holds; a folder that
 * holds nothing yet has nothing to rename, so it answers `false`.
 */
async function foldsCaseUnder(fs: FsLike, root: string): Promise<boolean> {
  const names = (await readdirIfExists(fs, root)).map((entry) => entry.name);
  const probe = names.find((name) => name.toLowerCase() !== name.toUpperCase());
  if (probe === undefined) {
    return false;
  }
  const swapped = probe === probe.toUpperCase() ? probe.toLowerCase() : probe.toUpperCase();
  if (names.includes(swapped)) {
    return false;
  }
  try {
    await fs.stat(toAbsolute(root, swapped));
    return true;
  } catch {
    return false;
  }
}

/** Renames `from` to `to`, two names of one entry, through a temporary name so the case change holds. */
async function renameByCase(fs: FsLike, from: string, to: string): Promise<void> {
  const hop = `${from}.case-${randomBytes(6).toString('hex')}`;
  await fs.rename(from, hop);
  await fs.rename(hop, to);
}

/** Gives each container folder whose container was renamed only by case its new name. */
async function renameContainersByCase(
  fs: FsLike,
  root: string,
  live: Readonly<Record<ContainerDir, ReadonlySet<string>>>,
): Promise<void> {
  for (const dir of [INTERFACES_DIR, APIS_DIR] as const) {
    const byKey = new Map([...live[dir]].map((slug) => [slug.toLowerCase(), slug]));
    for (const entry of await readdirIfExists(fs, toAbsolute(root, dir))) {
      const slug = byKey.get(entry.name.toLowerCase());
      if (entry.isDirectory && slug !== undefined && slug !== entry.name) {
        await renameByCase(fs, toAbsolute(root, `${dir}/${entry.name}`), toAbsolute(root, `${dir}/${slug}`));
      }
    }
  }
}

/**
 * Gives the managed file `from` the name `to`, which differs from it only by case, renaming each
 * folder on the way whose case changed too. `done` holds the case-folded paths already renamed.
 */
async function renamePathByCase(fs: FsLike, root: string, from: string, to: string, done: Set<string>): Promise<void> {
  const fromParts = from.split('/');
  const toParts = to.split('/');
  for (let index = 0; index < toParts.length; index += 1) {
    if (fromParts[index] === toParts[index]) {
      continue;
    }
    const target = toParts.slice(0, index + 1).join('/');
    if (done.has(target.toLowerCase())) {
      continue;
    }
    const current = [...toParts.slice(0, index), fromParts[index]].join('/');
    await renameByCase(fs, toAbsolute(root, current), toAbsolute(root, target));
    done.add(target.toLowerCase());
  }
}
