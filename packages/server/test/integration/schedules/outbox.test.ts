import type { ScheduleRunStatus } from '@wirebench/engine';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { newId } from '../../../src/identity/tokens.js';
import {
  ALERT_MAX_ATTEMPTS,
  backoffMs,
  enqueueAlerts,
  failuresOf,
  type AlertRun,
} from '../../../src/schedules/alerts/outbox.js';
import type { AlertPayload } from '../../../src/schedules/alerts/render.js';
import * as repo from '../../../src/schedules/repo.js';
import { sealAlertTargets } from '../../../src/schedules/seal.js';
import { describeDb } from '../../helpers/database.js';
import { testSettings } from '../../helpers/schedule-runs.js';
import { schedulesHarness, type SchedulesCast } from '../../helpers/schedules.js';

const SMTP = { url: 'smtp://mail.example.test:587', from: 'wirebench@example.test' };

type OutboxRow = {
  state: string;
  attempts: number;
  nextAt: Date;
  lastError: string | null;
  kind: string;
  targetIndex: number;
  payload: AlertPayload;
};

describeDb('schedule alerts: state, outbox and delivery (scheduled-runs spec §3.4)', () => {
  let c: SchedulesCast;
  let scheduleId: string;
  beforeEach(async () => {
    c = await schedulesHarness();
    scheduleId = newId();
    await repo.insertSchedule(c.h.tdb, {
      id: scheduleId,
      workspaceId: c.workspaceId,
      name: 'Nightly',
      cron: '0 3 * * *',
      timeZone: 'UTC',
      target: { project: 'Billing', environment: 'prod' },
      options: { timeoutMinutes: 15, allowProtected: false, insecureTls: false, bail: false },
      alerts: {
        targets: sealAlertTargets(testSettings({ smtp: SMTP }), [
          { kind: 'email', to: ['ops@example.test'] },
          { kind: 'webhook', url: 'https://hooks.example.test/in', secret: 'shh' },
        ]),
        muteAfter: 2,
      },
      enabled: true,
      nextRunAt: null,
      createdBy: c.admin.user.id,
      at: c.h.clock.now,
    });
  });
  afterEach(async () => {
    await c.close();
  });

  const env = () => ({ settings: testSettings(), now: () => c.h.clock.now });
  const finish = async (status: ScheduleRunStatus, results: unknown[] = []): Promise<AlertRun> => {
    const run: AlertRun = {
      id: newId(),
      status,
      reason: null,
      commit: 'abcdef0123456789abcdef0123456789abcdef01',
      environment: 'prod',
      summary: { total: 2, passed: 1, failed: status === 'failed' ? 1 : 0, errored: 0, skipped: 0, durationMs: 1200 },
      results,
    };
    await repo.insertRun(c.h.tdb, {
      id: run.id,
      scheduleId,
      trigger: 'schedule',
      status: 'running',
      at: c.h.clock.now,
    });
    await c.h.tdb.transaction((tx) => enqueueAlerts(tx, env(), scheduleId, run));
    return run;
  };
  const rows = async (): Promise<OutboxRow[]> =>
    (
      await c.h.db.query<OutboxRow>(
        `select state, attempts, next_at as "nextAt", last_error as "lastError", kind, target_index as "targetIndex",
           payload from schedule_alert_outbox order by created_at, target_index`,
      )
    ).rows;
  const alertState = async () =>
    (
      await c.h.db.query<{ alertState: string; failureStreak: number }>(
        'select alert_state as "alertState", failure_streak as "failureStreak" from schedules where id = $1',
        [scheduleId],
      )
    ).rows[0];

  it('a failure turns the schedule failing and queues one delivery per target, with the payload', async () => {
    const run = await finish('failed', [
      { path: 'Api/Health', outcome: 'passed', assertions: [] },
      {
        path: 'Api/Login',
        outcome: 'failed',
        assertions: [
          { label: 'status', outcome: 'passed' },
          { label: 'status is 200', outcome: 'failed', expected: '200', actual: '500' },
        ],
      },
    ]);
    expect(await alertState()).toEqual({ alertState: 'failing', failureStreak: 1 });
    const queued = await rows();
    expect(queued.map((row) => [row.targetIndex, row.kind, row.state, row.attempts])).toEqual([
      [0, 'failure', 'pending', 0],
      [1, 'failure', 'pending', 0],
    ]);
    expect(queued[0]!.payload).toEqual({
      kind: 'failure',
      streak: 1,
      muted: false,
      schedule: { id: scheduleId, name: 'Nightly' },
      workspace: { id: c.workspaceId, name: 'Smoke' },
      project: 'Billing',
      environment: 'prod',
      run: {
        id: run.id,
        status: 'failed',
        reason: null,
        commit: 'abcdef0123456789abcdef0123456789abcdef01',
        total: 2,
        failed: 1,
        errored: 0,
        durationMs: 1200,
        url: `https://wirebench.example.test/api/v1/workspaces/${c.workspaceId}/schedules/${scheduleId}/runs/${run.id}`,
      },
      failures: [{ path: 'Api/Login', message: 'status is 200: expected 200, got 500' }],
    });
  });

  it('mutes after muteAfter, recovers with an alert, and a pass from ok or a skip queues nothing', async () => {
    await finish('passed');
    await finish('skipped');
    expect(await rows()).toEqual([]);
    for (const status of ['failed', 'errored', 'failed'] as const) await finish(status);
    expect(await alertState()).toEqual({ alertState: 'failing', failureStreak: 3 });
    await finish('passed');
    expect(await alertState()).toEqual({ alertState: 'ok', failureStreak: 0 });
    const sent = (await rows()).filter((row) => row.targetIndex === 0).map((row) => row.payload);
    expect(sent.map((p) => [p.kind, p.streak, p.muted])).toEqual([
      ['failure', 1, false],
      ['failure', 2, true],
      ['recovery', 3, false],
    ]);
  });

  it('the worker delivers each queued alert to its target, once', async () => {
    await finish('failed');
    expect(await c.outbox().runOnce()).toEqual({ delivered: 2, failed: 0 });
    expect(c.deliveries.map((d) => [d.target.kind, d.payload.kind])).toEqual([
      ['email', 'failure'],
      ['webhook', 'failure'],
    ]);
    expect((await rows()).map((row) => [row.state, row.attempts])).toEqual([
      ['delivered', 1],
      ['delivered', 1],
    ]);
    expect(await c.outbox().runOnce()).toEqual({ delivered: 0, failed: 0 });
    expect(c.deliveries).toHaveLength(2);
  });

  it('retries a failed delivery with backoff from 5 s to 300 s, then marks it dead and logs', async () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffMs)).toEqual([5, 10, 20, 40, 80, 160, 300].map((s) => s * 1000));
    c.failDeliveries('connection refused');
    await finish('failed');
    await c.outbox().runOnce();
    let [first] = await rows();
    expect(first).toMatchObject({ state: 'pending', attempts: 1, lastError: 'connection refused' });
    expect(first!.nextAt.getTime() - c.h.clock.now.getTime()).toBe(5_000);
    // Not due yet: nothing is tried.
    expect(await c.outbox().runOnce()).toEqual({ delivered: 0, failed: 0 });
    for (let attempt = 2; attempt <= ALERT_MAX_ATTEMPTS; attempt += 1) {
      c.h.clock.advance(backoffMs(attempt - 1));
      expect(await c.outbox().runOnce()).toEqual({ delivered: 0, failed: 2 });
    }
    [first] = await rows();
    expect(first).toMatchObject({ state: 'dead', attempts: ALERT_MAX_ATTEMPTS, lastError: 'connection refused' });
    c.h.clock.advance(3_600_000);
    expect(await c.outbox().runOnce()).toEqual({ delivered: 0, failed: 0 });
    expect(c.deliveries).toHaveLength(0);
  });

  it('a target removed since the alert was queued is not delivered to', async () => {
    await finish('failed');
    const row = await repo.scheduleById(c.h.tdb, c.workspaceId, scheduleId);
    await c.h.db.query('update schedules set alerts = $2 where id = $1', [
      scheduleId,
      JSON.stringify({ ...row!.alerts, targets: row!.alerts.targets.slice(0, 1) }),
    ]);
    expect(await c.outbox().runOnce()).toEqual({ delivered: 1, failed: 1 });
    expect((await rows())[1]).toMatchObject({ state: 'pending', lastError: 'the alert target was removed' });
  });

  it('rechecks the license before each pass: without the feature nothing goes out', async () => {
    await finish('failed');
    await c.install('team');
    expect(await c.outbox().runOnce()).toEqual({ delivered: 0, failed: 0 });
    expect((await rows()).every((row) => row.state === 'pending' && row.attempts === 0)).toBe(true);
    await c.install('enterprise');
    expect(await c.outbox().runOnce()).toEqual({ delivered: 2, failed: 0 });
  });

  it('names at most three failing requests, an error when no assertion failed, and clips long messages', () => {
    const failing = (path: string, extra: object) => ({ path, outcome: 'failed', assertions: [], ...extra });
    expect(
      failuresOf([
        failing('A', { outcome: 'errored', error: { code: 'x', message: 'connect ECONNREFUSED' } }),
        failing('B', { assertions: [{ label: 'xpath', outcome: 'errored', message: 'does not compile' }] }),
        failing('C', { assertions: [{ label: 'script test', outcome: 'failed' }] }),
        failing('D', {}),
      ]),
    ).toEqual([
      { path: 'A', message: 'connect ECONNREFUSED' },
      { path: 'B', message: 'xpath: does not compile' },
      { path: 'C', message: 'script test failed' },
    ]);
    const [long] = failuresOf([failing('E', { error: { message: 'x'.repeat(1000) } })]);
    expect(long!.message).toHaveLength(300);
  });
});
