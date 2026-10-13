import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { executeRun } from '../../../src/schedules/executor.js';
import { expectNoSecretsInAudit, recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import {
  API_KEY,
  HEAD,
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
  tmpRoot = await mkdtemp(join(tmpdir(), 'wb-schedule-audit-'));
});
afterEach(async () => {
  await server.close();
  await c.close();
  await rm(tmpRoot, { recursive: true, force: true });
});

describeDb('scheduled-run fire sites (scheduled-runs spec §3.9)', () => {
  it('a finished run is recorded by the server, with its outcome, counts and commit, never a value', async () => {
    const events = recordingAudit(c.h.hooks);
    const files = await workspaceSnapshot([probe('Fail', `${server.url}/fail`)]);
    const { scheduleId, runId } = await seedRun(c);
    await executeRun(executorEnv(c, files, tmpRoot), runId, new AbortController().signal);
    expect(events.filter((event) => event.action === 'schedule.run_finished')).toEqual([
      expect.objectContaining({
        actor: { kind: 'system' },
        target: { kind: 'schedule', id: scheduleId },
        workspaceId: c.workspaceId,
        details: {
          name: expect.stringMatching(/^Nightly /) as string,
          runId,
          trigger: 'manual',
          status: 'failed',
          reason: null,
          commit: HEAD,
          total: 1,
          passed: 0,
          failed: 1,
          errored: 0,
        },
      }),
    ]);
    await expectNoSecretsInAudit(c.h.db);
    const rows = await c.h.db.query('select details from audit_events');
    expect(JSON.stringify(rows.rows)).not.toContain(API_KEY);
  });

  it('a run that a cancel already ended records nothing more', async () => {
    const events = recordingAudit(c.h.hooks);
    const files = await workspaceSnapshot([probe('Ok', `${server.url}/ok`)]);
    const { runId } = await seedRun(c);
    await c.h.db.query("update schedule_runs set status = 'cancelled' where id = $1", [runId]);
    await executeRun(executorEnv(c, files, tmpRoot), runId, new AbortController().signal);
    expect(events.filter((event) => event.action === 'schedule.run_finished')).toEqual([]);
  });
});
