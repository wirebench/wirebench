import { randomUUID } from 'node:crypto';
import type { Feature } from '@wirebench/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { permissiveLicense, type LicenseService } from '../../../src/context.js';
import { newId } from '../../../src/identity/tokens.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { scopeOf } from '../../../src/tenancy/scope.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import type { TenantQuerier } from '../../../src/tenancy/tenant-db.js';
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

/** An enabled hourly schedule, due `dueMs` ago (negative: in the future), in `where`'s tenant and workspace. */
async function seedSchedule(
  name: string,
  dueMs = 0,
  timeoutMinutes = 15,
  where: { readonly tdb: TenantQuerier; readonly workspaceId: string } = { tdb: c.h.tdb, workspaceId: c.workspaceId },
): Promise<string> {
  const id = newId();
  await repo.insertSchedule(where.tdb, {
    id,
    workspaceId: where.workspaceId,
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

/** Suspends or resumes the harness's tenant on its row, as the lifecycle's status write leaves it (spec §22.7). */
async function setSuspended(suspended: boolean): Promise<void> {
  await c.h.db.query('update tenants set status = $2, suspended_reason = $3 where id = $1::uuid', [
    directoryOf(c.h.ctx.tenancy).defaultScope().tenantId,
    suspended ? 'suspended' : 'active',
    suspended ? 'unpaid' : null,
  ]);
}

describeDb('the scheduler (scheduled-runs spec §3.1)', () => {
  it('a suspended tenant fires nothing; on its resume the next run is computed from then, never caught up', async () => {
    const id = await seedSchedule('Hourly', 60_000);
    await setSuspended(true);
    const held = heldRuns();
    const s = scheduler({ execute: held.execute });
    expect(await s.runOnce()).toEqual({ fired: 0, started: 0 });
    const nextAt = async () => new Date((await repo.scheduleById(c.h.tdb, c.workspaceId, id))!.nextRunAt!).getTime();
    expect(await nextAt()).toBeGreaterThan(c.h.clock.now.getTime());
    // Hours suspended: every fire in between passes without a run.
    for (let hour = 0; hour < 5; hour++) {
      c.h.clock.advance(60 * 60_000);
      expect(await s.runOnce()).toEqual({ fired: 0, started: 0 });
    }
    expect(await runsOf(id)).toEqual([]);
    // Resumed between two fires: nothing is caught up, and the next run is the first fire after the resume.
    c.h.clock.advance(20 * 60_000);
    await setSuspended(false);
    const resumedAt = c.h.clock.now.getTime();
    expect(await s.runOnce()).toEqual({ fired: 0, started: 0 });
    expect(await runsOf(id)).toEqual([]);
    const next = await nextAt();
    expect(next).toBeGreaterThan(resumedAt);
    expect(next - resumedAt).toBeLessThanOrEqual(60 * 60_000);
    c.h.clock.set(new Date(next));
    expect((await s.runOnce()).fired).toBe(1);
    expect(await runsOf(id)).toEqual([{ status: 'running', reason: null, trigger: 'schedule' }]);
    await s.stop();
  });

  it('a run queued before the suspension never starts as a catch-up: it ends skipped, suspended (review M2)', async () => {
    const id = await seedSchedule('Hourly', -60 * 60_000);
    await repo.insertRun(c.h.tdb, {
      id: newId(),
      scheduleId: id,
      trigger: 'manual',
      status: 'queued',
      at: c.h.clock.now,
    });
    await setSuspended(true);
    const held = heldRuns();
    const s = scheduler({ execute: held.execute });
    expect(await s.runOnce()).toEqual({ fired: 0, started: 0 });
    expect(held.started).toHaveLength(0);
    await setSuspended(false);
    expect((await s.runOnce()).started).toBe(0);
    expect(held.started).toHaveLength(0);
    expect(await runsOf(id)).toEqual([{ status: 'skipped', reason: 'suspended', trigger: 'manual' }]);
    await s.stop();
  });

  it('a run ending in the stale window starts no queued run of a tenant suspended since the pass (review M1)', async () => {
    const id = await seedSchedule('Hourly', -60 * 60_000);
    for (let n = 0; n < 2; n++) {
      await repo.insertRun(c.h.tdb, {
        id: newId(),
        scheduleId: id,
        trigger: 'manual',
        status: 'queued',
        at: new Date(c.h.clock.now.getTime() + n),
      });
    }
    const held = heldRuns();
    // One run at a time on this server, two slots for the tenant: the second waits for the first to end.
    const s = scheduler({ execute: held.execute, settings: testSettings({ concurrency: 1, runSlots: 2 }) });
    expect((await s.runOnce()).started).toBe(1);
    await setSuspended(true);
    // The first run ends before the next pass: its freed slot must not start the suspended tenant's next run.
    held.started[0]!.release();
    await s.idle();
    expect(held.started).toHaveLength(1);
    await s.stop();
  });

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

  describe('run slots (hosted spec §20.7)', () => {
    /** Another tenant with a workspace, as a hosted server has beside the default one. */
    async function otherTenant() {
      const id = randomUUID();
      await c.h.db.owner.query('insert into tenants (id, slug, name) values ($1, $2, $3)', [id, 'globex', 'Globex']);
      const tdb = c.h.ctx.tenancy.db(scopeOf({ id, slug: 'globex' }));
      const team = await teamsRepo.insertTeam(tdb, { id: newId(), name: 'Globex QA', at: c.h.clock.now });
      const workspaceId = newId();
      await teamsRepo.insertWorkspace(tdb, {
        id: workspaceId,
        name: 'Globex',
        teamId: team.id,
        defaultRole: 'viewer',
        createdBy: null,
        at: c.h.clock.now,
      });
      return { tdb, workspaceId };
    }

    it('a tenant at its run slots waits while another tenant’s run starts, under the per-server cap', async () => {
      const mine = [
        await seedSchedule('One', 3_000),
        await seedSchedule('Two', 2_000),
        await seedSchedule('Three', 1_000),
      ];
      const held = heldRuns();
      const s = scheduler({ execute: held.execute, settings: testSettings({ concurrency: 4, runSlots: 2 }) });
      // Room for four on this server, but the tenant has two slots.
      expect(await s.runOnce()).toEqual({ fired: 3, started: 2 });
      expect((await runsOf(mine[2]!))[0]?.status).toBe('queued');

      const globex = await otherTenant();
      const theirs = await seedSchedule('Theirs', 0, 15, globex);
      expect(await s.runOnce()).toEqual({ fired: 1, started: 1 });
      const their = await globex.tdb.query<{ status: string }>(
        'select status from schedule_runs where schedule_id = $1',
        [theirs],
      );
      expect(their.rows).toEqual([{ status: 'running' }]);
      // The full tenant's third run still waits; it starts as soon as one of its two ends.
      expect((await runsOf(mine[2]!))[0]?.status).toBe('queued');
      expect(s.running).toBe(3);
      // Ended as the executor ends a run: its row first, then the promise.
      await c.h.tdb.query("update schedule_runs set status = 'cancelled', finished_at = started_at where id = $1", [
        held.started[0]!.runId,
      ]);
      held.started[0]!.release();
      await vi.waitFor(async () => {
        expect((await runsOf(mine[2]!))[0]?.status).toBe('running');
      });
      expect(s.running).toBe(3);
      await s.stop();
    });

    it('two servers claiming at once never run more than the tenant’s slots', async () => {
      // Five queued runs, none due to fire: both servers' passes only start.
      const ids = await Promise.all(['A', 'B', 'C', 'D', 'E'].map((name) => seedSchedule(name, -60_000)));
      for (const scheduleId of ids) {
        await repo.insertRun(c.h.tdb, {
          id: newId(),
          scheduleId,
          trigger: 'manual',
          status: 'queued',
          at: c.h.clock.now,
        });
      }
      const held = heldRuns();
      const settings = testSettings({ concurrency: 4, runSlots: 1 });
      // Each claim holds its unit open a moment after claiming, so the other server counts inside that window.
      const claimQueued = async (tx: TenantQuerier, limit: number, at: Date): Promise<string[]> => {
        const claimed = await repo.claimQueuedRuns(tx, limit, at);
        await new Promise((done) => setTimeout(done, 50));
        return claimed;
      };
      const [a, b] = [
        scheduler({ execute: held.execute, settings, claimQueued }),
        scheduler({ execute: held.execute, settings, claimQueued }),
      ];
      await Promise.all([a.runOnce(), b.runOnce()]);
      const statuses = (await Promise.all(ids.map(runsOf))).map((runs) => runs[0]?.status);
      expect(statuses.filter((status) => status === 'running')).toHaveLength(1);
      expect(a.running + b.running).toBe(1);
      await Promise.all([a.stop(), b.stop()]);
    });
  });
});
