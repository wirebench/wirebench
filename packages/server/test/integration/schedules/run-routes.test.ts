import type { ScheduleRun, ScheduleRunDetail, ScheduleRunPage } from '@wirebench/engine';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { newId } from '../../../src/identity/tokens.js';
import * as repo from '../../../src/schedules/repo.js';
import { describeDb } from '../../helpers/database.js';
import { schedulesHarness, type SchedulesCast } from '../../helpers/schedules.js';
import { call } from '../../helpers/teams.js';

let c: SchedulesCast;
let scheduleId: string;
beforeEach(async () => {
  c = await schedulesHarness();
  const created = await call<{ id: string }>(c.h, c.admin, 'POST', `/workspaces/${c.workspaceId}/schedules`, {
    name: 'Nightly',
    schedule: '@daily',
    target: { project: 'Billing' },
  });
  scheduleId = created.body.id;
});
afterEach(async () => {
  await c.close();
});

const runs = (): string => `/workspaces/${c.workspaceId}/schedules/${scheduleId}/runs`;

/** A run of the schedule queued `minutesAgo` before the harness clock, with `status`. */
async function seedRun(minutesAgo: number, status: 'queued' | 'running' | 'skipped' = 'skipped'): Promise<string> {
  const id = newId();
  await repo.insertRun(c.h.db, {
    id,
    scheduleId,
    trigger: 'schedule',
    status,
    at: new Date(c.h.clock.now.getTime() - minutesAgo * 60_000),
  });
  return id;
}

describeDb('the runs API (scheduled-runs spec §3.7)', () => {
  it('run now queues a manual run for an admin, and starts it at once', async () => {
    const res = await call<ScheduleRun>(c.h, c.admin, 'POST', runs());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ scheduleId, trigger: 'manual', status: 'queued', summary: null });
    await c.scheduler().runOnce();
    expect(c.started.map((run) => run.runId)).toEqual([res.body.id]);
  });

  it('run now is refused while a run is open, and for anyone but an admin', async () => {
    expect((await call(c.h, c.admin, 'POST', runs())).status).toBe(201);
    expect(await call(c.h, c.admin, 'POST', runs())).toMatchObject({
      status: 409,
      body: { code: 'schedules-run-open' },
    });
    expect((await call(c.h, c.editor, 'POST', runs())).status).toBe(403);
    expect((await call(c.h, c.stranger, 'POST', runs())).status).toBe(404);
  });

  it('the history is newest first, cursor paged and filtered by status, for every role', async () => {
    const ids = [await seedRun(50), await seedRun(40), await seedRun(30), await seedRun(20, 'queued')];
    const first = await call<ScheduleRunPage>(c.h, c.viewer, 'GET', `${runs()}?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.runs.map((run) => run.id)).toEqual([ids[3], ids[2]]);
    const second = await call<ScheduleRunPage>(c.h, c.viewer, 'GET', `${runs()}?limit=2&after=${first.body.next!}`);
    expect(second.body.runs.map((run) => run.id)).toEqual([ids[1], ids[0]]);
    expect(second.body.next).toBeUndefined();
    const queued = await call<ScheduleRunPage>(c.h, c.viewer, 'GET', `${runs()}?status=queued`);
    expect(queued.body.runs.map((run) => run.id)).toEqual([ids[3]]);
  });

  it('a cursor the server did not give out is refused', async () => {
    for (const after of ['nonsense', Buffer.from('["not a date","x"]').toString('base64url')]) {
      expect(await call(c.h, c.viewer, 'GET', `${runs()}?after=${after}`)).toMatchObject({
        status: 400,
        body: { code: 'schedules-cursor-invalid' },
      });
    }
  });

  it('one run comes with its stored results; a run of another schedule is not found', async () => {
    const runId = await seedRun(5, 'running');
    const failed = { path: 'Api/Fail', group: 'Api', name: 'Fail', protocol: 'rest', outcome: 'failed', exchange: {} };
    await repo.finishRun(c.h.db, runId, {
      status: 'failed',
      reason: null,
      commit: 'c'.repeat(40),
      environment: 'prod',
      summary: { total: 1, passed: 0, failed: 1, errored: 0, skipped: 0, durationMs: 12 },
      results: [failed],
      at: c.h.clock.now,
    });
    const res = await call<ScheduleRunDetail>(c.h, c.viewer, 'GET', `${runs()}/${runId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: runId, status: 'failed', commit: 'c'.repeat(40), results: [failed] });
    expect(await call(c.h, c.viewer, 'GET', `${runs()}/${newId()}`)).toMatchObject({
      status: 404,
      body: { code: 'schedules-run-not-found' },
    });
  });

  it('cancel ends a queued run, aborts a running one, and refuses a finished one', async () => {
    const queued = await seedRun(10, 'queued');
    expect((await call(c.h, c.admin, 'DELETE', `${runs()}/${queued}`)).status).toBe(204);
    expect(await repo.runById(c.h.db, scheduleId, queued)).toMatchObject({
      status: 'cancelled',
      reason: 'cancelled',
    });

    const started = await call<ScheduleRun>(c.h, c.admin, 'POST', runs());
    await c.scheduler().runOnce();
    expect((await call(c.h, c.admin, 'DELETE', `${runs()}/${started.body.id}`)).status).toBe(204);
    expect(c.started[0]!.signal.reason).toBe('cancelled');

    const skipped = await seedRun(1);
    expect(await call(c.h, c.admin, 'DELETE', `${runs()}/${skipped}`)).toMatchObject({
      status: 409,
      body: { code: 'schedules-run-finished' },
    });
    expect((await call(c.h, c.editor, 'DELETE', `${runs()}/${skipped}`)).status).toBe(403);
  });
});
