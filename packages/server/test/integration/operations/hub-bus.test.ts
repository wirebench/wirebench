/**
 * Slice 5 Task 4 (hosted edition spec §20.3): two live servers, each with its own hooks, instance row and
 * notification bus, on one schema and one data directory. `headMoved`, `accessChanged` and `sessionEnded` on one
 * reach the other's sockets; presence is the union and drops a stopped holder; a lost bus resyncs with `head`,
 * `access` and `presence`; the host instances' and the share registry's listeners hear the other instance; and a
 * `licenseChanged` writes one audit row in the fleet. The full two-server suite is Task 14's.
 */
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LIVE_CLOSE, type LiveServerMessage, type SyncPushResponse } from '@wirebench/engine';
import { auditLogModule } from '../../../src/audit-log/module.js';
import {
  announce,
  cluster,
  type LicenseChangedEvent,
  type ServerHooks,
  type ServerModule,
} from '../../../src/context.js';
import { openSession, type Session } from '../../../src/db/pool.js';
import { HostInstances } from '../../../src/host/instances.js';
import { revokeToken } from '../../../src/identity/repo.js';
import type { HeldSessions } from '../../../src/operations/sessions.js';
import { liveModule } from '../../../src/live/module.js';
import { BusSignals, NotificationBus } from '../../../src/operations/bus.js';
import { InstanceRegistry } from '../../../src/operations/instances.js';
import type { PendingWrites } from '../../../src/pending-writes.js';
import { syncModule } from '../../../src/sync/module.js';
import { teamsModule } from '../../../src/teams/module.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { terminalSharesModule } from '../../../src/terminal-shares/module.js';
import { ShareRegistry } from '../../../src/terminal-shares/registry.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { hostHarness } from '../../helpers/host.js';
import {
  identityHarness,
  signedInUser,
  type IdentityHarness,
  type SignedInUser,
  type TestClock,
} from '../../helpers/identity.js';
import { openLive, type LiveTestClient } from '../../helpers/live.js';
import { seedSyncWorkspace } from '../../helpers/sync.js';
import { call, seedTeam } from '../../helpers/teams.js';
import { manualTimers } from '../../helpers/timers.js';

const log = Fastify({ logger: false }).log;
const AT = '2026-09-24T12:00:00.000Z';

interface Node {
  readonly h: IdentityHarness & { readonly port: number };
  readonly registry: InstanceRegistry;
  readonly bus: NotificationBus;
  /** The bus's listening sessions, newest last. */
  readonly sessions: Session[];
}

type Message<T extends LiveServerMessage['type']> = Extract<LiveServerMessage, { type: T }>;

/** A bus over `db` for `hooks`, retrying fast; started. */
async function busFor(
  db: TestDatabase,
  hooks: ServerHooks,
  holder: string,
  signals: BusSignals,
  h: IdentityHarness,
): Promise<{ bus: NotificationBus; sessions: Session[] }> {
  const sessions: Session[] = [];
  const bus = new NotificationBus({
    db,
    holder,
    hooks,
    open: async () => {
      const session = await openSession(db.url, { applicationName: 'wirebench-test-bus' });
      sessions.push(session);
      return session;
    },
    scopeFor: async (tenantId) => (await directoryOf(h.ctx.tenancy).get(tenantId))?.scope,
    log,
    retryDelayMs: 50,
    maxRetryDelayMs: 200,
  });
  signals.attach(bus);
  await bus.start();
  return { bus, sessions };
}

describeDb('the live hub, host instances and shares on the bus (hosted spec §20.3)', () => {
  let db: TestDatabase;
  let dataDir: string;
  const nodes: Node[] = [];
  const clients: LiveTestClient[] = [];
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    db = await testDatabase();
    dataDir = await mkTempDir();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const client of clients.splice(0)) client.close();
    for (const node of nodes.splice(0)) {
      await node.h.close();
      await node.bus.stop(0);
      await node.registry.stop();
    }
    for (const cleanup of cleanups.splice(0)) await cleanup();
    await db.close();
    await removeTempDir(dataDir);
  });

  /** One server: identity, teams, sync and live (plus `extra`), its own instance row and bus. */
  const node = async (
    extra: readonly ServerModule[] | ((clock: TestClock) => readonly ServerModule[]) = [],
  ): Promise<Node> => {
    const timers = manualTimers();
    const holder = randomUUID();
    const registry = new InstanceRegistry({
      db,
      holder,
      mode: 'multi',
      url: 'http://127.0.0.1:1',
      version: '0.0.0-test',
      setTimer: timers.setTimer,
      log: () => undefined,
    });
    await registry.start();
    const signals = new BusSignals();
    const h = await identityHarness({
      db,
      dataDir,
      instance: registry,
      bus: signals,
      modules: (clock) => [
        teamsModule({ now: () => clock.now }),
        syncModule(),
        liveModule({ now: () => clock.now, setTimer: timers.setTimer }),
        ...(typeof extra === 'function' ? extra(clock) : extra),
      ],
    });
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const address = h.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('not listening');
    const { bus, sessions } = await busFor(db, h.hooks, holder, signals, h);
    const made: Node = { h: { ...h, port: address.port }, registry, bus, sessions };
    nodes.push(made);
    return made;
  };

  const connect = async (on: Node, user: SignedInUser, workspaceId: string): Promise<LiveTestClient> => {
    const client = await openLive(on.h, user.token);
    clients.push(client);
    await client.next('ready');
    client.send({ type: 'subscribe', workspaceId });
    await client.next('presence');
    return client;
  };

  const until = async <T extends LiveServerMessage['type']>(
    client: LiveTestClient,
    type: T,
    match: (message: Message<T>) => boolean = () => true,
  ): Promise<Message<T>> => {
    for (;;) {
      const message = await client.next(type);
      if (match(message)) return message;
    }
  };

  /** The newest `presence` the client got, once it lists `count` users. */
  const presenceOf = async (client: LiveTestClient, count: number): Promise<Message<'presence'>> => {
    let found: Message<'presence'> | undefined;
    await vi.waitFor(
      () => {
        const last = client.messages.filter((m): m is Message<'presence'> => m.type === 'presence').at(-1);
        expect(last?.users).toHaveLength(count);
        found = last;
      },
      { timeout: 5_000 },
    );
    return found!;
  };

  /** Two nodes, a team with Ana (admin) and Ben (member, viewer), and one workspace. */
  const fleet = async () => {
    const a = await node();
    const b = await node();
    const ana = await signedInUser(a.h, { email: 'ana@example.com' });
    const ben = await signedInUser(a.h, { email: 'ben@example.com' });
    const team = await seedTeam(a.h, { name: 'Payments QA', admins: [ana], members: [ben] });
    const workspaceId = await seedSyncWorkspace(a.h, { team, name: 'Staging' });
    return { a, b, ana, ben, team, workspaceId };
  };
  const inTenant = (h: IdentityHarness) => ({ tenantId: h.tdb.scope.tenantId, tenant: h.tdb.scope });

  it('a push through one is a head on the other’s socket', async () => {
    const { a, b, ana, ben, workspaceId } = await fleet();
    const watcher = await connect(b, ben, workspaceId);
    const pushed = await call<SyncPushResponse>(a.h, ana, 'POST', `/workspaces/${workspaceId}/sync/commits`, {
      parent: null,
      commits: [{ subject: 'Set x', at: AT, changes: [{ path: 'workspace.yaml', encoding: 'utf8', content: 'x\n' }] }],
    });
    expect(pushed.status).toBe(201);
    expect(await watcher.next('head')).toEqual({ type: 'head', workspaceId, head: pushed.body.head });
  });

  it('accessChanged on one re-checks roles there, and sessionEnded closes sockets there', async () => {
    const { a, b, ben, workspaceId } = await fleet();
    const watcher = await connect(b, ben, workspaceId);
    await teamsRepo.upsertGrant(a.h.tdb, { workspaceId, userId: ben.user.id, role: 'editor', at: a.h.clock.now });
    announce(a.h.hooks.accessChanged, { ...inTenant(a.h), workspaceId }, log);
    expect(await watcher.next('access')).toEqual({ type: 'access', workspaceId });
    announce(a.h.hooks.sessionEnded, { tenantId: a.h.tdb.scope.tenantId, tokenId: ben.tokenId }, log);
    expect(await watcher.next('session-ended')).toEqual({ type: 'session-ended' });
    expect((await watcher.closed).code).toBe(LIVE_CLOSE.unauthenticated);
  });

  it('presence is the union across instances, and drops a holder that resets or whose row dies', async () => {
    const { a, b, ana, ben, workspaceId } = await fleet();
    const names = (message: Message<'presence'>) => message.users.map((user) => user.name);
    const onB = await connect(b, ben, workspaceId);
    const onA = await connect(a, ana, workspaceId);
    expect(names(await presenceOf(onB, 2))).toEqual(['ana', 'ben']);
    // A subscribed after B: B's list reached it when B's user arrived.
    expect(names(await presenceOf(onA, 2))).toEqual(['ana', 'ben']);
    // No email crosses: the receiving hub looked the display names up itself.
    expect(JSON.stringify(onB.messages)).not.toContain('@example.com');

    // A's bus goes quiet without a word, then its row goes: B's heartbeat finds it dead.
    await a.bus.stop(0);
    await a.registry.stop();
    await b.registry.renew();
    expect(names(await presenceOf(onB, 1))).toEqual(['ben']);
  });

  it('a holder that closes says presenceReset, and the other drops its users at once', async () => {
    const { a, b, ana, ben, workspaceId } = await fleet();
    const onB = await connect(b, ben, workspaceId);
    await connect(a, ana, workspaceId);
    await presenceOf(onB, 2);
    await a.h.app.close();
    expect((await presenceOf(onB, 1)).users[0]!.id).toBe(ben.user.id);
  });

  it('a lost bus resyncs each room with head, then access, then presence', async () => {
    const { a, b, ana, ben, workspaceId } = await fleet();
    const pushed = await call<SyncPushResponse>(a.h, ana, 'POST', `/workspaces/${workspaceId}/sync/commits`, {
      parent: null,
      commits: [{ subject: 'Set x', at: AT, changes: [{ path: 'workspace.yaml', encoding: 'utf8', content: 'x\n' }] }],
    });
    expect(pushed.status).toBe(201);
    const onB = await connect(b, ben, workspaceId);
    const before = onB.messages.length;
    await db.query('select pg_terminate_backend($1)', [b.sessions[0]!.pid]);
    await until(onB, 'access');
    await until(onB, 'presence');
    expect(onB.messages.slice(before, before + 3)).toEqual([
      { type: 'head', workspaceId, head: pushed.body.head },
      { type: 'access', workspaceId },
      { type: 'presence', workspaceId, users: [{ id: ben.user.id, name: 'ben' }] },
    ]);
  });

  it('the host instances and the share registry hear the other instance’s sessionEnded and accessChanged', async () => {
    const hostEnded = vi.spyOn(HostInstances.prototype, 'sessionEnded');
    const shareEnded = vi.spyOn(ShareRegistry.prototype, 'sessionEnded');
    const shareRecheck = vi.spyOn(ShareRegistry.prototype, 'recheck');
    const a = await node();
    // The share registry on a second node.
    await node([terminalSharesModule()]);
    const ended = { tenantId: a.h.tdb.scope.tenantId, userId: '01J8ZD0000000000000000A001' };
    announce(a.h.hooks.sessionEnded, ended, log);
    announce(a.h.hooks.accessChanged, { ...inTenant(a.h), userId: '01J8ZD0000000000000000A001' }, log);
    await vi.waitFor(() => {
      expect(shareEnded).toHaveBeenCalledWith(ended);
      expect(shareRecheck).toHaveBeenCalledWith(a.h.tdb.scope.tenantId);
    });
    // The host instances on their own server, on this schema, with a bus of their own.
    const host = await hostHarness({ db, dataDir });
    cleanups.push(() => host.close());
    const signals = new BusSignals();
    const hosted = await busFor(db, host.hooks, host.ctx.instance.holder, signals, host);
    cleanups.push(() => hosted.bus.stop(0));
    announce(a.h.hooks.sessionEnded, ended, log);
    await vi.waitFor(() => {
      expect(hostEnded).toHaveBeenCalledWith(ended);
    });
  });

  it('a bus that missed events ends the gone sessions and re-checks the shares on every holder (review I1)', async () => {
    const { a, b, ana, ben, team, workspaceId } = await fleet();
    const tenant = a.h.tdb.scope;
    const watcher = await connect(b, ben, workspaceId);
    // The share registry on a third node, and the host instances on a server of their own: both say they hold Ana's
    // and Ben's sessions, and the real handlers run on what the re-validation finds.
    const held = (): HeldSessions =>
      new Map([[tenant.tenantId, { tenant, tokenIds: new Set([ana.tokenId, ben.tokenId]) }]]);
    vi.spyOn(ShareRegistry.prototype, 'heldSessions').mockImplementation(held);
    vi.spyOn(HostInstances.prototype, 'heldSessions').mockImplementation(held);
    const shareEnded = vi.spyOn(ShareRegistry.prototype, 'sessionEnded');
    const shareRecheck = vi.spyOn(ShareRegistry.prototype, 'recheck');
    const hostEnded = vi.spyOn(HostInstances.prototype, 'sessionEnded');
    const c = await node([terminalSharesModule()]);
    const host = await hostHarness({ db, dataDir });
    cleanups.push(() => host.close());
    const hosted = await busFor(db, host.hooks, host.ctx.instance.holder, host.ctx.bus as BusSignals, host);
    cleanups.push(() => hosted.bus.stop(0));
    // Written while the buses are down, so no instance hears them: Ben's session revoked, Ben out of the team.
    await revokeToken(a.h.tdb, ben.tokenId, new Date());
    await teamsRepo.deleteMember(a.h.tdb, team.id, ben.user.id);
    for (const session of [b.sessions[0]!, c.sessions[0]!, hosted.sessions[0]!]) {
      await db.query('select pg_terminate_backend($1)', [session.pid]);
    }
    expect(await watcher.next('session-ended')).toEqual({ type: 'session-ended' });
    expect((await watcher.closed).code).toBe(LIVE_CLOSE.unauthenticated);
    const gone = { tenantId: tenant.tenantId, tokenId: ben.tokenId };
    await vi.waitFor(() => {
      expect(shareRecheck).toHaveBeenCalledWith(tenant.tenantId);
      expect(shareEnded).toHaveBeenCalledWith(gone);
      expect(hostEnded).toHaveBeenCalledWith(gone);
    });
    // Ana's session is live: nothing ends it.
    expect(shareEnded).toHaveBeenCalledTimes(1);
    expect(hostEnded).toHaveBeenCalledTimes(1);
  });

  it('a peer’s missed marker resyncs this instance the same way (review I2)', async () => {
    const { a, b, ben, workspaceId } = await fleet();
    const watcher = await connect(b, ben, workspaceId);
    await revokeToken(a.h.tdb, ben.tokenId, new Date());
    // As A's bus sends it after a payload it gave up.
    await db.query('select pg_notify($1, $2)', [
      a.bus.channel,
      JSON.stringify({ v: 1, from: a.registry.holder, at: Date.now(), kind: 'resync' }),
    ]);
    expect(await watcher.next('session-ended')).toEqual({ type: 'session-ended' });
    expect((await watcher.closed).code).toBe(LIVE_CLOSE.unauthenticated);
  });

  it('one licenseChanged writes one audit row in a fleet of two', async () => {
    const writes: PendingWrites[] = [];
    const audited = () => [auditLogModule({ onLicenseWrites: (made) => writes.push(made) })];
    const a = await node(audited);
    const b = await node(audited);
    const heardOnB: LicenseChangedEvent[] = [];
    b.h.hooks.licenseChanged.push(cluster((event) => heardOnB.push(event)));
    const event: LicenseChangedEvent = { ...inTenant(a.h), action: 'removed', actorUserId: null };
    announce(a.h.hooks.licenseChanged, event, log);
    await vi.waitFor(() => {
      expect(heardOnB).toHaveLength(1);
    });
    for (const made of writes) await made.settled();
    const rows = await a.h.tdb.query<{ n: string }>(
      "select count(*)::text as n from audit_events where action = 'license.removed'",
    );
    expect(rows.rows[0]!.n).toBe('1');
  });
});
