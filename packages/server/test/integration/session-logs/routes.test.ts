import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionLogPage, SessionLogTextResponse } from '@wirebench/engine';
import type { AuditInput } from '../../../src/context.js';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { sessionLogsModule } from '../../../src/session-logs/module.js';
import { removeLogsBefore } from '../../../src/session-logs/repo.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser } from '../../helpers/identity.js';
import { license, licenseInstallRecorded, licensingHarness, testKeys } from '../../helpers/licensing.js';
import { call, seedTeam } from '../../helpers/teams.js';

const OPEN = {
  clientLogId: '20261017T101500Z-6f1c2d3e',
  hostId: 'web',
  hostName: 'Web',
  address: '10.0.0.1',
  port: 22,
  user: 'deploy',
  startedAt: '2026-09-24T11:00:00.000Z',
};
const b64 = (text: string | Buffer): string => Buffer.from(text).toString('base64');
const MIB = 1024 * 1024;

describeDb('team session logs (#430)', () => {
  const keys = testKeys();
  let h: Awaited<ReturnType<typeof licensingHarness>>;
  let events: AuditInput[];
  let admin: Awaited<ReturnType<typeof signedInUser>>;
  let ada: Awaited<ReturnType<typeof signedInUser>>;
  let bo: Awaited<ReturnType<typeof signedInUser>>;
  let outsider: Awaited<ReturnType<typeof signedInUser>>;
  let ws: string;
  let base: string;

  beforeAll(async () => {
    h = await licensingHarness(keys, {
      env: { WIREBENCH_SERVER_SESSION_LOG_MAX_MB: '1' },
      extra: (clock) => [auditLogModule({ now: () => clock.now }), sessionLogsModule({ now: () => clock.now })],
    });
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    ada = await signedInUser(h, { email: 'ada@example.com' });
    bo = await signedInUser(h, { email: 'bo@example.com' });
    outsider = await signedInUser(h, { email: 'out@example.com' });
    const team = await seedTeam(h, { name: 'Ops', admins: [admin], members: [ada, bo] });
    await seedTeam(h, { name: 'Elsewhere', members: [outsider] });
    ws = (await call<{ id: string }>(h, admin, 'POST', `/teams/${team.id}/workspaces`, { name: 'Prod' })).body.id;
    base = `/workspaces/${ws}/session-logs`;
    events = recordingAudit(h.hooks);
  });
  afterAll(() => h.close());

  const audited = (action: string) => events.filter((e) => e.action === action);

  describe('before the feature and the switch', () => {
    it('without the session-logs feature a member hears licensing-feature-required', async () => {
      const res = await call<{ code: string }>(h, ada, 'POST', base, OPEN);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('licensing-feature-required');
    });

    it('with the feature but the switch off, opening a log is refused', async () => {
      const put = await call(h, admin, 'PUT', '/license', { license: license(keys, { edition: 'enterprise' }) });
      expect(put.status).toBe(200);
      await licenseInstallRecorded(h);
      const res = await call<{ code: string }>(h, ada, 'POST', base, OPEN);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('session-logs-recording-off');
      expect((await call(h, admin, 'PATCH', `/workspaces/${ws}`, { recordSessionLogs: true })).status).toBe(200);
    });

    it('someone outside the workspace hears not found', async () => {
      const res = await call<{ code: string }>(h, outsider, 'GET', base);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('teams-workspace-not-found');
    });
  });

  describe('writing', () => {
    let logId: string;

    it('opens a log once per member and client id, audited once', async () => {
      const first = await call<{ id: string; size: number; ended: boolean }>(h, ada, 'POST', base, OPEN);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ size: 0, ended: false });
      logId = first.body.id;
      const again = await call<{ id: string }>(h, ada, 'POST', base, OPEN);
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(logId);
      expect(audited('session_log.started')).toEqual([
        expect.objectContaining({
          target: { kind: 'session-log', id: logId },
          workspaceId: ws,
          details: { hostName: 'Web', userId: ada.user.id },
        }),
      ]);
      // Another member's log under the same client id is their own.
      const bos = await call<{ id: string }>(h, bo, 'POST', base, OPEN);
      expect(bos.status).toBe(201);
      expect(bos.body.id).not.toBe(logId);
    });

    it('appends at the size the server holds and refuses any other offset', async () => {
      const one = await call(h, ada, 'POST', `${base}/${logId}/chunks`, { offset: 0, data: b64('$ uptime\n') });
      expect(one.body).toEqual({ size: 9, truncated: false });
      const stale = await call<{ code: string }>(h, ada, 'POST', `${base}/${logId}/chunks`, {
        offset: 0,
        data: b64('again'),
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('session-logs-offset');
      const reopened = await call<{ size: number }>(h, ada, 'POST', base, OPEN);
      expect(reopened.body.size).toBe(9);
    });

    it('only the member who opened a log writes to it', async () => {
      const res = await call<{ code: string }>(h, bo, 'POST', `${base}/${logId}/chunks`, {
        offset: 9,
        data: b64('mine now'),
      });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('session-logs-not-found');
      const end = await call(h, bo, 'POST', `${base}/${logId}/end`, { endedAt: OPEN.startedAt, reason: 'exit' });
      expect(end.status).toBe(404);
    });

    it('ends once; a retried end changes nothing and later output is refused', async () => {
      const text = ' 11:00 up 3 days\n';
      await call(h, ada, 'POST', `${base}/${logId}/chunks`, { offset: 9, data: b64(text) });
      const end = { endedAt: '2026-09-24T11:30:00.000Z', exitCode: 0, reason: 'exit' };
      expect((await call(h, ada, 'POST', `${base}/${logId}/end`, end)).status).toBe(204);
      expect((await call(h, ada, 'POST', `${base}/${logId}/end`, { ...end, reason: 'lost' })).status).toBe(204);
      const late = await call<{ code: string }>(h, ada, 'POST', `${base}/${logId}/chunks`, {
        offset: 9 + text.length,
        data: b64('late'),
      });
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('session-logs-ended');
      const page = await call<SessionLogPage>(h, bo, 'GET', `${base}?userId=${ada.user.id}`);
      expect(page.body.logs[0]).toMatchObject({ endedAt: end.endedAt, exitCode: 0, reason: 'exit', live: false });
    });

    it('keeps at most the configured size and says so', async () => {
      const big = { ...OPEN, clientLogId: '20261017T110000Z-big' };
      const id = (await call<{ id: string }>(h, ada, 'POST', base, big)).body.id;
      const half = Buffer.alloc(512 * 1024, 0x61);
      const first = await call(h, ada, 'POST', `${base}/${id}/chunks`, { offset: 0, data: b64(half) });
      expect(first.body).toEqual({ size: 512 * 1024, truncated: false });
      // More than one chunk may carry is refused by the schema.
      const over = await call(h, ada, 'POST', `${base}/${id}/chunks`, {
        offset: 512 * 1024,
        data: b64(Buffer.concat([half, Buffer.from('xyz')])),
      });
      expect(over.status).toBe(400);
      const fill = await call(h, ada, 'POST', `${base}/${id}/chunks`, { offset: 512 * 1024, data: b64(half) });
      expect(fill.body).toEqual({ size: MIB, truncated: false });
      const past = await call(h, ada, 'POST', `${base}/${id}/chunks`, { offset: MIB, data: b64('more') });
      expect(past.body).toEqual({ size: MIB, truncated: true });
      const page = await call<SessionLogPage>(h, ada, 'GET', `${base}?hostId=web&limit=1`);
      expect(page.body.logs[0]).toMatchObject({ id, size: MIB, truncated: true });
    });
  });

  describe('reading', () => {
    let liveId: string;

    it('lists newest first with filters and pages; listing is not audited', async () => {
      const db = { ...OPEN, clientLogId: '20261017T120000Z-db', hostId: 'db', hostName: 'DB' };
      liveId = (await call<{ id: string }>(h, bo, 'POST', base, db)).body.id;
      const all = await call<SessionLogPage>(h, ada, 'GET', base);
      const ids = all.body.logs.map((l) => l.id);
      expect(ids).toEqual([...ids].sort().reverse());
      expect(all.body.logs[0]).toMatchObject({ id: liveId, hostName: 'DB', userId: bo.user.id, live: true });
      expect(all.body.logs[0]!.userName.length).toBeGreaterThan(0);
      const filtered = await call<SessionLogPage>(h, ada, 'GET', `${base}?hostId=db`);
      expect(filtered.body.logs.map((l) => l.id)).toEqual([liveId]);
      const first = await call<SessionLogPage>(h, ada, 'GET', `${base}?limit=2`);
      const next = first.body.next!;
      expect(next).toBe(first.body.logs[1]!.id);
      const second = await call<SessionLogPage>(h, ada, 'GET', `${base}?limit=2&before=${next}`);
      expect(second.body.logs.every((l) => l.id < next)).toBe(true);
      expect(audited('session_log.read')).toHaveLength(0);
    });

    it('reads across chunks from an offset; every read is audited', async () => {
      const page = await call<SessionLogPage>(h, bo, 'GET', `${base}?userId=${ada.user.id}&hostId=web`);
      const ended = page.body.logs.find((l) => !l.truncated)!;
      const whole = await call<SessionLogTextResponse>(h, bo, 'GET', `${base}/${ended.id}/text`);
      expect(whole.body).toEqual({
        offset: 0,
        text: '$ uptime\n 11:00 up 3 days\n',
        next: 26,
        size: 26,
        truncated: false,
        live: false,
      });
      const tail = await call<SessionLogTextResponse>(h, bo, 'GET', `${base}/${ended.id}/text?offset=9`);
      expect(tail.body.text).toBe(' 11:00 up 3 days\n');
      expect(audited('session_log.read').map((e) => e.details)).toEqual([
        { hostName: 'Web', userId: ada.user.id, offset: 0, bytes: 26 },
        { hostName: 'Web', userId: ada.user.id, offset: 9, bytes: 17 },
      ]);
      expect(audited('session_log.read')[0]).toMatchObject({ actor: { kind: 'user', userId: bo.user.id } });
    });

    it('leaves a character still arriving in a live log for the next read', async () => {
      const euro = Buffer.from('€', 'utf8'); // three bytes
      const partial = Buffer.concat([Buffer.from('a'), euro.subarray(0, 2)]);
      await call(h, bo, 'POST', `${base}/${liveId}/chunks`, { offset: 0, data: b64(partial) });
      const first = await call<SessionLogTextResponse>(h, ada, 'GET', `${base}/${liveId}/text`);
      expect(first.body).toMatchObject({ text: 'a', next: 1, size: 3, live: true });
      await call(h, bo, 'POST', `${base}/${liveId}/chunks`, { offset: 3, data: b64(euro.subarray(2)) });
      const second = await call<SessionLogTextResponse>(h, ada, 'GET', `${base}/${liveId}/text?offset=1`);
      expect(second.body).toMatchObject({ text: '€', next: 4 });
    });
  });

  describe('deleting and retention', () => {
    it('only a workspace admin deletes, audited; the log is then gone', async () => {
      const page = await call<SessionLogPage>(h, admin, 'GET', `${base}?hostId=db`);
      const id = page.body.logs[0]!.id;
      expect((await call(h, ada, 'DELETE', `${base}/${id}`)).status).toBe(403);
      expect((await call(h, admin, 'DELETE', `${base}/${id}`)).status).toBe(204);
      expect(audited('session_log.deleted')).toEqual([
        expect.objectContaining({
          target: { kind: 'session-log', id },
          details: { hostName: 'DB', userId: bo.user.id, size: 4 },
        }),
      ]);
      expect((await call(h, ada, 'GET', `${base}/${id}/text`)).status).toBe(404);
      // The uploader's next chunk hears the same, and stops.
      expect((await call(h, bo, 'POST', `${base}/${id}/chunks`, { offset: 4, data: b64('x') })).status).toBe(404);
    });

    it('drops logs last written before the cutoff, with their chunks', async () => {
      const count = async (table: string): Promise<number> =>
        (await h.db.query(`select count(*)::int as n from ${table}`)).rows[0]!['n'] as number;
      const before = await count('session_logs');
      expect(before).toBeGreaterThan(0);
      expect(await removeLogsBefore(h.tdb, new Date('2026-09-24T00:00:00Z'), 1000)).toBe(0);
      expect(await removeLogsBefore(h.tdb, new Date('2026-09-25T00:00:00Z'), 1000)).toBe(before);
      expect(await count('session_log_chunks')).toBe(0);
    });
  });
});
