/**
 * The host-instance lease (hosted edition spec §19.9): at most one process holds a user's host, so two processes
 * never write one checkout (§5.5). A lease is a `host_leases` row (from `0020`, scoped like every other table) with
 * an expiry on the database's clock.
 *
 * - **Taking it.** Before a user's host is built, one tenant unit takes the tenant's lease lock, deletes the
 *   tenant's expired leases, then inserts the user's row, or takes it over when it is this process's own or has
 *   expired. No row back means another process holds the user: {@link HostLeases.take} throws `host-lease-held`
 *   with the lease's remaining time as `retryAfterMs`.
 * - **Keeping it.** While this process holds any lease, it renews every {@link RENEW_MS} with one statement per
 *   tenant it holds a lease in (never for the others). A held user missing from the answer was lost to another
 *   holder. A lease this process has not confirmed for {@link STALE_MS}, by its own monotonic clock, is given up
 *   half a lease before anyone else could take it: the database could not be reached, so the instance stops on its
 *   own. Both reach the listener of {@link HostLeases.onLost}, which closes the instance's sockets and disposes it.
 * - **Giving it back.** {@link HostLeases.release} deletes the row, once the host's quit path has run; it deletes
 *   only this holder's row of the take it gives back (its `acquired_at`), so neither a lease lost to another
 *   process nor this process's next take of the user is ever deleted by it, however late the delete arrives.
 *
 * Self-hosted start-up deletes every lease ({@link clearLeasesAtStartUp}): it is one process (ADR-0013), so a lease
 * it finds is a crashed run's, and leaving it would keep that user out for a minute.
 *
 * **The cap** (decision 11). A tenant holds at most its seat limit of live leases, counted across processes in the
 * take's unit, between the expired delete and the insert, under the same lock: two takes racing for the last seat,
 * in one process or two, run one after the other, and the second counts the first's row. At the cap the take
 * throws `host-instance-cap`; `HostInstances` then evicts this process's idle instances of the tenant and tries
 * again. A user's own row is not counted, so a take that renews this holder's lease is never refused. At the cap, a
 * user whose lease another process holds is told `host-lease-held` with its remaining time, as below the cap: that
 * user's host is open elsewhere, and freeing a seat here would not let them in.
 */
import { WirebenchError } from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import type { ServerMode } from '../config.js';
import { SERVER_SCHEMA } from '../tenancy/running-lock.js';
import type { TenantScope } from '../tenancy/scope.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import type { TenantDbFactory, TenantQuerier } from '../tenancy/tenant-db.js';
import type { HostUserKey } from './instances.js';

/** The lease lock's first key, an int4 (the ASCII of "WBHL"); the second hashes the schema and the tenant. */
export const HOST_LEASE_CLASS = 0x5742484c;
/** How long a lease lasts past its last take or renew, on the database's clock. */
export const LEASE_MS = 60_000;
/** How often a held lease is renewed. */
export const RENEW_MS = 15_000;
/** How long, by this process's clock, a lease may go unconfirmed before its instance stops: half a lease. */
export const STALE_MS = 30_000;
/**
 * A renew out this long no longer holds back the tenant's next one. A renew sent on a half-open connection can wait
 * many minutes for an error; until then every new lease of the tenant would go unrenewed and stop at {@link STALE_MS}.
 * Half an interval, so the next tick always sends; its late answer is harmless (see `renew`).
 */
export const RENEW_GIVE_UP_MS = RENEW_MS / 2;
/** How long an eviction or shutdown waits for a release to answer; the row expires on its own after that. */
export const RELEASE_WAIT_MS = 5_000;

const LEASE_INTERVAL = `interval '${String(LEASE_MS / 1000)} seconds'`;

/**
 * The tenant's lease lock (spec §19.8 guard 5), keyed by the schema and the tenant like the seat and chain locks, so
 * two tenants never wait on each other and neither do two test schemas. `$1` is the tenant id.
 */
export const LEASE_LOCK = `select pg_advisory_xact_lock(${String(HOST_LEASE_CLASS)}, hashtext(coalesce(${SERVER_SCHEMA}, '') || ':' || $1::text))`;

const DELETE_EXPIRED = 'delete from host_leases where expires_at < now()';
const TAKE = `insert into host_leases (user_id, holder, acquired_at, renewed_at, expires_at)
  values ($1, $2, now(), now(), now() + ${LEASE_INTERVAL})
  on conflict (tenant_id, user_id) do update
    set holder = excluded.holder, acquired_at = excluded.acquired_at, renewed_at = excluded.renewed_at,
        expires_at = excluded.expires_at
    where host_leases.holder = excluded.holder or host_leases.expires_at < now()
  returning user_id, acquired_at::text as acquired`;
/** The tenant's live leases other than the user's own (`$1`): the expired ones were deleted just before. */
export const COUNT_LIVE = 'select count(*)::int as count from host_leases where user_id <> $1';
/** The user's live lease under another holder, at the cap (expired ones are gone): `$2` is this holder. */
const HELD_ELSEWHERE = `select greatest(0, ceil(extract(epoch from (expires_at - now())) * 1000))::int as remaining
  from host_leases where user_id = $1 and holder <> $2`;
const REMAINING = `select greatest(0, ceil(extract(epoch from (expires_at - now())) * 1000))::int as remaining
  from host_leases where user_id = $1`;
export const RENEW = `update host_leases set renewed_at = now(), expires_at = now() + ${LEASE_INTERVAL}
  where holder = $1 and user_id = any($2::text[]) returning user_id`;
/**
 * `$3` is the take's `acquired_at`, as text so no precision is lost. Every take sets it to its own transaction's
 * `now()`, and one user's takes in one process follow each other (the next starts after the last committed), so a
 * release sent before this process took the user again, and answered after, misses the new row.
 */
const RELEASE = 'delete from host_leases where user_id = $1 and holder = $2 and acquired_at = $3::timestamptz';

/** Why a held lease ended without a release: another holder has it, or this process could not renew it in time. */
export type LeaseLoss = 'lost' | 'expired';

/** The reason a refused socket closes `4409` with: the code, then how long to wait (spec §19.9). */
export function leaseHeldReason(retryAfterMs: number): string {
  return `host-lease-held retryAfterMs=${String(Math.max(0, Math.ceil(retryAfterMs)))}`;
}

/** The `retryAfterMs` of a `host-lease-held` error, or `undefined` for any other. */
export function leaseRetryAfter(error: unknown): number | undefined {
  if (!(error instanceof WirebenchError) || error.code !== 'host-lease-held') return undefined;
  const value = error.details?.['retryAfterMs'];
  return typeof value === 'number' ? value : LEASE_MS;
}

/** Whether `error` is a take refused at the tenant's instance cap. */
export function isInstanceCap(error: unknown): boolean {
  return error instanceof WirebenchError && error.code === 'host-instance-cap';
}

/** What `HostInstances` needs of the lease. */
export interface InstanceLeases {
  /**
   * Takes `user`'s lease; throws `host-lease-held` (details `retryAfterMs`) when another process holds it, and
   * `host-instance-cap` when the tenant's seats all hold one already.
   */
  take(user: HostUserKey): Promise<void>;
  /**
   * Gives `user`'s lease back; never throws (a failure is logged, and the row expires). Resolves `true` when no row
   * of this take is left (the delete answered, even with no row, or nothing was held), `false` when the delete
   * failed or went unanswered, so the row may still hold a seat.
   */
  release(user: HostUserKey): Promise<boolean>;
  /** Told of each lease lost to another holder (`lost`) or gone stale (`expired`); its instance must stop. */
  onLost(listener: (user: HostUserKey, why: LeaseLoss) => void): void;
  /** Stops the renewals and gives back whatever is still held. */
  close(): Promise<void>;
}

export interface HostLeasesDeps {
  readonly db: TenantDbFactory;
  /** This process's id, random at start-up. */
  readonly holder: string;
  readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
  /** A monotonic clock in milliseconds (`performance.now`): only when to stop early, never an expiry. */
  readonly now?: () => number;
  readonly log: (message: string, error: unknown) => void;
  /**
   * The tenant's seat limit, read inside the take's unit (`LicenseService.state(scope, tx)`); `null` is no cap.
   * Without it (a test), there is no cap.
   */
  readonly seatLimit?: (tx: TenantQuerier) => Promise<number | null>;
}

/** One held lease. A new take makes a new object, so an answer about an older one never touches it. */
interface Held {
  readonly user: HostUserKey;
  /** The take's `acquired_at`: the release deletes only this take's row. */
  readonly acquired: string;
  /** When, by {@link HostLeasesDeps.now}, the statement that last confirmed it was sent. */
  confirmedAt: number;
}

function keyOf(user: HostUserKey): string {
  return `${user.tenant.tenantId}:${user.id}`;
}

export class HostLeases implements InstanceLeases {
  /** By tenant id, then user id. A tenant appears only while it has a lease here. */
  private readonly held = new Map<string, Map<string, Held>>();
  /**
   * Tenants with a renew still out, and when it was sent. A renew asked for again within {@link RENEW_GIVE_UP_MS}
   * skips them; only `renewNow` can ask that soon, since the timer's ticks are {@link RENEW_MS} apart. The mark is
   * mostly for `finally`, which clears only its own.
   */
  private readonly renewing = new Map<string, { readonly sentAt: number }>();
  /** The `acquired_at` of leases lost or stopped here, by user key, for the release that follows. */
  private readonly ended = new Map<string, string>();
  private readonly listeners: ((user: HostUserKey, why: LeaseLoss) => void)[] = [];
  private renewTimer: { cancel(): void } | undefined;
  private watchdog: { cancel(): void } | undefined;
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly deps: HostLeasesDeps) {
    this.now = deps.now ?? (() => performance.now());
  }

  onLost(listener: (user: HostUserKey, why: LeaseLoss) => void): void {
    this.listeners.push(listener);
  }

  async take(user: HostUserKey): Promise<void> {
    if (this.closed) throw new WirebenchError('host-closing', 'the server is shutting down');
    const sent = this.now();
    const remaining = await this.deps.db(user.tenant).transaction(async (tx) => {
      await tx.query(LEASE_LOCK, [tx.scope.tenantId]);
      await tx.query(DELETE_EXPIRED);
      const limit = (await this.deps.seatLimit?.(tx)) ?? null;
      if (limit !== null) {
        const live = await tx.query<{ count: number }>(COUNT_LIVE, [user.id]);
        if (Number(live.rows[0]?.count ?? 0) >= limit) {
          const elsewhere = await tx.query<{ remaining: number }>(HELD_ELSEWHERE, [user.id, this.deps.holder]);
          const row = elsewhere.rows[0];
          return row === undefined ? ('cap' as const) : Number(row.remaining);
        }
      }
      const taken = await tx.query<{ user_id: string; acquired: string }>(TAKE, [user.id, this.deps.holder]);
      if (taken.rows[0] !== undefined) return { acquired: taken.rows[0].acquired };
      const left = await tx.query<{ remaining: number }>(REMAINING, [user.id]);
      // No row: the holder released it after the insert was refused (a release takes no lock), so it is free now.
      return Number(left.rows[0]?.remaining ?? 0);
    });
    if (remaining === 'cap') {
      throw new WirebenchError('host-instance-cap', 'every seat of this team has a browser host open');
    }
    if (typeof remaining === 'number') {
      throw new WirebenchError('host-lease-held', 'another server process holds this user’s browser host', {
        details: { retryAfterMs: remaining },
      });
    }
    let tenant = this.held.get(user.tenant.tenantId);
    if (tenant === undefined) {
      tenant = new Map();
      this.held.set(user.tenant.tenantId, tenant);
    }
    this.ended.delete(keyOf(user));
    tenant.set(user.id, { user, acquired: remaining.acquired, confirmedAt: sent });
    this.arm();
  }

  /** Waits at most {@link RELEASE_WAIT_MS} for the delete, so an unreachable database never stalls an eviction. */
  async release(user: HostUserKey): Promise<boolean> {
    const key = keyOf(user);
    const acquired = this.held.get(user.tenant.tenantId)?.get(user.id)?.acquired ?? this.ended.get(key);
    this.ended.delete(key);
    this.forget(user);
    // Nothing taken here, or given back already: no row of ours holds a seat, so there is nothing to delete.
    if (acquired === undefined) return true;
    const deleted = this.deps
      .db(user.tenant)
      .query(RELEASE, [user.id, this.deps.holder, acquired])
      .then(
        () => true,
        (error: unknown) => {
          this.deps.log('a host lease could not be released; it expires on its own', error);
          return 'failed' as const;
        },
      );
    let timer: { cancel(): void } | undefined;
    const waited = new Promise<false>((resolve) => {
      timer = this.deps.setTimer(() => {
        resolve(false);
      }, RELEASE_WAIT_MS);
    });
    const answered = await Promise.race([deleted, waited]);
    timer?.cancel();
    if (!answered) this.deps.log('a host lease release went unanswered; it expires on its own', undefined);
    return answered === true;
  }

  async close(): Promise<void> {
    this.closed = true;
    const left = [...this.held.values()].flatMap((tenant) => [...tenant.values()].map((one) => one.user));
    await Promise.all(left.map((user) => this.release(user)));
    this.disarm();
  }

  /** Test only: runs the renewals now, as the timer would, and resolves once every answer is in. */
  async renewNow(): Promise<void> {
    await this.renew();
  }

  /** How many leases this process holds, for tests. */
  get size(): number {
    let count = 0;
    for (const tenant of this.held.values()) count += tenant.size;
    return count;
  }

  private forget(user: HostUserKey): void {
    const tenant = this.held.get(user.tenant.tenantId);
    if (tenant === undefined) return;
    tenant.delete(user.id);
    if (tenant.size === 0) this.held.delete(user.tenant.tenantId);
    if (this.held.size === 0) this.disarm();
    else this.armWatchdog();
  }

  /** The renewal timer and the watchdog run only while something is held. */
  private arm(): void {
    this.armRenew();
    this.armWatchdog();
  }

  private armRenew(): void {
    if (this.renewTimer !== undefined || this.closed || this.held.size === 0) return;
    this.renewTimer = this.deps.setTimer(() => {
      this.renewTimer = undefined;
      void this.renew().catch((error: unknown) => {
        this.deps.log('host leases could not be renewed', error);
      });
      this.armRenew();
    }, RENEW_MS);
  }

  private disarm(): void {
    this.renewTimer?.cancel();
    this.renewTimer = undefined;
    this.watchdog?.cancel();
    this.watchdog = undefined;
  }

  /** Armed for the oldest confirmation's stale time, so a lease stops at {@link STALE_MS}, not at the next tick. */
  private armWatchdog(): void {
    this.watchdog?.cancel();
    this.watchdog = undefined;
    let oldest: number | undefined;
    for (const tenant of this.held.values()) {
      for (const one of tenant.values())
        oldest = oldest === undefined ? one.confirmedAt : Math.min(oldest, one.confirmedAt);
    }
    if (oldest === undefined || this.closed) return;
    this.watchdog = this.deps.setTimer(
      () => {
        this.watchdog = undefined;
        this.stopStale();
      },
      Math.max(0, oldest + STALE_MS - this.now()),
    );
  }

  private stopStale(): void {
    const at = this.now();
    const stale: HostUserKey[] = [];
    for (const tenant of this.held.values()) {
      for (const one of tenant.values()) if (at - one.confirmedAt >= STALE_MS) stale.push(one.user);
    }
    for (const user of stale)
      this.lose(user, 'expired', 'a host lease went unrenewed past half its time; its host stops');
    this.armWatchdog();
  }

  private lose(user: HostUserKey, why: LeaseLoss, message: string): void {
    const acquired = this.held.get(user.tenant.tenantId)?.get(user.id)?.acquired;
    if (acquired !== undefined) this.ended.set(keyOf(user), acquired);
    this.forget(user);
    this.deps.log(message, undefined);
    for (const listener of this.listeners) {
      try {
        listener(user, why);
      } catch (error) {
        this.deps.log('a host lease listener failed', error);
      }
    }
  }

  /**
   * One statement per tenant this process holds a lease in, each in its own unit; one tenant's failure is its own.
   * An answer that comes after the next renew was sent is still harmless: it judges only the very leases it was sent
   * for, and a confirmation never moves back.
   */
  private async renew(): Promise<void> {
    const sends: Promise<void>[] = [];
    for (const [tenantId, tenant] of this.held) {
      const at = this.now();
      const out = this.renewing.get(tenantId);
      if (out !== undefined && at - out.sentAt < RENEW_GIVE_UP_MS) continue;
      const sent = [...tenant.values()];
      const scope: TenantScope = sent[0]!.user.tenant;
      const mark = { sentAt: at };
      this.renewing.set(tenantId, mark);
      sends.push(
        this.deps
          .db(scope)
          .query<{ user_id: string }>(RENEW, [this.deps.holder, sent.map((one) => one.user.id)])
          .then(
            (result) => {
              const kept = new Set(result.rows.map((row) => row.user_id));
              for (const one of sent) {
                // Released, or released and taken again, while the renew was out: not this answer's to judge.
                if (this.held.get(tenantId)?.get(one.user.id) !== one) continue;
                if (kept.has(one.user.id)) one.confirmedAt = Math.max(one.confirmedAt, at);
                else this.lose(one.user, 'lost', 'a host lease was lost to another server process; its host stops');
              }
              this.armWatchdog();
            },
            (error: unknown) => {
              this.deps.log('host leases could not be renewed', error);
            },
          )
          .finally(() => {
            if (this.renewing.get(tenantId) === mark) this.renewing.delete(tenantId);
          }),
      );
    }
    await Promise.all(sends);
  }
}

/**
 * Self-hosted start-up (spec §19.9): every lease is a crashed run's, since a self-hosted server is one process, so
 * each tenant's are deleted, through the job loop (the app role outside a tenant sees no row). A hosted process
 * leaves them to expire. A multi-instance self-hosted server (slice 5) must drop this (§19.12).
 */
export async function clearLeasesAtStartUp(
  mode: ServerMode,
  tenancy: Pick<Tenancy, 'forEachTenant'>,
  log: Pick<FastifyBaseLogger, 'error'>,
): Promise<void> {
  if (mode === 'hosted') return;
  await tenancy.forEachTenant(
    'host-lease-clear',
    async (tx: TenantQuerier) => {
      await tx.query('delete from host_leases');
    },
    log,
  );
}
