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

  const serverProcess = (holder: string, db: TenantDbFactory = tenancy.db, order: string[] = []): Process => {
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
      create: (user) => {
        const host = fakeHost(order, user.id);
        hosts.set(`${user.tenant.tenantId}:${user.id}`, host);
        return Promise.resolve(host);
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
  const expire = async (scope: TenantScope, userId: string): Promise<void> => {
    await tenancy
      .db(scope)
      .query("update host_leases set expires_at = now() - interval '1 second' where user_id = $1", [userId]);
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
    // The same holder takes its own lease again, and another user is free.
    expect(await two.instances.open(bob, socket('b1'))).toBeDefined();
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
    const one = serverProcess('holder-one');
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
    // The loser's release after dispose never deletes the winner's row.
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
    expect(tab.closed).toEqual([{ code: 4409, reason: 'host-lease-lost' }]);
    expect(hostOf(one, alice)?.disposed).toBe(1);
    expect(one.clock).toBeLessThan(LEASE_MS);
    expect(one.leases.size).toBe(0);
    reachable = true;
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
    // Each release, in the order sent, beside the hosts' disposals.
    const watched: TenantDbFactory = (scope) => {
      const real = tenancy.db(scope);
      return {
        ...real,
        query: (text: string, params?: readonly unknown[]) => {
          if (text.startsWith('delete from host_leases where user_id')) order.push(`released ${String(params?.[0])}`);
          return real.query(text, params);
        },
      } as unknown as ReturnType<TenantDbFactory>;
    };
    const one = serverProcess('holder-one', watched, order);
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
      // A live user's own next socket is not a new seat.
      expect(await one.instances.open(alice, socket('a2'))).toBeDefined();
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

    it('an unlimited license has no cap', async () => {
      const one = serverProcess('holder-one');
      for (const [user, name] of [
        [alice, 'a1'],
        [bob, 'b1'],
        [dave, 'd1'],
        [erin, 'e1'],
      ] as const)
        expect(await one.instances.open(user, socket(name))).toBeDefined();
      expect(one.leases.size).toBe(4);
    });

    it('another tenant’s leases do not count', async () => {
      seatLimits.set(home.tenantId, 1);
      seatLimits.set(acme.tenantId, 1);
      const one = serverProcess('holder-one');
      const two = serverProcess('holder-two');
      await two.instances.open(carol, socket('c1'));
      expect(await one.instances.open(alice, socket('a1'))).toBeDefined();
      await expect(one.instances.open(bob, socket('b1'))).rejects.toMatchObject(capped);
      // And an idle instance of the full tenant is never evicted for another tenant's user.
      expect(hostOf(two, carol)?.disposed).toBe(0);
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

    it('clears the stale leases of every tenant', async () => {
      await seed();
      await clearLeasesAtStartUp('self-hosted', tenancy, quiet);
      expect(await leaseRows(home)).toEqual([]);
      expect(await leaseRows(acme)).toEqual([]);
      // The app role outside a tenant sees no lease at all, which is why it goes tenant by tenant.
      expect(await serverProcess('holder-one').instances.open(alice, socket('a1'))).toBeDefined();
    });

    it('a hosted process leaves them to expire', async () => {
      await seed();
      await clearLeasesAtStartUp('hosted', tenancy, quiet);
      expect(await leaseRows(home)).toEqual([{ user_id: alice.id, holder: 'crashed' }]);
      expect(await leaseRows(acme)).toEqual([{ user_id: carol.id, holder: 'crashed' }]);
    });
  });
});
