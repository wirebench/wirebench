/**
 * The server-running lock (hosted edition spec §19.10). Every running server holds it shared, on one dedicated
 * connection outside the pool, for its whole life; `admin tenancy revert` (Task 28) takes it exclusively, which
 * fails while any server runs. So "on a stopped server" is checked, not trusted, and any number of servers,
 * a start-before-stop restart among them, hold it at once.
 *
 * A dropped connection drops the lock with it, silently. The lock is then taken again on a new connection;
 * when that fails (a revert holds it, or the database is gone) `onLost` is called and the server exits.
 */
import { WirebenchError } from '@wirebench/engine';
import { openSession, type Session } from '../db/pool.js';

/** The advisory-lock class of the running lock; the schema's hash is the other half of the key. */
export const SERVER_RUNNING_CLASS = 0x57425352; // "WBSR"

export const TRY_SHARED = 'select pg_try_advisory_lock_shared($1, hashtext(current_schema())) as ok';
export const TRY_EXCLUSIVE = 'select pg_try_advisory_lock($1, hashtext(current_schema())) as ok';

export interface RunningLockOptions {
  /** How often, and how long apart, a lost lock is tried again before `onLost`. */
  readonly retries?: number;
  readonly retryDelayMs?: number;
  /** Called once when the lock is lost for good. */
  readonly onLost: (error: Error) => void;
  /** Called each time the lock was taken again on a new connection. */
  readonly onRetaken?: (pid: number) => void;
}

export class RunningLock {
  private session: Session | undefined;
  private closed = false;

  private constructor(
    private readonly url: string,
    private readonly options: RunningLockOptions,
  ) {}

  /** Takes the lock shared, or refuses with `tenancy-reverting` while a revert holds it. */
  static async acquire(url: string, options: RunningLockOptions): Promise<RunningLock> {
    const lock = new RunningLock(url, options);
    lock.watch(await lock.take());
    return lock;
  }

  /** The server process holding the lock, for a test that drops it. */
  get pid(): number | undefined {
    return this.session?.pid;
  }

  private async take(): Promise<Session> {
    const session = await openSession(this.url);
    try {
      const rows = await session.query<{ ok: boolean }>(TRY_SHARED, [SERVER_RUNNING_CLASS]);
      if (rows.rows[0]?.ok !== true) {
        throw new WirebenchError('tenancy-reverting', 'admin tenancy revert is running against this database');
      }
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  private watch(session: Session): void {
    this.session = session;
    session.onLost((error) => void this.retake(error));
  }

  private async retake(cause: Error): Promise<void> {
    const retries = this.options.retries ?? 5;
    let last = cause;
    for (let attempt = 0; attempt < retries && !this.closed; attempt++) {
      if (attempt > 0) await new Promise((done) => setTimeout(done, this.options.retryDelayMs ?? 1000));
      try {
        const session = await this.take();
        if (this.closed) {
          await session.close();
          return;
        }
        this.watch(session);
        this.options.onRetaken?.(session.pid);
        return;
      } catch (error) {
        last = error instanceof Error ? error : new Error(String(error));
        if (error instanceof WirebenchError && error.code === 'tenancy-reverting') break;
      }
    }
    if (!this.closed) this.options.onLost(last);
  }

  /** Releases the lock by closing its connection. Idempotent. */
  async release(): Promise<void> {
    this.closed = true;
    await this.session?.close();
  }
}
