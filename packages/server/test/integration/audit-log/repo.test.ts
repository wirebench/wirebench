import { afterAll, beforeAll, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../../src/audit-log/cursor.js';
import { auditHook } from '../../../src/audit-log/hook.js';
import { deleteAuditEventsBefore, listAuditEvents, listAuditEventsAscending } from '../../../src/audit-log/repo.js';
import { fileURLToPath } from 'node:url';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '../../../src/db/migrate.js';
import { describeDb, testDatabase } from '../../helpers/database.js';

const AUDIT_DIR = fileURLToPath(new URL('../../../migrations/audit-log/', import.meta.url));

describeDb('audit_events repo (audit-log spec §3.4, §4.2)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let tick = Date.parse('2026-10-01T00:00:00Z');
  const clock = () => new Date((tick += 1000));
  const record = auditHook(clock);

  beforeAll(async () => {
    db = await testDatabase();
    await migrate(db, [
      ...(await loadMigrations(MIGRATIONS_DIR)),
      ...(await loadMigrations(AUDIT_DIR, { contiguous: false })),
    ]);
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
    const first = await listAuditEvents(db, {}, { limit: 3 });
    expect(first.map((e) => e.details['n'])).toEqual([6, 5, 4]);
    const cursor = decodeCursor(encodeCursor({ at: first[2]!.at, id: first[2]!.id }));
    const second = await listAuditEvents(db, {}, { after: cursor, limit: 3 });
    expect(second.map((e) => e.details['n'])).toEqual([3, 2, 1]);
    const third = await listAuditEvents(db, {}, { after: { at: second[2]!.at, id: second[2]!.id }, limit: 3 });
    expect(third.map((e) => e.details['n'])).toEqual([0]);
  });

  it('filters by prefix, exact action, actor, workspace, team, target and a half-open time range', async () => {
    expect(await listAuditEvents(db, { action: 'workspace.' }, { limit: 50 })).toHaveLength(4);
    expect(await listAuditEvents(db, { action: 'team.created' }, { limit: 50 })).toHaveLength(3);
    expect(await listAuditEvents(db, { actorUserId: 'U1' }, { limit: 50 })).toHaveLength(4);
    expect(await listAuditEvents(db, { workspaceId: 'W1', targetKind: 'workspace' }, { limit: 50 })).toHaveLength(4);
    expect(await listAuditEvents(db, { teamId: 'TEAM1' }, { limit: 50 })).toHaveLength(3);
    expect(await listAuditEvents(db, { targetId: 'T5' }, { limit: 50 })).toHaveLength(1);
    const all = await listAuditEventsAscending(db, {}, undefined, 50);
    const range = await listAuditEvents(db, { from: new Date(all[2]!.at), to: new Date(all[5]!.at) }, { limit: 50 });
    expect(range.map((e) => e.details['n'])).toEqual([4, 3, 2]);
  });

  it('ascends in batches for the export', async () => {
    const a = await listAuditEventsAscending(db, {}, undefined, 4);
    expect(a.map((e) => e.details['n'])).toEqual([0, 1, 2, 3]);
    const b = await listAuditEventsAscending(db, {}, { at: a[3]!.at, id: a[3]!.id }, 4);
    expect(b.map((e) => e.details['n'])).toEqual([4, 5, 6]);
  });

  it('a user actor round-trips with email and ip; a system actor has neither', async () => {
    const [user, sys] = await listAuditEventsAscending(db, { action: 'workspace.pushed' }, undefined, 2);
    expect(user!.actor).toEqual({ kind: 'user', userId: 'U1', email: 'a@example.com', tokenId: undefined });
    expect(user!.ip).toBe('203.0.113.7');
    expect(sys!.actor).toEqual({ kind: 'system' });
    expect(sys!.ip).toBeNull();
  });

  it('deletes before a cutoff in bounded batches, oldest first', async () => {
    const all = await listAuditEventsAscending(db, {}, undefined, 50);
    const cutoff = new Date(all[3]!.at);
    expect(await deleteAuditEventsBefore(db, cutoff, 2)).toBe(2);
    expect(await deleteAuditEventsBefore(db, cutoff, 2)).toBe(1);
    expect(await deleteAuditEventsBefore(db, cutoff, 2)).toBe(0);
    expect((await listAuditEventsAscending(db, {}, undefined, 50)).map((e) => e.details['n'])).toEqual([3, 4, 5, 6]);
  });
});
