/**
 * The instance registry (hosted edition spec §20.1, §20.2): one `server_instances` row per running process, keyed
 * by the process's holder id, which the host leases use too (§19.9).
 *
 * - **Start.** {@link InstanceRegistry.start} inserts this process's row and arms the heartbeat.
 * - **The heartbeat.** Every {@link HEARTBEAT_MS}, the host leases' interval, one timer renews this row, deletes
 *   every row not renewed for {@link DEAD_MS} (a process that died without its shutdown), and runs each
 *   {@link ServerInstance.onBeat} listener: the host leases renew on it, so a process has one 15 s timer, not two.
 *   The renew is an upsert, so a row another instance swept while this one could not reach the database comes back.
 * - **Readiness** (§20.9). `starting` until the start-up says it is {@link InstanceRegistry.serving}, then `ready`
 *   while the bus listens and `reconnecting` while it is lost, and `draining` from the shutdown's first step on.
 *   `/readyz` answers `200` only when `ready`, so a balancer sends a draining process no new socket.
 * - **Draining** (§20.5). {@link InstanceRegistry.drain} runs every {@link ServerInstance.onDrain} listener, before
 *   the app closes: the host module stops its hosts and gives their leases back, the live module closes its sockets
 *   `1012`. From its first call {@link ServerInstance.draining} is set, and the socket routes refuse every upgrade.
 * - **Stop.** {@link InstanceRegistry.stop} cancels the timer and deletes this process's row.
 *
 * The table names processes, not tenants: nothing here reads or writes a tenant's rows, and `check:tenant-scope`
 * allows `server_instances` in `src/operations/` only.
 */
import type { LicenseState } from '@wirebench/engine';
import type { InstanceMode } from '../config.js';
import { RENEW_MS } from '../host/lease.js';
import type { BusEvents } from './bus.js';

/** How often the row is renewed: the host leases' interval, on the same timer. */
export const HEARTBEAT_MS = RENEW_MS;
/** A row not renewed for this long is a dead process's. */
export const DEAD_MS = 60_000;
/** How often a running `multi` server checks that its license still allows it (spec §20.1). */
export const LICENSE_CHECK_MS = 60 * 60_000;

const DEAD_INTERVAL = `interval '${String(DEAD_MS / 1000)} seconds'`;

const RENEW_ROW = `insert into server_instances (holder, url, version) values ($1::uuid, $2, $3)
  on conflict (holder) do update set renewed_at = now(), url = excluded.url, version = excluded.version`;
const SWEEP = `delete from server_instances where renewed_at < now() - ${DEAD_INTERVAL}`;
const DELETE_OWN = 'delete from server_instances where holder = $1::uuid';
const LIVE = `select holder::text as holder, url, version,
    to_char(started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as started_at,
    to_char(renewed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as renewed_at,
    floor(extract(epoch from (now() - started_at)))::int as age_seconds,
    floor(extract(epoch from (now() - renewed_at)))::int as renewed_seconds_ago
  from server_instances where renewed_at >= now() - ${DEAD_INTERVAL}
  order by started_at, holder`;

/** The slice of the server's pool the registry uses: the table is unscoped, so no tenant unit is involved. */
export interface InstanceQuerier {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: R[] }>;
}

/** One live instance, as `admin instances` lists it. */
export interface InstanceRow {
  readonly holder: string;
  /** `WIREBENCH_SERVER_INSTANCE_URL`; `null` in `single`. */
  readonly url: string | null;
  readonly version: string;
  /** ISO 8601, UTC, to the second. */
  readonly startedAt: string;
  readonly renewedAt: string;
  readonly ageSeconds: number;
  readonly renewedSecondsAgo: number;
}

/** What `/readyz` says of this process (spec §20.9); only `ready` answers `200`. */
export type Readiness = 'starting' | 'ready' | 'reconnecting' | 'draining';

/** What a module sees of this process (`ctx.instance`). */
export interface ServerInstance {
  /** This process's id, random at start-up: the instance row's key and the host leases' holder. */
  readonly holder: string;
  readonly mode: InstanceMode;
  /** Runs `listener` on every heartbeat; a failure is logged and is the listener's own. */
  onBeat(listener: () => Promise<void>): void;
  /** Every instance renewed within {@link DEAD_MS}, this one included: the live hub drops a dead holder's presence. */
  live(): Promise<InstanceRow[]>;
  /** Whether this process takes new sockets (spec §20.9), as `/readyz` reports it. */
  readiness(): Readiness;
  /** Set from the shutdown's first step (spec §20.5): every socket route refuses an upgrade from then on. */
  readonly draining: boolean;
  /**
   * Runs `listener` when the shutdown begins, before the app closes; the shutdown waits for every listener, and a
   * failure is logged and is the listener's own.
   */
  onDrain(listener: () => Promise<void>): void;
}

export interface InstanceRegistryDeps {
  readonly db: InstanceQuerier;
  readonly holder: string;
  readonly mode: InstanceMode;
  /** Stored in `multi` only. */
  readonly url?: string;
  readonly version: string;
  readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
  readonly log: (message: string, error: unknown) => void;
  /**
   * Whether the row is written. Only a test's start-up without migration `0020` (and so without `0022`) passes
   * `false`; the heartbeat still beats.
   */
  readonly record?: boolean;
}

export class InstanceRegistry implements ServerInstance {
  readonly holder: string;
  readonly mode: InstanceMode;
  private readonly listeners: (() => Promise<void>)[] = [];
  private readonly drainListeners: (() => Promise<void>)[] = [];
  private draining_: Promise<void> | undefined;
  private served = false;
  private listening = false;
  private timer: { cancel(): void } | undefined;
  private started = false;
  private stopped = false;
  /** The beat still running, which a later beat skips and {@link stop} waits for (review M3). */
  private beating: Promise<void> | undefined;

  constructor(private readonly deps: InstanceRegistryDeps) {
    this.holder = deps.holder;
    this.mode = deps.mode;
  }

  onBeat(listener: () => Promise<void>): void {
    this.listeners.push(listener);
  }

  /** Follows the bus: listening after each listen, not after a loss. The start-up calls it before the bus starts. */
  watchBus(bus: BusEvents): void {
    bus.onListen(() => {
      this.listening = true;
    });
    bus.onLost(() => {
      this.listening = false;
    });
  }

  /** The start-up has finished: the process listens, and takes sockets while the bus does. */
  serving(): void {
    this.served = true;
  }

  readiness(): Readiness {
    if (this.draining_ !== undefined) return 'draining';
    if (!this.served) return 'starting';
    return this.listening ? 'ready' : 'reconnecting';
  }

  get draining(): boolean {
    return this.draining_ !== undefined;
  }

  onDrain(listener: () => Promise<void>): void {
    this.drainListeners.push(listener);
  }

  /** The shutdown's first step: every drain listener, side by side; a second call is the same drain. Never throws. */
  drain(): Promise<void> {
    this.draining_ ??= Promise.all(
      this.drainListeners.map((listener) =>
        Promise.resolve()
          .then(listener)
          .catch((error: unknown) => {
            this.deps.log('a drain listener failed', error);
          }),
      ),
    ).then(() => undefined);
    return this.draining_;
  }

  /** Inserts this process's row, then beats every {@link HEARTBEAT_MS} until {@link stop}. Throws if the insert does. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.recording) await this.deps.db.query(RENEW_ROW, this.rowParams());
    this.arm();
  }

  /**
   * One heartbeat: the row's renew and sweep, and every listener, side by side. Never throws. While one runs, another
   * call waits for it instead of starting a second, and after {@link stop} none starts.
   */
  renew(): Promise<void> {
    if (this.beating !== undefined) return this.beating;
    if (this.stopped) return Promise.resolve();
    const beat = this.beat().finally(() => {
      this.beating = undefined;
    });
    this.beating = beat;
    return beat;
  }

  private async beat(): Promise<void> {
    const row = this.recording
      ? (async () => {
          await this.deps.db.query(RENEW_ROW, this.rowParams());
          await this.deps.db.query(SWEEP);
        })().catch((error: unknown) => {
          this.deps.log('the instance row could not be renewed', error);
        })
      : Promise.resolve();
    const listeners = this.listeners.map((listener) =>
      Promise.resolve()
        .then(listener)
        .catch((error: unknown) => {
          this.deps.log('a heartbeat listener failed', error);
        }),
    );
    await Promise.all([row, ...listeners]);
  }

  /** Every instance renewed within {@link DEAD_MS}, this one included, oldest first. */
  async live(): Promise<InstanceRow[]> {
    return listLive(this.deps.db);
  }

  /**
   * Stops the heartbeat and deletes this process's row; a failure is logged, and the row dies in {@link DEAD_MS}. A
   * beat still running is waited for first: its upsert landing after the delete would bring the row back.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
    await this.beating;
    if (!this.started || !this.recording) return;
    try {
      await this.deps.db.query(DELETE_OWN, [this.holder]);
    } catch (error) {
      this.deps.log('the instance row could not be deleted; it is swept once dead', error);
    }
  }

  private get recording(): boolean {
    return this.deps.record !== false;
  }

  private rowParams(): unknown[] {
    return [this.holder, this.mode === 'multi' ? (this.deps.url ?? null) : null, this.deps.version];
  }

  private arm(): void {
    if (this.stopped) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = undefined;
      void this.renew();
      this.arm();
    }, HEARTBEAT_MS);
  }
}

/**
 * Waits for `drain` (spec §20.5) at most `ms`: past it, the shutdown goes on and says so, and the drain's listeners
 * run on while the app closes. `0` waits not at all (the running lock is lost). Never rejects.
 */
export async function drainWithin(drain: Promise<void>, ms: number, warn: (message: string) => void): Promise<void> {
  const settled = drain.then(
    () => true,
    () => true,
  );
  if (ms <= 0) return;
  let timer: NodeJS.Timeout | undefined;
  const done = await Promise.race([
    settled,
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
  if (!done) warn('the drain did not finish within the drain time; the shutdown goes on');
}

/** The live rows, for the registry and for `admin instances`, which reads them without a registry of its own. */
export async function listLive(db: InstanceQuerier): Promise<InstanceRow[]> {
  const result = await db.query<{
    holder: string;
    url: string | null;
    version: string;
    started_at: string;
    renewed_at: string;
    age_seconds: number;
    renewed_seconds_ago: number;
  }>(LIVE);
  return result.rows.map((row) => ({
    holder: row.holder,
    url: row.url,
    version: row.version,
    startedAt: row.started_at,
    renewedAt: row.renewed_at,
    ageSeconds: Number(row.age_seconds),
    renewedSecondsAgo: Number(row.renewed_seconds_ago),
  }));
}

/** Whether `state` lets a self-hosted server run as several instances (ruling 3): Enterprise, valid or in grace. */
export function allowsMultipleInstances(state: Pick<LicenseState, 'edition' | 'status'> | undefined): boolean {
  return (
    state !== undefined && state.edition === 'enterprise' && (state.status === 'active' || state.status === 'grace')
  );
}

/**
 * A heartbeat listener for a running self-hosted `multi` server (spec §20.1): once every {@link LICENSE_CHECK_MS} it
 * reads the default tenant's license and warns when it no longer allows `multi`. It never stops the server; the next
 * start refuses. A read that fails warns too, as the next start would refuse.
 */
export function licenseLapseWatch(deps: {
  readonly read: () => Promise<Pick<LicenseState, 'edition' | 'status'> | undefined>;
  readonly warn: (message: string, details: Record<string, unknown>) => void;
  /** Milliseconds, monotonic; `performance.now` by default. */
  readonly now?: () => number;
  readonly everyMs?: number;
}): () => Promise<void> {
  const now = deps.now ?? (() => performance.now());
  const every = deps.everyMs ?? LICENSE_CHECK_MS;
  // The start-up checked it just now.
  let last = now();
  return async () => {
    const at = now();
    if (at - last < every) return;
    last = at;
    let state: Pick<LicenseState, 'edition' | 'status'> | undefined;
    try {
      state = await deps.read();
    } catch {
      state = undefined;
    }
    if (allowsMultipleInstances(state)) return;
    deps.warn(
      'the license no longer allows several instances: this instance keeps running, and the next start refuses with server-instances-need-enterprise',
      { edition: state?.edition ?? null, status: state?.status ?? null },
    );
  };
}
