import { afterAll, beforeAll, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../../src/audit-log/cursor.js';
import { auditHook } from '../../../src/audit-log/hook.js';
import { deleteAuditEventsBefore, listAuditEvents, listAuditEventsAscending } from '../../../src/audit-log/repo.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import type { TenantDb } from '../../../src/tenancy/tenant-db.js';
import { defaultTenantDb } from '../../helpers/tenancy.js';

describeDb('audit_events repo (audit-log spec §3.4, §4.2)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let tdb: TenantDb;
  let tick = Date.parse('2026-10-01T00:00:00Z');
  const clock = () => new Date((tick += 1000));
  const record = auditHook(clock);

  beforeAll(async () => {
    // Every migration, 0020 included: the repositories' upserts name the tenant keys.
    db = await testDatabase();
    tdb = await defaultTenantDb(db);
    for (let i = 0; i < 7; i++) {
      await record(db, {
        actor: i % 2 === 0 ? { kind: 'user', userId: 'U1', email: 'a@example.com' } : { kind: 'system' },
        ...(i % 2 === 0 ? { ip: '203.0.113.7' } : {}),
        action: i < 4 ? 'workspace.pushed' : 'team.created',
        target: { kind: i < 4 ? 'workspace' : 'team', id: `T${String(i)}` },
        ...(i < 4 ? { workspaceId: 'W1' } : { teamId: 'TEAM1' }),
        details: { n: i },
      });
    }
  });
  afterAll(() => db.close());

  it('pages newest first through an opaque cursor, no row twice and none missing', async () => {
    const first = await listAuditEvents(tdb, {}, { limit: 3 });
    expect(first.map((e) => e.details['n'])).toEqual([6, 5, 4]);
    const cursor = decodeCursor(encodeCursor({ at: first[2]!.at, id: first[2]!.id }));
    const second = await listAuditEvents(tdb, {}, { after: cursor, limit: 3 });
    expect(second.map((e) => e.details['n'])).toEqual([3, 2, 1]);
    const third = await listAuditEvents(tdb, {}, { after: { at: second[2]!.at, id: second[2]!.id }, limit: 3 });
    expect(third.map((e) => e.details['n'])).toEqual([0]);
  });

  it('filters by prefix, exact action, actor, workspace, team, target and a half-open time range', async () => {
    expect(await listAuditEvents(tdb, { action: 'workspace.' }, { limit: 50 })).toHaveLength(4);
    expect(await listAuditEvents(tdb, { action: 'team.created' }, { limit: 50 })).toHaveLength(3);
    expect(await listAuditEvents(tdb, { actorUserId: 'U1' }, { limit: 50 })).toHaveLength(4);
    expect(await listAuditEvents(tdb, { workspaceId: 'W1', targetKind: 'workspace' }, { limit: 50 })).toHaveLength(4);
    expect(await listAuditEvents(tdb, { teamId: 'TEAM1' }, { limit: 50 })).toHaveLength(3);
    expect(await listAuditEvents(tdb, { targetId: 'T5' }, { limit: 50 })).toHaveLength(1);
    const all = await listAuditEventsAscending(tdb, {}, undefined, 50);
    const range = await listAuditEvents(tdb, { from: new Date(all[2]!.at), to: new Date(all[5]!.at) }, { limit: 50 });
    expect(range.map((e) => e.details['n'])).toEqual([4, 3, 2]);
  });

  it('ascends in batches for the export', async () => {
    const a = await listAuditEventsAscending(tdb, {}, undefined, 4);
    expect(a.map((e) => e.details['n'])).toEqual([0, 1, 2, 3]);
    const b = await listAuditEventsAscending(tdb, {}, { at: a[3]!.at, id: a[3]!.id }, 4);
    expect(b.map((e) => e.details['n'])).toEqual([4, 5, 6]);
  });

  it('a user actor round-trips with email and ip; a system actor has neither', async () => {
    const [user, sys] = await listAuditEventsAscending(tdb, { action: 'workspace.pushed' }, undefined, 2);
    expect(user!.actor).toEqual({ kind: 'user', userId: 'U1', email: 'a@example.com', tokenId: undefined });
    expect(user!.ip).toBe('203.0.113.7');
    expect(sys!.actor).toEqual({ kind: 'system' });
    expect(sys!.ip).toBeNull();
  });

  it('deletes before a cutoff in bounded batches, oldest first', async () => {
    const all = await listAuditEventsAscending(tdb, {}, undefined, 50);
    const cutoff = new Date(all[3]!.at);
    expect(await deleteAuditEventsBefore(tdb, cutoff, 2)).toBe(2);
    expect(await deleteAuditEventsBefore(tdb, cutoff, 2)).toBe(1);
    expect(await deleteAuditEventsBefore(tdb, cutoff, 2)).toBe(0);
    expect((await listAuditEventsAscending(tdb, {}, undefined, 50)).map((e) => e.details['n'])).toEqual([3, 4, 5, 6]);
  });
});
