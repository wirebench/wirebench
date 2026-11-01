import type { Feature } from '@wirebench/engine';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { permissiveLicense, type LicenseService } from '../../../src/context.js';
import { newId } from '../../../src/identity/tokens.js';
import * as repo from '../../../src/schedules/repo.js';
import { SCHEDULER_TICK_MS, Scheduler, type SchedulerEnv } from '../../../src/schedules/scheduler.js';
import { describeDb } from '../../helpers/database.js';
import { executorEnv, testSettings } from '../../helpers/schedule-runs.js';
import { schedulesHarness, type SchedulesCast } from '../../helpers/schedules.js';

let c: SchedulesCast;
beforeEach(async () => {
  c = await schedulesHarness();
});
afterEach(async () => {
  await c.close();
});

function license(features: readonly Feature[] = ['scheduled-runs']): LicenseService {
  const state = () =>
    Promise.resolve({
      edition: 'enterprise' as const,
      status: 'active' as const,
      seats: { used: 0, limit: null },
      features: [...features],
    });
  return { ...permissiveLicense(), state };
}

/** Runs the scheduler starts, each held until the test releases it or it is aborted. */
function heldRuns() {
  const started: { runId: string; signal: AbortSignal; release: () => void }[] = [];
  const execute = (runId: string, signal: AbortSignal): Promise<void> =>
    new Promise<void>((done) => {
      // A run claimed during a stop starts already aborted.
      if (signal.aborted) done();
      else signal.addEventListener('abort', () => done(), { once: true });
      started.push({ runId, signal, release: done });
    });
  return { started, execute };
}

/** Lets pending callbacks run: a turn of the event loop, never a timed wait. */
const turn = (): Promise<void> => new Promise((done) => setImmediate(done));

function scheduler(overrides: Partial<SchedulerEnv> = {}): Scheduler {
  return new Scheduler({
    ...executorEnv(c, null, '/nonexistent'),
    tenancy: c.h.ctx.tenancy,
    license: () => license(),
    ...overrides,
  });
}

/** An enabled hourly schedule, due `dueMs` ago (negative: in the future). */
async function seedSchedule(name: string, dueMs = 0, timeoutMinutes = 15): Promise<string> {
  const id = newId();
  await repo.insertSchedule(c.h.tdb, {
    id,
    workspaceId: c.workspaceId,
    name,
    cron: '0 * * * *',
    timeZone: 'UTC',
    target: { project: 'Billing' },
    options: { timeoutMinutes, allowProtected: false, insecureTls: false, bail: false },
    alerts: { targets: [], muteAfter: 3 },
    enabled: true,
    nextRunAt: new Date(c.h.clock.now.getTime() - dueMs),
    createdBy: null,
    at: c.h.clock.now,
  });
  return id;
}

async function runsOf(scheduleId: string) {
  const rows = await c.h.tdb.query<{ status: string; reason: string | null; trigger: string }>(
    'select status, reason, trigger from schedule_runs where schedule_id = $1 order by queued_at, id',
    [scheduleId],
  );
  return rows.rows;
}

describeDb('the scheduler (scheduled-runs spec §3.1)', () => {
  it('fires a due schedule once, even with two servers passing at the same time', async () => {
    const id = await seedSchedule('Hourly');
    const held = heldRuns();
    const [a, b] = [scheduler({ execute: held.execute }), scheduler({ execute: held.execute })];
    const passes = await Promise.all([a.runOnce(), b.runOnce()]);
    expect(passes.reduce((sum, pass) => sum + pass.fired, 0)).toBe(1);
    expect(await runsOf(id)).toEqual([{ status: 'running', reason: null, trigger: 'schedule' }]);
    expect(held.started).toHaveLength(1);
    await Promise.all([a.stop(), b.stop()]);
  });

  it('moves the next fire past now, so missed fires collapse to one run', async () => {
    const id = await seedSchedule('Hourly', 3 * 60 * 60_000 + 60_000);
    const s = scheduler({ execute: heldRuns().execute });
    await s.runOnce();
    expect(await runsOf(id)).toHaveLength(1);
    const next = new Date((await repo.scheduleById(c.h.tdb, c.workspaceId, id))!.nextRunAt!);
    expect(next.getTime()).toBeGreaterThan(c.h.clock.now.getTime());
    expect(next.getUTCMinutes()).toBe(0);
    expect((await s.runOnce()).fired).toBe(0);
    await s.stop();
  });

  it('a schedule not yet due, or switched off, does not fire', async () => {
    await seedSchedule('Later', -60_000);
    const off = await seedSchedule('Off');
    await c.h.tdb.query('update schedules set enabled = false where id = $1', [off]);
    const s = scheduler({ execute: heldRuns().execute });
    expect(await s.runOnce()).toEqual({ fired: 0, started: 0 });
    await s.stop();
  });

  it('a fire while a run is still open is recorded as skipped, with reason overlap', async () => {
    // A two-hour deadline: an hour later the first run is still open, not past its deadline.
    const id = await seedSchedule('Hourly', 0, 120);
    const s = scheduler({ execute: heldRuns().execute });
    await s.runOnce();
    c.h.clock.advance(60 * 60_000);
    await s.runOnce();
    expect(await runsOf(id)).toEqual([
      { status: 'running', reason: null, trigger: 'schedule' },
      { status: 'skipped', reason: 'overlap', trigger: 'schedule' },
    ]);
    await s.stop();
  });

  it('runs at most the concurrency cap at once, oldest queued first, and starts the next as one ends', async () => {
    const first = await seedSchedule('First', 3_000);
    const second = await seedSchedule('Second', 2_000);
    const third = await seedSchedule('Third', 1_000);
    const held = heldRuns();
    const s = scheduler({ execute: held.execute, settings: testSettings({ concurrency: 2 }) });
    expect(await s.runOnce()).toEqual({ fired: 3, started: 2 });
    expect(s.running).toBe(2);
    expect((await runsOf(first))[0]?.status).toBe('running');
    expect((await runsOf(second))[0]?.status).toBe('running');
    expect((await runsOf(third))[0]?.status).toBe('queued');
    // Ends as the executor would, which frees its slot for the queued run.
    const done = held.started[0]!;
    await c.h.tdb.query("update schedule_runs set status = 'passed' where id = $1", [done.runId]);
    done.release();
    while (held.started.length < 3) await turn();
    expect((await runsOf(third))[0]?.status).toBe('running');
    await s.stop();
  });

  it('without the scheduled-runs feature nothing fires and nothing starts', async () => {
    const id = await seedSchedule('Hourly');
    const s = scheduler({ execute: heldRuns().execute, license: () => license([]) });
    expect(await s.runOnce()).toEqual({ fired: 0, started: 0 });
    expect(await runsOf(id)).toEqual([]);
    await s.stop();
  });

  it('stop aborts the runs in flight for a shutdown and waits for them', async () => {
    await seedSchedule('Hourly');
    const held = heldRuns();
    const s = scheduler({ execute: held.execute });
    await s.runOnce();
    await s.stop();
    expect(held.started.map((run) => run.signal.reason as unknown)).toEqual(['shutdown']);
    expect(s.running).toBe(0);
  });

  it('a stop while a pass is claiming aborts what the pass claims, and waits for it', async () => {
    await seedSchedule('Hourly');
    const held = heldRuns();
    let stopping: Promise<void> | undefined;
    // The claim commits, then the server stops before the pass launches what it claimed.
    const claimQueued: SchedulerEnv['claimQueued'] = async (tx, limit, at) => {
      const claimed = await repo.claimQueuedRuns(tx, limit, at);
      if (stopping === undefined && claimed.length > 0) stopping = s.stop();
      return claimed;
    };
    const s = scheduler({ claimQueued, execute: held.execute });
    await s.runOnce();
    await stopping;
    expect(held.started.map((run) => run.signal.reason as unknown)).toEqual(['shutdown']);
    expect(s.running).toBe(0);
  });

  it('cancel aborts a run this server is running, and says when it is not', async () => {
    await seedSchedule('Hourly');
    const held = heldRuns();
    const s = scheduler({ execute: held.execute });
    await s.runOnce();
    expect(s.cancel(c.h.tdb.scope, held.started[0]!.runId)).toBe(true);
    expect(held.started[0]!.signal.reason).toBe('cancelled');
    expect(s.cancel(c.h.tdb.scope, 'not-here')).toBe(false);
    await s.stop();
  });

  it('a run left running past its deadline by a server that died ends interrupted and counts for alerts; a live one is left alone', async () => {
    const id = await seedSchedule('Hourly', -60 * 60_000);
    const at = (minutesAgo: number): Date => new Date(c.h.clock.now.getTime() - minutesAgo * 60_000);
    const stale = newId();
    const live = newId();
    await repo.insertRun(c.h.tdb, { id: stale, scheduleId: id, trigger: 'schedule', status: 'running', at: at(17) });
    await repo.insertRun(c.h.tdb, { id: live, scheduleId: id, trigger: 'manual', status: 'running', at: at(5) });
    const s = scheduler({ execute: heldRuns().execute });
    await s.runOnce();
    expect((await repo.runWithSchedule(c.h.tdb, stale))!.run).toMatchObject({
      status: 'errored',
      reason: 'interrupted',
    });
    expect((await repo.runWithSchedule(c.h.tdb, live))!.run.status).toBe('running');
    // An interrupted run is an errored one to the alert state.
    expect(await repo.scheduleById(c.h.tdb, c.workspaceId, id)).toMatchObject({
      alertState: 'failing',
      failureStreak: 1,
    });
    await s.stop();
  });

  it('start passes at once and again every tick; stop disarms the timer', async () => {
    const id = await seedSchedule('Hourly');
    const s = scheduler({ execute: heldRuns().execute });
    s.start();
    await s.runOnce();
    await turn();
    expect(await runsOf(id)).toHaveLength(1);
    expect(c.timers.pending(SCHEDULER_TICK_MS)).toBe(1);
    await s.stop();
    expect(c.timers.pending(SCHEDULER_TICK_MS)).toBe(0);
  });
});
