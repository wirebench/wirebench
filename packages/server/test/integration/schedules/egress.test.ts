import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { executeRun } from '../../../src/schedules/executor.js';
import * as repo from '../../../src/schedules/repo.js';
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
