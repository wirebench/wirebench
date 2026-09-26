/**
 * The `SyncBackend` for a workspace shared through Wirebench Server (server-sync spec §3.1). There
 * is no git on the client (§12). The tree is plain files, and `ServerState` keeps the base snapshot
 * and the pending commits under `<workspace>/server/`. The three-way merge is the engine's
 * `mergeFiles`, run here, so a pull never publishes local commits. Every call to the server goes
 * through `ServerClient` with the account's token (`withToken`), and {@link mapServerError} (§3.5)
 * turns its failures into the codes `SyncService` knows.
 *
 * The semantics are `FakeServerBackend`'s, operation by operation, and the contract suite holds this
 * backend to them (O4).
 *
 * The tree is only written inside a `SyncService` operation, which reports `syncing` first, so
 * `WorkspaceService.onSyncStatus` holds outside-edit delivery (`HeldChanges`) meanwhile. The
 * `changedPaths` returned from `merge` and `finishMerge` go through `applyPulled`, which announces
 * them to the watchers (the self-write TTL) and forgets the events the writes caused. Writes from
 * `abortMerge` and `resolve` are replayed as outside edits once the hold ends. The git backend's
 * `git merge` relies on exactly this, so there is nothing to call here, but every path written must
 * be in `changedPaths`.
 *
 * Electron-free: the server package's contract run imports this file (O4).
 */
import type { SyncEncoding, SyncLogEntry, SyncPushResponse, TreeChange } from '@wirebench/engine';
import {
  describeTreePath,
  isWirebenchError,
  MAX_SYNC_LOG_LIMIT,
  MAX_SYNC_SUBJECT_LENGTH,
  mergeFiles,
  WirebenchError,
} from '@wirebench/engine';
import type { LiveClients } from '../live/live-clients.js';
import type { ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';
import type { RemoteEvent, SyncBackend } from './backend.js';
import {
  applyChanges,
  RECONNECT_GUIDANCE,
  diffTreeFiles,
  readTreeFiles,
  sameTreeFile,
  writeTreeFiles,
  type PendingCommitRecord,
  type ServerState,
  type ServerStateDoc,
  type TreeFile,
  type TreeFiles,
} from './server-state.js';
import type { SyncConflictWire, SyncLogEntryWire, SyncState, SyncStatusWire } from './types.js';

export interface ServerBackendDeps {
  readonly client: Pick<ServerClient, 'syncHead' | 'syncChanges' | 'pushCommits' | 'syncLog'>;
  readonly accounts: TokenSource;
  /** The share's server origin (`share.yaml`'s `server.url`, stored normalised). */
  readonly url: string;
  readonly workspaceId: string;
  /** `<workspaceDir>/tree`. */
  readonly tree: string;
  readonly state: ServerState;
  readonly now?: () => Date;
  /** The signed-in account's name and email: the identity until one is set (§3.1). */
  readonly defaultIdentity?: () => { readonly name: string; readonly email: string } | undefined;
  /** The most one push request carries before it is split; a test lowers it. Default {@link PUSH_BATCH_BYTES}. */
  readonly pushBatchBytes?: number;
  /**
   * The app's live sockets (live-updates §3.4). Omitted, `subscribeRemote` announces nothing and
   * the fetch timer does all the work, as in the first slice. The contract suite runs that way.
   */
  readonly live?: Pick<LiveClients, 'subscribe'>;
}

/**
 * One push request's size before the pending commits are split over several (I5). The server's
 * `bodyLimitMb` is 32 MiB by default and at least 1; a server with a lower limit answers `413`, and
 * the batch is halved until it fits or holds a single commit.
 */
export const PUSH_BATCH_BYTES = 8 * 1024 * 1024;

/** A server workspace has one branch (assumption 2); shown where the git backend shows its branch. */
const BRANCH = 'main';
const MERGE_SUBJECT = 'Merge';
/** What the server's commit route refuses in a subject. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const FALLBACK_SUBJECT = 'Update workspace';

/** §3.4: the fetch timer does not re-arm after these; `SyncService.resume()` restarts it. */
export const STOP_POLLING_CODES: ReadonlySet<string> = new Set([
  'sync-signed-out',
  'sync-account-disabled',
  'sync-access-removed',
]);

const HISTORY_MISMATCH_MESSAGE = `This copy's history no longer matches the server's. ${RECONNECT_GUIDANCE}`;

/** A pending commit as one push request carries it. */
function wireCommit({ subject, at, changes }: PendingCommitRecord): {
  subject: string;
  at: string;
  changes: PendingCommitRecord['changes'][number][];
} {
  return { subject, at, changes: [...changes] };
}

/** Its share of a push body, in bytes. */
function wireSize(commit: PendingCommitRecord): number {
  return Buffer.byteLength(JSON.stringify(wireCommit(commit)));
}

/** The commits from `start` that fit in `budget` bytes; always at least one. */
function takeBatch(pending: readonly PendingCommitRecord[], start: number, budget: number): PendingCommitRecord[] {
  const batch: PendingCommitRecord[] = [];
  let size = 0;
  for (let index = start; index < pending.length; index += 1) {
    const commit = pending[index]!;
    const next = size + wireSize(commit);
    if (batch.length > 0 && next > budget) break;
    batch.push(commit);
    size = next;
  }
  return batch;
}

/**
 * §3.5's table: maps any error from a `ServerClient` call (or `withToken`) to the backend's code.
 * The original error is kept as the `cause`, with its `details` (the HTTP status). Codes the table
 * keeps (`sync-push-rejected`, `invalid-request`, `sync-path-refused`) pass through unchanged, and
 * so does any other code below 500. Any other 5xx (`server-shutting-down` during a restart, too) is
 * the server not answering properly: *offline*, with the back-off, rather than a red error.
 */
export function mapServerError(error: unknown): WirebenchError {
  if (!isWirebenchError(error)) {
    return new WirebenchError('sync-failed', error instanceof Error ? error.message : String(error), { cause: error });
  }
  const mapped = (code: string, message: string): WirebenchError =>
    new WirebenchError(code, message, {
      cause: error,
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
  const status = error.details?.['status'];
  switch (error.code) {
    case 'server-unreachable':
    case 'internal':
      return mapped('sync-offline', 'Wirebench Server cannot be reached. Changes stay on this machine until it can.');
    case 'server-bad-response':
      return typeof status === 'number' && status >= 500
        ? mapped(
            'sync-offline',
            'Wirebench Server is not answering properly. Changes stay on this machine until it does.',
          )
        : error;
    case 'account-signed-out':
    case 'identity-unauthenticated':
      return mapped('sync-signed-out', 'Sign in to Wirebench Server to sync this workspace.');
    case 'identity-user-disabled':
      return mapped('sync-account-disabled', 'Your account on this Wirebench Server is disabled.');
    case 'teams-workspace-not-found':
      return mapped('sync-access-removed', 'You no longer have access; the files stay on this machine.');
    case 'teams-forbidden':
      return mapped('sync-forbidden', 'You have viewer access in this workspace; changes stay on this machine.');
    case 'request-too-large':
      return mapped(
        'sync-too-large',
        "These changes are larger than the server accepts (its bodyLimitMb setting). Ask the server's admin to raise it.",
      );
    case 'sync-too-large':
      return mapped('sync-too-large', error.message);
    case 'sync-not-ancestor':
    case 'sync-unknown-commit':
      return mapped('sync-history-mismatch', HISTORY_MISMATCH_MESSAGE);
    default:
      return typeof status === 'number' && status >= 500
        ? mapped(
            'sync-offline',
            'Wirebench Server is not answering properly. Changes stay on this machine until it does.',
          )
        : error;
  }
}

/** `mergeFiles` compares strings; the encoding travels with the content, so text and base64 never compare equal. */
function toText(files: TreeFiles): Map<string, string> {
  return new Map([...files].map(([path, file]) => [path, `${file.encoding}:${file.content}`]));
}

function fromText(files: ReadonlyMap<string, string>): Map<string, TreeFile> {
  const out = new Map<string, TreeFile>();
  for (const [path, value] of files) {
    const colon = value.indexOf(':');
    const encoding: SyncEncoding = value.slice(0, colon) === 'base64' ? 'base64' : 'utf8';
    out.set(path, { encoding, content: value.slice(colon + 1) });
  }
  return out;
}

/** Every path whose file differs, sorted, mapped to its `after` side (`null`: deleted). */
function changesBetween(before: TreeFiles, after: TreeFiles): Map<string, TreeFile | null> {
  const changed = new Map<string, TreeFile | null>();
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const next = after.get(path);
    if (!sameTreeFile(before.get(path), next)) changed.set(path, next ?? null);
  }
  return changed;
}

function pick(files: TreeFiles, paths: readonly string[]): Record<string, TreeFile> {
  const out: Record<string, TreeFile> = {};
  for (const path of paths) {
    const file = files.get(path);
    if (file !== undefined) out[path] = file;
  }
  return out;
}

function describeConflict(path: string): SyncConflictWire {
  const entity = describeTreePath(path);
  return { path, entity: { kind: entity.kind, name: entity.name } };
}

/**
 * The first non-blank line, cut to what the push accepts. The server refuses a subject with any C0
 * control or DEL (a `\r` left by a CRLF line end, a tab), so those become spaces here; otherwise the
 * push would be refused for good, since the pending commit keeps its subject.
 */
function subjectOf(message: string): string {
  const line = message
    .split(/\r\n|\r|\n/)
    .map((candidate) => candidate.replace(CONTROL_CHARACTERS, ' ').trim())
    .find((candidate) => candidate.length > 0);
  return (line ?? FALLBACK_SUBJECT).slice(0, MAX_SYNC_SUBJECT_LENGTH).trimEnd();
}

function uncommittedChanges(): WirebenchError {
  return new WirebenchError('sync-uncommitted', 'Commit or discard your local changes before pulling.');
}

function conflictOpen(): WirebenchError {
  return new WirebenchError('sync-conflict', 'Resolve the merge conflicts before pulling again.');
}

/** The server's history from a base head backwards, as far as it was fetched. */
interface LogCache {
  readonly base: string;
  readonly entries: readonly SyncLogEntry[];
  /** The server returned fewer entries than asked for: this is the whole history. */
  readonly complete: boolean;
}

export class ServerBackend implements SyncBackend {
  readonly kind = 'server' as const;
  private readonly deps: ServerBackendDeps;
  private readonly state: ServerState;
  private readonly now: () => Date;
  private readonly pushBatchBytes: number;
  /** The server's history from a base backwards. It never changes, so keyed by the base it never goes stale. */
  private logCache: LogCache | undefined;

  constructor(deps: ServerBackendDeps) {
    this.deps = deps;
    this.state = deps.state;
    this.now = deps.now ?? (() => new Date());
    this.pushBatchBytes = deps.pushBatchBytes ?? PUSH_BATCH_BYTES;
  }

  async probe(): Promise<SyncStatusWire> {
    try {
      return await this.status();
    } catch (error) {
      // §4.2: a damaged state is a status, as the git backend reports "not a repository".
      if (isWirebenchError(error) && error.code === 'sync-state-corrupt') {
        return {
          ...this.where(),
          state: 'error',
          ahead: 0,
          behind: 0,
          uncommitted: 0,
          error: { code: error.code, message: error.message },
        };
      }
      throw error;
    }
  }

  async fetch(): Promise<SyncStatusWire> {
    const doc = await this.state.read();
    const answer = await this.call((url, token) =>
      this.deps.client.syncHead(url, token, this.deps.workspaceId, doc.base.head),
    );
    if (answer.head === null && doc.base.head !== null) {
      throw new WirebenchError('sync-history-mismatch', HISTORY_MISMATCH_MESSAGE);
    }
    // While a merge is open, finishMerge advances the base to the head the merge was computed
    // against (its record holds that tree); moving knownHead now would name a newer head than those files.
    const merging = (await this.state.readMerge()) !== undefined;
    await this.state.update({
      role: answer.role,
      lastSyncAt: this.now().toISOString(),
      ...(merging
        ? {}
        : {
            knownHead: answer.head,
            behind: answer.head === doc.base.head ? 0 : (answer.behind ?? answer.commits),
          }),
    });
    return this.probe();
  }

  async merge(): Promise<{ conflicts: SyncConflictWire[]; changedPaths: string[] }> {
    const open = await this.state.readMerge();
    if (open !== undefined) {
      if (open.conflicts.length > 0) throw conflictOpen();
      // Resolved, but interrupted before it was finished: finish it before merging again.
      await this.finishMerge();
    }
    const doc = await this.state.read();
    const known = doc.knownHead;
    if (known === undefined || known === null || known === doc.base.head) return { conflicts: [], changedPaths: [] };
    const committed = await this.state.committedFiles();
    const uncommitted = async (): Promise<boolean> =>
      changesBetween(committed, await readTreeFiles(this.deps.tree)).size > 0;
    if (await uncommitted()) throw uncommittedChanges();
    const answer = await this.call((url, token) =>
      this.deps.client.syncChanges(url, token, this.deps.workspaceId, doc.base.head, known),
    );
    // Saves are not held while the download runs (up to SYNC_TRANSFER_TIMEOUT_MS): one made
    // meanwhile would be overwritten below by a merge computed without it (I2). Nothing has
    // changed yet, so the state stays as it was and the next save pulls again.
    if (await uncommitted()) throw uncommittedChanges();
    const base = await this.state.baseFiles();
    const theirs = applyChanges(base, answer.files);
    const result = mergeFiles(toText(base), toText(theirs), toText(committed), { modifyDelete: 'conflict' });
    const merged = fromText(result.files);
    const written = changesBetween(committed, merged);
    // The tree first: if the record were written first and the app stopped in between, finishMerge
    // would commit the pre-merge tree over theirs.
    await writeTreeFiles(this.deps.tree, written);

    if (result.conflicts.length > 0) {
      const conflicts = [...result.conflicts];
      const mergePaths = [...new Set([...written.keys(), ...conflicts])].sort();
      await this.state.writeMerge({
        conflicts,
        mine: pick(committed, conflicts),
        theirs: Object.fromEntries(theirs),
        preMerge: pick(committed, mergePaths),
        mergePaths,
      });
      return { conflicts: conflicts.map(describeConflict), changedPaths: [] };
    }

    const hadPending = (await this.state.pending()).length > 0;
    await this.state.advanceBase(known, theirs, { pushed: [] });
    if (hadPending) await this.recordMerge(merged);
    return { conflicts: [], changedPaths: [...written.keys()] };
  }

  async commit(message: string): Promise<{ committed: boolean }> {
    const changes = diffTreeFiles(await this.state.committedFiles(), await readTreeFiles(this.deps.tree));
    if (changes.length === 0) return { committed: false };
    await this.state.appendPending({ subject: subjectOf(message), at: this.now().toISOString(), changes });
    return { committed: true };
  }

  /**
   * Sends the pending commits as they stand now, oldest first, in as many requests as the server's
   * body limit needs (I5): each request stands on the head the previous one made, so the history
   * is kept commit for commit. After each request the base moves on by exactly the commits it
   * carried, and only their files leave `pending/`: a commit made meanwhile (another session after
   * a reopen, I1) stays pending and out of the base. A failure keeps what already landed.
   */
  async push(): Promise<SyncStatusWire> {
    const pending = await this.state.pending();
    if (pending.length === 0) return this.probe();
    let parent = (await this.state.read()).base.head;
    let base = await this.state.baseFiles();
    let budget = this.pushBatchBytes;
    for (let next = 0; next < pending.length;) {
      const batch = takeBatch(pending, next, budget);
      let result: SyncPushResponse;
      try {
        result = await this.call((url, token) =>
          this.deps.client.pushCommits(url, token, this.deps.workspaceId, { parent, commits: batch.map(wireCommit) }),
        );
      } catch (error) {
        if (isWirebenchError(error) && error.code === 'sync-too-large' && batch.length > 1) {
          // The server's limit is lower than the budget: halve the batch and keep going.
          budget = Math.floor(batch.reduce((sum, commit) => sum + wireSize(commit), 0) / 2);
          continue;
        }
        // The role changed since the last fetch (§3.1): refresh it so the badge and SyncService agree.
        if (isWirebenchError(error) && error.code === 'sync-forbidden') await this.state.update({ role: 'viewer' });
        throw error;
      }
      base = applyChanges(
        base,
        batch.flatMap((commit) => commit.changes),
      );
      await this.state.advanceBase(result.head, base, { pushed: batch.map((commit) => commit.id) });
      await this.state.update({ lastSyncAt: this.now().toISOString() });
      parent = result.head;
      next += batch.length;
    }
    return this.probe();
  }

  async conflicts(): Promise<SyncConflictWire[]> {
    return ((await this.state.readMerge())?.conflicts ?? []).map(describeConflict);
  }

  async resolve(path: string, side: 'mine' | 'theirs'): Promise<void> {
    const record = await this.state.readMerge();
    if (record === undefined || !record.conflicts.includes(path)) return;
    const kept = (side === 'mine' ? record.mine : record.theirs)[path];
    await writeTreeFiles(this.deps.tree, new Map([[path, kept ?? null]]));
    await this.state.writeMerge({ ...record, conflicts: record.conflicts.filter((candidate) => candidate !== path) });
  }

  async finishMerge(): Promise<{ changedPaths: string[] }> {
    const record = await this.state.readMerge();
    if (record === undefined) return { changedPaths: [] };
    if (record.conflicts.length > 0) {
      throw new WirebenchError('sync-conflict', 'Resolve every conflict before finishing the merge.');
    }
    const head = (await this.state.read()).knownHead;
    if (head === undefined || head === null) {
      throw new WirebenchError(
        'sync-state-corrupt',
        `This workspace's sync state is damaged (a merge with no known head). ${RECONNECT_GUIDANCE}`,
        { details: { file: 'state.yaml' } },
      );
    }
    const before = await this.state.committedFiles();
    const tree = await readTreeFiles(this.deps.tree);
    // Only what the merge wrote or left in conflict is committed; other edits stay uncommitted, as in git.
    const committed = new Map(before);
    for (const path of record.mergePaths) {
      const file = tree.get(path);
      if (file === undefined) committed.delete(path);
      else committed.set(path, file);
    }
    // Cleared first: an interruption after this leaves the resolution as uncommitted changes, which
    // the next commit takes, never a merge that SyncService could no longer finish.
    await this.state.clearMerge();
    await this.state.advanceBase(head, new Map(Object.entries(record.theirs)), { pushed: [] });
    await this.recordMerge(committed);
    return { changedPaths: [...changesBetween(before, committed).keys()] };
  }

  async abortMerge(): Promise<void> {
    const record = await this.state.readMerge();
    if (record === undefined) return;
    await writeTreeFiles(
      this.deps.tree,
      new Map(record.mergePaths.map((path) => [path, record.preMerge[path] ?? null] as const)),
    );
    await this.state.clearMerge();
  }

  async log(limit: number): Promise<SyncLogEntryWire[]> {
    const doc = await this.state.read();
    const identity = this.currentIdentity(doc);
    const author = identity === undefined ? 'unknown' : `${identity.name} <${identity.email}>`;
    const local = [...(await this.state.pending())]
      .reverse()
      .map(({ id, subject, at }) => ({ id, subject, author, at }));
    const rest = limit - local.length;
    const base = doc.base.head;
    if (rest <= 0 || base === null) return local.slice(0, limit);
    return [...local, ...(await this.serverLog(doc, base, rest))];
  }

  async changedPaths(): Promise<TreeChange[]> {
    const committed = await this.state.committedFiles();
    const changes: TreeChange[] = [];
    for (const [path, file] of changesBetween(committed, await readTreeFiles(this.deps.tree))) {
      changes.push({ path, status: file === null ? 'deleted' : committed.has(path) ? 'modified' : 'added' });
    }
    return changes;
  }

  async identity(): Promise<{ name: string; email: string } | undefined> {
    const identity = this.currentIdentity(await this.state.read());
    return identity === undefined ? undefined : { name: identity.name, email: identity.email };
  }

  async setIdentity(name: string, email: string): Promise<void> {
    await this.state.update({ identity: { name, email } });
  }

  /**
   * Relays the live socket for this share's server and workspace as {@link RemoteEvent}s (live-updates
   * §3.4):
   * - `head` becomes `changed` only when neither the last fetch (`knownHead`) nor the base names it.
   *   A second device's echo of its own push is then free.
   * - `access` and `refused` both become `access`: the fetch that follows asks the server, which knows
   *   the role.
   * - `presence` passes through; the live client has already removed this account's own user.
   * - The socket's state becomes `live`, except `ended`, which becomes `live: 'off'` (unless off
   *   already shows) and then `ended`.
   *
   * A `live-too-many-subscriptions` refusal leaves this workspace without events while the socket is
   * up. It therefore reads `off` until the socket reconnects, so `SyncService` keeps the user's own
   * interval (§3.5).
   */
  subscribeRemote(listener: (event: RemoteEvent) => void): () => void {
    const live = this.deps.live;
    if (live === undefined) {
      return () => {};
    }
    let active = true;
    let refusedForLimit = false;
    /** The last `live` state emitted, so `ended` adds an `off` only when one is not already showing. */
    let lastLive: 'connected' | 'connecting' | 'off' | undefined;
    // One head check at a time, so each `changed` leaves in the order its head arrived.
    let heads: Promise<void> = Promise.resolve();
    // A throwing listener must not reach the live client's dispatch, nor leave the head chain
    // rejected (every later check would be skipped). The backend has no logger, so it is dropped.
    const emit = (event: RemoteEvent): void => {
      if (!active) return;
      try {
        listener(event);
      } catch {
        // Swallowed on purpose; see above.
      }
    };
    const off = live.subscribe(this.deps.url, this.deps.workspaceId, (event) => {
      if (event.kind === 'state') {
        if (event.state === 'ended') {
          // The socket is gone: say so first, so nothing that only listens for `live` keeps showing
          // `connected` (the client can go straight from `connected` to `ended` on `4401`).
          if (lastLive !== 'off') emit({ kind: 'live', state: 'off' });
          lastLive = 'off';
          emit({ kind: 'ended' });
          return;
        }
        if (event.state !== 'connected') refusedForLimit = false;
        lastLive = refusedForLimit ? 'off' : event.state;
        emit({ kind: 'live', state: lastLive });
        return;
      }
      const message = event.message;
      switch (message.type) {
        case 'head':
          heads = heads
            .then(async () => {
              if (await this.isNewHead(message.head)) emit({ kind: 'changed' });
            })
            .catch(() => undefined);
          return;
        case 'access':
          emit({ kind: 'access' });
          return;
        case 'refused':
          emit({ kind: 'access' });
          if (message.code === 'live-too-many-subscriptions') {
            refusedForLimit = true;
            lastLive = 'off';
            emit({ kind: 'live', state: 'off' });
          }
          return;
        case 'presence':
          emit({ kind: 'presence', users: message.users.map(({ id, name }) => ({ id, name })) });
          return;
        default: {
          const unreachable: never = message;
          return unreachable;
        }
      }
    });
    return () => {
      // First, so a head check still reading the state cannot reach a listener that is gone.
      active = false;
      off();
    };
  }

  // ——— internals ——————————————————————————————————————————————————————————————————————————

  /** Every call to the server: the account token (`withToken`), then §3.5's mapping. */
  private async call<T>(request: (origin: string, token: string) => Promise<T>): Promise<T> {
    try {
      return await withToken(this.deps, this.deps.url, request);
    } catch (error) {
      throw mapServerError(error);
    }
  }

  /** `gitAvailable` means "sync works" for a server share (assumption 6): SyncService arms its fetch timer on it. */
  private where(): Pick<SyncStatusWire, 'kind' | 'gitAvailable' | 'remote' | 'branch'> {
    return { kind: 'server', gitAvailable: true, remote: this.deps.url, branch: BRANCH };
  }

  private async status(): Promise<SyncStatusWire> {
    const doc = await this.state.read();
    const conflicts = (await this.state.readMerge())?.conflicts.length ?? 0;
    const ahead = (await this.state.pending()).length;
    const uncommitted = changesBetween(await this.state.committedFiles(), await readTreeFiles(this.deps.tree)).size;
    const behind = doc.knownHead !== undefined && doc.knownHead !== doc.base.head ? (doc.behind ?? 0) : 0;
    const state: SyncState =
      conflicts > 0
        ? 'conflict'
        : ahead > 0 && behind > 0
          ? 'diverged'
          : ahead > 0
            ? 'ahead'
            : behind > 0
              ? 'behind'
              : 'clean';
    return {
      ...this.where(),
      state,
      ahead,
      behind,
      uncommitted,
      ...(doc.lastSyncAt !== undefined ? { lastSyncAt: doc.lastSyncAt } : {}),
      ...(doc.role !== undefined ? { role: doc.role } : {}),
    };
  }

  /**
   * Appends the pending *Merge* commit that takes the committed files (the new base with every
   * pending commit replayed) to `target`; nothing when they already match.
   */
  private async recordMerge(target: TreeFiles): Promise<void> {
    const changes = diffTreeFiles(await this.state.committedFiles(), target);
    if (changes.length === 0) return;
    await this.state.appendPending({ subject: MERGE_SUBJECT, at: this.now().toISOString(), changes });
  }

  /**
   * The server's history from `base` backwards. The log route starts at the server's head, so the
   * commits fetched but not merged yet come first: the query asks for that many more and starts at
   * the base's id. Offline, the cache (or nothing) is the answer, so the popover never fails for
   * want of a network.
   */
  private async serverLog(doc: ServerStateDoc, base: string, count: number): Promise<SyncLogEntryWire[]> {
    const cached = this.logCache?.base === base ? this.logCache : undefined;
    if (cached !== undefined && (cached.complete || cached.entries.length >= count)) {
      return cached.entries.slice(0, count);
    }
    const skip = doc.knownHead !== undefined && doc.knownHead !== base ? (doc.behind ?? 0) : 0;
    const ask = Math.min(MAX_SYNC_LOG_LIMIT, count + skip);
    let entries: SyncLogEntry[];
    try {
      entries = await this.call((url, token) => this.deps.client.syncLog(url, token, this.deps.workspaceId, ask));
    } catch (error) {
      if (isWirebenchError(error) && error.code === 'sync-offline') return cached?.entries.slice(0, count) ?? [];
      throw error;
    }
    const from = entries.findIndex((entry) => entry.id === base);
    // The server moved on further than the last fetch saw: the base is outside this window.
    if (from === -1) return [];
    const history = entries.slice(from);
    this.logCache = { base, entries: history, complete: entries.length < ask };
    return history.slice(0, count);
  }

  private currentIdentity(doc: ServerStateDoc): { readonly name: string; readonly email: string } | undefined {
    return doc.identity ?? this.deps.defaultIdentity?.();
  }

  /**
   * Whether a pushed `head` is news: neither the last fetch's `knownHead` nor the base names it. A
   * local read, no network. A state that cannot be read counts as news, so the fetch that follows
   * reports the damage as the status it already is (`sync-state-corrupt`). Never rejects.
   */
  private async isNewHead(head: string): Promise<boolean> {
    try {
      const doc = await this.state.read();
      return head !== doc.knownHead && head !== doc.base.head;
    } catch {
      return true;
    }
  }
}
