/**
 * Unsaved changes kept across sessions: the recovery records a workspace leaves behind when it
 * closes (or crashes) with edits that were never saved, and the merge that lays them back over
 * whatever is on disk when it opens again.
 *
 * Nothing here ever writes to a project folder. Records live under
 * `<workspace>/unsaved/`, one `<projectId>.json` per project that had unsaved changes plus one
 * `drafts.json` for the renderer's staged request edits. A missing, corrupt or unknown-version
 * record reads as "nothing to restore": broken recovery state must never stop a workspace from
 * opening.
 *
 * See `docs/specs/2026-09-13-unsaved-changes-across-sessions-design.md`.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { MANIFEST_PATH, nodeFs } from '@wirebench/engine';
import type { DirEntry, FileStat, FsLike, ProjectFiles } from '@wirebench/engine';
import { requestPatchSchema, restRequestPatchSchema } from '../shared/wire-types.js';
import type { RequestPatchWire, RestRequestPatchWire } from '../shared/wire-types.js';

/** Folder, inside a workspace's own folder, that holds its recovery records. */
export const UNSAVED_DIR = 'unsaved';

/** Format version of every record in {@link UNSAVED_DIR}; any other version reads as absent. */
export const UNSAVED_RECORD_VERSION = 1;

const DRAFTS_FILE = 'drafts.json';

const filesSchema = z.record(z.string(), z.string());

const projectRecordSchema = z.object({
  version: z.literal(UNSAVED_RECORD_VERSION),
  savedAt: z.string(),
  /** The project's files as they were on disk when the model was last in sync with them. */
  baseline: filesSchema,
  /** The project's files as the unsaved in-memory model would write them. */
  unsaved: filesSchema,
});

const draftsRecordSchema = z.object({
  version: z.literal(UNSAVED_RECORD_VERSION),
  requests: z.record(z.string(), requestPatchSchema),
  /** Absent in a file written before REST existed, which is read as "no REST drafts". */
  restRequests: z.record(z.string(), restRequestPatchSchema).optional(),
});

/** One project's recovery record, as stored. */
export type UnsavedProjectRecord = z.infer<typeof projectRecordSchema>;

/** What a host hands over for a project with unsaved changes: both sides of the merge. */
export interface UnsavedProjectFiles {
  readonly baseline: ProjectFiles;
  readonly unsaved: ProjectFiles;
}

/** A project file map as a plain object, which is what JSON can hold. */
export function filesToRecord(files: ProjectFiles): Record<string, string> {
  return Object.fromEntries(files);
}

/** The inverse of {@link filesToRecord}. */
export function recordToFiles(record: Readonly<Record<string, string>>): ProjectFiles {
  return new Map(Object.entries(record));
}

// ——— merge ———————————————————————————————————————————————————————————————————————————————

/** The outcome of laying unsaved files back over the files on disk. */
export interface UnsavedMerge {
  /** The files the restored project should be read from. */
  readonly files: ProjectFiles;
  /** Changed both on disk and in the unsaved record; the unsaved version was kept (or, for an
   * unsaved deletion of a file that changed on disk, the disk version was). */
  readonly conflicts: readonly string[];
  /** Changed in the unsaved record but deleted on disk; the unsaved change was dropped. */
  readonly dropped: readonly string[];
  /** Whether the merged files differ from disk at all. */
  readonly changed: boolean;
}

/**
 * The manifest records which save wrote it (`writtenBy: wirebench (manual)`), so two otherwise
 * identical manifests differ after every save. That line is not a change anyone made.
 */
function comparable(path: string, content: string | undefined): string | undefined {
  if (content === undefined || path !== MANIFEST_PATH) {
    return content;
  }
  return content
    .split('\n')
    .filter((line) => !/^writtenBy:/.test(line))
    .join('\n');
}

function same(path: string, a: string | undefined, b: string | undefined): boolean {
  return comparable(path, a) === comparable(path, b);
}

/**
 * Three-way merge, one file at a time, of the `baseline` (B) an unsaved record was taken
 * against, the files now on `disk` (D) and the `unsaved` files (U):
 *
 * - U = B → D (only disk changed, or nothing did);
 * - D = B → U (only the unsaved side changed — including an unsaved deletion);
 * - both changed:
 *   - D = U → U (the same change on both sides);
 *   - deleted on disk → dropped (the file, e.g. a request, no longer exists);
 *   - deleted in the unsaved record → D, flagged (a change on disk beats an unsaved deletion);
 *   - otherwise → U, flagged (unsaved changes are restored on top).
 */
export function mergeUnsaved(baseline: ProjectFiles, disk: ProjectFiles, unsaved: ProjectFiles): UnsavedMerge {
  const files = new Map<string, string>();
  const conflicts: string[] = [];
  const dropped: string[] = [];
  const paths = [...new Set([...baseline.keys(), ...disk.keys(), ...unsaved.keys()])].sort();
  for (const path of paths) {
    const b = baseline.get(path);
    const d = disk.get(path);
    const u = unsaved.get(path);
    let take: string | undefined;
    if (same(path, u, b)) {
      take = d;
    } else if (same(path, d, b)) {
      take = u;
    } else if (same(path, d, u)) {
      take = u;
    } else if (d === undefined) {
      dropped.push(path);
      take = undefined;
    } else if (u === undefined) {
      conflicts.push(path);
      take = d;
    } else {
      conflicts.push(path);
      take = u;
    }
    if (take !== undefined) {
      files.set(path, take);
    }
  }
  const changed = [...new Set([...files.keys(), ...disk.keys()])].some(
    (path) => !same(path, files.get(path), disk.get(path)),
  );
  return { files, conflicts, dropped, changed };
}

// ——— overlay file system ——————————————————————————————————————————————————————————————————

function notFound(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT' });
}

/**
 * An `FsLike` that reads the project at `root` as if `files` (relative path → content) were its
 * managed files: those are served from memory, a managed file on disk that `files` leaves out
 * is hidden, and everything else (attachments, definition caches) comes from the real folder.
 * Read-only by construction — `loadProject` is the only consumer, and it never writes.
 */
export function overlayFs(
  root: string,
  files: ProjectFiles,
  managedOnDisk: Iterable<string>,
  base: FsLike = nodeFs,
): FsLike {
  const toRel = (path: string): string | undefined => {
    const rel = relative(root, path);
    if (rel.startsWith('..') || rel === '') {
      return rel === '' ? '' : undefined;
    }
    return rel.split(sep).join('/');
  };
  const hidden = new Set([...managedOnDisk].filter((path) => !files.has(path)));
  /** Directories implied by the in-memory files, relative, `''` being the root. */
  const dirs = new Set<string>(['']);
  for (const path of files.keys()) {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      dirs.add(parts.slice(0, depth).join('/'));
    }
  }
  const refuse = (): Promise<never> => Promise.reject(new Error('overlayFs is read-only'));

  return {
    async readFile(path) {
      const rel = toRel(path);
      if (rel !== undefined) {
        const content = files.get(rel);
        if (content !== undefined) {
          return Buffer.from(content, 'utf8');
        }
        if (hidden.has(rel)) {
          throw notFound(path);
        }
      }
      return base.readFile(path);
    },
    async readdir(path) {
      const rel = toRel(path);
      let real: readonly DirEntry[] = [];
      try {
        real = await base.readdir(path);
      } catch (error) {
        if (rel === undefined || !dirs.has(rel)) {
          throw error;
        }
      }
      if (rel === undefined) {
        return real;
      }
      const prefix = rel === '' ? '' : `${rel}/`;
      const byName = new Map<string, DirEntry>();
      for (const entry of real) {
        if (!hidden.has(`${prefix}${entry.name}`)) {
          byName.set(entry.name, entry);
        }
      }
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) {
          continue;
        }
        const rest = file.slice(prefix.length);
        const [head, ...tail] = rest.split('/');
        if (head === undefined || head === '') {
          continue;
        }
        byName.set(
          head,
          tail.length === 0
            ? { name: head, isFile: true, isDirectory: false }
            : { name: head, isFile: false, isDirectory: true },
        );
      }
      return [...byName.values()];
    },
    async stat(path): Promise<FileStat> {
      const rel = toRel(path);
      if (rel !== undefined) {
        const content = files.get(rel);
        if (content !== undefined) {
          return { isFile: true, isDirectory: false, size: Buffer.byteLength(content, 'utf8') };
        }
        if (hidden.has(rel)) {
          throw notFound(path);
        }
        if (dirs.has(rel)) {
          return { isFile: false, isDirectory: true, size: 0 };
        }
      }
      return base.stat(path);
    },
    writeFile: refuse,
    rename: refuse,
    mkdir: refuse,
    rm: refuse,
  };
}

// ——— store ——————————————————————————————————————————————————————————————————————————————————

/** Writes `data` to `path` via a sibling temp file renamed over the target. */
async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temp, data, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads and writes one workspace's recovery records. Every operation on a given file is
 * serialised, so a debounced write that started earlier can never land after a newer one or
 * after the delete that follows a save.
 */
export class UnsavedStore {
  private readonly dir: string;
  private readonly queues = new Map<string, Promise<void>>();

  /** `workspaceDir` is the workspace's own folder (`<userData>/workspaces/<id>`). */
  constructor(workspaceDir: string) {
    this.dir = join(workspaceDir, UNSAVED_DIR);
  }

  private projectPath(projectId: string): string {
    return join(this.dir, `${projectId}.json`);
  }

  private enqueue(path: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(path) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    this.queues.set(path, settled);
    void settled.then(() => {
      if (this.queues.get(path) === settled) {
        this.queues.delete(path);
      }
    });
    return next;
  }

  /** Waits for every queued write or delete to settle. */
  async idle(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  async readProject(projectId: string): Promise<UnsavedProjectRecord | undefined> {
    const path = this.projectPath(projectId);
    await this.queues.get(path);
    return readJson(path, projectRecordSchema);
  }

  writeProject(projectId: string, files: UnsavedProjectFiles, savedAt: string): Promise<void> {
    const record: UnsavedProjectRecord = {
      version: UNSAVED_RECORD_VERSION,
      savedAt,
      baseline: filesToRecord(files.baseline),
      unsaved: filesToRecord(files.unsaved),
    };
    const path = this.projectPath(projectId);
    return this.enqueue(path, () => writeAtomic(path, JSON.stringify(record)));
  }

  deleteProject(projectId: string): Promise<void> {
    const path = this.projectPath(projectId);
    return this.enqueue(path, () => rm(path, { force: true }));
  }

  /** Keeps a record that could not be restored out of the way, rather than retrying it forever. */
  setAsideProject(projectId: string): Promise<void> {
    const path = this.projectPath(projectId);
    return this.enqueue(path, async () => {
      await rename(path, join(this.dir, `${projectId}.failed.json`)).catch(() => undefined);
    });
  }

  /** Both protocols' stored drafts. A file from before REST existed reads as no REST drafts. */
  async readDrafts(): Promise<{
    readonly requests: Record<string, RequestPatchWire>;
    readonly restRequests: Record<string, RestRequestPatchWire>;
  }> {
    const path = join(this.dir, DRAFTS_FILE);
    await this.queues.get(path);
    const record = await readJson(path, draftsRecordSchema);
    return { requests: record?.requests ?? {}, restRequests: record?.restRequests ?? {} };
  }

  /** Replaces the stored drafts; an empty pair of maps removes the file. */
  writeDrafts(
    requests: Readonly<Record<string, RequestPatchWire>>,
    restRequests: Readonly<Record<string, RestRequestPatchWire>> = {},
  ): Promise<void> {
    const path = join(this.dir, DRAFTS_FILE);
    if (Object.keys(requests).length === 0 && Object.keys(restRequests).length === 0) {
      return this.enqueue(path, () => rm(path, { force: true }));
    }
    const record = { version: UNSAVED_RECORD_VERSION, requests, restRequests };
    return this.enqueue(path, () => writeAtomic(path, JSON.stringify(record)));
  }
}
