import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncFile } from '@wirebench/engine';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { executeRun, type ExecutorEnv } from '../../../src/schedules/executor.js';
import * as repo from '../../../src/schedules/repo.js';
import { sealAlertTargets } from '../../../src/schedules/seal.js';
import { describeDb } from '../../helpers/database.js';
import {
  API_KEY,
  HEAD,
  executorEnv,
  fixtureServer,
  probe,
  quietLog,
  seedRun,
  testSettings,
  workspaceSnapshot,
  type FixtureServer,
} from '../../helpers/schedule-runs.js';
import { schedulesHarness, type SchedulesCast } from '../../helpers/schedules.js';

let c: SchedulesCast;
let server: FixtureServer;
let tmpRoot: string;
beforeEach(async () => {
  c = await schedulesHarness();
  server = await fixtureServer();
  tmpRoot = await mkdtemp(join(tmpdir(), 'wb-schedule-runs-'));
});
afterEach(async () => {
  await server.close();
  await c.close();
  await rm(tmpRoot, { recursive: true, force: true });
});

const never = new AbortController().signal;

async function runOnce(
  files: readonly SyncFile[] | null,
  seed: Parameters<typeof seedRun>[1] = {},
  overrides: Partial<ExecutorEnv> = {},
) {
  const { runId } = await seedRun(c, seed);
  await executeRun(executorEnv(c, files, tmpRoot, overrides), c.h.tdb.scope, runId, never);
  const found = await repo.runWithSchedule(c.h.tdb, runId);
  expect(await readdir(tmpRoot)).toEqual([]);
  return { run: found!.run, results: await repo.resultsOf(c.h.tdb, runId) };
}

describeDb('executeRun (scheduled-runs spec §3.2)', () => {
  it('a passing run stores its summary and masked results, with the commit and environment', async () => {
    const { run, results } = await runOnce(await workspaceSnapshot([probe('Ok', `${server.url}/ok`)]));
    expect(run).toMatchObject({ status: 'passed', reason: null, commit: HEAD, environment: 'prod' });
    expect(run.summary).toMatchObject({ total: 1, passed: 1, failed: 0, errored: 0, skipped: 0 });
    expect(results).toEqual([expect.objectContaining({ name: 'Ok', outcome: 'passed', status: 200 })]);
    expect(server.seen[0]?.['x-key']).toBe(API_KEY);
  });

  it("the server's own environment is not the project's: a ${#System#…} reference resolves to nothing", async () => {
    const files = await workspaceSnapshot([probe('Home', `${server.url}/ok`, { 'X-Home': '${#System#HOME}' })]);
    const { run, results } = await runOnce(files);
    expect(run.status).toBe('errored');
    expect(results).toEqual([
      expect.objectContaining({
        outcome: 'errored',
        error: expect.objectContaining({ code: 'rest-unresolved-properties' }) as unknown,
      }),
    ]);
    expect(server.seen).toEqual([]);
  });

  it('a failing assertion fails the run, and the stored exchange never shows the secret', async () => {
    const { run, results } = await runOnce(await workspaceSnapshot([probe('Fail', `${server.url}/fail`)]));
    expect(run.status).toBe('failed');
    expect(results).toEqual([expect.objectContaining({ outcome: 'failed', status: 500 })]);
    expect(JSON.stringify(results)).toContain('exchange');
    const stored = await c.h.db.query(
      'select r.summary, s.result from schedule_runs r join schedule_results s on s.run_id = r.id',
    );
    expect(JSON.stringify(stored.rows)).not.toContain(API_KEY);
  });

  it('a failing run moves the alert state and queues its alert in the same commit', async () => {
    const alerts = {
      targets: sealAlertTargets(testSettings(), [{ kind: 'webhook', url: 'https://hooks.example.test/in' }]),
      muteAfter: 3,
    };
    const { run } = await runOnce(await workspaceSnapshot([probe('Fail', `${server.url}/fail`)]), { alerts });
    const schedule = await repo.runWithSchedule(c.h.tdb, run.id);
    expect(schedule!.schedule).toMatchObject({ alertState: 'failing', failureStreak: 1 });
    const queued = await c.h.db.query<{ kind: string; payload: { run: { id: string }; failures: { path: string }[] } }>(
      'select kind, payload from schedule_alert_outbox where run_id = $1',
      [run.id],
    );
    expect(queued.rows).toEqual([
      {
        kind: 'failure',
        payload: expect.objectContaining({
          run: expect.objectContaining({ id: run.id, status: 'failed' }) as unknown,
          failures: [expect.objectContaining({ path: expect.stringContaining('Fail') as unknown })],
        }) as unknown,
      },
    ]);
    expect(JSON.stringify(queued.rows)).not.toContain(API_KEY);
  });

  it('an unreachable host errors the run', async () => {
    const { run } = await runOnce(await workspaceSnapshot([probe('Gone', 'http://127.0.0.1:1/gone')]));
    expect(run).toMatchObject({ status: 'errored', reason: null });
    expect(run.summary).toMatchObject({ errored: 1 });
  });

  it('a target the workspace no longer has errors the run with target-missing', async () => {
    const files = await workspaceSnapshot([probe('Ok', `${server.url}/ok`)]);
    for (const target of [{ project: 'Orders' }, { environment: 'staging' }, { select: ['Api/Nope'] }]) {
      const { run } = await runOnce(files, { target });
      expect(run).toMatchObject({ status: 'errored', reason: 'target-missing', summary: null });
    }
    expect(server.seen).toEqual([]);
  });

  it('a project is found by its id as well as its slug', async () => {
    const files = await workspaceSnapshot([probe('Ok', `${server.url}/ok`)]);
    expect((await runOnce(files, { target: { project: 'project-billing' } })).run.status).toBe('passed');
  });

  it('a workspace with nothing pushed errors the run with workspace-empty', async () => {
    const { run } = await runOnce(null);
    expect(run).toMatchObject({ status: 'errored', reason: 'workspace-empty', commit: null });
  });

  it('a protected environment is refused unless the schedule allows it', async () => {
    const files = await workspaceSnapshot([probe('Ok', `${server.url}/ok`)], { protectedProd: true });
    expect((await runOnce(files)).run).toMatchObject({ status: 'errored', reason: 'environment-protected' });
    expect(server.seen).toEqual([]);
    expect((await runOnce(files, { options: { allowProtected: true } })).run.status).toBe('passed');
  });

  it('a snapshot over the cap errors the run with snapshot-too-large', async () => {
    const files = await workspaceSnapshot([probe('Ok', `${server.url}/ok`)]);
    const { run } = await runOnce(files, {}, { settings: testSettings({ maxSnapshotBytes: 10 }) });
    expect(run).toMatchObject({ status: 'errored', reason: 'snapshot-too-large' });
  });

  it('secrets without the schedules key error the run with secret-key-missing', async () => {
    const files = await workspaceSnapshot([probe('Ok', `${server.url}/ok`)]);
    const { secretKey, ...withoutKey } = testSettings();
    expect(secretKey).toBeDefined();
    const { run } = await runOnce(files, {}, { settings: withoutKey });
    expect(run).toMatchObject({ status: 'errored', reason: 'secret-key-missing' });
  });

  it('the deadline aborts a hanging run, which errors with timeout', async () => {
    const files = await workspaceSnapshot([probe('Hang', `${server.url}/hang`)]);
    const { runId } = await seedRun(c, { options: { timeoutMinutes: 2 } });
    const running = executeRun(executorEnv(c, files, tmpRoot), c.h.tdb.scope, runId, never);
    await server.hanging;
    expect(c.timers.fire(2 * 60_000)).toBe(1);
    await running;
    expect((await repo.runWithSchedule(c.h.tdb, runId))!.run).toMatchObject({ status: 'errored', reason: 'timeout' });
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('a shutdown cancels a running run with reason shutdown, and the deadline is disarmed', async () => {
    const files = await workspaceSnapshot([probe('Hang', `${server.url}/hang`)]);
    const { runId } = await seedRun(c);
    const stop = new AbortController();
    const running = executeRun(executorEnv(c, files, tmpRoot), c.h.tdb.scope, runId, stop.signal);
    await server.hanging;
    stop.abort('shutdown');
    await running;
    expect((await repo.runWithSchedule(c.h.tdb, runId))!.run).toMatchObject({
      status: 'cancelled',
      reason: 'shutdown',
    });
    expect(c.timers.pending(15 * 60_000)).toBe(0);
  });

  it('a run cancelled while it ran keeps that outcome, and stores no results', async () => {
    const files = await workspaceSnapshot([probe('Hang', `${server.url}/hang`)]);
    const { runId } = await seedRun(c);
    const stop = new AbortController();
    const running = executeRun(executorEnv(c, files, tmpRoot), c.h.tdb.scope, runId, stop.signal);
    await server.hanging;
    await c.h.db.query("update schedule_runs set status = 'cancelled', reason = 'cancelled' where id = $1", [runId]);
    stop.abort('cancelled');
    await running;
    expect((await repo.runWithSchedule(c.h.tdb, runId))!.run).toMatchObject({
      status: 'cancelled',
      reason: 'cancelled',
    });
    expect(await repo.resultsOf(c.h.tdb, runId)).toEqual([]);
  });

  it('an unexpected failure errors the run with run-failed and logs a masked message', async () => {
    const errors: unknown[] = [];
    const { run } = await runOnce(
      null,
      {},
      { log: quietLog(errors), snapshot: () => Promise.reject(new Error(`git broke near ${API_KEY}`)) },
    );
    expect(run).toMatchObject({ status: 'errored', reason: 'run-failed' });
    expect(JSON.stringify(errors)).toContain('git broke');
    expect(JSON.stringify(errors)).not.toContain(API_KEY);
  });

  it('announces the outcome after the commit, and not for a run a cancel already ended', async () => {
    const heard: unknown[] = [];
    c.h.hooks.scheduleRunFinished.push((event) => heard.push(event));
    const files = await workspaceSnapshot([probe('Ok', `${server.url}/ok`)]);
    const { scheduleId, runId } = await seedRun(c);
    await executeRun(executorEnv(c, files, tmpRoot), c.h.tdb.scope, runId, never);
    expect(heard).toEqual([
      { tenantId: c.h.tdb.scope.tenantId, workspaceId: c.workspaceId, scheduleId, runId, status: 'passed' },
    ]);

    const cancelled = await seedRun(c);
    await c.h.db.query("update schedule_runs set status = 'cancelled' where id = $1", [cancelled.runId]);
    await executeRun(executorEnv(c, files, tmpRoot), c.h.tdb.scope, cancelled.runId, never);
    expect(heard).toHaveLength(1);
  });
});
