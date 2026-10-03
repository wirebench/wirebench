import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import { auditEventSchema, type AuditEvent, type LicenseState } from '@wirebench/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditForwarder,
  FORWARD_BACKOFF_MAX_MS,
  FORWARD_BUSY_MS,
  FORWARD_IDLE_MS,
  FORWARD_UNLICENSED_MS,
  type ForwardSink,
} from '../../../src/audit-log/forward/forwarder.js';
import { auditHook } from '../../../src/audit-log/hook.js';
import { deleteAuditEventsBefore } from '../../../src/audit-log/repo.js';
import { permissiveLicense, type AuditInput, type LicenseService } from '../../../src/context.js';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '../../../src/db/migrate.js';
import { describeDb, testDatabase } from '../../helpers/database.js';

const dir = (name: string) => fileURLToPath(new URL(`../../../migrations/${name}/`, import.meta.url));

/** Records every batch; `failWith` makes the next sends reject; `gate` holds sends until released. */
class FakeSink implements ForwardSink {
  readonly batches: AuditEvent[][] = [];
  failure: Error | undefined;
  gate: Promise<void> | undefined;
  closed = false;
  entered = 0;
  async send(events: AuditEvent[]): Promise<void> {
    this.entered += 1;
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

function licensed(features: string[]): LicenseService & { features: string[] } {
  const base = permissiveLicense();
  const service = {
    ...base,
    features,
    state: (): Promise<LicenseState> =>
      Promise.resolve({
        edition: 'enterprise',
        status: 'active',
        seats: { used: 0, limit: null },
        features: [...service.features],
      }),
  };
  return service;
}

describeDb('the audit forward outbox and forwarder (issue #209)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
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
    (await db.query<{ n: string }>('select count(*)::text as n from audit_forward_queue')).rows[0]!.n;
  const forwarder = (sink: ForwardSink, extra: Partial<ConstructorParameters<typeof AuditForwarder>[0]> = {}) =>
    new AuditForwarder({
      db,
      sink,
      license: () => licensed(['audit-log']),
      now: clock,
      setTimer: manualTimer().setTimer,
      log: recordingLog().log,
      ...extra,
    });

  beforeAll(async () => {
    db = await testDatabase();
    const modules = await Promise.all(
      ['identity', 'teams-access', 'audit-log'].map((name) => loadMigrations(dir(name), { contiguous: false })),
    );
    await migrate(
      db,
      [...(await loadMigrations(MIGRATIONS_DIR)), ...modules.flat()].sort((a, b) => a.version - b.version),
    );
  });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.query('delete from audit_events');
  });

  describe('the hook', () => {
    it('configured, queues a recorded event in the same transaction', async () => {
      await db.transaction(async (tx) => {
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
        db.transaction(async (tx) => {
          await forwarding(tx, event(1));
          throw new Error('the action failed');
        }),
      ).rejects.toThrow('the action failed');
      expect(await queued()).toBe('0');
      expect((await db.query('select id from audit_events')).rows).toHaveLength(0);
    });

    it('unconfigured, records the event and queues nothing', async () => {
      await plain(db, event(1));
      expect((await db.query('select id from audit_events')).rows).toHaveLength(1);
      expect(await queued()).toBe('0');
    });

    it('a deleted event (retention) takes its queue row with it', async () => {
      await forwarding(db, event(1));
      await forwarding(db, event(2));
      expect(await deleteAuditEventsBefore(db, new Date(tick + 1), 10)).toBe(2);
      expect(await queued()).toBe('0');
    });
  });

  describe('runOnce', () => {
    it('sends oldest first, as the API returns events, and empties the queue', async () => {
      for (let i = 0; i < 5; i++) await forwarding(db, event(i));
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
      expect((await db.query('select id from audit_events')).rows).toHaveLength(5);
    });

    it('a failing sink keeps the rows and backs off 5 s, doubling to 300 s; a success resets it', async () => {
      await forwarding(db, event(1));
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
      await forwarding(db, event(2));
      expect((await f.runOnce()).nextDelayMs).toBe(5_000);
      expect(lines.filter((l) => l.level === 'warn')).toHaveLength(2);
      expect(JSON.stringify(lines)).not.toContain('a@example.com');
    });

    it('without the audit-log feature sends nothing, keeps the rows, and checks again after 60 s', async () => {
      await forwarding(db, event(1));
      const sink = new FakeSink();
      const license = licensed([]);
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

    it('two concurrent passes never send the same event twice (skip locked)', async () => {
      for (let i = 0; i < 5; i++) await forwarding(db, event(i));
      const sink = new FakeSink();
      let release: () => void = () => undefined;
      sink.gate = new Promise((resolve) => {
        release = resolve;
      });
      const a = forwarder(sink, { batchSize: 3 }).runOnce();
      const b = forwarder(sink, { batchSize: 3 }).runOnce();
      // Both passes have claimed and reached the sink before either send resolves, so each
      // transaction still holds its rows' locks while the other claims.
      for (let i = 0; i < 1_000 && sink.entered < 2; i++) await new Promise((r) => setImmediate(r));
      expect(sink.entered).toBe(2);
      release();
      const passes = await Promise.all([a, b]);
      expect(passes.map((p) => p.sent).sort()).toEqual([2, 3]);
      const ids = sink.sent.map((e) => e.id);
      expect(new Set(ids).size).toBe(5);
      expect(ids).toHaveLength(5);
      expect(await queued()).toBe('0');
    });
  });

  describe('the loop', () => {
    it('passes at start, every 2 s while busy, every 5 s when idle, backing off on failure', async () => {
      await forwarding(db, event(1));
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
      await forwarding(db, event(2));
      timer.fire();
      await f.runOnce();
      timer.fire();
      await f.runOnce();
      expect(timer.delays()).toEqual([FORWARD_BUSY_MS, FORWARD_IDLE_MS, 5_000, 10_000]);
      await f.stop();
      expect(timer.armed.every((entry) => entry.cancelled)).toBe(true);
      expect(sink.closed).toBe(false);
    });

    it('stop waits for a batch under way, which still commits, and nothing runs after', async () => {
      await forwarding(db, event(1));
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
