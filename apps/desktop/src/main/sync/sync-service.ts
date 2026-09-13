/**
 * Drives one open shared workspace's {@link SyncBackend}: every backend call goes through one
 * promise chain (so a timer fetch, a save's commit/push and a user's pull never interleave), an
 * auto-fetch timer with an offline back-off, a debounced commit (and push) after saves, and the
 * pull → merge → reload/conflict hand-off to its consumer (`WorkspaceService`).
 *
 * Electron-free and clock-injectable: timers only ever go through `deps.setTimer`/`clearTimer`,
 * so the whole service runs under fake timers in tests and in plain Node (spec 2's server).
 */

import type { GitShareSettings } from '@wirebench/engine';
import { commitMessage, isWirebenchError, WirebenchError } from '@wirebench/engine';
import type { SyncBackend } from './backend.js';
import type { SyncConflictWire, SyncLogEntryWire, SyncStatusWire } from './types.js';

/** Saves landing within this window (a Save All across hosts) become one commit. */
export const SAVE_COMMIT_DEBOUNCE_MS = 500;
/** Auto-fetch delay while the remote is unreachable, until a fetch succeeds again. */
export const OFFLINE_FETCH_SECONDS = 300;

/** git's refusal of a push that is behind the remote — answered by pulling and pushing once more. */
const PUSH_REJECTED_PATTERN = /rejected|non-fast-forward|fetch first/i;

/** Failures that describe something the user must do, not a broken sync — the state is kept. */
const STATE_KEEPING_CODES: ReadonlySet<string> = new Set([
  'git-identity-needed',
  'sync-uncommitted',
  'sync-conflict',
  'sync-not-supported',
  'sync-no-remote',
]);

export interface SyncServiceDeps {
  backend: SyncBackend;
  /** The share's current git settings, re-read on every use (they can be patched while open). */
  settings: () => GitShareSettings;
  /** Every status change, including the `syncing` one each operation starts with. */
  onStatus(status: SyncStatusWire): void;
  /** A merge brought in `changedPaths` (tree-relative); awaited before the pull resolves. */
  onPulled(changedPaths: readonly string[]): Promise<void>;
  /** A merge stopped on conflicts; the workspace stays in `conflict` until resolved or aborted. */
  onConflict(conflicts: readonly SyncConflictWire[]): void;
  /** A commit needs a name and email first; `setIdentity` retries the commit that asked. */
  onIdentityNeeded(): void;
  /** Stamps `lastSyncAt` when a backend does not report its own. */
  now?: () => Date;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

type Timer = ReturnType<typeof setTimeout>;

/** A commit that stopped on a missing identity, retried by {@link SyncService.setIdentity}. */
interface PendingCommit {
  readonly message: string | undefined;
  readonly autosave: boolean;
  readonly push: boolean;
}

function hasCode(error: unknown, code: string): boolean {
  return isWirebenchError(error) && error.code === code;
}

function isPushRejected(error: unknown): boolean {
  if (!hasCode(error, 'git-failed')) {
    return false;
  }
  const stderr = (error as WirebenchError).details?.['stderr'];
  return typeof stderr === 'string' && PUSH_REJECTED_PATTERN.test(stderr);
}

export class SyncService {
  private readonly deps: SyncServiceDeps;
  private readonly backend: SyncBackend;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly now: () => Date;
  /** Every backend call runs behind this; never left rejected. */
  private queue: Promise<void> = Promise.resolve();
  /** Operations currently executing (0 or 1 — the queue runs them one at a time). */
  private running = 0;
  private last: SyncStatusWire;
  private stopped = false;
  /** Set by a `git-offline` failure, cleared by the next successful fetch. */
  private offline = false;
  private fetchTimer: Timer | undefined;
  private saveTimer: Timer | undefined;
  /** While a debounced save is pending: whether every save folded into it was an autosave. */
  private saveIsAutosave: boolean | undefined;
  /** A save commit was skipped because the workspace was in `conflict`; rescheduled once it is not. */
  private saveDeferredByConflict = false;
  private identityPending: PendingCommit | undefined;

  constructor(deps: SyncServiceDeps) {
    this.deps = deps;
    this.backend = deps.backend;
    // Resolved at call time, not captured here, so a test's fake timers installed before or after
    // construction are both honoured.
    this.setTimer =
      deps.setTimer ?? (((handler: () => void, ms: number) => setTimeout(handler, ms)) as unknown as typeof setTimeout);
    this.clearTimer =
      deps.clearTimer ?? (((timer: Timer | undefined) => clearTimeout(timer)) as unknown as typeof clearTimeout);
    this.now = deps.now ?? ((): Date => new Date());
    this.last = {
      kind: deps.backend.kind,
      gitAvailable: deps.backend.kind !== 'folder',
      state: 'clean',
      ahead: 0,
      behind: 0,
      uncommitted: 0,
    };
  }

  /** The last known status — `syncing` (over the last known counts) while an operation runs. */
  status(): SyncStatusWire {
    return this.running > 0 ? { ...this.last, state: 'syncing' } : this.last;
  }

  /**
   * Probes, commits changes made while the app was not watching (a CLI edit, a sync client, a
   * migration re-save) when `commitOnSave` is on, fetches when a remote is set, and arms the
   * auto-fetch timer. Never throws: every failure ends up in {@link status}.
   */
  async start(): Promise<void> {
    await this.run(async () => {
      await this.probeNow();
      if (!this.canSync() || this.last.state === 'error') {
        return;
      }
      if (this.last.state === 'conflict') {
        // A merge left unresolved by an earlier session: hold reloads exactly as a fresh one would.
        this.deps.onConflict(await this.backend.conflicts());
        return;
      }
      if (this.last.uncommitted > 0 && this.deps.settings().commitOnSave) {
        try {
          await this.commitNow(undefined, { autosave: false, push: false });
          await this.probeNow();
        } catch (error) {
          if (!hasCode(error, 'git-identity-needed')) {
            throw error;
          }
          this.recordError(error);
        }
      }
      if (this.last.remote !== undefined) {
        await this.fetchNow();
      }
    }).catch(() => undefined);
    this.armFetchTimer();
  }

  /** Stops the timers; operations already queued still finish. */
  stop(): void {
    this.stopped = true;
    if (this.fetchTimer !== undefined) {
      this.clearTimer(this.fetchTimer);
      this.fetchTimer = undefined;
    }
    if (this.saveTimer !== undefined) {
      this.clearTimer(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.saveIsAutosave = undefined;
  }

  /**
   * A save wrote files into the tree. With `commitOnSave`, schedules one commit
   * {@link SAVE_COMMIT_DEBOUNCE_MS} after the last of a burst of saves (trailing), then a push
   * when `pushOnSave` is on and a remote is set.
   */
  afterSave(reason: 'manual' | 'autosave' | 'workspace'): void {
    if (this.stopped || !this.canSync() || !this.deps.settings().commitOnSave) {
      return;
    }
    this.saveIsAutosave = (this.saveIsAutosave ?? true) && reason === 'autosave';
    this.scheduleSaveCommit();
  }

  fetch(): Promise<SyncStatusWire> {
    return this.run(() => this.fetchNow());
  }

  pull(): Promise<SyncStatusWire> {
    return this.run(async () => {
      await this.pullNow();
      return this.last;
    });
  }

  push(): Promise<SyncStatusWire> {
    return this.run(() => this.pushNow());
  }

  /** Commits every change in the tree; `message` wins over the generated one. */
  commit(message?: string): Promise<SyncStatusWire> {
    return this.run(async () => {
      await this.commitNow(message, { autosave: false, push: false });
      return await this.probeNow();
    });
  }

  conflicts(): Promise<SyncConflictWire[]> {
    return this.run(() => this.backend.conflicts());
  }

  /** Resolves one conflicted path; resolving the last one commits the merge and applies it. */
  resolve(path: string, side: 'mine' | 'theirs'): Promise<SyncStatusWire> {
    return this.run(async () => {
      await this.backend.resolve(path, side);
      if ((await this.backend.conflicts()).length > 0) {
        return await this.probeNow();
      }
      // What the merge commit brought in — not the working tree's status, which would also carry
      // saves made (and deliberately left uncommitted) while the conflict was open.
      const { changedPaths } = await this.backend.finishMerge();
      await this.probeNow();
      if (changedPaths.length > 0) {
        await this.deps.onPulled(changedPaths);
      }
      return this.last;
    });
  }

  abortMerge(): Promise<SyncStatusWire> {
    return this.run(async () => {
      await this.backend.abortMerge();
      return await this.probeNow();
    });
  }

  log(limit: number): Promise<SyncLogEntryWire[]> {
    return this.run(() => this.backend.log(limit));
  }

  /** Sets the commit identity, then retries the commit (and push) that asked for it, if any. */
  async setIdentity(name: string, email: string): Promise<void> {
    await this.run(async () => {
      await this.backend.setIdentity(name, email);
      const pending = this.identityPending;
      this.identityPending = undefined;
      if (pending === undefined) {
        return;
      }
      try {
        await this.commitThenMaybePush(pending);
      } catch (error) {
        // The identity itself was set; a failing retry (offline, a rejected push) is a status,
        // not a failure of this call.
        this.recordError(error);
      }
    });
  }

  /** Re-reads the settings for the timer (an `autoFetchSeconds` change takes effect now). */
  applySettings(): void {
    this.armFetchTimer();
  }

  // ——— internals: each runs inside an operation already holding the queue ———————————————

  private run<T>(op: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      // Checked right before starting, not at call time: an operation already running when
      // `stop()` is called finishes, but nothing queued behind it may reach a workspace that is
      // closing (and possibly being reopened under a new service). No status is emitted for it.
      if (this.stopped) {
        throw new WirebenchError('sync-stopped', 'Sync stopped for this workspace.');
      }
      this.running += 1;
      this.emit();
      try {
        return await op();
      } catch (error) {
        this.recordError(error);
        throw error;
      } finally {
        this.running -= 1;
        this.emit();
        if (this.saveDeferredByConflict && this.last.state !== 'conflict') {
          this.saveDeferredByConflict = false;
          this.saveIsAutosave = this.saveIsAutosave ?? false;
          this.scheduleSaveCommit();
        }
      }
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private canSync(): boolean {
    return this.backend.kind !== 'folder';
  }

  private emit(): void {
    this.deps.onStatus(this.status());
  }

  private setStatus(next: SyncStatusWire): SyncStatusWire {
    this.last =
      this.offline && next.state !== 'conflict' && next.state !== 'error' ? { ...next, state: 'offline' } : next;
    return this.last;
  }

  private recordError(error: unknown): void {
    const code = isWirebenchError(error) ? error.code : 'git-failed';
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'git-offline') {
      this.offline = true;
      this.last = { ...this.last, state: 'offline', error: { code, message } };
      return;
    }
    this.last = {
      ...this.last,
      state: STATE_KEEPING_CODES.has(code) ? this.last.state : 'error',
      error: { code, message },
    };
  }

  private async probeNow(): Promise<SyncStatusWire> {
    return this.setStatus(await this.backend.probe());
  }

  private async fetchNow(): Promise<SyncStatusWire> {
    const fetched = await this.backend.fetch();
    this.offline = false;
    return this.setStatus(
      fetched.lastSyncAt !== undefined ? fetched : { ...fetched, lastSyncAt: this.now().toISOString() },
    );
  }

  /** Returns whether a commit was made. */
  private async commitNow(
    message: string | undefined,
    options: { autosave: boolean; push: boolean },
  ): Promise<boolean> {
    if (this.last.state === 'conflict') {
      throw new WirebenchError('sync-conflict', 'Resolve the merge conflicts before committing.');
    }
    if ((await this.backend.identity()) === undefined) {
      this.identityPending = { message, autosave: options.autosave, push: options.push };
      this.deps.onIdentityNeeded();
      throw new WirebenchError('git-identity-needed', 'Set the name and email your commits are recorded under.');
    }
    const explicit = message !== undefined && message.trim().length > 0 ? message : undefined;
    const changes = await this.backend.changedPaths();
    if (changes.length === 0 && explicit === undefined) {
      return false;
    }
    const { committed } = await this.backend.commit(explicit ?? commitMessage(changes, { autosave: options.autosave }));
    return committed;
  }

  private async commitThenMaybePush(commit: PendingCommit): Promise<void> {
    const committed = await this.commitNow(commit.message, commit);
    const current = await this.probeNow();
    // `status.remote` undefined means there is nowhere to push; the backend would throw
    // `sync-no-remote`, which is not something a save should surface.
    if (
      commit.push &&
      this.deps.settings().pushOnSave &&
      current.remote !== undefined &&
      (committed || current.ahead > 0)
    ) {
      await this.pushNow();
    }
  }

  private async pushNow(): Promise<SyncStatusWire> {
    try {
      return this.setStatus(await this.backend.push());
    } catch (error) {
      if (!isPushRejected(error)) {
        throw error;
      }
      await this.pullNow();
      if (this.last.state === 'conflict') {
        return this.last;
      }
      return this.setStatus(await this.backend.push());
    }
  }

  private async pullNow(): Promise<void> {
    const fetched = await this.fetchNow();
    if (fetched.state === 'conflict') {
      throw new WirebenchError('sync-conflict', 'Resolve the merge conflicts before pulling again.');
    }
    if (fetched.uncommitted > 0) {
      if (!this.deps.settings().commitOnSave) {
        throw new WirebenchError('sync-uncommitted', 'Commit or discard your local changes before pulling.');
      }
      await this.commitNow(undefined, { autosave: false, push: false });
    }
    const { conflicts, changedPaths } = await this.backend.merge();
    if (conflicts.length > 0) {
      await this.probeNow();
      this.deps.onConflict(conflicts);
      return;
    }
    if (changedPaths.length > 0) {
      await this.deps.onPulled(changedPaths);
    }
    await this.probeNow();
  }

  private scheduleSaveCommit(): void {
    if (this.stopped) {
      return;
    }
    if (this.saveTimer !== undefined) {
      this.clearTimer(this.saveTimer);
    }
    this.saveTimer = this.setTimer(() => {
      this.saveTimer = undefined;
      const autosave = this.saveIsAutosave === true;
      this.saveIsAutosave = undefined;
      void this.run(async () => {
        if (this.last.state === 'conflict') {
          this.saveDeferredByConflict = true;
          return;
        }
        await this.commitThenMaybePush({ message: undefined, autosave, push: true });
      }).catch(() => undefined);
    }, SAVE_COMMIT_DEBOUNCE_MS);
    unref(this.saveTimer);
  }

  private armFetchTimer(): void {
    if (this.fetchTimer !== undefined) {
      this.clearTimer(this.fetchTimer);
      this.fetchTimer = undefined;
    }
    if (this.stopped || !this.canSync() || !this.last.gitAvailable) {
      return;
    }
    const seconds = this.deps.settings().autoFetchSeconds;
    if (!(seconds > 0)) {
      return;
    }
    const delaySeconds = this.offline ? Math.max(seconds, OFFLINE_FETCH_SECONDS) : seconds;
    this.fetchTimer = this.setTimer(() => {
      this.fetchTimer = undefined;
      void this.fetch()
        .catch(() => undefined)
        .finally(() => {
          this.armFetchTimer();
        });
    }, delaySeconds * 1000);
    unref(this.fetchTimer);
  }
}

/** Lets a pending sync timer never keep the process alive on its own (a no-op for fakes without `unref`). */
function unref(timer: Timer): void {
  (timer as { unref?: () => void }).unref?.();
}
