/**
 * The server-running lock (hosted edition spec §19.10). Every running server holds it shared, on one dedicated
 * connection outside the pool, for its whole life; `admin tenancy revert` (Task 28) takes it exclusively, which
 * fails while any server runs. So "on a stopped server" is checked, not trusted, and any number of servers,
 * a start-before-stop restart among them, hold it at once.
 *
 * A dropped connection drops the lock with it, silently. So the connection has TCP keepalive and a connect
 * timeout, and a heartbeat asks every {@link HEARTBEAT_MS} whether this session still holds the lock. A failed
 * or `false` answer counts as a drop, and so does no answer within {@link LOCK_QUERY_TIMEOUT_MS}: on a
 * half-open connection a sent query neither answers nor fails until TCP gives up, minutes later. A tick is
 * skipped while the last heartbeat is still out, so nothing queues. A drop is therefore seen within
 * {@link HEARTBEAT_MS} + {@link LOCK_QUERY_TIMEOUT_MS}.
 *
 * After a drop the lock is taken again on a new connection. Two failures differ (owner ruling, 2026-10-30):
 * - **A revert holds it** (`TRY_SHARED` answers, and refuses): `onLost` is called at once, and the server stops.
 * - **The database cannot be reached** (refused, timed out, a name that does not resolve, a restart or a
 *   failover): the re-take keeps trying, with a delay that starts at 1 s and doubles up to 15 s, for
 *   {@link RETAKE_WINDOW_MS}. It is let go only when that window has passed with no attempt getting through. A
 *   database restart therefore costs the server nothing as long as the database is back within two minutes.
 *
 * One attempt is one connect and one query: `TRY_SHARED` reads the backend's pid too, and runs as the session's
 * first query (`openSession`'s `first`), so there is no separate pid read. The connect is bounded by its
 * connect timeout (10 s) and the query by {@link LOCK_QUERY_TIMEOUT_MS} (5 s), and the attempt is raced against
 * their sum. An attempt starts only while the window is open, after a delay of at most 15 s, so `onLost` comes
 * at most {@link RETAKE_WINDOW_MS} + 15 + 15 s = 150 s after the drop, by default.
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

/** The attempt's one query: the lock, and the backend's pid, in one round trip. */
export const TRY_SHARED = `select pg_backend_pid() as pid, pg_try_advisory_lock_shared($1, ${LOCK_SCHEMA_KEY}) as ok`;
export const TRY_EXCLUSIVE = `select pg_try_advisory_lock($1, ${LOCK_SCHEMA_KEY}) as ok`;
export const UNLOCK_EXCLUSIVE = `select pg_advisory_unlock($1, ${LOCK_SCHEMA_KEY}) as ok`;

/** Whether this session still holds the shared lock. */
export const HELD = `select exists (
  select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
    and classid::bigint = ($1::bigint & 4294967295) and objid::bigint = (${LOCK_SCHEMA_KEY})::oid::bigint
    and objsubid = 2 and mode = 'ShareLock' and granted) as held`;

export const HEARTBEAT_MS = 15_000;

/** How long `TRY_SHARED` or a heartbeat may wait for its answer before the lock counts as lost. */
export const LOCK_QUERY_TIMEOUT_MS = 5_000;

/** `promise`, or a rejection once `ms` have passed without it settling. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} had no answer within ${String(ms)} ms`));
    }, ms);
    timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => {
    clearTimeout(timer);
  });
}

/** The lock connection's name in `pg_stat_activity`, which revert reads (plan Task 28). */
export const LOCK_APPLICATION_NAME = `${APPLICATION_NAME}-lock`;

/** How long an unreachable database is tried before the lock counts as lost for good. */
export const RETAKE_WINDOW_MS = 120_000;
/** The delay before the first re-take attempt, doubled after each failure up to {@link MAX_RETRY_DELAY_MS}. */
export const RETRY_DELAY_MS = 1_000;
export const MAX_RETRY_DELAY_MS = 15_000;

export interface RunningLockOptions {
  /** How long an unreachable database is tried again before `onLost`; {@link RETAKE_WINDOW_MS} by default. */
  readonly retakeWindowMs?: number;
  /** The first delay, and the most it doubles to; {@link RETRY_DELAY_MS} and {@link MAX_RETRY_DELAY_MS}. */
  readonly retryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  /** How often the heartbeat asks; {@link HEARTBEAT_MS} by default. */
  readonly heartbeatMs?: number;
  /** How long one connection attempt may take. */
  readonly connectTimeoutMs?: number;
  /** How long `TRY_SHARED` or a heartbeat may take; {@link LOCK_QUERY_TIMEOUT_MS} by default. */
  readonly queryTimeoutMs?: number;
  /** Which lock this is, in the error `onLost` gets: the owner's while migrating, or the app role's. */
  readonly label?: string;
  /** Called once when the lock is lost for good. */
  readonly onLost: (error: Error) => void;
  /** Called each time the lock was taken again on a new connection. */
  readonly onRetaken?: (pid: number) => void;
  /** Test only: how a session is opened, `first` being its first query (`openSession`'s option of that name). */
  readonly open?: (
    url: string,
    first: { readonly text: string; readonly params: readonly unknown[] },
  ) => Promise<Session>;
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

  private get queryTimeoutMs(): number {
    return this.options.queryTimeoutMs ?? LOCK_QUERY_TIMEOUT_MS;
  }

  /** The server process holding the lock, for a test that drops it. */
  get pid(): number | undefined {
    return this.session?.pid;
  }

  private async take(): Promise<Session> {
    const connectTimeoutMs = this.options.connectTimeoutMs ?? 10_000;
    const first = { text: TRY_SHARED, params: [SERVER_RUNNING_CLASS] };
    const opening = (
      this.options.open ??
      ((url) =>
        openSession(url, {
          applicationName: LOCK_APPLICATION_NAME,
          queryTimeoutMs: this.queryTimeoutMs,
          connectTimeoutMs,
          first,
        }))
    )(this.url, first);
    let session: Session;
    try {
      session = await within(opening, connectTimeoutMs + this.queryTimeoutMs, 'taking the server-running lock');
    } catch (error) {
      // A session that opens after its deadline is closed, not left holding a lock nobody watches.
      void opening.then(
        (late) => late.close(),
        () => undefined,
      );
      throw error;
    }
    if (session.first?.ok !== true) {
      await session.close();
      throw new WirebenchError('tenancy-reverting', 'admin tenancy revert is running against this database');
    }
    return session;
  }

  private watch(session: Session): void {
    this.session = session;
    session.onLost((error) => {
      this.dropped(session, error);
    });
    clearInterval(this.heartbeat);
    let pending = false;
    this.heartbeat = setInterval(() => {
      if (pending) return;
      pending = true;
      within(session.query<{ held: boolean }>(HELD, [SERVER_RUNNING_CLASS]), this.queryTimeoutMs, 'the lock heartbeat')
        .then((rows) => {
          if (rows.rows[0]?.held !== true) throw new Error('the session no longer holds the server-running lock');
        })
        .catch((error: unknown) => {
          this.dropped(session, error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          pending = false;
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
    const window = this.options.retakeWindowMs ?? RETAKE_WINDOW_MS;
    const maxDelay = this.options.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS;
    let delay = this.options.retryDelayMs ?? RETRY_DELAY_MS;
    const started = Date.now();
    let last = cause;
    while (!this.closed && Date.now() - started < window) {
      // Before every attempt, the first too: a dropped database gets a moment, and a revert that is about to
      // take the lock is not raced.
      await new Promise((done) => setTimeout(done, delay));
      delay = Math.min(delay * 2, maxDelay);
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
        // A revert answered: there is nothing to wait for. Anything else is the database being unreachable.
        if (error instanceof WirebenchError && error.code === 'tenancy-reverting') break;
      }
    }
    if (!this.closed) {
      const which = this.options.label === undefined ? '' : ` (${this.options.label})`;
      this.options.onLost(new Error(`the server-running lock${which} was lost: ${last.message}`, { cause: last }));
    }
  }

  /** Releases the lock by closing its connection. Idempotent. */
  async release(): Promise<void> {
    this.closed = true;
    clearInterval(this.heartbeat);
    await this.session?.close();
  }
}
