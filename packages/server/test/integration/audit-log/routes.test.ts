import { afterAll, beforeAll, expect, it } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { exportLines } from '../../../src/audit-log/routes.js';
import { SWEEP_INTERVAL_MS } from '../../../src/hooks/sweep.js';
import { expectNoSecretsInAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser } from '../../helpers/identity.js';
import { license, licensingHarness, testKeys } from '../../helpers/licensing.js';
import { manualTimers } from '../../helpers/timers.js';

type Page = {
  events: { action: string; actor: { email?: string }; details: Record<string, unknown> }[];
  next?: string;
};

describeDb('GET /audit and /audit/export (audit-log spec §3.4)', () => {
  const keys = testKeys();
  const timers = manualTimers();
  let h: Awaited<ReturnType<typeof licensingHarness>>;
  let admin: Awaited<ReturnType<typeof signedInUser>>;
  let member: Awaited<ReturnType<typeof signedInUser>>;

  const get = (url: string, user = admin) =>
    h.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: user.headers });
  const install = (edition: 'team' | 'enterprise') =>
    h.app.inject({
      method: 'PUT',
      url: '/api/v1/license',
      headers: admin.headers,
      payload: { license: license(keys, { edition }) },
    });
  /** The listener writes after the announce (ruling 5), so a test waits for the row rather than sleeping. */
  const rowsOf = async (action: string) =>
    (
      await h.db.query<{ actor_email: string | null; details: Record<string, unknown> }>(
        'select actor_email, details from audit_events where action = $1 order by at, id',
        [action],
      )
    ).rows;

  beforeAll(async () => {
    h = await licensingHarness(keys, {
      extra: (clock) => [auditLogModule({ now: () => clock.now, setTimer: timers.setTimer })],
    });
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    member = await signedInUser(h, { email: 'm@example.com' });
  });
  afterAll(() => h.close());

  it('Community: an admin is refused with licensing-feature-required, on both routes', async () => {
    for (const url of ['/audit', '/audit/export']) {
      const res = await get(url);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'licensing-feature-required' });
    }
  });

  it('a member hears identity-forbidden before the feature is checked', async () => {
    const res = await get('/audit', member);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'identity-forbidden' });
  });

  it('Team: still refused, and the install is recorded all the same (recording is on for every edition)', async () => {
    expect((await install('team')).statusCode).toBe(200);
    await expect.poll(async () => (await rowsOf('license.installed')).length).toBe(1);
    expect((await get('/audit')).statusCode).toBe(403);
    expect((await get('/audit/export')).statusCode).toBe(403);
  });

  it('Enterprise: pages newest first with a cursor, filters by prefix, refuses a bad cursor', async () => {
    expect((await install('enterprise')).statusCode).toBe(200);
    await expect.poll(async () => (await rowsOf('license.installed')).length).toBe(2);
    const page = await get('/audit?limit=1');
    expect(page.statusCode).toBe(200);
    const body = page.json<Page>();
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.action).toBe('license.installed');
    expect(body.events[0]!.actor.email).toBe('root@example.com');
    expect(body.events[0]!.details).toEqual({ edition: 'enterprise' });
    expect(body.next).toBeTypeOf('string');
    const rest = await get(`/audit?limit=200&after=${encodeURIComponent(body.next!)}`);
    expect(rest.statusCode).toBe(200);
    expect(rest.json<Page>().next).toBeUndefined();
    for (const e of (await get('/audit?action=license.')).json<Page>().events)
      expect(e.action.startsWith('license.')).toBe(true);
    const bad = await get('/audit?after=!!!');
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'audit-cursor-invalid' });
  });

  it('exports oldest first as NDJSON across the 1000-row batch boundary, then records the export', async () => {
    await h.db.query(
      `insert into audit_events (id, at, actor_kind, action, target_kind, details)
       select lpad(n::text, 26, '0'), timestamptz '2026-01-01' + n * interval '1 second', 'system', 'hook.cleared', 'hook', '{}'::jsonb
       from generate_series(1, 1005) as n`,
    );
    const res = await get('/audit/export?action=hook.cleared');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/);
    const lines = res.body
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: string; at: string });
    expect(lines).toHaveLength(1005);
    expect(new Set(lines.map((l) => l.id)).size).toBe(1005);
    for (let i = 1; i < lines.length; i++) expect(lines[i]!.at >= lines[i - 1]!.at).toBe(true);
    const exported = (await get('/audit?action=audit.exported')).json<Page>().events[0]!;
    expect(exported.details).toMatchObject({ action: 'hook.cleared', count: 1005 });
    expect(exported.actor.email).toBe('root@example.com');
  });

  it('a consumer that stops mid-stream leaves no audit.exported row', async () => {
    const before = (await rowsOf('audit.exported')).length;
    const ended: number[] = [];
    const lines = exportLines(h.db, { action: 'hook.cleared' }, (count) => {
      ended.push(count);
      return Promise.resolve();
    });
    await lines.next();
    await lines.return(undefined);
    expect(ended).toEqual([]);
    expect((await rowsOf('audit.exported')).length).toBe(before);
  });

  it('license removal is recorded by the listener, after the commit, with the admin as actor', async () => {
    await h.app.inject({ method: 'DELETE', url: '/api/v1/license', headers: admin.headers });
    await expect
      .poll(async () => (await rowsOf('license.removed')).map((r) => r.actor_email))
      .toEqual(['root@example.com']);
  });

  it('the module sweeps events older than the retention on its own timer', async () => {
    h.clock.set(new Date('2027-06-01T00:00:00Z')); // the generated rows are from 2026-01-01, beyond 365 days
    expect(timers.fire(SWEEP_INTERVAL_MS)).toBe(1);
    await expect.poll(async () => (await rowsOf('hook.cleared')).length).toBe(0);
  });

  it('writes no secret-shaped value', () => expectNoSecretsInAudit(h.db));
});
