import { afterEach, beforeEach, expect, it } from 'vitest';
import { CaptureSweeper, rawSweepTarget } from '../../../src/hooks/sweep.js';
import { newId } from '../../../src/identity/tokens.js';
import * as repo from '../../../src/schedules/repo.js';
import { describeDb } from '../../helpers/database.js';
import { quietLog } from '../../helpers/schedule-runs.js';
import { schedulesHarness, type SchedulesCast } from '../../helpers/schedules.js';

let c: SchedulesCast;
let scheduleId: string;
beforeEach(async () => {
  c = await schedulesHarness();
  scheduleId = newId();
  await repo.insertSchedule(c.h.db, {
    id: scheduleId,
    workspaceId: c.workspaceId,
    name: 'Nightly',
    cron: '0 3 * * *',
    timeZone: 'UTC',
    target: { project: 'Billing' },
    options: { timeoutMinutes: 15, allowProtected: false, insecureTls: false, bail: false },
    alerts: { targets: [], muteAfter: 3 },
    enabled: true,
    nextRunAt: null,
    createdBy: null,
    at: c.h.clock.now,
  });
});
afterEach(async () => {
  await c.close();
});

const DAY = 24 * 60 * 60_000;
const daysAgo = (days: number): Date => new Date(c.h.clock.now.getTime() - days * DAY);

async function run(days: number, status: 'running' | 'skipped' = 'skipped'): Promise<string> {
  const id = newId();
  await repo.insertRun(c.h.db, { id, scheduleId, trigger: 'schedule', status, at: daysAgo(days) });
  return id;
}

async function delivery(days: number, state: 'pending' | 'delivered' | 'dead'): Promise<string> {
  const id = newId();
  await c.h.db.query(
    `insert into schedule_alert_outbox (id, schedule_id, target_index, kind, payload, state, created_at)
     values ($1, $2, 0, 'failure', '{}', $3, $4)`,
    [id, scheduleId, state, daysAgo(days)],
  );
  return id;
}

const ids = async (table: string): Promise<string[]> =>
  (await c.h.db.query<{ id: string }>(`select id from ${table}`)).rows.map((row) => row.id).sort();

describeDb('schedule retention (scheduled-runs spec §3.6)', () => {
  it('deletes finished runs past the maximum age, in batches, with their results; never an open run', async () => {
    const old = [await run(100), await run(95), await run(91)];
    const stuck = await run(120, 'running');
    const recent = await run(10);
    await c.h.db.query(`insert into schedule_results (run_id, ordinal, result) values ($1, 0, '{}')`, [old[0]]);
    const sweeper = new CaptureSweeper({
      target: rawSweepTarget(c.h.db, repo.deleteRunsBefore),
      maxAgeDays: 90,
      now: () => c.h.clock.now,
      setTimer: c.timers.setTimer,
      log: quietLog(),
      batchSize: 2,
    });
    expect(await sweeper.runOnce()).toBe(3);
    expect(await ids('schedule_runs')).toEqual([stuck, recent].sort());
    expect((await c.h.db.query('select 1 from schedule_results')).rowCount).toBe(0);
    await sweeper.stop();
  });

  it('deletes delivered and dead alert deliveries after a week, never a pending one', async () => {
    const gone = [await delivery(8, 'delivered'), await delivery(30, 'dead')];
    const kept = [await delivery(30, 'pending'), await delivery(2, 'delivered')];
    expect(await repo.deleteOutboxBefore(c.h.db, daysAgo(7), 100)).toBe(gone.length);
    expect(await ids('schedule_alert_outbox')).toEqual(kept.sort());
  });
});
