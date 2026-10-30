/**
 * The server-running lock (hosted edition spec §19.10). Every running server holds it shared, on one dedicated
 * connection outside the pool, for its whole life; `admin tenancy revert` (Task 28) takes it exclusively, which
 * fails while any server runs. So "on a stopped server" is checked, not trusted, and any number of servers,
 * a start-before-stop restart among them, hold it at once.
 *
 * A dropped connection drops the lock with it, silently. So the connection has TCP keepalive and a connect
 * timeout, and a heartbeat asks every {@link HEARTBEAT_MS} whether this session still holds the lock; a failed
 * or `false` answer counts as a drop. After a drop the lock is taken again on a new connection, after a delay
 * each time; when that fails (a revert holds it, or the database is gone) `onLost` is called and the server
 * stops. The whole re-take is bounded by retries × (delay + connect timeout).
 */
import { WirebenchError } from '@wirebench/engine';
import { APPLICATION_NAME, openSession, type Session } from '../db/pool.js';

/** The advisory-lock class of the running lock; the schema's hash is the other half of the key. */
export const SERVER_RUNNING_CLASS = 0x57425352; // "WBSR"

/**
 * The schema half of the key: the schema `server_identity` lives in, so the owner (revert) and the app role
 * (servers) agree even when their search paths start differently. Before the first migration there is none
 * yet, and the session's schema stands in.
 */
export const LOCK_SCHEMA_KEY =
  "hashtext(coalesce((select relnamespace::regnamespace::text from pg_class where oid = to_regclass('server_identity')), current_schema()))";

export const TRY_SHARED = `select pg_try_advisory_lock_shared($1, ${LOCK_SCHEMA_KEY}) as ok`;
export const TRY_EXCLUSIVE = `select pg_try_advisory_lock($1, ${LOCK_SCHEMA_KEY}) as ok`;
export const UNLOCK_EXCLUSIVE = `select pg_advisory_unlock($1, ${LOCK_SCHEMA_KEY}) as ok`;

/** Whether this session still holds the shared lock. */
export const HELD = `select exists (
  select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
    and classid::bigint = ($1::bigint & 4294967295) and objid::bigint = (${LOCK_SCHEMA_KEY})::oid::bigint
    and objsubid = 2 and mode = 'ShareLock' and granted) as held`;

export const HEARTBEAT_MS = 15_000;

/** The lock connection's name in `pg_stat_activity`, which revert reads (plan Task 28). */
export const LOCK_APPLICATION_NAME = `${APPLICATION_NAME}-lock`;

export interface RunningLockOptions {
  /** How often, and how long apart, a lost lock is tried again before `onLost`. */
  readonly retries?: number;
  readonly retryDelayMs?: number;
  /** How often the heartbeat asks; {@link HEARTBEAT_MS} by default. */
  readonly heartbeatMs?: number;
  /** How long one connection attempt may take. */
  readonly connectTimeoutMs?: number;
  /** Called once when the lock is lost for good. */
  readonly onLost: (error: Error) => void;
  /** Called each time the lock was taken again on a new connection. */
  readonly onRetaken?: (pid: number) => void;
  /** Test only: how a session is opened. */
  readonly open?: (url: string) => Promise<Session>;
}

export class RunningLock {
  private session: Session | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private retaking = false;

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
    const session = await (
      this.options.open ??
      ((url) =>
        openSession(url, {
          applicationName: LOCK_APPLICATION_NAME,
          ...(this.options.connectTimeoutMs !== undefined ? { connectTimeoutMs: this.options.connectTimeoutMs } : {}),
        }))
    )(this.url);
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
    session.onLost((error) => {
      this.dropped(session, error);
    });
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      session
        .query<{ held: boolean }>(HELD, [SERVER_RUNNING_CLASS])
        .then((rows) => {
          if (rows.rows[0]?.held !== true) throw new Error('the session no longer holds the server-running lock');
        })
        .catch((error: unknown) => {
          this.dropped(session, error instanceof Error ? error : new Error(String(error)));
        });
    }, this.options.heartbeatMs ?? HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** The connection or the lock on it is gone: close what is left of it, and take the lock again. */
  private dropped(session: Session, cause: Error): void {
    if (this.closed || this.retaking || session !== this.session) return;
    this.retaking = true;
    clearInterval(this.heartbeat);
    this.session = undefined;
    void session.close();
    void this.retake(cause).finally(() => {
      this.retaking = false;
    });
  }

  private async retake(cause: Error): Promise<void> {
    const retries = this.options.retries ?? 5;
    let last = cause;
    for (let attempt = 0; attempt < retries && !this.closed; attempt++) {
      // Before every attempt, the first too: a dropped database gets a moment, and a revert that is about to
      // take the lock is not raced.
      await new Promise((done) => setTimeout(done, this.options.retryDelayMs ?? 1000));
      if (this.closed) return;
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
    clearInterval(this.heartbeat);
    await this.session?.close();
  }
}
