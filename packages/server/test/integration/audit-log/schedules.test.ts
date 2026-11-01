import type { Schedule } from '@wirebench/engine';
import { afterEach, expect, it } from 'vitest';
import type { AuditInput } from '../../../src/context.js';
import { expectNoSecretsInAudit, recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { schedulesHarness, type SchedulesCast } from '../../helpers/schedules.js';
import { call } from '../../helpers/teams.js';

let c: SchedulesCast | undefined;
afterEach(async () => {
  await c?.close();
  c = undefined;
});

const last = (events: AuditInput[], action: AuditInput['action']) => events.filter((e) => e.action === action).at(-1);
const body = { name: 'Smoke', schedule: 'every 5m', target: { project: 'billing', environment: 'prod' } };

describeDb('scheduled-runs fire sites (scheduled-runs spec §3.9)', () => {
  it('a schedule created, changed, given secrets and deleted, each with what it was', async () => {
    c = await schedulesHarness();
    const events = recordingAudit(c.h.hooks);
    const base = `/workspaces/${c.workspaceId}/schedules`;
    const created = (await call<Schedule>(c.h, c.admin, 'POST', base, body)).body;
    expect(last(events, 'schedule.created')).toMatchObject({
      actor: { kind: 'user', userId: c.admin.user.id },
      target: { kind: 'schedule', id: created.id },
      workspaceId: c.workspaceId,
      details: {
        name: 'Smoke',
        cron: '*/5 * * * *',
        timeZone: 'UTC',
        project: 'billing',
        environment: 'prod',
        enabled: true,
        allowProtected: false,
        insecureTls: false,
      },
    });

    await call(c.h, c.admin, 'PATCH', `${base}/${created.id}`, {
      name: 'Prod smoke',
      options: { allowProtected: true },
      enabled: false,
    });
    expect(last(events, 'schedule.updated')).toMatchObject({
      target: { kind: 'schedule', id: created.id },
      details: { name: 'Prod smoke', fields: ['enabled', 'name', 'options'], enabled: false, allowProtected: true },
    });
    expect(last(events, 'schedule.updated')?.details).not.toHaveProperty('insecureTls');

    await call(c.h, c.admin, 'PUT', `${base}/${created.id}/secrets`, { API_KEY: 'a-long-api-key-value', OLD: null });
    expect(last(events, 'schedule.secrets_set')?.details).toEqual({
      name: 'Prod smoke',
      added: ['API_KEY'],
      changed: [],
      removed: [],
    });
    await call(c.h, c.admin, 'PUT', `${base}/${created.id}/secrets`, { API_KEY: 'another-api-key-value' });
    expect(last(events, 'schedule.secrets_set')?.details).toMatchObject({ changed: ['API_KEY'] });

    await call(c.h, c.admin, 'DELETE', `${base}/${created.id}`);
    expect(last(events, 'schedule.deleted')).toMatchObject({
      target: { kind: 'schedule', id: created.id },
      details: { name: 'Prod smoke' },
    });
    await expectNoSecretsInAudit(c.h.tdb);
    const rows = await c.h.tdb.query<{ details: unknown }>(
      "select details from audit_events where action like 'schedule.%'",
    );
    expect(JSON.stringify(rows.rows)).not.toContain('api-key-value');
  });

  it('a refused write records nothing, and an audit failure undoes the write', async () => {
    c = await schedulesHarness();
    const events = recordingAudit(c.h.hooks);
    const base = `/workspaces/${c.workspaceId}/schedules`;
    expect((await call(c.h, c.admin, 'POST', base, { ...body, schedule: 'every 7m' })).status).toBe(400);
    expect(events.filter((e) => e.action.startsWith('schedule.'))).toEqual([]);

    c.h.hooks.audit.push(() => Promise.reject(new Error('audit store unavailable')));
    expect((await call(c.h, c.admin, 'POST', base, body)).status).toBe(500);
    expect((await c.h.tdb.query('select 1 from schedules')).rowCount).toBe(0);
  });

  it('run now and a cancel are recorded with the run they name', async () => {
    c = await schedulesHarness();
    const events = recordingAudit(c.h.hooks);
    const base = `/workspaces/${c.workspaceId}/schedules`;
    const created = (await call<Schedule>(c.h, c.admin, 'POST', base, body)).body;
    const run = (await call<{ id: string }>(c.h, c.admin, 'POST', `${base}/${created.id}/runs`)).body;
    expect(last(events, 'schedule.run_requested')).toMatchObject({
      actor: { kind: 'user', userId: c.admin.user.id },
      target: { kind: 'schedule', id: created.id },
      workspaceId: c.workspaceId,
      details: { name: 'Smoke', runId: run.id },
    });
    // Run now starts the run at once, so the cancel finds it running.
    await c.scheduler().runOnce();
    await call(c.h, c.admin, 'DELETE', `${base}/${created.id}/runs/${run.id}`);
    expect(last(events, 'schedule.run_cancelled')).toMatchObject({
      target: { kind: 'schedule', id: created.id },
      details: { name: 'Smoke', runId: run.id, was: 'running' },
    });
  });
});
