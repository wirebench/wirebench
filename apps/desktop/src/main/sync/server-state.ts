/**
 * The client's sync state for a workspace shared through Wirebench Server (server-sync spec §4.2),
 * under `<userData>/workspaces/<id>/server/`:
 *
 * - `state.yaml`: the base head, the head the last fetch saw, `behind`, the role, the identity and
 *   `lastSyncAt`;
 * - `base/`: the tree as of `base.head`, file for file and byte for byte;
 * - `pending/NNNN.yaml`: the local commits not yet pushed, oldest first, each holding the full
 *   content of every path it changed, so replaying them over any base is well defined;
 * - `merge.yaml`: present only while a merge is in conflict.
 *
 * This module is the only writer under `server/`, and every file goes through the engine's
 * `writeFileAtomic`. Replacing `base/` is the one change that spans several files. It is journaled
 * in `advance.yaml`, and the first use of a `ServerState` rolls an interrupted one forward, so
 * `base/` and `base.head` always describe the same commit.
 *
 * The encoding is not stored. `base/` mirrors the tree, and UTF-8 validity decides the encoding on
 * every read, which is the rule the server applies (§3.3). It is lossless, and a file reads the
 * same from the tree, from `base/` and from the wire.
 *
 * Electron-free: `ServerBackend` imports this module, and the server package's contract run imports
 * `ServerBackend` (O4).
 */
import { isUtf8 } from 'node:buffer';
import type { Stats } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertTreePath,
  generateId,
  isTreePath,
  nodeFs,
  syncChangeSchema,
  syncCommitIdSchema,
  syncEncodingSchema,
  TREE_ITEMS,
  WirebenchError,
  workspaceRoleSchema,
  writeFileAtomic,
  type SyncChange,
  type SyncEncoding,
  type WorkspaceRole,
} from '@wirebench/engine';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

/** A file as the sync wire carries it. */
export type TreeFile = { readonly encoding: SyncEncoding; readonly content: string };
export type TreeFiles = ReadonlyMap<string, TreeFile>;

export interface ServerStateDoc {
  readonly version: 1;
  /** The server head the tree was last reconciled with; `null` before the first push or join. */
  readonly base: { readonly head: string | null };
  /** The head the last fetch reported; frozen while a merge is open (see `ServerBackend.fetch`). */
  readonly knownHead?: string | null;
  /** Commits between the base and `knownHead`, as the server counted them. */
  readonly behind?: number;
  /** The caller's role, as the last fetch reported it. */
  readonly role?: WorkspaceRole;
  /** Local display only; the server attributes commits to the signed-in user (§3.1). */
  readonly identity?: { readonly name: string; readonly email: string };
  readonly lastSyncAt?: string;
}

export interface PendingCommitRecord {
  readonly id: string;
  readonly subject: string;
  readonly at: string;
  /** Full-file changes against the committed files before this commit; `content: null` deletes. */
  readonly changes: readonly SyncChange[];
}

export interface MergeRecord {
  /** Paths still in conflict; `resolve` removes them one at a time. */
  readonly conflicts: readonly string[];
  /** My side of each conflicted path; a conflicted path missing here was deleted on my side. */
  readonly mine: Readonly<Record<string, TreeFile>>;
  /** Their whole tree at the merged head, so `finishMerge` can make it the base without the network. */
  readonly theirs: Readonly<Record<string, TreeFile>>;
  /** The tree before the merge, for each of `mergePaths`; a path missing here did not exist. */
  readonly preMerge: Readonly<Record<string, TreeFile>>;
  /** Every path the merge wrote or left in conflict: what `finishMerge` commits and `abortMerge` restores. */
  readonly mergePaths: readonly string[];
}

export const SERVER_STATE_DIR = 'server';

const STATE_VERSION = 1;
const STATE_FILE = 'state.yaml';
const BASE_DIR = 'base';
/** Where the next base is written before `advance.yaml` commits it. */
const BASE_NEXT_DIR = 'base.next';
/** The journal of an `advanceBase`: written once `base.next/` is complete, removed once applied. */
const ADVANCE_FILE = 'advance.yaml';
const PENDING_DIR = 'pending';
const MERGE_FILE = 'merge.yaml';
/** `0001.yaml`, `0002.yaml`, …; more digits past 9999, which is why they are sorted by number. */
const PENDING_NAME = /^(\d{4,})\.yaml$/;

const headSchema = syncCommitIdSchema.nullable();
const stateDocSchema = z.object({
  version: z.literal(STATE_VERSION),
  base: z.object({ head: headSchema }),
  knownHead: headSchema.optional(),
  behind: z.number().int().min(0).optional(),
  role: workspaceRoleSchema.optional(),
  identity: z.object({ name: z.string().min(1), email: z.string().min(1) }).optional(),
  lastSyncAt: z.string().optional(),
});
const treeFileSchema = z.object({ encoding: syncEncodingSchema, content: z.string() });
const treeFileRecordSchema = z.record(z.string(), treeFileSchema);
const pendingSchema = z.object({
  id: z.string().min(1),
  subject: z.string(),
  at: z.string(),
  changes: z.array(syncChangeSchema),
});
const mergeSchema = z.object({
  conflicts: z.array(z.string()),
  mine: treeFileRecordSchema,
  theirs: treeFileRecordSchema,
  preMerge: treeFileRecordSchema,
  mergePaths: z.array(z.string()),
});
/**
 * YAML does not carry every text byte for byte: a whitespace-only line in a block scalar loses its
 * blanks (`"   \n"` reads back as `"\n"`), and no scalar style avoids that for every string. So every
 * content in `pending/` and `merge.yaml` is stored as base64, whatever its encoding, and read back
 * through `canonicalTreeFile`, which gives valid UTF-8 back as text. (`base/` holds raw bytes.)
 */
function storedTreeFile(file: TreeFile): TreeFile {
  return { encoding: 'base64', content: treeFileBytes(file).toString('base64') };
}

function toStored(change: SyncChange): SyncChange {
  const { path, encoding, content } = change;
  return content === null ? change : { path, ...storedTreeFile({ encoding, content }) };
}

/** A change as a read gives it back: base64 of valid UTF-8 becomes text. */
function canonicalChange(change: SyncChange): SyncChange {
  return change.content === null
    ? change
    : { path: change.path, ...canonicalTreeFile(change.encoding, change.content) };
}

function mapRecord(
  record: Readonly<Record<string, TreeFile>>,
  map: (file: TreeFile) => TreeFile,
): Record<string, TreeFile> {
  return Object.fromEntries(Object.entries(record).map(([path, file]) => [path, map(file)]));
}

/** The file operations `ServerState` lets a test replace. */
export interface ServerStateIo {
  readonly rename: (from: string, to: string) => Promise<void>;
}

const advanceSchema = z.object({ head: syncCommitIdSchema, clearPending: z.boolean() });

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function corrupt(file: string, cause?: unknown): WirebenchError {
  return new WirebenchError(
    'sync-state-corrupt',
    `This workspace's sync state is damaged (${file}). Remove this copy, then open it again with Open a team workspace….`,
    { details: { file }, ...(cause !== undefined ? { cause } : {}) },
  );
}

/** A YAML file checked against `schema`; `undefined` when absent; `sync-state-corrupt` when unreadable or invalid. */
async function readYaml<T>(path: string, schema: z.ZodType<T>, file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw corrupt(file, error);
  }
  const parsed = schema.safeParse(document);
  if (!parsed.success) throw corrupt(file, parsed.error);
  return parsed.data;
}

/** No line folding (`lineWidth: 0`), so a long base64 line stays one line; `yaml` quotes whatever needs it. */
async function writeYaml(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(nodeFs, path, stringifyYaml(value, { lineWidth: 0 }));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function pendingNumber(name: string): number {
  return Number(PENDING_NAME.exec(name)?.[1] ?? '0');
}

function toDoc(parsed: z.infer<typeof stateDocSchema>): ServerStateDoc {
  return {
    version: STATE_VERSION,
    base: { head: parsed.base.head },
    ...(parsed.knownHead !== undefined ? { knownHead: parsed.knownHead } : {}),
    ...(parsed.behind !== undefined ? { behind: parsed.behind } : {}),
    ...(parsed.role !== undefined ? { role: parsed.role } : {}),
    ...(parsed.identity !== undefined
      ? { identity: { name: parsed.identity.name, email: parsed.identity.email } }
      : {}),
    ...(parsed.lastSyncAt !== undefined ? { lastSyncAt: parsed.lastSyncAt } : {}),
  };
}

export class ServerState {
  /** The roll-forward of an interrupted `advanceBase`, run once per instance before its first use. */
  private recovery: Promise<void> | undefined;

  /**
   * `dir` is `<workspaceDir>/server` ({@link SERVER_STATE_DIR}). `io.rename` is the folder swap of
   * `advanceBase`; tests replace it to make the swap fail the way Windows can (EPERM).
   */
  constructor(
    private readonly dir: string,
    private readonly io: ServerStateIo = { rename },
  ) {}

  /**
   * Writes a fresh state: `base/` holds `files` (the tree at `head`), with no pending commits and no
   * merge. Replaces whatever was in `dir`. `state.yaml` is written last, so an interrupted
   * initialisation reads as corrupt rather than as an empty base.
   */
  static async initialize(dir: string, head: string | null, files: TreeFiles): Promise<ServerState> {
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, BASE_DIR), { recursive: true });
    await writeTreeFiles(join(dir, BASE_DIR), files);
    const state = new ServerState(dir);
    await state.writeDoc({ version: STATE_VERSION, base: { head } });
    return state;
  }

  /** @throws WirebenchError 'sync-state-corrupt' */
  async read(): Promise<ServerStateDoc> {
    await this.recover();
    return this.readDoc();
  }

  async update(patch: Partial<Omit<ServerStateDoc, 'version'>>): Promise<ServerStateDoc> {
    const next: ServerStateDoc = { ...(await this.read()), ...patch };
    await this.writeDoc(next);
    return next;
  }

  /** @throws WirebenchError 'sync-state-corrupt' when `base/` is missing, which must never read as an empty base. */
  async baseFiles(): Promise<Map<string, TreeFile>> {
    await this.recover();
    const base = join(this.dir, BASE_DIR);
    if (!(await exists(base))) throw corrupt(BASE_DIR);
    return readTreeFiles(base);
  }

  async pending(): Promise<PendingCommitRecord[]> {
    await this.recover();
    const records: PendingCommitRecord[] = [];
    for (const name of await this.pendingNames()) {
      const file = `${PENDING_DIR}/${name}`;
      const record = await readYaml(join(this.dir, PENDING_DIR, name), pendingSchema, file);
      if (record === undefined) throw corrupt(file);
      records.push({
        id: record.id,
        subject: record.subject,
        at: record.at,
        changes: record.changes.map(canonicalChange),
      });
    }
    return records;
  }

  async appendPending(commit: Omit<PendingCommitRecord, 'id'>): Promise<PendingCommitRecord> {
    await this.recover();
    for (const change of commit.changes) assertTreePath(change.path);
    const last = (await this.pendingNames()).at(-1);
    const number = last === undefined ? 1 : pendingNumber(last) + 1;
    const record: PendingCommitRecord = {
      id: generateId(),
      subject: commit.subject,
      at: commit.at,
      changes: commit.changes.map(canonicalChange),
    };
    await writeYaml(join(this.dir, PENDING_DIR, `${String(number).padStart(4, '0')}.yaml`), {
      ...record,
      changes: record.changes.map(toStored),
    });
    return record;
  }

  /** Base with every pending commit applied in order: the last committed snapshot. */
  async committedFiles(): Promise<Map<string, TreeFile>> {
    let files = await this.baseFiles();
    for (const commit of await this.pending()) files = applyChanges(files, commit.changes);
    return files;
  }

  /**
   * Replaces `base/` with `files` at `head`, sets `knownHead` to `head` and `behind` to 0 (the
   * client stands on `head`, so it knows at least that far), and with `clearPending` drops
   * `pending/` (after a push). Journaled: once `advance.yaml` is written the advance completes, now
   * or on the next use after a crash.
   */
  async advanceBase(head: string, files: TreeFiles, options: { readonly clearPending: boolean }): Promise<void> {
    await this.recover();
    const next = join(this.dir, BASE_NEXT_DIR);
    await rm(next, { recursive: true, force: true });
    await mkdir(next, { recursive: true });
    await writeTreeFiles(next, files);
    await writeYaml(join(this.dir, ADVANCE_FILE), { head, clearPending: options.clearPending });
    try {
      await this.applyAdvance();
    } catch (error) {
      // The journal is committed: the next use must roll it forward rather than trust a stale recovery.
      this.recovery = undefined;
      throw error;
    }
  }

  async readMerge(): Promise<MergeRecord | undefined> {
    await this.recover();
    const stored = await readYaml(join(this.dir, MERGE_FILE), mergeSchema, MERGE_FILE);
    if (stored === undefined) return undefined;
    return {
      conflicts: stored.conflicts,
      mine: mapRecord(stored.mine, (file) => canonicalTreeFile(file.encoding, file.content)),
      theirs: mapRecord(stored.theirs, (file) => canonicalTreeFile(file.encoding, file.content)),
      preMerge: mapRecord(stored.preMerge, (file) => canonicalTreeFile(file.encoding, file.content)),
      mergePaths: stored.mergePaths,
    };
  }

  async writeMerge(record: MergeRecord): Promise<void> {
    await this.recover();
    for (const path of [...record.conflicts, ...record.mergePaths]) assertTreePath(path);
    await writeYaml(join(this.dir, MERGE_FILE), {
      conflicts: record.conflicts,
      mine: mapRecord(record.mine, storedTreeFile),
      theirs: mapRecord(record.theirs, storedTreeFile),
      preMerge: mapRecord(record.preMerge, storedTreeFile),
      mergePaths: record.mergePaths,
    });
  }

  async clearMerge(): Promise<void> {
    await this.recover();
    await rm(join(this.dir, MERGE_FILE), { force: true });
  }

  private recover(): Promise<void> {
    this.recovery ??= this.applyAdvance().catch((error: unknown) => {
      this.recovery = undefined;
      throw error;
    });
    return this.recovery;
  }

  /**
   * Applies a committed `advance.yaml`, or discards a `base.next/` that has no journal (the crash
   * came while it was still being written). Every step is idempotent, so this also finishes an
   * advance a crash interrupted part-way.
   */
  private async applyAdvance(): Promise<void> {
    const journal = await readYaml(join(this.dir, ADVANCE_FILE), advanceSchema, ADVANCE_FILE);
    const next = join(this.dir, BASE_NEXT_DIR);
    if (journal === undefined) {
      await rm(next, { recursive: true, force: true });
      return;
    }
    if (await exists(next)) {
      await rm(join(this.dir, BASE_DIR), { recursive: true, force: true });
      await this.io.rename(next, join(this.dir, BASE_DIR));
    }
    if (journal.clearPending) await rm(join(this.dir, PENDING_DIR), { recursive: true, force: true });
    const doc = await this.readDoc();
    await this.writeDoc({ ...doc, base: { head: journal.head }, knownHead: journal.head, behind: 0 });
    await rm(join(this.dir, ADVANCE_FILE), { force: true });
  }

  private async readDoc(): Promise<ServerStateDoc> {
    const parsed = await readYaml(join(this.dir, STATE_FILE), stateDocSchema, STATE_FILE);
    if (parsed === undefined) throw corrupt(STATE_FILE);
    return toDoc(parsed);
  }

  private async writeDoc(doc: ServerStateDoc): Promise<void> {
    await writeYaml(join(this.dir, STATE_FILE), doc);
  }

  private async pendingNames(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(join(this.dir, PENDING_DIR));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return names.filter((name) => PENDING_NAME.test(name)).sort((a, b) => pendingNumber(a) - pendingNumber(b));
  }
}

// ——— tree files ——————————————————————————————————————————————————————————————————————————

/** Bytes as the wire carries them: UTF-8 text when the bytes are valid UTF-8, base64 otherwise (§3.3). */
export function treeFileFromBytes(bytes: Buffer): TreeFile {
  return isUtf8(bytes)
    ? { encoding: 'utf8', content: bytes.toString('utf8') }
    : { encoding: 'base64', content: bytes.toString('base64') };
}

/** A wire file's bytes. `Buffer#toString('utf8')` kept any BOM, so text round-trips exactly. */
export function treeFileBytes(file: TreeFile): Buffer {
  return Buffer.from(file.content, file.encoding);
}

/** Same encoding and content; two absent files are the same. */
export function sameTreeFile(a: TreeFile | undefined, b: TreeFile | undefined): boolean {
  return a?.encoding === b?.encoding && a?.content === b?.content;
}

/** A wire file as a read would give it: base64 whose bytes are valid UTF-8 becomes text. */
function canonicalTreeFile(encoding: SyncEncoding, content: string): TreeFile {
  return encoding === 'utf8' ? { encoding, content } : treeFileFromBytes(Buffer.from(content, 'base64'));
}

/**
 * Reads every file under the TREE_ITEMS of `tree` (skipping `.git`, anything not a tree item, and
 * machine-local paths); UTF-8 validity decides the encoding. Keys are forward-slash tree paths,
 * joined by hand rather than with `node:path`, so they are the same on Windows. A symbolic link or
 * anything else that is neither a file nor a folder is not part of a tree and is skipped.
 */
export async function readTreeFiles(tree: string): Promise<Map<string, TreeFile>> {
  const files = new Map<string, TreeFile>();
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(join(tree, ...folder.split('/')), { withFileTypes: true })) {
      const path = `${folder}/${entry.name}`;
      if (!isTreePath(path)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.set(path, treeFileFromBytes(await readFile(join(tree, ...path.split('/')))));
    }
  };
  for (const item of TREE_ITEMS) {
    let info: Stats;
    try {
      info = await lstat(join(tree, item));
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (info.isDirectory()) await walk(item);
    else if (info.isFile() && isTreePath(item)) files.set(item, treeFileFromBytes(await readFile(join(tree, item))));
  }
  return files;
}

/**
 * Writes (content) or removes (null) each path under `tree`, atomically per file. Every path passes
 * `assertTreePath` before anything is written, so a refused one leaves the tree untouched. A
 * deletion also removes the folders it emptied, as git does, down to but not including the tree
 * item itself.
 *
 * @throws WirebenchError 'sync-path-refused'
 */
export async function writeTreeFiles(tree: string, files: ReadonlyMap<string, TreeFile | null>): Promise<void> {
  const entries = [...files].map(([path, file]) => [assertTreePath(path), file] as const);
  for (const [path, file] of entries) {
    const target = join(tree, ...path.split('/'));
    if (file === null) {
      await rm(target, { force: true });
      await pruneEmptyFolders(tree, path);
    } else {
      await writeFileAtomic(nodeFs, target, treeFileBytes(file));
    }
  }
}

/** `projects/p/attachments/a.bin` removed: tries `projects/p/attachments`, then `projects/p`; never `projects`. */
async function pruneEmptyFolders(tree: string, path: string): Promise<void> {
  const segments = path.split('/');
  for (let length = segments.length - 1; length >= 2; length -= 1) {
    try {
      await rmdir(join(tree, ...segments.slice(0, length)));
    } catch {
      return; // not empty, already gone: nothing further up can be empty because of this deletion
    }
  }
}

/** Path-wise difference `after` vs `before` as wire changes (null content = deleted), sorted by path. */
export function diffTreeFiles(before: TreeFiles, after: TreeFiles): SyncChange[] {
  const changes: SyncChange[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const next = after.get(path);
    if (sameTreeFile(before.get(path), next)) continue;
    changes.push(
      next === undefined
        ? { path, encoding: 'utf8', content: null }
        : { path, encoding: next.encoding, content: next.content },
    );
  }
  return changes;
}

/**
 * Applies wire changes to a copy of `files`. Each path passes `assertTreePath` (§6: validated on the
 * client too), and content is canonicalised, so equal bytes compare equal whatever encoding the
 * sender chose.
 *
 * @throws WirebenchError 'sync-path-refused'
 */
export function applyChanges(files: TreeFiles, changes: readonly SyncChange[]): Map<string, TreeFile> {
  const next = new Map(files);
  for (const change of changes) {
    const path = assertTreePath(change.path);
    if (change.content === null) next.delete(path);
    else next.set(path, canonicalTreeFile(change.encoding, change.content));
  }
  return next;
}
