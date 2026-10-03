import { afterAll, beforeAll, expect, it } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser } from '../../helpers/identity.js';
import { license, licensingHarness, testKeys } from '../../helpers/licensing.js';
import { seedTeam, seedWorkspace } from '../../helpers/teams.js';

type Page = { events: { id: string; action: string; teamId: string | null }[]; next?: string };

describeDb('team-scoped audit reads (issue #208)', () => {
  const keys = testKeys();
  let h: Awaited<ReturnType<typeof licensingHarness>>;
  let root: Awaited<ReturnType<typeof signedInUser>>;
  let adminA: Awaited<ReturnType<typeof signedInUser>>;
  let memberB: Awaited<ReturnType<typeof signedInUser>>;
  let teamA: string;
  let teamB: string;
  let wsA: string;
  let wsB: string;

  const get = (url: string, user = adminA) =>
    h.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: user.headers });
  const seedEvent = (id: string, action: string, team: string | null, workspace: string | null, actor: string) =>
    h.db.query(
      `insert into audit_events (id, at, actor_kind, actor_user_id, action, target_kind, team_id, workspace_id)
       values ($1, now(), 'user', $5, $2, 'team', $3, $4)`,
      [id, action, team, workspace, actor],
    );

  beforeAll(async () => {
    h = await licensingHarness(keys, {
      extra: (clock) => [auditLogModule({ now: () => clock.now })],
    });
    root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    adminA = await signedInUser(h, { email: 'a@example.com' });
    memberB = await signedInUser(h, { email: 'b@example.com' });
    const a = await seedTeam(h, { name: 'A', admins: [adminA] });
    const b = await seedTeam(h, { name: 'B', members: [memberB] });
    teamA = a.id;
    teamB = b.id;
    wsA = await seedWorkspace(h, { team: a, name: 'wa' });
    wsB = await seedWorkspace(h, { team: b, name: 'wb' });
    for (let i = 1; i <= 3; i++)
      await seedEvent(`0A${i}`.padEnd(26, '0'), 'workspace.renamed', teamA, wsA, adminA.user.id);
    await seedEvent('0A9'.padEnd(26, '0'), 'team.renamed', teamA, null, adminA.user.id);
    for (let i = 1; i <= 2; i++)
      await seedEvent(`0B${i}`.padEnd(26, '0'), 'workspace.renamed', teamB, wsB, adminA.user.id);
    await seedEvent('0N1'.padEnd(26, '0'), 'user.signed_in', null, null, adminA.user.id);
  });
  afterAll(() => h.close());

  it('without the feature a team admin hears licensing-feature-required', async () => {
    const res = await get(`/audit?teamId=${teamA}`);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'licensing-feature-required' });
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/license',
      headers: root.headers,
      payload: { license: license(keys, { edition: 'enterprise' }) },
    });
    expect(put.statusCode).toBe(200);
  });

  it('a team admin sees exactly their team, in pages', async () => {
    const first = await get(`/audit?teamId=${teamA}&limit=2`);
    expect(first.statusCode).toBe(200);
    const body = first.json<Page>();
    expect(body.events).toHaveLength(2);
    expect(body.next).toBeTypeOf('string');
    const rest = (await get(`/audit?teamId=${teamA}&limit=50&after=${encodeURIComponent(body.next!)}`)).json<Page>();
    const all = [...body.events, ...rest.events];
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const e of all) expect(e.teamId).toBe(teamA);
  });

  it('a non-member hears 404, a plain member 403, and no teamId 403 audit-team-required, on both routes', async () => {
    for (const base of ['/audit', '/audit/export']) {
      const outsider = await get(`${base}?teamId=${teamB}`);
      expect(outsider.statusCode).toBe(404);
      expect(outsider.json()).toMatchObject({ code: 'teams-team-not-found' });
      const plain = await get(`${base}?teamId=${teamB}`, memberB);
      expect(plain.statusCode).toBe(403);
      expect(plain.json()).toMatchObject({ code: 'teams-forbidden' });
      const none = await get(base);
      expect(none.statusCode).toBe(403);
      expect(none.json()).toMatchObject({ code: 'audit-team-required' });
      const missing = await get(`${base}?teamId=nope`);
      expect(missing.statusCode).toBe(404);
    }
  });

  it('no other filter widens a team admin', async () => {
    for (const q of [
      `action=workspace.`,
      `workspaceId=${wsA}`,
      `actorUserId=${adminA.user.id}`,
      `workspaceId=${wsB}`,
    ]) {
      const page = (await get(`/audit?teamId=${teamA}&${q}`)).json<Page>();
      for (const e of page.events) expect(e.teamId).toBe(teamA);
    }
    expect((await get(`/audit?teamId=${teamA}&workspaceId=${wsB}`)).json<Page>().events).toEqual([]);
  });

  it('a server admin with no teamId sees everything; with teamId sees that team', async () => {
    const all = (await get('/audit?limit=200', root)).json<Page>().events;
    expect(all.some((e) => e.teamId === null)).toBe(true);
    expect(all.some((e) => e.teamId === teamA)).toBe(true);
    expect(all.some((e) => e.teamId === teamB)).toBe(true);
    const onlyB = (await get(`/audit?teamId=${teamB}`, root)).json<Page>().events;
    expect(onlyB).toHaveLength(2);
    for (const e of onlyB) expect(e.teamId).toBe(teamB);
  });

  it("a team admin's export is scoped and records audit.exported with their teamId", async () => {
    const res = await get(`/audit/export?teamId=${teamA}`);
    expect(res.statusCode).toBe(200);
    const lines = res.body
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as { teamId?: string });
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const l of lines) expect(l.teamId).toBe(teamA);
    await expect
      .poll(async () => (await get(`/audit?teamId=${teamA}&action=audit.exported`)).json<Page>().events.length)
      .toBe(1);
    const row = await h.db.query<{ team_id: string }>(
      `select team_id from audit_events where action = 'audit.exported'`,
    );
    expect(row.rows[0]!.team_id).toBe(teamA);
  });
});
