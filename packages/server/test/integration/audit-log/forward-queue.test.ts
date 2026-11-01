import type { FastifyBaseLogger } from 'fastify';
import { auditEventSchema, type AuditEvent, type LicenseState } from '@wirebench/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditForwarder,
  FORWARD_BACKOFF_MAX_MS,
  FORWARD_BACKOFF_MIN_MS,
  FORWARD_BUSY_MS,
  FORWARD_IDLE_MS,
  FORWARD_UNLICENSED_MS,
  type ForwardSink,
} from '../../../src/audit-log/forward/forwarder.js';
import { auditHook } from '../../../src/audit-log/hook.js';
import { deleteAuditEventsBefore, deleteForwarded } from '../../../src/audit-log/repo.js';
import { createDatabase } from '../../../src/db/pool.js';
import { permissiveLicense, type AuditInput, type LicenseService } from '../../../src/context.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { tenantDbFactory, type TenantDb } from '../../../src/tenancy/tenant-db.js';
import { createTenancy, type Tenancy } from '../../../src/tenancy/tenancy.js';
import { defaultTenantDb } from '../../helpers/tenancy.js';

/** Records every batch; `failWith` makes the next sends reject; `gate` holds sends until released. */
class FakeSink implements ForwardSink {
  readonly batches: AuditEvent[][] = [];
  failure: Error | undefined;
  gate: Promise<void> | undefined;
  closed = false;
  entered = 0;
  private waiters: { count: number; resolve: () => void }[] = [];
  /** Resolves once `count` sends have started. */
  enteredAtLeast(count: number): Promise<void> {
    if (this.entered >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }
  async send(events: AuditEvent[]): Promise<void> {
    this.entered += 1;
    for (const waiter of this.waiters.filter((w) => w.count <= this.entered)) waiter.resolve();
    if (this.gate !== undefined) await this.gate;
    if (this.failure !== undefined) throw this.failure;
    this.batches.push(events);
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  get sent(): AuditEvent[] {
    return this.batches.flat();
  }
}

/** A timer the test fires by hand; it remembers every delay it was armed with. */
function manualTimer() {
  const armed: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    armed,
    setTimer: (fn: () => void, ms: number) => {
      const entry = { fn, ms, cancelled: false };
      armed.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
    /** Fires the latest live timer. */
    fire(): void {
      const live = armed.filter((entry) => !entry.cancelled).at(-1);
      if (live === undefined) throw new Error('no timer armed');
      live.cancelled = true;
      live.fn();
    },
    delays: () => armed.map((entry) => entry.ms),
  };
}

function recordingLog() {
  const lines: { level: string; args: unknown[] }[] = [];
  const at =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push({ level, args });
    };
  const logger = {
    level: 'info',
    fatal: at('fatal'),
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    trace: at('trace'),
    silent: at('silent'),
    child: (): unknown => logger,
  };
  return { lines, log: logger as unknown as FastifyBaseLogger };
}

/** `features` for the tenant `tenantId()` names, and none for any other: a read of the wrong tenant's license shows. */
function licensed(features: string[], tenantId: () => string): LicenseService & { features: string[] } {
  const base = permissiveLicense();
  const service = {
    ...base,
    features,
    state: (of: Parameters<LicenseService['state']>[0]): Promise<LicenseState> =>
      Promise.resolve({
        edition: 'enterprise',
        status: 'active',
        seats: { used: 0, limit: null },
        features: ('tenantId' in of ? of.tenantId : of.tenant.tenantId) === tenantId() ? [...service.features] : [],
      }),
  };
  return service;
}

describeDb('the audit forward outbox and forwarder (issue #209)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let tdb: TenantDb;
  let tenancy: Tenancy;
  let tick = Date.parse('2026-10-03T00:00:00Z');
  const clock = () => new Date((tick += 1000));
  const forwarding = auditHook(clock, { forward: true });
  const plain = auditHook(clock, { forward: false });
  const event = (n: number): AuditInput => ({
    actor: { kind: 'user', userId: 'U1', email: 'a@example.com' },
    ip: '203.0.113.7',
    action: 'team.created',
    target: { kind: 'team', id: `T${String(n)}` },
    teamId: 'TEAM1',
    details: { n },
  });
  const queued = async () =>
    (await tdb.query<{ n: string }>('select count(*)::text as n from audit_forward_queue')).rows[0]!.n;
  const forwarder = (sink: ForwardSink, extra: Partial<ConstructorParameters<typeof AuditForwarder>[0]> = {}) =>
    new AuditForwarder({
      tenancy,
      sink,
      license: () => licensed(['audit-log'], () => tdb.scope.tenantId),
      now: clock,
      setTimer: manualTimer().setTimer,
      log: recordingLog().log,
      ...extra,
    });

  beforeAll(async () => {
    // Every migration, 0020 included: the repositories' upserts name the tenant keys.
    db = await testDatabase();
    tdb = await defaultTenantDb(db);
    tenancy = createTenancy(db);
  });
  afterAll(() => db.close());
  beforeEach(async () => {
    await tdb.query('delete from audit_events');
  });

  describe('the hook', () => {
    it('configured, queues a recorded event in the same transaction', async () => {
      await tdb.transaction(async (tx) => {
        await forwarding(tx, event(1));
        const inside = await tx.query<{ event_id: string; id: string }>(
          'select q.event_id, e.id from audit_forward_queue q join audit_events e on e.id = q.event_id',
        );
        expect(inside.rows).toHaveLength(1);
        expect(inside.rows[0]!.event_id).toBe(inside.rows[0]!.id);
      });
      expect(await queued()).toBe('1');
    });

    it('queues nothing when the action rolls back', async () => {
      await expect(
        tdb.transaction(async (tx) => {
          await forwarding(tx, event(1));
          throw new Error('the action failed');
        }),
      ).rejects.toThrow('the action failed');
      expect(await queued()).toBe('0');
      expect((await tdb.query('select id from audit_events')).rows).toHaveLength(0);
    });

    it('in a unit of its own (one statement), the event and its queue row are written together', async () => {
      await forwarding(tdb, event(1));
      const rows = await tdb.query<{ id: string; event_id: string | null }>(
        'select e.id, q.event_id from audit_events e left join audit_forward_queue q on q.event_id = e.id',
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.event_id).toBe(rows.rows[0]!.id);
    });

    it('unconfigured, records the event and queues nothing', async () => {
      await plain(tdb, event(1));
      expect((await tdb.query('select id from audit_events')).rows).toHaveLength(1);
      expect(await queued()).toBe('0');
    });

    it('a deleted event (retention) takes its queue row with it', async () => {
      await forwarding(tdb, event(1));
      await forwarding(tdb, event(2));
      expect(await deleteAuditEventsBefore(tdb, new Date(tick + 1), 10)).toBe(2);
      expect(await queued()).toBe('0');
    });
  });

  describe('runOnce', () => {
    it('sends oldest first, as the API returns events, and empties the queue', async () => {
      for (let i = 0; i < 5; i++) await forwarding(tdb, event(i));
      const sink = new FakeSink();
      const pass = await forwarder(sink, { batchSize: 2 }).runOnce();
      expect(pass).toEqual({ outcome: 'sent', sent: 2, nextDelayMs: FORWARD_BUSY_MS });
      const f = forwarder(sink, { batchSize: 2 });
      await f.runOnce();
      await f.runOnce();
      expect(sink.batches.map((b) => b.length)).toEqual([2, 2, 1]);
      expect(sink.sent.map((e) => e.details['n'])).toEqual([0, 1, 2, 3, 4]);
      for (const sent of sink.sent) expect(auditEventSchema.safeParse(sent).success).toBe(true);
      expect(sink.sent[0]).toMatchObject({ action: 'team.created', teamId: 'TEAM1', ip: '203.0.113.7' });
      expect(await queued()).toBe('0');
      expect(await f.runOnce()).toEqual({ outcome: 'idle', sent: 0, nextDelayMs: FORWARD_IDLE_MS });
      // Forwarding never deletes the events themselves.
      expect((await tdb.query('select id from audit_events')).rows).toHaveLength(5);
    });

    it('a failing sink keeps the rows and backs off 5 s, doubling to 300 s; a success resets it', async () => {
      await forwarding(tdb, event(1));
      const sink = new FakeSink();
      sink.failure = new Error('connection refused');
      const { lines, log } = recordingLog();
      const f = forwarder(sink, { log });
      const delays: number[] = [];
      for (let i = 0; i < 9; i++) {
        const pass = await f.runOnce();
        expect(pass.outcome).toBe('failed');
        delays.push(pass.nextDelayMs);
      }
      expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
      expect(FORWARD_BACKOFF_MAX_MS).toBe(300_000);
      expect(await queued()).toBe('1');
      expect(lines.filter((l) => l.level === 'warn')).toHaveLength(1);
      sink.failure = undefined;
      expect(await f.runOnce()).toEqual({ outcome: 'sent', sent: 1, nextDelayMs: FORWARD_BUSY_MS });
      expect(lines.filter((l) => l.level === 'info')).toHaveLength(1);
      expect(await queued()).toBe('0');
      sink.failure = new Error('again');
      await forwarding(tdb, event(2));
      expect((await f.runOnce()).nextDelayMs).toBe(5_000);
      expect(lines.filter((l) => l.level === 'warn')).toHaveLength(2);
      expect(JSON.stringify(lines)).not.toContain('a@example.com');
    });

    it('without the audit-log feature sends nothing, keeps the rows, and checks again after 60 s', async () => {
      await forwarding(tdb, event(1));
      const sink = new FakeSink();
      const license = licensed([], () => tdb.scope.tenantId);
      const { lines, log } = recordingLog();
      const f = forwarder(sink, { license: () => license, log });
      expect(await f.runOnce()).toEqual({ outcome: 'unlicensed', sent: 0, nextDelayMs: FORWARD_UNLICENSED_MS });
      expect(await f.runOnce()).toEqual({ outcome: 'unlicensed', sent: 0, nextDelayMs: FORWARD_UNLICENSED_MS });
      expect(FORWARD_UNLICENSED_MS).toBe(60_000);
      expect(sink.batches).toHaveLength(0);
      expect(await queued()).toBe('1');
      expect(lines.filter((l) => l.level === 'info')).toHaveLength(1);
      license.features = ['audit-log'];
      expect((await f.runOnce()).outcome).toBe('sent');
      expect(lines.filter((l) => l.level === 'info')).toHaveLength(2);
      expect(await queued()).toBe('0');
    });

    it('two concurrent passes never send the same event twice (the lease)', async () => {
      for (let i = 0; i < 5; i++) await forwarding(tdb, event(i));
      const sink = new FakeSink();
      let release: () => void = () => undefined;
      sink.gate = new Promise((resolve) => {
        release = resolve;
      });
      const a = forwarder(sink, { batchSize: 3 }).runOnce();
      const b = forwarder(sink, { batchSize: 3 }).runOnce();
      // Both passes have claimed and reached the sink before either send resolves: each holds its rows' lease
      // while the other claims, and neither holds a unit.
      await sink.enteredAtLeast(2);
      release();
      const passes = await Promise.all([a, b]);
      expect(passes.map((p) => p.sent).sort()).toEqual([2, 3]);
      const ids = sink.sent.map((e) => e.id);
      expect(new Set(ids).size).toBe(5);
      expect(ids).toHaveLength(5);
      expect(await queued()).toBe('0');
    });
  });

  describe('the lease (Task 17)', () => {
    const leases = async () =>
      (
        await tdb.query<{ lease: string | null; live: boolean | null }>(
          'select lease_id as lease, leased_until > now() as live from audit_forward_queue order by event_id',
        )
      ).rows;

    it('holds no pooled connection while the sink takes its time', async () => {
      await forwarding(tdb, event(1));
      // One connection in all: a forwarder holding it across the send would leave none for anyone else.
      const single = createDatabase(db.url, { max: 1 });
      try {
        const sink = new FakeSink();
        let release: () => void = () => undefined;
        sink.gate = new Promise((resolve) => {
          release = resolve;
        });
        const pass = forwarder(sink, { tenancy: createTenancy(single) });
        const running = pass.runOnce();
        await sink.enteredAtLeast(1);
        // The send is under way; the one connection is free for a unit of the same tenant.
        const during = await tenantDbFactory(single)(tdb.scope).query<{ lease: string }>(
          'select lease_id as lease from audit_forward_queue',
        );
        expect(during.rows).toHaveLength(1);
        expect(typeof during.rows[0]!.lease).toBe('string');
        release();
        expect((await running).sent).toBe(1);
        expect(await queued()).toBe('0');
      } finally {
        await single.close();
      }
    });

    it('a failed send frees its lease at once; a lease that ran out is claimed again', async () => {
      await forwarding(tdb, event(1));
      const sink = new FakeSink();
      sink.failure = new Error('down');
      expect((await forwarder(sink).runOnce()).outcome).toBe('failed');
      expect(await leases()).toEqual([{ lease: null, live: null }]);
      // A server that stalled after its claim: its lease runs out, and the next claim takes the row.
      await tdb.query(
        "update audit_forward_queue set lease_id = 'L-stalled', leased_until = now() - interval '1 second'",
      );
      sink.failure = undefined;
      expect((await forwarder(sink).runOnce()).sent).toBe(1);
      expect(await queued()).toBe('0');
    });

    it('a live lease keeps the row from another claim, and the stalled server’s delete misses a retaken row', async () => {
      await forwarding(tdb, event(1));
      await tdb.query(
        "update audit_forward_queue set lease_id = 'L-other', leased_until = now() + interval '1 minute'",
      );
      const sink = new FakeSink();
      expect(await forwarder(sink).runOnce()).toMatchObject({ outcome: 'idle', sent: 0 });
      expect(sink.batches).toHaveLength(0);
      // Under another lease id the delete takes nothing.
      const [row] = (await tdb.query<{ id: string }>('select event_id as id from audit_forward_queue')).rows;
      expect(await tdb.transaction((tx) => deleteForwarded(tx, [row!.id], 'L-mine'))).toBe(0);
      expect(await leases()).toEqual([{ lease: 'L-other', live: true }]);
    });
  });

  describe('the loop', () => {
    it('passes at start, every 2 s while busy, every 5 s when idle, backing off on failure', async () => {
      await forwarding(tdb, event(1));
      const timer = manualTimer();
      const sink = new FakeSink();
      const f = forwarder(sink, { setTimer: timer.setTimer, batchSize: 1 });
      f.start();
      await f.runOnce(); // the pass `start` began
      expect(sink.sent).toHaveLength(1);
      expect(timer.delays()).toEqual([FORWARD_BUSY_MS]);
      timer.fire();
      await f.runOnce();
      expect(timer.delays()).toEqual([FORWARD_BUSY_MS, FORWARD_IDLE_MS]);
      sink.failure = new Error('down');
      await forwarding(tdb, event(2));
      timer.fire();
      await f.runOnce();
      timer.fire();
      await f.runOnce();
      expect(timer.delays()).toEqual([FORWARD_BUSY_MS, FORWARD_IDLE_MS, 5_000, 10_000]);
      await f.stop();
      expect(timer.armed.every((entry) => entry.cancelled)).toBe(true);
      expect(sink.closed).toBe(false);
    });

    it('a pass that rejects is logged and the loop re-arms', async () => {
      await forwarding(tdb, event(1));
      const timer = manualTimer();
      const sink = new FakeSink();
      sink.failure = new Error('down');
      const { lines, log } = recordingLog();
      // A logger that throws makes the pass itself reject, past its own catch.
      const throwing = Object.assign(Object.create(log) as FastifyBaseLogger, {
        warn: () => {
          throw new Error('logger broke');
        },
      });
      const f = forwarder(sink, { setTimer: timer.setTimer, log: throwing });
      f.start();
      await expect(f.runOnce()).rejects.toThrow('logger broke');
      expect(timer.delays()).toEqual([FORWARD_BACKOFF_MIN_MS]);
      expect(lines.filter((l) => l.level === 'error')).toHaveLength(1);
      sink.failure = undefined;
      timer.fire();
      expect((await f.runOnce()).outcome).toBe('sent');
      await f.stop();
    });

    it('stop waits for a batch under way, which still commits, and nothing runs after', async () => {
      await forwarding(tdb, event(1));
      const timer = manualTimer();
      const sink = new FakeSink();
      let release: () => void = () => undefined;
      sink.gate = new Promise((resolve) => {
        release = resolve;
      });
      const f = forwarder(sink, { setTimer: timer.setTimer });
      f.start();
      const stopped = f.stop();
      release();
      await stopped;
      expect(sink.sent).toHaveLength(1);
      expect(await queued()).toBe('0');
      expect(timer.armed.filter((entry) => !entry.cancelled)).toHaveLength(0);
      expect(await f.runOnce()).toEqual({ outcome: 'stopped', sent: 0, nextDelayMs: 0 });
    });
  });
});
