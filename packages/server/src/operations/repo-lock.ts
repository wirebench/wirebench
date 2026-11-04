/**
 * The advisory repository lock (hosted edition spec §20.4, amending ADR-0009 and ADR-0012): with several instances on
 * one data volume, the in-process queue of `RepoStore.withLock` no longer keeps two writers off one bare repository,
 * so after that queue the store takes a session-level advisory lock, keyed by the schema, the tenant and the
 * workspace, on a connection of the lock pool it holds for the whole operation.
 *
 * - **Session, not transaction.** `fn` runs git for seconds and its own short units, so it cannot sit in one
 *   transaction; the lock is unlocked on the same connection before that connection goes back.
 * - **A bounded wait.** The pool's connections carry `lock_timeout`, so a wait past it fails in the server itself
 *   and the backend never goes on to take the lock. A connection in any doubt (a failed lock or unlock, a lost
 *   connection) is destroyed, which drops whatever it held: a lock is never left behind.
 * - **A lost connection** is seen at `fn`'s next git step: the server's `GitCli` is wrapped by {@link guardGit},
 *   which asks {@link checkRepoLock} first. The operation's state rides in an `AsyncLocalStorage`, so every
 *   git call `fn` makes, through whichever module, is checked without the callers changing. A git step that
 *   already started runs to completion, as a crash would; the repository's own lock files and the push's
 *   compare-and-swap of the head keep it consistent.
 * - **A half-open connection** (a failover: the old primary's socket gives no error, and another instance takes
 *   the lock on the new one) is seen by a probe: `select 1` on the held connection, answered within
 *   {@link REPO_LOCK_PROBE_TIMEOUT_MS}, at most once every {@link REPO_LOCK_PROBE_MS} before a git step, and always
 *   right before a step that moves a ref or the head (`update-ref`, `symbolic-ref`: the push's final step). A probe
 *   that fails or times out marks the lock lost and destroys the connection.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { GitCli, WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';
import type { TenantScope } from '../tenancy/scope.js';
import { SERVER_SCHEMA } from '../tenancy/running-lock.js';

/** The advisory-lock class of a repository lock; the schema, tenant and workspace hash is the other half. */
export const REPO_LOCK_CLASS = 0x57425250; // "WBRP"

/** How long a push may wait for the lock (and, apart, for a lock-pool connection) before `503 repo-busy`. */
export const REPO_LOCK_WAIT_MS = 30_000;
/** The lock pool's size: at most this many repository operations hold a lock at once in one process. */
export const REPO_LOCK_POOL_MAX = 8;
/** The `Retry-After` of both 503s; the desktop already retries a 503 push. */
export const REPO_LOCK_RETRY_AFTER_S = 5;
/** A held lock's connection is probed at most this often before an ordinary git step. */
export const REPO_LOCK_PROBE_MS = 1_000;
/** A probe unanswered for this long is a lost connection. */
export const REPO_LOCK_PROBE_TIMEOUT_MS = 2_000;
/** The git steps that move a ref or the head: the lock is always probed right before one. */
const REF_STEPS: ReadonlySet<string> = new Set(['update-ref', 'symbolic-ref']);
const PROBE = 'select 1';

const KEY = `hashtext((${SERVER_SCHEMA}) || ':' || $2 || ':' || $3)`;
const LOCK = `select pg_advisory_lock($1, ${KEY})`;
const UNLOCK = `select pg_advisory_unlock($1, ${KEY}) as ok`;

/** The lock pool's connection: `createLockPool` in `db/pool.ts`, which the start-up opens. */
export interface RepoLockConnection {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: R[] }>;
  onLost(listener: (error: Error) => void): void;
  release(destroy: boolean): void;
}

export interface RepoLockPool {
  readonly waitMs: number;
  acquire(): Promise<RepoLockConnection>;
}

export const repoBusy = (): WirebenchError =>
  problem('repo-busy', 'The workspace repository is busy. Try again in a moment.', 503, {
    retryAfter: REPO_LOCK_RETRY_AFTER_S,
  });

export const repoLockLost = (): WirebenchError =>
  problem('repo-lock-lost', 'The workspace repository lock was lost. Try again in a moment.', 503, {
    retryAfter: REPO_LOCK_RETRY_AFTER_S,
  });

/** One held lock's state, for the git steps of its operation. */
interface Held {
  lost: WirebenchError | undefined;
  /** When the connection last answered (`performance.now`): the lock, or the last probe. */
  answeredAt: number;
  /** The probe in flight, which every step meanwhile waits for. */
  probing: Promise<void> | undefined;
  /** The held connection's probe: resolves when it answered in time, rejects otherwise. */
  readonly probe: () => Promise<void>;
  /** Marks the lock lost and destroys its connection; the first call wins. */
  readonly lose: (error: Error) => void;
}

const current = new AsyncLocalStorage<Held>();

/**
 * Throws `repo-lock-lost` when the repository operation this runs in has lost its lock connection. Outside a
 * locked operation it does nothing: a host checkout's git, say, is not under this lock.
 */
export function assertRepoLockHeld(): void {
  const held = current.getStore();
  if (held?.lost !== undefined) throw held.lost;
}

/** The git subcommand of `args`: the first argument that is not an option. */
const subcommandOf = (args: readonly string[]): string | undefined => args.find((arg) => !arg.startsWith('-'));

/**
 * {@link assertRepoLockHeld}, after probing the held connection when the last answer is older than
 * {@link REPO_LOCK_PROBE_MS}, or whatever its age when `args` moves a ref or the head.
 */
export async function checkRepoLock(args: readonly string[] = []): Promise<void> {
  const held = current.getStore();
  if (held === undefined) return;
  if (held.lost !== undefined) throw held.lost;
  const subcommand = subcommandOf(args);
  const moves = subcommand !== undefined && REF_STEPS.has(subcommand);
  if (!moves && performance.now() - held.answeredAt < REPO_LOCK_PROBE_MS) return;
  held.probing ??= (async () => {
    const started = performance.now();
    try {
      await held.probe();
      held.answeredAt = started;
    } catch (error) {
      held.lose(error instanceof Error ? error : new Error(String(error)));
    } finally {
      held.probing = undefined;
    }
  })();
  await held.probing;
  // Read again: the probe may have lost it.
  assertRepoLockHeld();
}

/** `select 1` on `connection`, refused once {@link REPO_LOCK_PROBE_TIMEOUT_MS} passed without an answer. */
async function probeOf(connection: RepoLockConnection, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      connection.query(PROBE),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`the repository lock connection did not answer within ${String(timeoutMs)} ms`));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `git`, with every `run` asking {@link checkRepoLock} first, and `withPlumbing()` wrapped the same way, so
 * the commit store's plumbing copy is checked too.
 */
export function guardGit(git: GitCli): GitCli {
  return new Proxy(git, {
    get(target, property) {
      if (property === 'run') {
        return async (...args: Parameters<GitCli['run']>) => {
          await checkRepoLock(args[1]);
          return await target.run(...args);
        };
      }
      if (property === 'withPlumbing') return () => guardGit(target.withPlumbing());
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

const codeOf = (error: unknown): unknown => (error as { readonly code?: unknown } | null)?.code;

export class DatabaseRepoLock {
  readonly #pool: RepoLockPool;
  readonly #warn: (error: Error, message: string) => void;
  readonly #probeTimeoutMs: number;
  readonly #waited: (tenantId: string, ms: number) => void;

  constructor(deps: {
    readonly pool: RepoLockPool;
    readonly warn?: (error: Error, message: string) => void;
    /** {@link REPO_LOCK_PROBE_TIMEOUT_MS} unless a test shortens it. */
    readonly probeTimeoutMs?: number;
    /**
     * How long each hold waited for its connection and lock, granted or run out (`503 repo-busy`): the
     * `wirebench.repo.lock.wait` histogram (spec §20.8).
     */
    readonly waited?: (tenantId: string, ms: number) => void;
  }) {
    this.#pool = deps.pool;
    this.#warn = deps.warn ?? (() => undefined);
    this.#probeTimeoutMs = deps.probeTimeoutMs ?? REPO_LOCK_PROBE_TIMEOUT_MS;
    this.#waited = deps.waited ?? (() => undefined);
  }

  /** Runs `fn` holding the lock for `scope`'s `workspaceId`; `503 repo-busy` when the wait runs out. */
  async hold<T>(scope: TenantScope, workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const params = [REPO_LOCK_CLASS, scope.tenantId, workspaceId];
    const asked = performance.now();
    const busy = (): WirebenchError => {
      this.#waited(scope.tenantId, performance.now() - asked);
      return repoBusy();
    };
    let connection: RepoLockConnection;
    try {
      connection = await this.#pool.acquire();
    } catch (error) {
      if (codeOf(error) === 'pool-timeout') throw busy();
      throw error;
    }
    let released = false;
    const release = (destroy: boolean): void => {
      if (released) return;
      released = true;
      connection.release(destroy);
    };
    const held: Held = {
      lost: undefined,
      answeredAt: 0,
      probing: undefined,
      probe: () => probeOf(connection, this.#probeTimeoutMs),
      lose: (error) => {
        if (held.lost !== undefined) return;
        held.lost = repoLockLost();
        this.#warn(error, 'a repository lock connection was lost while its operation ran');
        // Closed now: whatever it still holds on its server is dropped with it.
        release(true);
      },
    };
    // Before the lock is asked for (review fix): a loss in between would go unheard otherwise.
    connection.onLost((error) => {
      held.lose(error);
    });
    try {
      await connection.query(LOCK, params);
    } catch (error) {
      // Destroyed whatever went wrong: a wait cut short on the client side could still be granted later.
      release(true);
      if (codeOf(error) === '55P03') throw busy(); // lock_not_available: `lock_timeout` ran out
      throw error;
    }
    if (held.lost !== undefined) {
      release(true);
      throw held.lost;
    }
    held.answeredAt = performance.now();
    this.#waited(scope.tenantId, held.answeredAt - asked);
    try {
      return await current.run(held, fn);
    } finally {
      let destroy = held.lost !== undefined;
      if (!destroy) {
        try {
          const { rows } = await connection.query<{ ok: boolean }>(UNLOCK, params);
          // Not held any more is a lock in doubt: closing the connection drops anything it still has.
          if (rows[0]?.ok !== true) destroy = true;
        } catch {
          destroy = true;
        }
      }
      release(destroy);
    }
  }
}
