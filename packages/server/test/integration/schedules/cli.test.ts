import type { ScheduleRun } from '@wirebench/engine';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runAdmin } from '../../../src/identity/cli.js';
import { newId } from '../../../src/identity/tokens.js';
import { main } from '../../../src/main.js';
import { runSchedulesCommand } from '../../../src/schedules/cli.js';
import * as repo from '../../../src/schedules/repo.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { schedulesHarness, type SchedulesCast } from '../../helpers/schedules.js';

function capture(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: { write: (t: string) => out.push(t) }, stderr: { write: (t: string) => err.push(t) }, env },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

describeDb('wirebench-server admin schedules (scheduled-runs spec §3.8)', () => {
  let c: SchedulesCast;
  let scheduleId: string;
  beforeEach(async () => {
    // No license: the commands need none.
    c = await schedulesHarness({ enterprise: false });
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
      nextRunAt: new Date('2026-09-25T03:00:00Z'),
      createdBy: null,
      at: c.h.clock.now,
    });
  });
  afterEach(async () => {
    await c.close();
  });
  const env = () => ({ db: c.h.db, hooks: c.h.hooks, now: () => c.h.clock.now });

  it('list shows every schedule with its state, next run and last outcome; --workspace narrows it', async () => {
    await repo.insertRun(c.h.db, {
      id: newId(),
      scheduleId,
      trigger: 'schedule',
      status: 'skipped',
      at: c.h.clock.now,
    });
    const all = capture();
    expect(await runSchedulesCommand({ command: 'admin-schedules-list' }, env(), all.io)).toBe(0);
    const [header, row, ...rest] = all.stdout().trimEnd().split('\n');
    expect(header).toMatch(/^id\s+workspace\s+enabled\s+next run\s+last\s+name$/);
    expect(row).toMatch(
      new RegExp(`^${scheduleId}  ${c.workspaceId}  yes\\s+2026-09-25T03:00:00.000Z\\s+skipped\\s+Nightly$`),
    );
    expect(rest).toEqual([]);
    const none = capture();
    await runSchedulesCommand({ command: 'admin-schedules-list', workspace: newId() }, env(), none.io);
    expect(none.stdout().trimEnd().split('\n')).toHaveLength(1);
  });

  it('disable and enable switch a schedule, recorded with the system actor; a second time changes nothing', async () => {
    const events = recordingAudit(c.h.hooks);
    const off = capture();
    expect(await runSchedulesCommand({ command: 'admin-schedules-disable', id: scheduleId }, env(), off.io)).toBe(0);
    expect(off.stdout()).toBe(`Schedule ${scheduleId} disabled\n`);
    expect(await repo.scheduleById(c.h.db, c.workspaceId, scheduleId)).toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
    const again = capture();
    await runSchedulesCommand({ command: 'admin-schedules-disable', id: scheduleId }, env(), again.io);
    expect(again.stdout()).toBe(`Schedule ${scheduleId} was already disabled\n`);
    await runSchedulesCommand({ command: 'admin-schedules-enable', id: scheduleId }, env(), capture().io);
    // The harness clock is 2026-09-24T12:00Z: the next 03:00 is tomorrow's.
    expect(await repo.scheduleById(c.h.db, c.workspaceId, scheduleId)).toMatchObject({
      enabled: true,
      nextRunAt: '2026-09-25T03:00:00.000Z',
    });
    expect(events.map((event) => [event.action, event.actor, event.details])).toEqual([
      ['schedule.updated', { kind: 'system' }, { name: 'Nightly', fields: ['enabled'], enabled: false }],
      ['schedule.updated', { kind: 'system' }, { name: 'Nightly', fields: ['enabled'], enabled: true }],
    ]);
  });

  it('runs writes the newest runs as NDJSON, up to --limit', async () => {
    const at = (minutes: number): Date => new Date(c.h.clock.now.getTime() - minutes * 60_000);
    for (const minutes of [30, 20, 10]) {
      await repo.insertRun(c.h.db, {
        id: newId(),
        scheduleId,
        trigger: 'schedule',
        status: 'skipped',
        at: at(minutes),
      });
    }
    const out = capture();
    expect(
      await runSchedulesCommand({ command: 'admin-schedules-runs', id: scheduleId, limit: 2 }, env(), out.io),
    ).toBe(0);
    const runs = out
      .stdout()
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as ScheduleRun);
    expect(runs.map((run) => run.queuedAt)).toEqual([at(10).toISOString(), at(20).toISOString()]);
  });

  it('an unknown schedule is named on stderr with exit 1', async () => {
    for (const command of [
      { command: 'admin-schedules-enable', id: 'missing' },
      { command: 'admin-schedules-runs', id: 'missing', limit: 50 },
    ] as const) {
      const out = capture();
      expect(await runSchedulesCommand(command, env(), out.io)).toBe(1);
      expect(out.stderr()).toBe('schedules-not-found: no schedule with id missing\n');
    }
  });
});

describeDb('admin schedules through the binary (scheduled-runs spec §3.8)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  beforeEach(async () => {
    db = await testDatabase();
  });
  afterEach(async () => {
    await db.close();
  });

  it('runs against a migrated database with no license and no schedules', async () => {
    const env = {
      WIREBENCH_SERVER_DATABASE_URL: db.url,
      WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
      WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
    };
    expect(await main(['migrate'], capture(env).io)).toBe(0);
    const list = capture(env);
    expect(await runAdmin({ command: 'admin-schedules-list' }, list.io)).toBe(0);
    expect(list.stdout().trimEnd().split('\n')).toHaveLength(1);
    const missing = capture(env);
    expect(await runAdmin({ command: 'admin-schedules-disable', id: 'missing' }, missing.io)).toBe(1);
  });
});
