import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { executeRun } from '../../../src/schedules/executor.js';
import * as repo from '../../../src/schedules/repo.js';
import type { AlertTestResponse, Schedule } from '@wirebench/engine';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { schedulesModule } from '../../../src/schedules/module.js';
import type { Scheduler } from '../../../src/schedules/scheduler.js';
import { call } from '../../helpers/teams.js';
import { postAlert } from '../../../src/schedules/alerts/https.js';
import { describeDb } from '../../helpers/database.js';
import {
  executorEnv,
  fixtureServer,
  probe,
  seedRun,
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
  tmpRoot = await mkdtemp(join(tmpdir(), 'wb-schedule-egress-'));
});
afterEach(async () => {
  await server.close();
  await c.close();
  await rm(tmpRoot, { recursive: true, force: true });
});

const never = new AbortController().signal;

async function runTo(url: string, egress: { denyPrivate: boolean }) {
  const { runId } = await seedRun(c);
  const files = await workspaceSnapshot([probe('Out', url)]);
  await executeRun(executorEnv(c, files, tmpRoot, { egress }), runId, never);
  const found = await repo.runWithSchedule(c.h.db, runId);
  return { run: found!.run, results: await repo.resultsOf(c.h.db, runId) };
}

describeDb('the egress rule on scheduled runs and alerts (hosted edition spec §17.5)', () => {
  it('records a failed run, sending nothing, when the request targets a loopback address', async () => {
    const { run, results } = await runTo(`${server.url}/ok`, { denyPrivate: false });
    expect(run.status).toBe('errored');
    expect(results).toEqual([
      expect.objectContaining({
        outcome: 'errored',
        error: expect.objectContaining({ code: 'egress-refused' }) as unknown,
      }),
    ]);
    expect(server.seen).toEqual([]);
  });

  it('refuses a private address with denyPrivate on, as a private network address', async () => {
    const { results } = await runTo('http://10.0.0.1:9/ok', { denyPrivate: true });
    expect(results).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: 'egress-refused' }) as unknown }),
    ]);
    expect(results).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          details: expect.objectContaining({ addressClass: 'private' }) as unknown,
        }) as unknown,
      }),
    ]);
  });

  it('refuses a cloud metadata address whatever the policy', async () => {
    const { results } = await runTo('http://169.254.169.254/latest', { denyPrivate: false });
    expect(results).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: 'egress-refused' }) as unknown }),
    ]);
  });

  it('refuses an alert to a loopback host without connecting', async () => {
    const error = await postAlert(
      { url: 'https://127.0.0.1:9/hook', body: {} },
      { egress: { denyPrivate: false } },
    ).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain('refused');
    expect(error?.message).not.toContain('127.0.0.1:9');
  });

  it('refuses an alert whose name resolves to a loopback address', async () => {
    const error = await postAlert(
      { url: 'https://localhost:9/hook', body: {} },
      { egress: { denyPrivate: false } },
    ).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain('refused');
  });
});

describeDb('the schedules module hands the server context egress rule on (production wiring)', () => {
  it('gives the scheduler and the alert delivery ctx.egress', async () => {
    let made: Scheduler | undefined;
    const wired = await schedulesHarness({
      env: { WIREBENCH_SERVER_EGRESS_DENY_PRIVATE: 'true' },
      // No `deliver` and no `execute`: the module builds its own, as in production.
      modules: (clock, timers) => [
        schedulesModule({
          now: () => clock.now,
          setTimer: timers.setTimer,
          startScheduler: false,
          onScheduler: (scheduler) => {
            made = scheduler;
          },
        }),
        auditLogModule({ now: () => clock.now, setTimer: timers.setTimer }),
      ],
    });
    try {
      // The executor's env is the scheduler's.
      expect((made as unknown as { env: { egress: unknown } }).env.egress).toEqual({ denyPrivate: true });
      // A private literal is reachable with the switch off, so only the wired policy refuses it here.
      const url = `/workspaces/${wired.workspaceId}/schedules`;
      const created = await call<Schedule>(wired.h, wired.admin, 'POST', url, {
        name: 'Smoke',
        schedule: 'every 5m',
        timeZone: 'UTC',
        target: { project: 'billing' },
        alerts: { targets: [{ kind: 'slack', url: 'https://10.0.0.1/hook' }] },
      });
      expect(created.status).toBe(201);
      const sent = await call<AlertTestResponse>(
        wired.h,
        wired.admin,
        'POST',
        `${url}/${created.body.id}/alerts/test`,
        {},
      );
      expect(sent.body.results).toEqual([
        { index: 0, kind: 'slack', ok: false, error: expect.stringContaining('refused') as unknown },
      ]);
    } finally {
      await wired.close();
    }
  });
});
