/**
 * The host-instance lease (hosted edition spec §19.9), over a real database with two holders, as two server
 * processes would be: one process per user's host, a takeover after expiry, a lost lease stopping its instance, a
 * process that cannot renew stopping its own before anyone could take over, one renew statement per tenant that has
 * an instance here and none for the others, a release after eviction and at shutdown, and self-hosted start-up
 * clearing every tenant's leases. Hosts are fakes and timers manual; the clock is a counter.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerHost } from '../../../src/host/host-runtime.js';
import { HostInstances, type HostSocketHandle, type HostUser } from '../../../src/host/instances.js';
import {
  clearLeasesAtStartUp,
  COUNT_LIVE,
  HOST_LEASE_CLASS,
  HostLeases,
  LEASE_LOCK,
  LEASE_MS,
  RELEASE_WAIT_MS,
  RENEW,
  RENEW_MS,
  STALE_MS,
} from '../../../src/host/lease.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import type { TenantDbFactory } from '../../../src/tenancy/tenant-db.js';
import { createTenancy, directoryOf, type Tenancy } from '../../../src/tenancy/tenancy.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { statementLog, type StatementLog } from '../../helpers/tenancy.js';
import { testInstance } from '../../helpers/context.js';
import { manualTimers, type ManualTimers } from '../../helpers/timers.js';

const IDLE_MS = 30 * 60_000;
const quiet = { error: () => undefined };

function fakeHost(order: string[], name: string): ServerHost & { disposed: number } {
  const host = {
    disposed: 0,
    capabilities: ['send:public'],
    osTheme: 'light' as const,
    channels: () => [],
    attach: () => undefined,
    serve: () => Promise.reject(new Error('unused')),
    detach: () => Promise.resolve(),
    dispose: () => {
      host.disposed += 1;
      order.push(`disposed ${name}`);
      return Promise.resolve();
    },
  };
  return host;
}

function socket(token: string): HostSocketHandle & { closed: { code: number; reason: string }[] } {
  const closed: { code: number; reason: string }[] = [];
  return { token, tokenId: `id-${token}`, closed, close: (code, reason) => closed.push({ code, reason }) };
}

/** One server process: its own holder, timers, clock and instances, over the shared database. */
interface Process {
  readonly leases: HostLeases;
  readonly instances: HostInstances;
  readonly timers: ManualTimers;
  readonly hosts: Map<string, ServerHost & { disposed: number }>;
  readonly order: string[];
  clock: number;
}

describeDb('the host-instance lease (spec §19.9)', () => {
  let db: TestDatabase;
  let tenancy: Tenancy;
  let log: StatementLog;
  let home: TenantScope;
  let acme: TenantScope;
  let dataDir: string;
  let alice: HostUser;
  let bob: HostUser;
  let carol: HostUser;
  let dave: HostUser;
  let erin: HostUser;
  let made: Process[];
  /** Each tenant's seat limit, as its license would give it; a tenant not here is unlimited. */
  let seatLimits: Map<string, number>;

  beforeAll(async () => {
    db = await testDatabase();
    log = statementLog();
    tenancy = createTenancy(db, { onStatement: log.onStatement });
    const directory = directoryOf(tenancy);
    await directory.load();
    home = directory.defaultScope();
    acme = (await new TenantAdmin(db, directory).create({ slug: 'acme', name: 'Acme' })).scope;
    const addUser = async (scope: TenantScope, id: string, email: string): Promise<HostUser> => {
      await tenancy
        .db(scope)
        .query('insert into users (id, email, email_lower, display_name) values ($1, $2, $2, $1)', [id, email]);
      return { id, email, serverUrl: 'https://wirebench.test', tenant: scope };
    };
    alice = await addUser(home, 'U-alice', 'alice@example.com');
    bob = await addUser(home, 'U-bob', 'bob@example.com');
    carol = await addUser(acme, 'U-carol', 'carol@example.com');
    dave = await addUser(home, 'U-dave', 'dave@example.com');
    erin = await addUser(home, 'U-erin', 'erin@example.com');
    dataDir = await mkdtemp(join(tmpdir(), 'wb-host-lease-'));
  });
  afterAll(async () => {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    made = [];
    seatLimits = new Map();
    log.entries.length = 0;
  });
  afterEach(async () => {
    for (const one of made) await one.instances.closeAll();
    for (const scope of [home, acme]) await tenancy.db(scope).query('delete from host_leases');
  });

  /** `building`, when given, is awaited before a host is made: a test holds a build there. */
  const serverProcess = (
    holder: string,
    db: TenantDbFactory = tenancy.db,
    order: string[] = [],
    building?: (user: HostUser) => Promise<void>,
  ): Process => {
    const timers = manualTimers();
    const hosts = new Map<string, ServerHost & { disposed: number }>();
    const proc: Process = { timers, hosts, order, clock: 0 } as Process;
    const leases = new HostLeases({
      db,
      holder,
      setTimer: timers.setTimer,
      now: () => proc.clock,
      log: () => undefined,
      seatLimit: (tx) => Promise.resolve(seatLimits.get(tx.scope.tenantId) ?? null),
    });
    const instances = new HostInstances({
      dataDir,
      idleMs: IDLE_MS,
      setTimer: timers.setTimer,
      log: () => undefined,
      leases,
      create: async (user) => {
        await building?.(user);
        const host = fakeHost(order, user.id);
        hosts.set(`${user.tenant.tenantId}:${user.id}`, host);
        return host;
      },
    });
    Object.assign(proc, { leases, instances });
    made.push(proc);
    return proc;
  };
  const hostOf = (proc: Process, user: HostUser) => proc.hosts.get(`${user.tenant.tenantId}:${user.id}`);
  const leaseRows = async (scope: TenantScope) =>
    (
      await tenancy
        .db(scope)
        .query<{ user_id: string; holder: string }>('select user_id, holder from host_leases order by user_id')
    ).rows;
  /** A live lease row for `userId` under `holder`, as another process (or this one before a restart) left it. */
  const leaseFor = async (scope: TenantScope, userId: string, holder: string): Promise<void> => {
    await tenancy
      .db(scope)
      .query(
        "insert into host_leases (user_id, holder, acquired_at, renewed_at, expires_at) values ($1, $2, now(), now(), now() + interval '60 seconds')",
        [userId, holder],
      );
  };
  const expire = async (scope: TenantScope, userId: string): Promise<void> => {
    await tenancy
      .db(scope)
      .query("update host_leases set expires_at = now() - interval '1 second' where user_id = $1", [userId]);
  };
  /** The real database, with each release noted in `order`, in the order sent, beside the hosts' disposals. */
  const watching =
    (order: string[]): TenantDbFactory =>
    (scope) => {
      const real = tenancy.db(scope);
      return {
        ...real,
        query: (text: string, params?: readonly unknown[]) => {
          if (text.startsWith('delete from host_leases where user_id')) order.push(`released ${String(params?.[0])}`);
          return real.query(text, params);
        },
      } as unknown as ReturnType<TenantDbFactory>;
    };
  /**
   * The real database, but the statements `pick` names wait for the test: each one held is in `held`, to answer
   * (with the real query, or with a result the test makes up) or to leave unanswered.
   */
  const gated = (pick: (text: string) => boolean) => {
    const held: {
      text: string;
      params: readonly unknown[] | undefined;
      /** Resolves once the statement has its answer. */
      answer: (rows?: { user_id: string }[]) => Promise<void>;
    }[] = [];
    const factory: TenantDbFactory = (scope) => {
      const real = tenancy.db(scope);
      return {
        ...real,
        query: (text: string, params?: readonly unknown[]) => {
          if (!pick(text)) return real.query(text, params);
          return new Promise((resolve, reject) => {
            held.push({
              text,
              params,
              answer: async (rows) => {
                if (rows !== undefined) resolve({ rows, rowCount: rows.length });
                else await real.query(text, params).then(resolve, reject);
              },
            });
          });
        },
      } as unknown as ReturnType<TenantDbFactory>;
    };
    return { factory, held };
  };
  /** Lets the evictions and renews already started run to their end (fake hosts, so a few turns of the loop). */
  const settled = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  it('a second process is refused a held user, with the lease’s remaining time', async () => {
    const one = serverProcess('holder-one');
    const two = serverProcess('holder-two');
    expect(await one.instances.open(alice, socket('a1'))).toBeDefined();
    const refused = two.instances.open(alice, socket('a2'));
    await expect(refused).rejects.toMatchObject({ code: 'host-lease-held' });
    const error = (await refused.catch((e: unknown) => e)) as { details?: { retryAfterMs?: number } };
    expect(error.details?.retryAfterMs).toBeGreaterThan(LEASE_MS - 10_000);
    expect(error.details?.retryAfterMs).toBeLessThanOrEqual(LEASE_MS);
    expect(hostOf(two, alice)).toBeUndefined();
    expect(two.instances.size).toBe(0);
    expect(await leaseRows(home)).toEqual([{ user_id: alice.id, holder: 'holder-one' }]);
    // The holder takes its own lease again (a second take of the same user is not refused).
    await one.leases.take(alice);
    expect(await leaseRows(home)).toEqual([{ user_id: alice.id, holder: 'holder-one' }]);
    // Another user is free for the second process.
    expect(await two.instances.open(bob, socket('b1'))).toBeDefined();
  });

  it('a refused take whose holder released in between is told to wait nothing, not a full lease', async () => {
    const one = serverProcess('holder-one');
    // The holder's release lands between the refused insert and the remaining-time select: that select finds no row.
    const vanished: TenantDbFactory = (scope) => {
      const real = tenancy.db(scope);
      return {
        ...real,
        transaction: (fn: Parameters<typeof real.transaction>[0]) =>
          real.transaction((tx) =>
            fn(
              Object.assign(Object.create(tx) as typeof tx, {
                query: (text: string, params?: readonly unknown[]) =>
                  text.startsWith('select greatest')
                    ? Promise.resolve({ rows: [], rowCount: 0 })
                    : tx.query(text, params),
              }),
            ),
          ),
      } as unknown as ReturnType<TenantDbFactory>;
    };
    const two = serverProcess('holder-two', vanished);
    await one.instances.open(alice, socket('a1'));
    const error = (await two.instances.open(alice, socket('a2')).catch((e: unknown) => e)) as {
      code?: string;
      details?: { retryAfterMs?: number };
    };
    expect(error.code).toBe('host-lease-held');
    expect(error.details?.retryAfterMs).toBe(0);
  });

  it('after expiry the second process takes over', async () => {
    const one = serverProcess('holder-one');
    const two = serverProcess('holder-two');
    await one.instances.open(alice, socket('a1'));
    await expect(two.instances.open(alice, socket('a2'))).rejects.toMatchObject({ code: 'host-lease-held' });
    await expire(home, alice.id);
    expect(await two.instances.open(alice, socket('a3'))).toBeDefined();
    expect(await leaseRows(home)).toEqual([{ user_id: alice.id, holder: 'holder-two' }]);
  });

  it('a lease lost to another holder closes its sockets 4409 and disposes the instance', async () => {
    const order: string[] = [];
    const one = serverProcess('holder-one', watching(order), order);
    const two = serverProcess('holder-two');
    const first = socket('a1');
    const second = socket('a2');
    await one.instances.open(alice, first);
    await one.instances.open(alice, second);
    await one.instances.open(bob, socket('b1'));
    await expire(home, alice.id);
    await two.instances.open(alice, socket('a3'));
    await one.leases.renewNow();
    await settled();
    expect(first.closed).toEqual([{ code: 4409, reason: 'host-lease-lost' }]);
    expect(second.closed).toEqual([{ code: 4409, reason: 'host-lease-lost' }]);
    expect(hostOf(one, alice)?.disposed).toBe(1);
    // Bob's lease was renewed in the same statement and his instance stays.
    expect(hostOf(one, bob)?.disposed).toBe(0);
    expect(one.instances.size).toBe(1);
    // The loser's release after dispose has run, and it never deleted the winner's row.
    await expect.poll(() => order).toEqual([`disposed ${alice.id}`, `released ${alice.id}`]);
    expect(await leaseRows(home)).toEqual([
      { user_id: alice.id, holder: 'holder-two' },
      { user_id: bob.id, holder: 'holder-one' },
    ]);
  });

  it('a renew that cannot reach the database stops the instance at half a lease, before anyone could take it', async () => {
    let reachable = true;
    const broken: TenantDbFactory = (scope) => {
      const real = tenancy.db(scope);
      const down = () => Promise.reject(new Error('connect ECONNREFUSED'));
      return {
        ...real,
        query: (text: string, params?: readonly unknown[]) => (reachable ? real.query(text, params) : down()),
        transaction: (fn: Parameters<typeof real.transaction>[0]) => (reachable ? real.transaction(fn) : down()),
      } as unknown as ReturnType<TenantDbFactory>;
    };
    const one = serverProcess('holder-one', broken);
    const tab = socket('a1');
    await one.instances.open(alice, tab);
    reachable = false;
    one.clock = RENEW_MS;
    expect(one.timers.fire(RENEW_MS)).toBe(1);
    await settled();
    // One failed renew is not enough to stop.
    expect(tab.closed).toEqual([]);
    one.clock = STALE_MS;
    expect(one.timers.fire(STALE_MS)).toBeGreaterThan(0);
    await settled();
    // Not "lost": no other process has it, this one could not keep it.
    expect(tab.closed).toEqual([{ code: 4409, reason: 'host-lease-expired' }]);
    expect(hostOf(one, alice)?.disposed).toBe(1);
    expect(one.leases.size).toBe(0);
    reachable = true;
  });

  it('an unconfirmed lease is not stopped a moment before half a lease', async () => {
    let reachable = true;
    const broken: TenantDbFactory = (scope) => {
      const real = tenancy.db(scope);
      return {
        ...real,
        query: (text: string, params?: readonly unknown[]) =>
          reachable ? real.query(text, params) : Promise.reject(new Error('connect ECONNREFUSED')),
      } as unknown as ReturnType<TenantDbFactory>;
    };
    const one = serverProcess('holder-one', broken);
    const tab = socket('a1');
    await one.instances.open(alice, tab);
    reachable = false;
    one.clock = RENEW_MS;
    one.timers.fire(RENEW_MS);
    await settled();
    // The watchdog fires early (a timer may), finds the lease 1 ms short of stale, and waits that 1 ms more.
    one.clock = STALE_MS - 1;
    expect(one.timers.fire(STALE_MS)).toBe(1);
    await settled();
    expect(tab.closed).toEqual([]);
    expect(one.leases.size).toBe(1);
    one.clock = STALE_MS;
    expect(one.timers.fire(1)).toBe(1);
    await settled();
    expect(tab.closed).toEqual([{ code: 4409, reason: 'host-lease-expired' }]);
    reachable = true;
  });

  it('a renew that never answers holds back the tenant’s renews for half an interval, not until it errors', async () => {
    // The first renew is sent on a connection that never answers (half-open); the test answers the later ones.
    const { factory, held } = gated((text) => text === RENEW);
    const one = serverProcess('holder-one', factory);
    await one.instances.open(alice, socket('a1'));
    one.clock = RENEW_MS;
    one.timers.fire(RENEW_MS);
    expect(held).toHaveLength(1);
    // Unconfirmed for half a lease, Alice's instance stops, as it must.
    one.clock = STALE_MS;
    one.timers.fire(STALE_MS);
    await settled();
    expect(one.leases.size).toBe(0);
    // The database answers again: Bob's new lease is taken, and renewed at the next tick despite the renew still out.
    const tab = socket('b1');
    await one.instances.open(bob, tab);
    one.clock = STALE_MS + RENEW_MS;
    one.timers.fire(RENEW_MS);
    expect(held).toHaveLength(2);
    expect(held[1]!.params?.[1]).toEqual([bob.id]);
    await held[1]!.answer();
    await settled();
    // So the 30 s stop does not take Bob, who was confirmed at the renew.
    one.clock = STALE_MS * 2;
    one.timers.fire(STALE_MS);
    await settled();
    expect(tab.closed).toEqual([]);
    expect(one.leases.size).toBe(1);
    // The stuck renew's late answer (Alice "missing") judges only the lease it was sent for, long gone.
    await held[0]!.answer([]);
    await settled();
    expect(tab.closed).toEqual([]);
    expect(one.leases.size).toBe(1);
  });

  it('a renew answered after its lease was released and taken again leaves the new lease alone', async () => {
    const { factory, held } = gated((text) => text === RENEW);
    const lost: string[] = [];
    const leases = new HostLeases({
      db: factory,
      holder: 'holder-one',
      setTimer: manualTimers().setTimer,
      log: () => undefined,
    });
    leases.onLost((user) => lost.push(user.id));
    await leases.take(alice);
    const renewing = leases.renewNow();
    expect(held).toHaveLength(1);
    await leases.release(alice);
    await leases.take(alice);
    // The answer says Alice was not kept: about the old lease, not this one.
    await held[0]!.answer([]);
    await renewing;
    expect(lost).toEqual([]);
    expect(leases.size).toBe(1);
    await leases.close();
  });

  it('on the instance heartbeat, renews on each beat and arms no renew timer of its own (spec §20.2)', async () => {
    const timers = manualTimers();
    const heartbeat = testInstance('single', 'holder-one');
    const beating = new HostLeases({
      db: tenancy.db,
      holder: 'holder-two',
      setTimer: timers.setTimer,
      heartbeat,
      log: () => undefined,
    });
    // Nothing held: a beat sends nothing.
    await heartbeat.beat();
    await beating.take(alice);
    // One process, one timer: the beat's, not a lease timer.
    expect(timers.pending(RENEW_MS)).toBe(0);
    await expire(home, alice.id);
    await heartbeat.beat();
    // The beat renewed it: the row is live again under its holder.
    const live = await tenancy
      .db(home)
      .query<{ holder: string; live: boolean }>(
        'select holder, expires_at > now() as live from host_leases where user_id = $1',
        [alice.id],
      );
    expect(live.rows).toEqual([{ holder: 'holder-two', live: true }]);
    await beating.close();
  });

  it('a renew extends only the users this process holds, not an orphaned row of its own', async () => {
    const one = serverProcess('holder-one');
    // A row of this holder for Dave, whose release failed: this process holds no lease for him.
    await tenancy
      .db(home)
      .query(
        "insert into host_leases (user_id, holder, acquired_at, renewed_at, expires_at) values ($1, 'holder-one', now(), now(), now() + interval '20 seconds')",
        [dave.id],
      );
    await one.instances.open(alice, socket('a1'));
    await one.leases.renewNow();
    const rows = await tenancy.db(home).query<{
      user_id: string;
      short: boolean;
    }>("select user_id, expires_at < now() + interval '30 seconds' as short from host_leases order by user_id");
    expect(rows.rows).toEqual([
      { user_id: alice.id, short: false },
      { user_id: dave.id, short: true },
    ]);
  });

  it('a release that never answers holds up eviction and shutdown for a few seconds only', async () => {
    const { factory, held } = gated((text) => text.startsWith('delete from host_leases where user_id'));
    const one = serverProcess('holder-one', factory);
    await one.instances.open(alice, socket('a1'));
    let closed = false;
    const closing = one.instances.closeAll().then(() => {
      closed = true;
    });
    await expect.poll(() => held.length).toBe(1);
    await settled();
    expect(closed).toBe(false);
    expect(one.timers.fire(RELEASE_WAIT_MS)).toBe(1);
    await closing;
    expect(closed).toBe(true);
    // Its row expires on its own; here the delete is let through.
    await held[0]!.answer();
  });

  it('a release that gave up and lands after the user was taken again leaves the new lease alone', async () => {
    const { factory, held } = gated((text) => text.startsWith('delete from host_leases where user_id'));
    const one = serverProcess('holder-one', factory);
    const lost: string[] = [];
    one.leases.onLost((user) => lost.push(user.id));
    const tab = socket('a1');
    await one.instances.open(alice, tab);
    one.instances.release(alice, tab);
    expect(one.timers.fire(IDLE_MS)).toBe(1);
    await expect.poll(() => held.length).toBe(1);
    // The release gives up; the eviction ends and Alice's tab opens her again on this process.
    expect(one.timers.fire(RELEASE_WAIT_MS)).toBe(1);
    const again = socket('a2');
    expect(await one.instances.open(alice, again)).toBeDefined();
    // Now the old delete reaches the database.
    await held[0]!.answer();
    expect(await leaseRows(home)).toEqual([{ user_id: alice.id, holder: 'holder-one' }]);
    await one.leases.renewNow();
    await settled();
    expect(lost).toEqual([]);
    expect(again.closed).toEqual([]);
    expect(one.leases.size).toBe(1);
    // Shutdown's release is gated too: let it through, and it deletes the new lease.
    const closing = one.instances.closeAll();
    await expect.poll(() => held.length).toBe(2);
    await held[1]!.answer();
    await closing;
    expect(await leaseRows(home)).toEqual([]);
  });

  it('a release frees the seat when no row of its take is left: nothing held, or a delete that matched no row', async () => {
    const order: string[] = [];
    const leases = new HostLeases({
      db: watching(order),
      holder: 'holder-one',
      setTimer: manualTimers().setTimer,
      log: () => undefined,
    });
    // Never taken here: no delete is sent, and no seat of ours is left.
    expect(await leases.release(bob)).toBe(true);
    expect(order).toEqual([]);
    // Taken, then the row is no longer this take's (as if taken again): the delete matches nothing, and says so.
    await leases.take(alice);
    await tenancy
      .db(home)
      .query("update host_leases set acquired_at = acquired_at + interval '1 second' where user_id = $1", [alice.id]);
    expect(await leases.release(alice)).toBe(true);
    expect(order).toEqual([`released ${alice.id}`]);
    expect(await leaseRows(home)).toEqual([{ user_id: alice.id, holder: 'holder-one' }]);
  });

  it('a renewed lease is not stopped: the watchdog follows the last confirmation', async () => {
    const one = serverProcess('holder-one');
    const tab = socket('a1');
    await one.instances.open(alice, tab);
    one.clock = RENEW_MS;
    await one.leases.renewNow();
    // The watchdog was re-armed from the renew's send time.
    one.clock = STALE_MS;
    one.timers.fire(STALE_MS);
    await settled();
    expect(tab.closed).toEqual([]);
    expect(one.leases.size).toBe(1);
  });

  it('renews with one statement per tenant that has an instance here, and none for the others', async () => {
    const one = serverProcess('holder-one');
    await one.instances.open(alice, socket('a1'));
    await one.instances.open(bob, socket('b1'));
    log.entries.length = 0;
    await one.leases.renewNow();
    const renews = () => log.entries.filter((entry) => entry.kind === 'statement' && entry.text === RENEW);
    expect(renews().map((entry) => entry.tenantId)).toEqual([home.tenantId]);
    await one.instances.open(carol, socket('c1'));
    log.entries.length = 0;
    await one.leases.renewNow();
    expect(
      renews()
        .map((entry) => entry.tenantId)
        .sort(),
    ).toEqual([home.tenantId, acme.tenantId].sort());
    // A renew is that one statement in its unit: the tenant's set_config and the update.
    expect(log.entries).toHaveLength(4);
  });

  it('nothing is renewed, and no timer is armed, while nothing is held', async () => {
    const one = serverProcess('holder-one');
    const tab = socket('a1');
    await one.instances.open(alice, tab);
    expect(one.timers.pending(RENEW_MS)).toBe(1);
    one.instances.release(alice, tab);
    one.timers.fire(IDLE_MS);
    await expect.poll(() => one.leases.size).toBe(0);
    expect(one.timers.pending(RENEW_MS)).toBe(0);
    expect(one.timers.pending(STALE_MS)).toBe(0);
    log.entries.length = 0;
    await one.leases.renewNow();
    expect(log.entries).toEqual([]);
  });

  it('eviction releases the lease after the host’s quit path, and shutdown releases every lease', async () => {
    const order: string[] = [];
    const one = serverProcess('holder-one', watching(order), order);
    const tab = socket('a1');
    await one.instances.open(alice, tab);
    await one.instances.open(bob, socket('b1'));
    await one.instances.open(carol, socket('c1'));
    one.instances.release(alice, tab);
    expect(one.timers.fire(IDLE_MS)).toBe(1);
    await expect.poll(() => leaseRows(home)).toEqual([{ user_id: bob.id, holder: 'holder-one' }]);
    expect(order).toEqual([`disposed ${alice.id}`, `released ${alice.id}`]);
    await one.instances.closeAll();
    expect(await leaseRows(home)).toEqual([]);
    expect(await leaseRows(acme)).toEqual([]);
    expect(order.indexOf(`released ${bob.id}`)).toBeGreaterThan(order.indexOf(`disposed ${bob.id}`));
    expect(order.indexOf(`released ${carol.id}`)).toBeGreaterThan(order.indexOf(`disposed ${carol.id}`));
    expect(one.timers.pending(RENEW_MS)).toBe(0);
    // Another process can take them at once.
    const two = serverProcess('holder-two');
    expect(await two.instances.open(alice, socket('a2'))).toBeDefined();
  });

  it('a drain closes each socket 4503 host-draining after the quit path and the release, so another process takes the user at once', async () => {
    const order: string[] = [];
    const one = serverProcess('holder-one', watching(order), order);
    const two = serverProcess('holder-two');
    /** A socket whose close is noted in `order`, beside the disposals and releases. */
    const tab = (token: string): HostSocketHandle & { closed: { code: number; reason: string }[] } => {
      const made = socket(token);
      return {
        ...made,
        close: (code, reason) => {
          order.push(`closed ${token} ${String(code)} ${reason}`);
          made.close(code, reason);
        },
      };
    };
    const first = tab('a1');
    const second = tab('a2');
    await one.instances.open(alice, first);
    await one.instances.open(alice, second);
    await one.instances.open(carol, tab('c1'));
    // Held by the first process: the second is told to wait out the lease.
    await expect(two.instances.open(alice, socket('a3'))).rejects.toMatchObject({ code: 'host-lease-held' });
    await one.instances.drain();
    const alices = order.filter((entry) => entry.includes(alice.id) || entry.includes(' a'));
    expect(alices).toEqual([
      `disposed ${alice.id}`,
      `released ${alice.id}`,
      'closed a1 4503 host-draining',
      'closed a2 4503 host-draining',
    ]);
    expect(order.indexOf('closed c1 4503 host-draining')).toBeGreaterThan(order.indexOf(`released ${carol.id}`));
    expect(await leaseRows(home)).toEqual([]);
    expect(await leaseRows(acme)).toEqual([]);
    // No expiry waited for: the other process takes the user the moment the tab reconnects.
    expect(await two.instances.open(alice, socket('a4'))).toBeDefined();
    expect(await leaseRows(home)).toEqual([{ user_id: alice.id, holder: 'holder-two' }]);
    // The drained process builds nothing more, and its shutdown afterwards has nothing left to do.
    expect(await one.instances.open(bob, socket('b1'))).toBeUndefined();
    await one.instances.closeAll();
    expect(hostOf(one, alice)?.disposed).toBe(1);
  });

  it('a drain whose lease release throws still closes the sockets 4503 host-draining and ends', async () => {
    const order: string[] = [];
    // The release statement throws before it is sent: `leases.release` rejects.
    const failing: TenantDbFactory = (scope) => {
      const real = tenancy.db(scope);
      return {
        ...real,
        query: (text: string, params?: readonly unknown[]) => {
          if (text.startsWith('delete from host_leases where user_id')) throw new Error('the pool is gone');
          return real.query(text, params);
        },
      } as unknown as ReturnType<TenantDbFactory>;
    };
    const one = serverProcess('holder-one', failing, order);
    const closed: string[] = [];
    const made = socket('a1');
    await one.instances.open(alice, {
      ...made,
      close: (code, reason) => {
        closed.push(`${String(code)} ${reason}`);
        made.close(code, reason);
      },
    });
    await one.instances.drain();
    expect(closed).toEqual(['4503 host-draining']);
    expect(order).toContain(`disposed ${alice.id}`);
    await one.instances.closeAll();
  });

  it('a take is one unit: the lock, the expired delete and the insert (and the remaining time when refused)', async () => {
    const one = serverProcess('holder-one');
    const two = serverProcess('holder-two');
    log.entries.length = 0;
    await one.instances.open(alice, socket('a1'));
    const taken = log.entries.filter((entry) => entry.kind === 'statement');
    expect(new Set(taken.map((entry) => entry.unit)).size).toBe(1);
    expect(taken.map((entry) => entry.text.split(/\s+/).slice(0, 3).join(' '))).toEqual([
      LEASE_LOCK.split(' ').slice(0, 3).join(' '),
      'delete from host_leases',
      'insert into host_leases',
    ]);
    expect(taken[0]!.text).toBe(LEASE_LOCK);
    expect(LEASE_LOCK).toContain(`pg_advisory_xact_lock(${String(HOST_LEASE_CLASS)}, hashtext(`);
    log.entries.length = 0;
    await expect(two.instances.open(alice, socket('a2'))).rejects.toMatchObject({ code: 'host-lease-held' });
    expect(log.entries.filter((entry) => entry.kind === 'statement')).toHaveLength(4);
  });

  it('a host that cannot be built gives its lease back', async () => {
    const leases = new HostLeases({
      db: tenancy.db,
      holder: 'holder-one',
      setTimer: manualTimers().setTimer,
      log: () => undefined,
    });
    const instances = new HostInstances({
      dataDir,
      idleMs: IDLE_MS,
      setTimer: manualTimers().setTimer,
      log: () => undefined,
      leases,
      create: () => Promise.reject(new Error('no host')),
    });
    await expect(instances.open(alice, socket('a1'))).rejects.toThrow('no host');
    expect(await leaseRows(home)).toEqual([]);
    expect(leases.size).toBe(0);
  });

  describe('the instance cap', () => {
    const capped = { code: 'host-instance-cap' };

    it('a seat limit of 2 with two live users refuses a third, in this process and in another', async () => {
      seatLimits.set(home.tenantId, 2);
      const one = serverProcess('holder-one');
      const two = serverProcess('holder-two');
      await one.instances.open(alice, socket('a1'));
      await one.instances.open(bob, socket('b1'));
      log.entries.length = 0;
      await expect(one.instances.open(dave, socket('d1'))).rejects.toMatchObject(capped);
      // Counted inside the take's unit, under its lock, and nothing inserted.
      const statements = log.entries.filter((entry) => entry.kind === 'statement');
      expect(new Set(statements.map((entry) => entry.unit)).size).toBe(1);
      expect(statements[0]!.text).toBe(LEASE_LOCK);
      expect(statements.map((entry) => entry.text)).toContain(COUNT_LIVE);
      expect(statements.some((entry) => entry.text.startsWith('insert into host_leases'))).toBe(false);
      await expect(two.instances.open(dave, socket('d2'))).rejects.toMatchObject(capped);
      expect(hostOf(one, dave)).toBeUndefined();
      expect(hostOf(two, dave)).toBeUndefined();
      expect(one.instances.size).toBe(2);
      expect((await leaseRows(home)).map((row) => row.user_id)).toEqual([alice.id, bob.id]);
      // A live user's next socket joins their instance and takes nothing.
      expect(await one.instances.open(alice, socket('a2'))).toBeDefined();
    });

    it('a user’s own live row is not counted against them: a take of it at a limit of 1 is admitted', async () => {
      seatLimits.set(home.tenantId, 1);
      // This holder's row from before (a release that failed, or a re-take right after an eviction).
      await leaseFor(home, alice.id, 'holder-one');
      const one = serverProcess('holder-one');
      expect(await one.instances.open(alice, socket('a1'))).toBeDefined();
      expect(await leaseRows(home)).toEqual([{ user_id: alice.id, holder: 'holder-one' }]);
    });

    it('at the cap, a user held by another process is told to wait for it, and nothing idle is evicted', async () => {
      const one = serverProcess('holder-one');
      const d1 = socket('d1');
      await one.instances.open(dave, d1);
      one.instances.release(dave, d1);
      // A downgrade to 1 seat, with Alice's host open on another process.
      seatLimits.set(home.tenantId, 1);
      await leaseFor(home, alice.id, 'holder-two');
      const error = (await one.instances.open(alice, socket('a1')).catch((e: unknown) => e)) as {
        code?: string;
        details?: { retryAfterMs?: number };
      };
      expect(error.code).toBe('host-lease-held');
      expect(error.details?.retryAfterMs).toBeGreaterThan(LEASE_MS - 10_000);
      expect(hostOf(one, dave)?.disposed).toBe(0);
    });

    it('at the cap with nothing idle here, a user held by another process is told to wait, not capped', async () => {
      seatLimits.set(home.tenantId, 1);
      await leaseFor(home, bob.id, 'holder-two');
      await leaseFor(home, alice.id, 'holder-two');
      const one = serverProcess('holder-one');
      const error = (await one.instances.open(alice, socket('a1')).catch((e: unknown) => e)) as {
        code?: string;
        details?: { retryAfterMs?: number };
      };
      expect(error.code).toBe('host-lease-held');
      expect(error.details?.retryAfterMs).toBeGreaterThan(LEASE_MS - 10_000);
    });

    it('expired leases do not count', async () => {
      seatLimits.set(home.tenantId, 1);
      await leaseFor(home, bob.id, 'holder-two');
      await expire(home, bob.id);
      const one = serverProcess('holder-one');
      expect(await one.instances.open(alice, socket('a1'))).toBeDefined();
      expect(await leaseRows(home)).toEqual([{ user_id: alice.id, holder: 'holder-one' }]);
    });

    it('an eviction whose release fails frees no seat, so the open stops there', async () => {
      seatLimits.set(home.tenantId, 2);
      const failing: TenantDbFactory = (scope) => {
        const real = tenancy.db(scope);
        return {
          ...real,
          query: (text: string, params?: readonly unknown[]) =>
            text.startsWith('delete from host_leases where user_id')
              ? Promise.reject(new Error('the database went away'))
              : real.query(text, params),
        } as unknown as ReturnType<TenantDbFactory>;
      };
      const one = serverProcess('holder-one', failing);
      const a1 = socket('a1');
      const b1 = socket('b1');
      await one.instances.open(alice, a1);
      await one.instances.open(bob, b1);
      one.instances.release(bob, b1);
      one.instances.release(alice, a1);
      await expect(one.instances.open(dave, socket('d1'))).rejects.toMatchObject(capped);
      // Bob went, but his row stayed, so Alice was not evicted for nothing.
      expect(hostOf(one, bob)?.disposed).toBe(1);
      expect(hostOf(one, alice)?.disposed).toBe(0);
    });

    it('an instance still building is never evicted for the cap, though its socket has gone', async () => {
      seatLimits.set(home.tenantId, 1);
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const one = serverProcess('holder-one', tenancy.db, [], (user) =>
        user.id === erin.id ? held : Promise.resolve(),
      );
      const e1 = socket('e1');
      const erinOpen = one.instances.open(erin, e1);
      // Erin's take is in and her host is building; her tab closes, so the instance is idle but not built.
      await expect.poll(async () => (await leaseRows(home)).map((row) => row.user_id)).toEqual([erin.id]);
      one.instances.release(erin, e1);
      const daveOpen = one.instances.open(dave, socket('d1')).then(
        () => 'admitted',
        (error: unknown) => (error as { code?: string }).code,
      );
      // Refused without waiting on Erin's build (an eviction of her would wait for it until the build ends).
      let wait: ReturnType<typeof setTimeout> | undefined;
      try {
        const first = await Promise.race([
          daveOpen,
          new Promise((resolve) => {
            wait = setTimeout(() => resolve('waiting'), 5_000);
          }),
        ]);
        expect(first).toBe('host-instance-cap');
      } finally {
        clearTimeout(wait);
        finish();
      }
      expect(await erinOpen).toBeDefined();
      expect(hostOf(one, erin)?.disposed).toBe(0);
    });

    it('at the cap, this process evicts its oldest idle instance of the tenant and admits the new user', async () => {
      seatLimits.set(home.tenantId, 2);
      const order: string[] = [];
      const one = serverProcess('holder-one', tenancy.db, order);
      const a1 = socket('a1');
      const b1 = socket('b1');
      await one.instances.open(alice, a1);
      await one.instances.open(bob, b1);
      // Bob goes idle first, so he is the oldest idle one, though Alice's instance is older.
      one.instances.release(bob, b1);
      one.instances.release(alice, a1);
      expect(await one.instances.open(dave, socket('d1'))).toBeDefined();
      expect(hostOf(one, bob)?.disposed).toBe(1);
      expect(hostOf(one, alice)?.disposed).toBe(0);
      expect((await leaseRows(home)).map((row) => row.user_id)).toEqual([alice.id, dave.id]);
      expect(order).toEqual([`disposed ${bob.id}`]);
      // Its idle timer went with it; Alice's still runs.
      expect(one.timers.pending(IDLE_MS)).toBe(1);
      // The next one takes Alice's seat the same way, and with no idle instance left the one after is refused.
      expect(await one.instances.open(erin, socket('e1'))).toBeDefined();
      expect(hostOf(one, alice)?.disposed).toBe(1);
      await expect(one.instances.open(bob, socket('b2'))).rejects.toMatchObject(capped);
    });

    it('evicts only idle instances: one with a socket open stays, and so does another process’s idle one', async () => {
      seatLimits.set(home.tenantId, 2);
      const one = serverProcess('holder-one');
      const two = serverProcess('holder-two');
      await one.instances.open(alice, socket('a1'));
      const b1 = socket('b1');
      await two.instances.open(bob, b1);
      two.instances.release(bob, b1);
      await expect(one.instances.open(dave, socket('d1'))).rejects.toMatchObject(capped);
      expect(hostOf(one, alice)?.disposed).toBe(0);
      expect(hostOf(two, bob)?.disposed).toBe(0);
      expect(two.instances.size).toBe(1);
    });

    it('an unlimited license has no cap, and sends no count', async () => {
      const one = serverProcess('holder-one');
      for (const [user, name] of [
        [alice, 'a1'],
        [bob, 'b1'],
        [dave, 'd1'],
        [erin, 'e1'],
      ] as const)
        expect(await one.instances.open(user, socket(name))).toBeDefined();
      expect(one.leases.size).toBe(4);
      expect(log.entries.some((entry) => entry.kind === 'statement' && entry.text === COUNT_LIVE)).toBe(false);
    });

    it('another tenant’s leases do not count', async () => {
      seatLimits.set(home.tenantId, 1);
      seatLimits.set(acme.tenantId, 1);
      const one = serverProcess('holder-one');
      const two = serverProcess('holder-two');
      await two.instances.open(carol, socket('c1'));
      expect(await one.instances.open(alice, socket('a1'))).toBeDefined();
      await expect(one.instances.open(bob, socket('b1'))).rejects.toMatchObject(capped);
    });

    it('a capped open never evicts another tenant’s idle instance in this process', async () => {
      seatLimits.set(home.tenantId, 1);
      const one = serverProcess('holder-one');
      const c1 = socket('c1');
      await one.instances.open(carol, c1);
      one.instances.release(carol, c1);
      await one.instances.open(alice, socket('a1'));
      await expect(one.instances.open(bob, socket('b1'))).rejects.toMatchObject(capped);
      expect(hostOf(one, carol)?.disposed).toBe(0);
      expect(one.instances.size).toBe(2);
    });

    it('two processes racing for the last seat: the lease lock lets only one in', async () => {
      seatLimits.set(home.tenantId, 2);
      const one = serverProcess('holder-one');
      const two = serverProcess('holder-two');
      await one.instances.open(alice, socket('a1'));
      // Hold the tenant's lease lock, so both takes queue behind it and then run back to back.
      let unlock!: () => void;
      const held = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holding = tenancy.db(home).transaction(async (tx) => {
        await tx.query(LEASE_LOCK, [tx.scope.tenantId]);
        locked();
        await held;
      });
      await isLocked;
      const racing = [one.instances.open(dave, socket('d1')), two.instances.open(erin, socket('e1'))];
      // Both are waiting on the lock: no lease row was written for either.
      await settled();
      expect((await leaseRows(home)).map((row) => row.user_id)).toEqual([alice.id]);
      unlock();
      await holding;
      const results = await Promise.allSettled(racing);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const refused = results.filter((result) => result.status === 'rejected');
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toMatchObject(capped);
      expect(await leaseRows(home)).toHaveLength(2);
    });
  });

  describe('self-hosted start-up', () => {
    const seed = async (): Promise<void> => {
      for (const [scope, user] of [
        [home, alice],
        [acme, carol],
      ] as const) {
        await tenancy
          .db(scope)
          .query(
            "insert into host_leases (user_id, holder, acquired_at, renewed_at, expires_at) values ($1, 'crashed', now(), now(), now() + interval '60 seconds')",
            [user.id],
          );
      }
    };

    it('clears the stale leases of every tenant in single mode', async () => {
      await seed();
      await clearLeasesAtStartUp('single', tenancy, quiet);
      expect(await leaseRows(home)).toEqual([]);
      expect(await leaseRows(acme)).toEqual([]);
      // Cleared tenant by tenant, so a take after it is free.
      expect(await serverProcess('holder-one').instances.open(alice, socket('a1'))).toBeDefined();
    });

    it('multi leaves them to expire: another instance may hold them (spec §20.1)', async () => {
      await seed();
      await clearLeasesAtStartUp('multi', tenancy, quiet);
      expect(await leaseRows(home)).toEqual([{ user_id: alice.id, holder: 'crashed' }]);
      expect(await leaseRows(acme)).toEqual([{ user_id: carol.id, holder: 'crashed' }]);
    });
  });
});
