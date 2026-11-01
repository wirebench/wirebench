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
 *   only this holder's row, so a lease lost to another process is never taken from it.
 *
 * Self-hosted start-up deletes every lease ({@link clearLeasesAtStartUp}): it is one process (ADR-0013), so a lease
 * it finds is a crashed run's, and leaving it would keep that user out for a minute.
 *
 * The cap (Task 27) goes in the take's unit, between the expired delete and the insert: it counts the tenant's live
 * leases under the same lock.
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
  returning user_id`;
const REMAINING = `select greatest(0, ceil(extract(epoch from (expires_at - now())) * 1000))::int as remaining
  from host_leases where user_id = $1`;
export const RENEW = `update host_leases set renewed_at = now(), expires_at = now() + ${LEASE_INTERVAL}
  where holder = $1 and user_id = any($2::text[]) returning user_id`;
const RELEASE = 'delete from host_leases where user_id = $1 and holder = $2';

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

/** What `HostInstances` needs of the lease. */
export interface InstanceLeases {
  /** Takes `user`'s lease; throws `host-lease-held` (details `retryAfterMs`) when another process holds it. */
  take(user: HostUserKey): Promise<void>;
  /** Gives `user`'s lease back; never throws (a failure is logged, and the row expires). */
  release(user: HostUserKey): Promise<void>;
  /** Told of each lease lost to another holder or gone stale; its instance must stop. */
  onLost(listener: (user: HostUserKey) => void): void;
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
}

/** One held lease. A new take makes a new object, so an answer about an older one never touches it. */
interface Held {
  readonly user: HostUserKey;
  /** When, by {@link HostLeasesDeps.now}, the statement that last confirmed it was sent. */
  confirmedAt: number;
}

export class HostLeases implements InstanceLeases {
  /** By tenant id, then user id. A tenant appears only while it has a lease here. */
  private readonly held = new Map<string, Map<string, Held>>();
  /** Tenants with a renew still out: the next tick skips them rather than queue a second one. */
  private readonly renewing = new Set<string>();
  private readonly listeners: ((user: HostUserKey) => void)[] = [];
  private renewTimer: { cancel(): void } | undefined;
  private watchdog: { cancel(): void } | undefined;
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly deps: HostLeasesDeps) {
    this.now = deps.now ?? (() => performance.now());
  }

  onLost(listener: (user: HostUserKey) => void): void {
    this.listeners.push(listener);
  }

  async take(user: HostUserKey): Promise<void> {
    if (this.closed) throw new WirebenchError('host-closing', 'the server is shutting down');
    const sent = this.now();
    const remaining = await this.deps.db(user.tenant).transaction(async (tx) => {
      await tx.query(LEASE_LOCK, [tx.scope.tenantId]);
      await tx.query(DELETE_EXPIRED);
      const taken = await tx.query<{ user_id: string }>(TAKE, [user.id, this.deps.holder]);
      if (taken.rows.length > 0) return undefined;
      const left = await tx.query<{ remaining: number }>(REMAINING, [user.id]);
      return Number(left.rows[0]?.remaining ?? LEASE_MS);
    });
    if (remaining !== undefined) {
      throw new WirebenchError('host-lease-held', 'another server process holds this user’s browser host', {
        details: { retryAfterMs: remaining },
      });
    }
    let tenant = this.held.get(user.tenant.tenantId);
    if (tenant === undefined) {
      tenant = new Map();
      this.held.set(user.tenant.tenantId, tenant);
    }
    tenant.set(user.id, { user, confirmedAt: sent });
    this.arm();
  }

  async release(user: HostUserKey): Promise<void> {
    this.forget(user);
    try {
      await this.deps.db(user.tenant).query(RELEASE, [user.id, this.deps.holder]);
    } catch (error) {
      this.deps.log('a host lease could not be released; it expires on its own', error);
    }
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
      void this.renew();
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
    for (const user of stale) this.lose(user, 'a host lease went unrenewed past half its time; its host stops');
    this.armWatchdog();
  }

  private lose(user: HostUserKey, why: string): void {
    this.forget(user);
    this.deps.log(why, undefined);
    for (const listener of this.listeners) {
      try {
        listener(user);
      } catch (error) {
        this.deps.log('a host lease listener failed', error);
      }
    }
  }

  /** One statement per tenant this process holds a lease in, each in its own unit; one tenant's failure is its own. */
  private async renew(): Promise<void> {
    const sends: Promise<void>[] = [];
    for (const [tenantId, tenant] of this.held) {
      if (this.renewing.has(tenantId)) continue;
      const sent = [...tenant.values()];
      const scope: TenantScope = sent[0]!.user.tenant;
      const at = this.now();
      this.renewing.add(tenantId);
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
                else this.lose(one.user, 'a host lease was lost to another server process; its host stops');
              }
              this.armWatchdog();
            },
            (error: unknown) => {
              this.deps.log('host leases could not be renewed', error);
            },
          )
          .finally(() => {
            this.renewing.delete(tenantId);
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
