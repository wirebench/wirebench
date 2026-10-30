import { afterEach, expect, it } from 'vitest';
import { isUniqueViolation } from '../../../src/db/errors.js';
import { newId } from '../../../src/identity/tokens.js';
import * as repo from '../../../src/schedules/repo.js';
import { describeDb } from '../../helpers/database.js';
import { schedulesHarness, type SchedulesCast } from '../../helpers/schedules.js';

let c: SchedulesCast | undefined;
afterEach(async () => {
  await c?.close();
  c = undefined;
});

function schedule(cast: SchedulesCast, name: string): repo.NewSchedule {
  return {
    id: newId(),
    workspaceId: cast.workspaceId,
    name,
    cron: '*/5 * * * *',
    timeZone: 'Europe/Vienna',
    target: { project: 'billing', environment: 'prod' },
    options: { timeoutMinutes: 15, allowProtected: false, insecureTls: false, bail: false },
    alerts: { targets: [{ kind: 'email', to: ['ops@example.test'] }], muteAfter: 3 },
    enabled: true,
    nextRunAt: new Date('2026-09-24T12:05:00.000Z'),
    createdBy: cast.admin.user.id,
    at: cast.h.clock.now,
  };
}

describeDb('the schedules repository (scheduled-runs §4)', () => {
  it('writes a schedule and reads it back whole, with its creator', async () => {
    c = await schedulesHarness({ enterprise: false });
    const input = schedule(c, 'Smoke');
    await repo.insertSchedule(c.h.tdb, input);
    const row = await repo.scheduleById(c.h.tdb, c.workspaceId, input.id);
    expect(row).toEqual({
      id: input.id,
      workspaceId: c.workspaceId,
      name: 'Smoke',
      cron: '*/5 * * * *',
      timeZone: 'Europe/Vienna',
      target: input.target,
      options: input.options,
      alerts: input.alerts,
      secrets: {},
      enabled: true,
      nextRunAt: '2026-09-24T12:05:00.000Z',
      alertState: 'ok',
      failureStreak: 0,
      createdBy: c.admin.user.id,
      createdByName: 'admin',
      createdAt: c.h.clock.now.toISOString(),
      updatedAt: c.h.clock.now.toISOString(),
    });
    expect(await repo.scheduleById(c.h.tdb, newId(), input.id)).toBeUndefined();
  });

  it('lists by name, counts, refuses a name taken in any case, and updates', async () => {
    c = await schedulesHarness({ enterprise: false });
    const smoke = schedule(c, 'smoke');
    await repo.insertSchedule(c.h.tdb, schedule(c, 'Nightly'));
    await repo.insertSchedule(c.h.tdb, smoke);
    expect((await repo.schedulesOfWorkspace(c.h.tdb, c.workspaceId)).map((s) => s.name)).toEqual(['Nightly', 'smoke']);
    expect(await repo.countSchedules(c.h.tdb, c.workspaceId)).toBe(2);
    const taken = await repo.insertSchedule(c.h.tdb, schedule(c, 'SMOKE')).catch((error: unknown) => error);
    expect(isUniqueViolation(taken, repo.SCHEDULE_NAME_INDEX)).toBe(true);

    await repo.updateSchedule(c.h.tdb, { ...smoke, name: 'Smoke', enabled: false, nextRunAt: null });
    const updated = await repo.scheduleById(c.h.tdb, c.workspaceId, smoke.id);
    expect(updated).toMatchObject({ name: 'Smoke', enabled: false, nextRunAt: null });
  });

  it('keeps secrets as given, and a removal takes the runs with it', async () => {
    c = await schedulesHarness({ enterprise: false });
    const input = schedule(c, 'Smoke');
    await repo.insertSchedule(c.h.tdb, input);
    await repo.setScheduleSecrets(c.h.tdb, input.id, { API_KEY: { sealed: 'AAAA', hint: 'abcd' } }, c.h.clock.now);
    expect((await repo.scheduleById(c.h.tdb, c.workspaceId, input.id))?.secrets).toEqual({
      API_KEY: { sealed: 'AAAA', hint: 'abcd' },
    });
    await c.h.db.query(
      `insert into schedule_runs (id, schedule_id, trigger, status) values ($1, $2, 'manual', 'queued')`,
      [newId(), input.id],
    );
    expect((await repo.lastRunsOf(c.h.tdb, [input.id])).get(input.id)).toMatchObject({
      status: 'queued',
      trigger: 'manual',
    });
    expect(await repo.deleteSchedule(c.h.tdb, newId(), input.id)).toBeUndefined();
    expect(await repo.deleteSchedule(c.h.tdb, c.workspaceId, input.id)).toBe('Smoke');
    expect((await c.h.db.query('select 1 from schedule_runs')).rowCount).toBe(0);
  });
});
