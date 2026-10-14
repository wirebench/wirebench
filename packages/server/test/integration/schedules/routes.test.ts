import type { AlertTestResponse, Schedule } from '@wirebench/engine';
import { afterEach, expect, it } from 'vitest';
import { describeDb } from '../../helpers/database.js';
import { schedulesHarness, type SchedulesCast } from '../../helpers/schedules.js';
import { call } from '../../helpers/teams.js';
import type { SignedInUser } from '../../helpers/identity.js';

let c: SchedulesCast | undefined;
afterEach(async () => {
  await c?.close();
  c = undefined;
});

const SLACK = 'https://hooks.slack.example/services/T000/B000/abcdWXYZ';
const body = { name: 'Smoke', schedule: 'every 5m', timeZone: 'Europe/Vienna', target: { project: 'billing' } };

const base = (cast: SchedulesCast): string => `/workspaces/${cast.workspaceId}/schedules`;
const create = (cast: SchedulesCast, payload: object = body, user: SignedInUser = cast.admin) =>
  call<Schedule & { code?: string }>(cast.h, user, 'POST', base(cast), payload);

describeDb('the schedules API (scheduled-runs §3.7)', () => {
  it('a workspace admin creates a schedule; it comes back with defaults, the canonical cron and its next run', async () => {
    c = await schedulesHarness();
    const created = await create(c);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      workspaceId: c.workspaceId,
      name: 'Smoke',
      cron: '*/5 * * * *',
      timeZone: 'Europe/Vienna',
      target: { project: 'billing' },
      options: { timeoutMinutes: 15, allowProtected: false, insecureTls: false, bail: false },
      alerts: { targets: [], muteAfter: 3 },
      secrets: [],
      enabled: true,
      // The harness clock is 2026-09-24T12:00Z.
      nextRunAt: '2026-09-24T12:05:00.000Z',
      alertState: 'ok',
      failureStreak: 0,
      createdBy: 'admin',
      lastRun: null,
    });
  });

  it('every role reads; only an admin writes; someone without a role learns nothing', async () => {
    c = await schedulesHarness();
    const id = (await create(c)).body.id;
    for (const user of [c.viewer, c.editor, c.admin]) {
      expect((await call(c.h, user, 'GET', base(c))).status).toBe(200);
      expect((await call(c.h, user, 'GET', `${base(c)}/${id}`)).status).toBe(200);
    }
    for (const user of [c.viewer, c.editor]) {
      expect((await create(c, { ...body, name: 'Other' }, user)).status).toBe(403);
      expect((await call(c.h, user, 'PATCH', `${base(c)}/${id}`, { enabled: false })).status).toBe(403);
      expect((await call(c.h, user, 'DELETE', `${base(c)}/${id}`)).status).toBe(403);
      expect((await call(c.h, user, 'PUT', `${base(c)}/${id}/secrets`, { A: 'value' })).status).toBe(403);
    }
    expect((await call(c.h, c.stranger, 'GET', base(c))).status).toBe(404);
    expect((await call(c.h, c.root, 'GET', base(c))).status).toBe(200);
  });

  it('needs the scheduled-runs feature: a Team license answers 403 to everyone', async () => {
    c = await schedulesHarness({ enterprise: false });
    const res = await call<{ code: string }>(c.h, c.admin, 'GET', base(c));
    expect(res).toMatchObject({ status: 403, body: { code: 'licensing-feature-required' } });
    await c.install('team');
    expect((await create(c)).status).toBe(403);
    // The role is checked first: a stranger still learns nothing.
    expect((await call(c.h, c.stranger, 'GET', base(c))).status).toBe(404);
    await c.install('team', ['scheduled-runs']);
    expect((await create(c)).status).toBe(201);
  });

  it('refuses a schedule, zone, target or alert target it cannot keep', async () => {
    c = await schedulesHarness();
    const code = async (payload: object) => (await create(c!, payload)).body.code;
    expect(await code({ ...body, schedule: 'every 7m' })).toBe('schedules-cron-invalid');
    expect(await code({ ...body, timeZone: 'Mars/Olympus' })).toBe('schedules-zone-invalid');
    expect((await create(c, { ...body, target: { project: '' } })).status).toBe(400);
    expect((await create(c, { ...body, alerts: { targets: [{ kind: 'slack', url: 'http://x.test' }] } })).status).toBe(
      400,
    );
    expect(await code({ ...body, alerts: { targets: [{ kind: 'email', to: ['ops@example.test'] }] } })).toBe(
      'schedules-smtp-missing',
    );
  });

  it('refuses an alert host off the allow-list, and email once mail is set up is fine', async () => {
    c = await schedulesHarness({
      env: {
        WIREBENCH_SERVER_SCHEDULES_ALERT_HOSTS: '*.slack.com',
        WIREBENCH_SERVER_SMTP_URL: 'smtp://mail.example.test:587',
        WIREBENCH_SERVER_SMTP_FROM: 'wirebench@example.test',
      },
    });
    const off = await create(c, { ...body, alerts: { targets: [{ kind: 'slack', url: SLACK }] } });
    expect(off.body.code).toBe('schedules-alert-host-refused');
    const ok = await create(c, {
      ...body,
      alerts: {
        targets: [
          { kind: 'email', to: ['ops@example.test'] },
          { kind: 'slack', url: 'https://hooks.slack.com/x/abcd' },
        ],
      },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.alerts.targets).toEqual([
      { kind: 'email', to: ['ops@example.test'] },
      { kind: 'slack', host: 'hooks.slack.com', hint: 'abcd' },
    ]);
  });

  it('test alerts go to every target now, each with its own outcome; admins only', async () => {
    c = await schedulesHarness({
      env: { WIREBENCH_SERVER_SMTP_URL: 'smtp://mail.example.test:587', WIREBENCH_SERVER_SMTP_FROM: 'wb@example.test' },
    });
    const created = await create(c, {
      ...body,
      target: { project: 'billing', environment: 'prod' },
      alerts: {
        targets: [
          { kind: 'email', to: ['ops@example.test'] },
          { kind: 'slack', url: SLACK },
        ],
      },
    });
    const url = `${base(c)}/${created.body.id}/alerts/test`;
    expect((await call(c.h, c.editor, 'POST', url, {})).status).toBe(403);
    const sent = await call<AlertTestResponse>(c.h, c.admin, 'POST', url, {});
    expect(sent.status).toBe(200);
    expect(sent.body.results).toEqual([
      { index: 0, kind: 'email', ok: true },
      { index: 1, kind: 'slack', ok: true },
    ]);
    expect(c.deliveries.map((d) => d.payload)).toEqual([
      expect.objectContaining({
        kind: 'test',
        schedule: { id: created.body.id, name: 'Smoke' },
        workspace: { id: c.workspaceId, name: 'Smoke' },
        project: 'billing',
        environment: 'prod',
        failures: [],
      }) as unknown,
      expect.anything(),
    ]);
    expect(c.deliveries[0]!.payload.run).toBeUndefined();
    c.failDeliveries('the alert to hooks.slack.example was answered 404');
    const failed = await call<AlertTestResponse>(c.h, c.admin, 'POST', url, {});
    expect(failed.body.results[1]).toEqual({
      index: 1,
      kind: 'slack',
      ok: false,
      error: 'the alert to hooks.slack.example was answered 404',
    });
    // A test touches neither the alert state nor the outbox.
    expect((await c.h.db.query('select 1 from schedule_alert_outbox')).rows).toEqual([]);
  });

  it('never hands back an alert URL or a secret value', async () => {
    c = await schedulesHarness();
    const created = await create(c, { ...body, alerts: { targets: [{ kind: 'slack', url: SLACK }] } });
    const id = created.body.id;
    const secrets = await call<Schedule>(c.h, c.admin, 'PUT', `${base(c)}/${id}/secrets`, {
      API_KEY: 'the-api-key-value',
      SHORT: 'abc',
    });
    expect(secrets.status).toBe(200);
    expect(secrets.body.secrets).toEqual([
      { name: 'API_KEY', hint: 'alue' },
      { name: 'SHORT', hint: null },
    ]);
    const read = await c.h.app.inject({ method: 'GET', url: `/api/v1${base(c)}/${id}`, headers: c.viewer.headers });
    const list = await c.h.app.inject({ method: 'GET', url: `/api/v1${base(c)}`, headers: c.viewer.headers });
    for (const text of [created.body, secrets.body].map((b) => JSON.stringify(b)).concat([read.body, list.body])) {
      expect(text).not.toContain('services/T000');
      expect(text).not.toContain('the-api-key-value');
    }
    const removed = await call<Schedule>(c.h, c.admin, 'PUT', `${base(c)}/${id}/secrets`, { SHORT: null });
    expect(removed.body.secrets.map((s) => s.name)).toEqual(['API_KEY']);
  });

  it('refuses secrets without the schedules key', async () => {
    c = await schedulesHarness({ env: { WIREBENCH_SERVER_SCHEDULES_SECRET_KEY: '' } });
    const id = (await create(c)).body.id;
    const res = await call<{ code: string }>(c.h, c.admin, 'PUT', `${base(c)}/${id}/secrets`, { A: 'value' });
    expect(res).toMatchObject({ status: 409, body: { code: 'schedules-secret-key-missing' } });
  });

  it('updates: a pause clears the next run, a resume or a new time starts from now', async () => {
    c = await schedulesHarness();
    const id = (await create(c)).body.id;
    const patch = (payload: object) =>
      call<Schedule & { code?: string }>(c!.h, c!.admin, 'PATCH', `${base(c!)}/${id}`, payload);
    expect((await patch({ enabled: false })).body).toMatchObject({ enabled: false, nextRunAt: null });
    c.h.clock.advance(60 * 60 * 1000);
    expect((await patch({ enabled: true })).body).toMatchObject({
      enabled: true,
      nextRunAt: '2026-09-24T13:05:00.000Z',
    });
    expect((await patch({ schedule: '@daily', timeZone: 'UTC' })).body).toMatchObject({
      cron: '0 0 * * *',
      nextRunAt: '2026-09-25T00:00:00.000Z',
    });
    expect((await patch({ name: 'Renamed', options: { timeoutMinutes: 5 } })).body).toMatchObject({
      name: 'Renamed',
      options: { timeoutMinutes: 5, allowProtected: false, insecureTls: false, bail: false },
      nextRunAt: '2026-09-25T00:00:00.000Z',
    });
    expect((await patch({})).status).toBe(400);
    expect((await patch({ timeZone: 'Mars/Olympus' })).body.code).toBe('schedules-zone-invalid');
  });

  it('a name is unique in the workspace, in any case', async () => {
    c = await schedulesHarness();
    expect((await create(c)).status).toBe(201);
    const again = await create(c, { ...body, name: 'SMOKE' });
    expect(again).toMatchObject({ status: 409, body: { code: 'schedules-name-taken' } });
    const other = (await create(c, { ...body, name: 'Other' })).body.id;
    const renamed = await call<{ code: string }>(c.h, c.admin, 'PATCH', `${base(c)}/${other}`, { name: 'smoke' });
    expect(renamed).toMatchObject({ status: 409, body: { code: 'schedules-name-taken' } });
  });

  it('deletes, and an unknown id is 404 everywhere', async () => {
    c = await schedulesHarness();
    const id = (await create(c)).body.id;
    expect((await call(c.h, c.admin, 'DELETE', `${base(c)}/${id}`)).status).toBe(204);
    for (const [method, path, payload] of [
      ['GET', `${base(c)}/${id}`, undefined],
      ['PATCH', `${base(c)}/${id}`, { enabled: true }],
      ['DELETE', `${base(c)}/${id}`, undefined],
      ['PUT', `${base(c)}/${id}/secrets`, { A: null }],
    ] as const) {
      const res = await call<{ code: string }>(c.h, c.admin, method, path, payload);
      expect(res).toMatchObject({ status: 404, body: { code: 'schedules-not-found' } });
    }
  });

  it('holds at most a hundred schedules a workspace', async () => {
    c = await schedulesHarness();
    for (let i = 0; i < 100; i += 1) {
      await c.h.db.query(
        `insert into schedules (id, workspace_id, name, cron, time_zone, target, options, alerts)
         values ($1, $2, $3, '* * * * *', 'UTC', '{}', '{}', '{}')`,
        [`01K00000000000000000000${String(i).padStart(3, '0')}`, c.workspaceId, `s${i}`],
      );
    }
    expect(await create(c)).toMatchObject({ status: 409, body: { code: 'schedules-limit' } });
  });
});
