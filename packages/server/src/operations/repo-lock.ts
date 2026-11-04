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
 *   which asks {@link assertRepoLockHeld} first. The operation's state rides in an `AsyncLocalStorage`, so every
 *   git call `fn` makes, through whichever module, is checked without the callers changing. A git step that
 *   already started runs to completion, as a crash would; the repository's own lock files and the push's
 *   compare-and-swap of the head keep it consistent.
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

/**
 * `git`, with every `run` asking {@link assertRepoLockHeld} first, and `withPlumbing()` wrapped the same way, so
 * the commit store's plumbing copy is checked too.
 */
export function guardGit(git: GitCli): GitCli {
  return new Proxy(git, {
    get(target, property) {
      if (property === 'run') {
        return (...args: Parameters<GitCli['run']>) => {
          assertRepoLockHeld();
          return target.run(...args);
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

  constructor(deps: { readonly pool: RepoLockPool; readonly warn?: (error: Error, message: string) => void }) {
    this.#pool = deps.pool;
    this.#warn = deps.warn ?? (() => undefined);
  }

  /** Runs `fn` holding the lock for `scope`'s `workspaceId`; `503 repo-busy` when the wait runs out. */
  async hold<T>(scope: TenantScope, workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const params = [REPO_LOCK_CLASS, scope.tenantId, workspaceId];
    let connection: RepoLockConnection;
    try {
      connection = await this.#pool.acquire();
    } catch (error) {
      if (codeOf(error) === 'pool-timeout') throw repoBusy();
      throw error;
    }
    const held: Held = { lost: undefined };
    try {
      await connection.query(LOCK, params);
    } catch (error) {
      // Destroyed whatever went wrong: a wait cut short on the client side could still be granted later.
      connection.release(true);
      if (codeOf(error) === '55P03') throw repoBusy(); // lock_not_available: `lock_timeout` ran out
      throw error;
    }
    connection.onLost((error) => {
      held.lost ??= repoLockLost();
      this.#warn(error, 'a repository lock connection was lost while its operation ran');
    });
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
      connection.release(destroy);
    }
  }
}
