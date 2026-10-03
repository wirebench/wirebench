import { afterAll, beforeAll, expect, it } from 'vitest';
import { DESKTOP_EVENTS_RATE } from '../../../src/audit-log/desktop-routes.js';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { describeDb } from '../../helpers/database.js';
import { seedCiToken } from '../../helpers/hooks.js';
import { signedInUser } from '../../helpers/identity.js';
import { licensingHarness, testKeys } from '../../helpers/licensing.js';
import { call, seedTeam } from '../../helpers/teams.js';

const SENT = {
  action: 'desktop.request_sent',
  details: {
    protocol: 'rest',
    method: 'GET',
    url: 'https://api.example.com/orders',
    status: 200,
    outcome: 'ok',
    durationMs: 42,
    environment: 'staging',
    requestId: 'req-1',
    requestName: 'List orders',
    sentAt: '2026-09-24T11:59:00.000Z',
  },
} as const;
const RUN = {
  action: 'desktop.run_finished',
  details: {
    sequenceId: 'seq-1',
    name: 'Smoke',
    outcome: 'passed',
    passed: 3,
    failed: 0,
    errored: 0,
    skipped: 0,
    durationMs: 900,
    hosts: ['https://api.example.com'],
    environment: null,
    startedAt: '2026-09-24T11:58:00.000Z',
    sentAt: '2026-09-24T11:59:00.000Z',
  },
} as const;

describeDb('POST /workspaces/:id/audit/desktop-events (#211)', () => {
  let h: Awaited<ReturnType<typeof licensingHarness>>;
  let admin: Awaited<ReturnType<typeof signedInUser>>;
  let viewer: Awaited<ReturnType<typeof signedInUser>>;
  let stranger: Awaited<ReturnType<typeof signedInUser>>;
  let teamId: string;
  let workspaceId: string;
  let url: string;

  beforeAll(async () => {
    h = await licensingHarness(testKeys(), { extra: (clock) => [auditLogModule({ now: () => clock.now })] });
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    viewer = await signedInUser(h, { email: 'v@example.com' });
    stranger = await signedInUser(h, { email: 'x@example.com' });
    const team = await seedTeam(h, { name: 'Ops', admins: [admin], members: [viewer] });
    teamId = team.id;
    workspaceId = (await call<{ id: string }>(h, admin, 'POST', `/teams/${teamId}/workspaces`, { name: 'Prod' })).body
      .id;
    url = `/workspaces/${workspaceId}/audit/desktop-events`;
  });
  afterAll(() => h.close());

  const rows = async (action?: string) =>
    (
      await h.db.query<{
        action: string;
        actor_kind: string;
        actor_user_id: string | null;
        at: Date;
        target_kind: string;
        target_id: string | null;
        workspace_id: string | null;
        team_id: string | null;
        details: Record<string, unknown>;
      }>(
        `select action, actor_kind, actor_user_id, at, target_kind, target_id, workspace_id, team_id, details
         from audit_events where action like 'desktop.%' and ($1::text is null or action = $1) order by id`,
        [action ?? null],
      )
    ).rows;
  const setRecording = (enabled: boolean) =>
    call(h, admin, 'PATCH', `/workspaces/${workspaceId}`, { recordDesktopActivity: enabled });

  it('answers 409 audit-desktop-recording-off and writes nothing while the workspace does not record', async () => {
    const res = await call<{ code: string }>(h, viewer, 'POST', url, { events: [SENT] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('audit-desktop-recording-off');
    expect(await rows()).toHaveLength(0);
  });

  it('a body that does not match, 101 events, or a dropped count over a million, is a 400 and writes nothing', async () => {
    await setRecording(true);
    for (const body of [
      {},
      { events: [] },
      { events: [{ action: 'desktop.request_sent', details: { url: 'x' } }] },
      { events: [{ action: 'auth.signed_in', details: {} }] },
      { events: [SENT], extra: true },
      { events: Array.from({ length: 101 }, () => SENT) },
      { events: [], dropped: 1_000_001 },
    ]) {
      expect((await call(h, viewer, 'POST', url, body)).status).toBe(400);
    }
    expect(await rows()).toHaveLength(0);
  });

  it('a viewer reports: 204, rows stamped with the caller and the server clock, details as sent', async () => {
    h.clock.set(new Date('2026-09-24T12:30:00.000Z'));
    const res = await call(h, viewer, 'POST', url, { events: [SENT, RUN] });
    expect(res.status).toBe(204);
    const sent = await rows('desktop.request_sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      actor_kind: 'user',
      actor_user_id: viewer.user.id,
      target_kind: 'workspace',
      target_id: workspaceId,
      workspace_id: workspaceId,
      team_id: teamId,
      details: SENT.details,
    });
    expect(sent[0]!.at.toISOString()).toBe('2026-09-24T12:30:00.000Z');
    expect((await rows('desktop.run_finished'))[0]!.details).toEqual(RUN.details);
  });

  it('dropped alone writes one desktop.events_dropped with the count; with events it adds one beside them', async () => {
    expect((await call(h, viewer, 'POST', url, { events: [], dropped: 7 })).status).toBe(204);
    const dropped = await rows('desktop.events_dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      actor_user_id: viewer.user.id,
      workspace_id: workspaceId,
      details: { count: 7 },
    });
    await call(h, viewer, 'POST', url, { events: [SENT], dropped: 2 });
    expect(await rows('desktop.events_dropped')).toHaveLength(2);
    expect(await rows('desktop.request_sent')).toHaveLength(2);
  });

  it('a caller with no role in the workspace gets 404; an anonymous one 401; a CI token 403', async () => {
    const before = (await rows()).length;
    expect((await call(h, stranger, 'POST', url, { events: [SENT] })).status).toBe(404);
    expect((await call(h, undefined, 'POST', url, { events: [SENT] })).status).toBe(401);
    const ci = await seedCiToken(h, workspaceId, 'gha');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${ci.token}` },
      payload: { events: [SENT] },
    });
    expect(res.statusCode).toBe(403);
    expect((await rows()).length).toBe(before);
  });

  it('past 120 batches at once a caller gets 429 with Retry-After; others are unaffected; a second later one more goes', async () => {
    await setRecording(true);
    h.clock.set(new Date('2026-09-24T13:00:00.000Z'));
    for (let i = 0; i < DESKTOP_EVENTS_RATE.capacity; i++) {
      expect((await call(h, admin, 'POST', url, { events: [], dropped: 1 })).status).toBe(204);
    }
    const before = (await rows()).length;
    const refused = await h.app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: admin.headers,
      payload: { events: [SENT] },
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.json<{ code: string }>().code).toBe('audit-desktop-rate-limited');
    expect(refused.headers['retry-after']).toBe('1');
    expect((await rows()).length).toBe(before);
    expect((await call(h, viewer, 'POST', url, { events: [SENT] })).status).toBe(204);
    h.clock.advance(1000);
    expect((await call(h, admin, 'POST', url, { events: [SENT] })).status).toBe(204);
    expect((await call(h, admin, 'POST', url, { events: [SENT] })).status).toBe(429);
  });
});
