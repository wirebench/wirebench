/**
 * The server's commit store (spec §3.3). A push becomes ordinary git commits on `refs/heads/main` of
 * the workspace's bare repository, and a read comes straight from git objects. There is no worktree
 * and no server-side merge (ADR-0012).
 *
 * - A push builds its trees in a private index file (`GIT_INDEX_FILE` under `<dataDir>/tmp/`),
 *   removed in a `finally`. No two pushes share an index, and a crash leaves only a file the module
 *   sweeps at start-up ({@link sweepIndexFiles}).
 * - Every git call goes through the plumbing-enabled `GitCli`, so the subcommand allow-list and the
 *   hooks guard (`-c core.hooksPath=`) apply to each one (§6).
 * - Every commit id is matched against `SYNC_COMMIT_ID_PATTERN` before it becomes an argument, and
 *   every pushed path and content is checked before the first git call (§3.2).
 */
import { isUtf8 } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  assertTreePath,
  MAX_SYNC_FILE_BYTES,
  MAX_SYNC_LOG_LIMIT,
  SYNC_COMMIT_ID_PATTERN,
  WirebenchError,
  type GitCallEnv,
  type GitCli,
  type GitPlumbingSubcommand,
  type GitSubcommand,
  type SyncChange,
  type SyncChangesResponse,
  type SyncFile,
  type SyncLogEntry,
  type SyncPushCommit,
  type SyncPushResponse,
  type SyncSnapshotResponse,
} from '@wirebench/engine';
import { problem } from '../problem.js';
import type { RepoStore } from '../repos/repo-store.js';
import {
  syncContentInvalid,
  syncNotAncestor,
  syncPathRefused,
  syncPushRejected,
  syncTooLarge,
  syncUnknownCommit,
} from './errors.js';

/** Every git subcommand this store runs, each a named constant (shared-workspaces §10). */
const GIT = {
  revParse: 'rev-parse',
  revList: 'rev-list',
  log: 'log',
  lsTree: 'ls-tree',
  catFile: 'cat-file',
  mergeBase: 'merge-base',
  diffTree: 'diff-tree',
  readTree: 'read-tree',
  hashObject: 'hash-object',
  updateIndex: 'update-index',
  writeTree: 'write-tree',
  commitTree: 'commit-tree',
  updateRef: 'update-ref',
} as const satisfies Readonly<Record<string, GitSubcommand | GitPlumbingSubcommand>>;

/** One linear history per workspace (spec assumption 2). */
const MAIN = 'refs/heads/main';
const FILE_MODE = '100644';
/** A submodule entry: never written by a push, skipped if a tree ever holds one. */
const GITLINK_MODE = '160000';
const MIB = 1024 * 1024;
/** What `cat-file --batch` adds around each blob (`"<id> blob <size>\n"` … `"\n"`), with room to spare. */
const BATCH_FRAMING_BYTES = 160;
/** Id, subject, `name <email>`, strict ISO author date; with `-z`, each commit also ends with a NUL. */
const LOG_FORMAT = '%H%x00%s%x00%an <%ae>%x00%aI';
/** A lone UTF-16 surrogate: a JSON string can carry one, and UTF-8 encoding would quietly replace it. */
const LONE_SURROGATE = /\p{Cs}/u;
/** A private index file, or the lock git holds beside it while writing. */
const INDEX_FILE = /\.idx(?:\.lock)?$/;

export interface CommitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface CommitStoreDeps {
  /** Plumbing-enabled: `ctx.git.withPlumbing()`. */
  readonly git: GitCli;
  /** For `path(id)` only; the caller holds `withLock` for a push. */
  readonly repos: RepoStore;
  /**
   * `<dataDir>/tmp`, where private index files live. Absolute: git resolves `GIT_INDEX_FILE` against
   * the repository it runs in, Node's `rm` against the process's cwd, so a relative path names two places.
   */
  readonly tmpDir: string;
  /** `bodyLimitMb` in bytes: the most blob content one snapshot or changes answer may carry (R5). */
  readonly limitBytes: number;
}

interface TreeEntry {
  readonly path: string;
  readonly id: string;
}

/** One changed path between two commits; `id` is the new blob, or `null` when the file was deleted. */
interface DiffEntry {
  readonly path: string;
  readonly id: string | null;
}

/** A pushed change after validation: its checked path and decoded bytes (`null` = delete). */
interface StagedChange {
  readonly path: string;
  readonly bytes: Buffer | null;
}

interface StagedCommit {
  readonly subject: string;
  readonly date: string;
  readonly changes: readonly StagedChange[];
}

/** The exit code of a git run that ran and failed; `undefined` for anything else (spawn failure, timeout). */
function exitCodeOf(error: unknown): number | undefined {
  if (!(error instanceof WirebenchError) || error.code !== 'git-failed') return undefined;
  const code = error.details?.exitCode;
  return typeof code === 'number' ? code : undefined;
}

/**
 * `update-ref` lost its compare-and-swap: main moved ("is at X but expected Y") or appeared
 * ("reference already exists") after the head check. Git words other failures to lock the ref the
 * same way ("cannot lock ref …: Unable to create '…/main.lock': File exists"), and those are not a
 * teammate's push: answered 409, the client would pull (a no-op) and push again forever, and the
 * server would log nothing. They stay git failures, which the server answers with a logged 500.
 */
function lostSwap(error: unknown): boolean {
  if (exitCodeOf(error) !== 128) return false;
  const stderr = (error as WirebenchError).details?.stderr;
  return (
    typeof stderr === 'string' &&
    /cannot lock ref/i.test(stderr) &&
    /but expected|reference already exists/i.test(stderr)
  );
}

/** §6: nothing that is not a full hex object id ever becomes a git argument, so none can be an option. */
function commitId(value: string): string {
  if (!SYNC_COMMIT_ID_PATTERN.test(value)) {
    throw problem('invalid-request', 'Commit ids are 40 or 64 lower-case hexadecimal characters.', 400);
  }
  return value;
}

/** The last instant of the year 9999: past it, a date no longer prints as a four-digit ISO year. */
const LATEST_COMMIT_MS = Date.UTC(9999, 11, 31, 23, 59, 59);

/**
 * An ISO 8601 time as git's raw date (`@<unix seconds> +0000`), which it stores exactly. The `@`
 * matters: without it git reads the number as a timestamp only between 1973 and 2099 and refuses
 * the rest. Git refuses a negative time, so a time before 1970 (or past the year 9999) is the
 * client's mistake, answered 400 here rather than a 500 from `commit-tree` half-way through a push.
 */
function gitDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0 || ms > LATEST_COMMIT_MS) {
    throw problem('invalid-request', 'Each commit needs a valid ISO 8601 time between 1970 and 9999.', 400);
  }
  return `@${Math.floor(ms / 1000)} +0000`;
}

function treePath(path: string): string {
  try {
    return assertTreePath(path);
  } catch {
    throw syncPathRefused(path);
  }
}

/** Strict decoding: base64 must re-encode to the same text, and UTF-8 must hold no lone surrogate. */
function decode(change: SyncChange & { readonly content: string }): Buffer | undefined {
  if (change.encoding === 'base64') {
    const bytes = Buffer.from(change.content, 'base64');
    return bytes.toString('base64') === change.content ? bytes : undefined;
  }
  return LONE_SURROGATE.test(change.content) ? undefined : Buffer.from(change.content, 'utf8');
}

function stage(change: SyncChange): StagedChange {
  const path = treePath(change.path);
  if (change.content === null) return { path, bytes: null };
  const bytes = decode({ ...change, content: change.content });
  if (bytes === undefined || bytes.length > MAX_SYNC_FILE_BYTES) throw syncContentInvalid(path);
  return { path, bytes };
}

/** §3.3: UTF-8 validity decides the encoding on the way out, whatever the push used. */
function fileOf(path: string, bytes: Buffer): SyncFile {
  return isUtf8(bytes)
    ? { path, encoding: 'utf8', content: bytes.toString('utf8') }
    : { path, encoding: 'base64', content: bytes.toString('base64') };
}

const deleted = (path: string): SyncChange => ({ path, encoding: 'utf8', content: null });

/** Git's `-z` output as its fields, without the empty string after the final NUL. */
function nulFields(stdout: string): string[] {
  const fields = stdout.split('\0');
  if (fields.at(-1) === '') fields.pop();
  return fields;
}

/** `ls-tree -r -z`: `"<mode> <type> <id>\t<path>"` per entry. Only blobs are workspace files. */
function parseTree(stdout: string): TreeEntry[] {
  return nulFields(stdout).flatMap((record) => {
    const tab = record.indexOf('\t');
    const [, type, id] = record.slice(0, tab).split(' ');
    return type === 'blob' && id !== undefined ? [{ path: record.slice(tab + 1), id }] : [];
  });
}

/** Raw `diff-tree -r -z`: `":<src mode> <dst mode> <src id> <dst id> <status>"`, then the path, per change. */
function parseRawDiff(stdout: string): DiffEntry[] {
  const fields = nulFields(stdout);
  const entries: DiffEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, dstMode, , dstId, status] = fields[i]!.slice(1).split(' ');
    const path = fields[i + 1]!;
    if (status === 'D') entries.push({ path, id: null });
    else if (dstMode !== GITLINK_MODE && dstId !== undefined) entries.push({ path, id: dstId });
  }
  return entries;
}

/** `cat-file --batch`: per object `"<id> <type> <size>\n"`, the raw bytes, then `"\n"`. */
function parseBatch(out: Buffer): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  let at = 0;
  while (at < out.length) {
    const eol = out.indexOf(0x0a, at);
    const [id, type, size] = out.toString('utf8', at, eol === -1 ? out.length : eol).split(' ');
    if (eol === -1 || id === undefined || type !== 'blob' || size === undefined) {
      throw new Error('cat-file --batch answered something other than a blob');
    }
    const start = eol + 1;
    const end = start + Number(size);
    blobs.set(id, out.subarray(start, end));
    at = end + 1;
  }
  return blobs;
}

function blobOf(blobs: ReadonlyMap<string, Buffer>, id: string): Buffer {
  const bytes = blobs.get(id);
  if (bytes === undefined) throw new Error(`blob ${id} was not read`);
  return bytes;
}

/** How old a ref lock must be before a push treats it as a crash's leftover. `update-ref` holds it for milliseconds. */
const STALE_REF_LOCK_MS = 60_000;

/**
 * Removes the ref's lock file when it is older than {@link STALE_REF_LOCK_MS}. The caller holds
 * `withLock`, so no push of this process owns it: an old one was left by a crash (a SIGKILL
 * mid-`update-ref`) and would fail every push to the workspace from then on. A fresh one may belong
 * to a live `update-ref` in a second instance, and removing it would break §6's no-lost-update
 * promise, so it stays and that push fails as a git error instead.
 */
async function clearStaleRefLock(lock: string): Promise<void> {
  const info = await stat(lock).catch(() => undefined);
  if (info !== undefined && Date.now() - info.mtimeMs > STALE_REF_LOCK_MS) await rm(lock, { force: true });
}

export class CommitStore {
  private readonly git: GitCli;
  private readonly repos: RepoStore;
  private readonly tmpDir: string;
  private readonly limitBytes: number;

  constructor(deps: CommitStoreDeps) {
    if (!isAbsolute(deps.tmpDir)) throw new Error(`CommitStore needs an absolute tmpDir, got "${deps.tmpDir}"`);
    this.git = deps.git;
    this.repos = deps.repos;
    this.tmpDir = deps.tmpDir;
    this.limitBytes = deps.limitBytes;
  }

  /** `refs/heads/main`, or `null` while the branch is unborn (an empty workspace, §2). */
  head(workspaceId: string): Promise<string | null> {
    return this.resolve(this.repos.path(workspaceId), MAIN);
  }

  /**
   * Total commits on main, and, when `from` is given, how many come after it (§3.2). An unknown
   * `from` counts the total, as the spec's head row says: the client's base is not on this server.
   * `at` is the head to count from, as {@link head} returned it (`null`: unborn), so a push landing
   * between the two reads cannot make the counts describe a newer head than the one answered.
   */
  async counts(
    workspaceId: string,
    from?: string,
    at?: string | null,
  ): Promise<{ readonly commits: number; readonly behind?: number }> {
    if (from !== undefined) commitId(from);
    if (typeof at === 'string') commitId(at);
    const dir = this.repos.path(workspaceId);
    const head = at === undefined ? await this.resolve(dir, MAIN) : at;
    if (head === null) return from === undefined ? { commits: 0 } : { commits: 0, behind: 0 };
    const commits = await this.count(dir, head);
    if (from === undefined) return { commits };
    const base = await this.resolve(dir, from);
    return { commits, behind: base === null ? commits : await this.count(dir, `${base}..${head}`) };
  }

  /** Every file at `at` (default: the head). @throws syncUnknownCommit, syncTooLarge */
  async snapshot(workspaceId: string, at?: string): Promise<SyncSnapshotResponse> {
    const dir = this.repos.path(workspaceId);
    const commit = at === undefined ? await this.resolve(dir, MAIN) : await this.known(dir, at);
    if (commit === null) return { head: null, files: [] };
    const entries = parseTree((await this.git.run(dir, [GIT.lsTree, '-r', '-z', commit])).stdout);
    const blobs = await this.readBlobs(
      dir,
      entries.map((entry) => entry.id),
    );
    return { head: commit, files: entries.map((entry) => fileOf(entry.path, blobOf(blobs, entry.id))) };
  }

  /**
   * Every path that differs between `from` and `to`, with `null` content for a deletion. `from`
   * undefined means the empty tree, so the answer is every file of `to`.
   * @throws syncUnknownCommit, syncNotAncestor, syncTooLarge
   */
  async changes(workspaceId: string, from: string | undefined, to: string): Promise<SyncChangesResponse> {
    commitId(to);
    if (from !== undefined) commitId(from);
    const dir = this.repos.path(workspaceId);
    await this.known(dir, to);
    if (from === undefined) {
      const entries = parseTree((await this.git.run(dir, [GIT.lsTree, '-r', '-z', to])).stdout);
      const blobs = await this.readBlobs(
        dir,
        entries.map((entry) => entry.id),
      );
      return { from: null, to, files: entries.map((entry) => fileOf(entry.path, blobOf(blobs, entry.id))) };
    }
    await this.known(dir, from);
    if (!(await this.isAncestor(dir, from, to))) throw syncNotAncestor();
    const diff = parseRawDiff((await this.git.run(dir, [GIT.diffTree, '-r', '-z', '--no-renames', from, to])).stdout);
    const blobs = await this.readBlobs(
      dir,
      diff.flatMap((entry) => (entry.id === null ? [] : [entry.id])),
    );
    return {
      from,
      to,
      files: diff.map((entry) =>
        entry.id === null ? deleted(entry.path) : fileOf(entry.path, blobOf(blobs, entry.id)),
      ),
    };
  }

  /**
   * Appends `commits` on top of `parent`, one git commit each, authored and committed by `author`.
   * The caller holds `RepoStore.withLock`; `update-ref`'s compare-and-swap is the second line of
   * defence (§3.3, §6). Every change is validated before the first git call.
   * @throws syncPushRejected when `parent` is not the head
   */
  async appendCommits(
    workspaceId: string,
    parent: string | null,
    commits: readonly SyncPushCommit[],
    author: CommitAuthor,
  ): Promise<SyncPushResponse> {
    if (parent !== null) commitId(parent);
    if (commits.length === 0) throw problem('invalid-request', 'A push needs at least one commit.', 400);
    const staged: StagedCommit[] = commits.map((commit) => ({
      subject: commit.subject,
      date: gitDate(commit.at),
      changes: commit.changes.map(stage),
    }));
    const dir = this.repos.path(workspaceId);
    await clearStaleRefLock(join(dir, ...MAIN.split('/')) + '.lock');
    if ((await this.resolve(dir, MAIN)) !== parent) throw syncPushRejected();

    const index = join(this.tmpDir, `${workspaceId}-${randomBytes(8).toString('hex')}.idx`);
    const withIndex: Partial<Record<GitCallEnv, string>> = { GIT_INDEX_FILE: index };
    // The committer is the caller too, dated by the server. Every identity variable is set on each
    // call, so a GIT_AUTHOR_* or GIT_COMMITTER_* in the process environment can never leak in.
    const committedAt = gitDate(new Date().toISOString());
    try {
      await this.git.run(dir, parent === null ? [GIT.readTree, '--empty'] : [GIT.readTree, parent], { env: withIndex });
      // A removal record names the zero id, as long as this repository's object ids.
      const idLength =
        parent?.length ?? (await this.git.run(dir, [GIT.hashObject, '--stdin'], { input: '' })).stdout.trim().length;
      const zero = '0'.repeat(idLength);
      const ids: string[] = [];
      let previous = parent;
      for (const commit of staged) {
        const records: string[] = [];
        for (const change of commit.changes) {
          if (change.bytes === null) {
            records.push(`0 ${zero}\t${change.path}\0`);
            continue;
          }
          const written = await this.git.run(dir, [GIT.hashObject, '-w', '--stdin'], { input: change.bytes });
          const blob = written.stdout.trim();
          records.push(`${FILE_MODE} ${blob}\t${change.path}\0`);
        }
        if (records.length > 0) {
          await this.git.run(dir, [GIT.updateIndex, '-z', '--index-info'], { input: records.join(''), env: withIndex });
        }
        const tree = (await this.git.run(dir, [GIT.writeTree], { env: withIndex })).stdout.trim();
        const parents = previous === null ? [] : ['-p', previous];
        const id = (
          await this.git.run(dir, [GIT.commitTree, tree, ...parents, '-m', commit.subject], {
            env: {
              GIT_AUTHOR_NAME: author.name,
              GIT_AUTHOR_EMAIL: author.email,
              GIT_AUTHOR_DATE: commit.date,
              GIT_COMMITTER_NAME: author.name,
              GIT_COMMITTER_EMAIL: author.email,
              GIT_COMMITTER_DATE: committedAt,
            },
          })
        ).stdout.trim();
        ids.push(id);
        previous = id;
      }
      const head = ids.at(-1)!;
      await this.moveMain(dir, head, parent);
      return { head, ids };
    } finally {
      await rm(index, { force: true });
      await rm(`${index}.lock`, { force: true });
    }
  }

  /** Newest first, at most `limit` (1 to MAX_SYNC_LOG_LIMIT) entries; `[]` for an empty workspace. */
  async log(workspaceId: string, limit: number): Promise<SyncLogEntry[]> {
    const dir = this.repos.path(workspaceId);
    const head = await this.resolve(dir, MAIN);
    if (head === null) return [];
    const count = Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_SYNC_LOG_LIMIT);
    const args = [GIT.log, '-z', `--format=${LOG_FORMAT}`, '-n', String(count), head, '--'];
    const { stdout } = await this.git.run(dir, args);
    const fields = nulFields(stdout);
    const entries: SyncLogEntry[] = [];
    for (let i = 0; i + 3 < fields.length; i += 4) {
      entries.push({
        id: fields[i]!,
        subject: fields[i + 1]!,
        author: fields[i + 2]!,
        at: new Date(fields[i + 3]!).toISOString(),
      });
    }
    return entries;
  }

  /** The commit `rev` names, or `null`: exit 1 covers an unborn branch, an unknown id and a non-commit. */
  private async resolve(dir: string, rev: string): Promise<string | null> {
    try {
      return (await this.git.run(dir, [GIT.revParse, '--verify', '--quiet', `${rev}^{commit}`])).stdout.trim();
    } catch (error) {
      if (exitCodeOf(error) === 1) return null;
      throw error;
    }
  }

  private async known(dir: string, id: string): Promise<string> {
    if ((await this.resolve(dir, commitId(id))) === null) throw syncUnknownCommit();
    return id;
  }

  private async count(dir: string, range: string): Promise<number> {
    return Number((await this.git.run(dir, [GIT.revList, '--count', range])).stdout.trim());
  }

  private async isAncestor(dir: string, from: string, to: string): Promise<boolean> {
    try {
      await this.git.run(dir, [GIT.mergeBase, '--is-ancestor', from, to]);
      return true;
    } catch (error) {
      if (exitCodeOf(error) === 1) return false;
      throw error;
    }
  }

  /** Sizes first (`--batch-check`), so an answer over the limit is refused before any blob is read. */
  private async readBlobs(dir: string, ids: readonly string[]): Promise<Map<string, Buffer>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const input = `${unique.join('\n')}\n`;
    const sizes = new Map<string, number>();
    for (const line of (await this.git.run(dir, [GIT.catFile, '--batch-check'], { input })).stdout.split('\n')) {
      if (line === '') continue;
      const [id, type, size] = line.split(' ');
      if (id === undefined || type !== 'blob' || size === undefined) {
        throw new Error('cat-file --batch-check answered something other than a blob');
      }
      sizes.set(id, Number(size));
    }
    const total = ids.reduce((sum, id) => sum + (sizes.get(id) ?? 0), 0); // repeats count: the answer repeats them
    if (total > this.limitBytes) throw syncTooLarge(this.limitBytes / MIB);
    const content = [...sizes.values()].reduce((sum, size) => sum + size, 0);
    const { stdout } = await this.git.run(dir, [GIT.catFile, '--batch'], {
      input,
      stdout: 'buffer',
      maxBuffer: content + unique.length * BATCH_FRAMING_BYTES,
    });
    return parseBatch(stdout);
  }

  /** The compare-and-swap (§3.3): main moves only if it still holds `expected` (`""` = must not exist yet). */
  private async moveMain(dir: string, next: string, expected: string | null): Promise<void> {
    try {
      await this.git.run(dir, [GIT.updateRef, MAIN, next, expected ?? '']);
    } catch (error) {
      if (lostSwap(error)) throw syncPushRejected();
      throw error;
    }
  }
}

/**
 * Removes the private index files (and their git locks) a crash left in `tmpDir`. The sync module
 * calls it once at start-up, before any push can own one. Directories (a moved-away repository) and
 * other files are left alone.
 */
export async function sweepIndexFiles(tmpDir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(tmpDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && INDEX_FILE.test(entry.name)) await rm(join(tmpDir, entry.name), { force: true });
  }
}
