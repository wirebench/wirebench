import { describe, expect, it } from 'vitest';
import { auditHook, boundDetails } from '../../../src/audit-log/hook.js';
import type { Querier } from '../../../src/context.js';

/** Records every statement; a `select ... from workspaces` answers from `teams` (workspace id → team id). */
function capturing(teams: Record<string, string> = {}): {
  db: Querier;
  statements: { text: string; params: readonly unknown[] }[];
} {
  const statements: { text: string; params: readonly unknown[] }[] = [];
  return {
    statements,
    db: {
      query: (text, params = []) => {
        statements.push({ text, params });
        if (/from workspaces/.test(text)) {
          const team = teams[params[0] as string];
          const rows = team === undefined ? [] : [{ team_id: team }];
          return Promise.resolve({ rows: rows as never[], rowCount: rows.length });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    },
  };
}
const inserted = (statements: { text: string; params: readonly unknown[] }[]) => {
  const insert = statements.filter((s) => /insert into audit_events/.test(s.text));
  expect(insert).toHaveLength(1);
  return insert[0]!.params;
};

describe('auditHook (audit-log spec §3.1, §4.2)', () => {
  it('inserts one row with a ULID, the clock, and the actor flattened', async () => {
    const { db, statements } = capturing();
    const now = new Date('2026-10-01T12:00:00Z');
    await auditHook(() => now)(db, {
      actor: { kind: 'user', userId: 'U1', email: 'a@example.com', tokenId: 'T1' },
      ip: '203.0.113.7',
      userAgent: 'Wirebench/3.1.0',
      action: 'team.created',
      target: { kind: 'team', id: 'TEAM1' },
      teamId: 'TEAM1',
      details: { name: 'Payments' },
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.text).toMatch(/insert into audit_events/);
    const p = statements[0]!.params;
    expect(p[0]).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(p[1]).toEqual(now);
    expect(p.slice(2, 6)).toEqual(['user', 'U1', 'a@example.com', 'T1']);
    expect(p[6]).toBe('team.created');
    expect(p.slice(7, 11)).toEqual(['team', 'TEAM1', null, 'TEAM1']);
    expect(p.slice(11, 13)).toEqual(['203.0.113.7', 'Wirebench/3.1.0']);
    expect(JSON.parse(p[13] as string)).toEqual({ name: 'Payments' });
    expect(p[14]).toBeNull();
  });

  it('a system actor has no ids, an absent ip is null, no details is {}', async () => {
    const { db, statements } = capturing();
    await auditHook(() => new Date())(db, {
      actor: { kind: 'system' },
      action: 'audit.exported',
      target: { kind: 'server' },
    });
    const p = statements[0]!.params;
    expect(p.slice(2, 6)).toEqual(['system', null, null, null]);
    expect(p[8]).toBeNull();
    expect(p[11]).toBeNull();
    expect(p[13]).toBe('{}');
  });

  it('a CI token actor carries its token and workspace', async () => {
    const { db, statements } = capturing();
    await auditHook(() => new Date())(db, {
      actor: { kind: 'ci-token', tokenId: 'CT1', workspaceId: 'W1' },
      action: 'hook.cleared',
      target: { kind: 'hook', id: 'H1' },
      workspaceId: 'W1',
    });
    const p = inserted(statements);
    expect(p.slice(2, 6)).toEqual(['ci-token', null, null, 'CT1']);
    expect(p[14]).toBe('W1');
  });

  it("a workspace event with no team takes the workspace's team, read through the same querier", async () => {
    const { db, statements } = capturing({ W1: 'TEAM1' });
    await auditHook(() => new Date())(db, {
      actor: { kind: 'user', userId: 'U1', email: 'a@example.com' },
      action: 'workspace.pushed',
      target: { kind: 'workspace', id: 'W1' },
      workspaceId: 'W1',
    });
    expect(statements[0]!.text).toMatch(/select team_id from workspaces/);
    expect(statements[0]!.params).toEqual(['W1']);
    const p = inserted(statements);
    expect(p.slice(9, 11)).toEqual(['W1', 'TEAM1']);
  });

  it('a team the event names wins, and no lookup runs', async () => {
    const { db, statements } = capturing({ W1: 'TEAM1' });
    await auditHook(() => new Date())(db, {
      actor: { kind: 'system' },
      action: 'workspace.deleted',
      target: { kind: 'workspace', id: 'W1' },
      workspaceId: 'W1',
      teamId: 'TEAM2',
    });
    expect(statements).toHaveLength(1);
    expect(inserted(statements).slice(9, 11)).toEqual(['W1', 'TEAM2']);
  });

  it('a workspace whose row is gone leaves the team null', async () => {
    const { db, statements } = capturing();
    await auditHook(() => new Date())(db, {
      actor: { kind: 'system' },
      action: 'workspace.deleted',
      target: { kind: 'workspace', id: 'GONE' },
      workspaceId: 'GONE',
    });
    expect(inserted(statements).slice(9, 11)).toEqual(['GONE', null]);
  });

  it('bounds details at 4 KiB and marks the truncation', () => {
    const bounded = boundDetails({ note: 'x'.repeat(5000), kept: 'yes' });
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(4096);
    expect(bounded['_truncated']).toBe(true);
    expect(bounded['kept']).toBe('yes');
    expect(boundDetails({ a: 1 })).toEqual({ a: 1 });
    expect(boundDetails(undefined)).toEqual({});
  });

  it('a failing insert rejects, so the action rolls back with it', async () => {
    const db: Querier = { query: () => Promise.reject(new Error('connection lost')) };
    await expect(
      auditHook(() => new Date())(db, {
        actor: { kind: 'anonymous' },
        action: 'auth.sign_in_failed',
        target: { kind: 'server' },
      }),
    ).rejects.toThrow('connection lost');
  });
});
