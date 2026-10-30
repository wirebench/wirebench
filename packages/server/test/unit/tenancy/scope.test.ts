import { describe, expect, it, vi } from 'vitest';
import type { Database, Querier, ServerContext } from '../../../src/context.js';
import { checkAppRole, checkPostgresVersion } from '../../../src/tenancy/checks.js';
import { forEachTenant } from '../../../src/tenancy/jobs.js';
import { scopeOf, type TenantScope } from '../../../src/tenancy/scope.js';
import { SET_TENANT, tenantDbFactory } from '../../../src/tenancy/tenant-db.js';
import { testContext } from '../../helpers/context.js';
import { expectNoRawStatementsOn, rawStatementsOf, scopedContext, statementLog } from '../../helpers/tenancy.js';

const A = scopeOf({ id: '00000000-0000-4000-8000-00000000000a', slug: 'a' });
const B = scopeOf({ id: '00000000-0000-4000-8000-00000000000b', slug: 'b' });

/** A database that records what it is sent, one transaction at a time. */
function recordingDatabase(): { readonly db: Database; readonly sent: string[] } {
  const sent: string[] = [];
  const querier: Querier = {
    query: (text: string, params?: readonly unknown[]) => {
      sent.push(params === undefined ? text : `${text} ${JSON.stringify(params)}`);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  const db = {
    ...querier,
    transaction: async <T>(fn: (tx: Querier) => Promise<T>) => {
      sent.push('BEGIN');
      try {
        const result = await fn(querier);
        sent.push('COMMIT');
        return result;
      } catch (error) {
        sent.push('ROLLBACK');
        throw error;
      }
    },
    close: () => Promise.resolve(),
  };
  return { db, sent };
}

describe('the tenant database (spec §19.4)', () => {
  it('sets the tenant first in every unit, transaction-locally, and logs each statement after it', async () => {
    const { db, sent } = recordingDatabase();
    const log = statementLog();
    const tenantDb = tenantDbFactory(db, { onStatement: log.onStatement });
    await tenantDb(A).query('select 1');
    await tenantDb(B).transaction(async (tx) => {
      expect(tx.scope).toBe(B);
      await tx.query('select 2');
      await tx.query('select 3');
    });
    expect(sent).toEqual([
      'BEGIN',
      `${SET_TENANT} ["${A.tenantId}"]`,
      'select 1',
      'COMMIT',
      'BEGIN',
      `${SET_TENANT} ["${B.tenantId}"]`,
      'select 2',
      'select 3',
      'COMMIT',
    ]);
    expect(SET_TENANT).toContain(', true)');
    expect(log.entries.map((e) => [e.unit, e.kind, e.tenantId === A.tenantId ? 'A' : 'B', e.text])).toEqual([
      [1, 'set-config', 'A', SET_TENANT],
      [1, 'statement', 'A', 'select 1'],
      [2, 'set-config', 'B', SET_TENANT],
      [2, 'statement', 'B', 'select 2'],
      [2, 'statement', 'B', 'select 3'],
    ]);
  });

  it('joins a nested unit of the same tenant to the outer one, on its connection and in its transaction', async () => {
    const { db, sent } = recordingDatabase();
    const tenantDb = tenantDbFactory(db);
    await expect(
      tenantDb(A).transaction(async (outer) => {
        await outer.query('select 1');
        await tenantDb(A).query('select 2');
        await tenantDb(A).transaction(async (inner) => {
          expect(inner).toBe(outer);
          await inner.query('select 3');
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // One unit: the nested writes roll back with the outer one. The joined transaction has a savepoint of its own.
    expect(sent).toEqual([
      'BEGIN',
      `${SET_TENANT} ["${A.tenantId}"]`,
      'select 1',
      'select 2',
      'savepoint tenancy_1',
      'select 3',
      'release savepoint tenancy_1',
      'ROLLBACK',
    ]);
  });

  it('undoes only a failed joined transaction, through its savepoint, and keeps the outer unit going', async () => {
    const { db, sent } = recordingDatabase();
    const tenantDb = tenantDbFactory(db);
    await tenantDb(A).transaction(async (outer) => {
      await expect(
        tenantDb(A).transaction(async (inner) => {
          await inner.query('insert 1');
          throw new Error('inner failed');
        }),
      ).rejects.toThrow('inner failed');
      await outer.query('insert 2');
    });
    expect(sent).toEqual([
      'BEGIN',
      `${SET_TENANT} ["${A.tenantId}"]`,
      'savepoint tenancy_1',
      'insert 1',
      'rollback to savepoint tenancy_1',
      'insert 2',
      'COMMIT',
    ]);
  });

  it('rethrows the inner error when its savepoint rollback fails too, with the rollback as its cause', async () => {
    const sent: string[] = [];
    const querier: Querier = {
      query: (text: string) => {
        sent.push(text);
        return text.startsWith('rollback to savepoint')
          ? Promise.reject(new Error('the connection died'))
          : Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const db = {
      ...querier,
      transaction: async <T>(fn: (tx: Querier) => Promise<T>) => fn(querier),
      close: () => Promise.resolve(),
    };
    const tenantDb = tenantDbFactory(db);
    let caught: unknown;
    await tenantDb(A).transaction(async () => {
      caught = await tenantDb(A)
        .transaction(() => Promise.reject(new Error('inner failed')))
        .catch((error: unknown) => error);
    });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('inner failed');
    expect(((caught as Error).cause as Error).message).toBe('the connection died');
    expect(sent).toContain('rollback to savepoint tenancy_1');
  });

  it('fails a unit that settles with a statement it did not await, and rolls it back', async () => {
    const sent: string[] = [];
    const slow: Querier = {
      query: (text: string) => {
        sent.push(text);
        const answer = { rows: [], rowCount: 0 };
        return text === 'select slow'
          ? new Promise((done) => setTimeout(() => done(answer), 50))
          : Promise.resolve(answer);
      },
    };
    const db = {
      ...slow,
      transaction: async <T>(fn: (tx: Querier) => Promise<T>) => {
        sent.push('BEGIN');
        try {
          const result = await fn(slow);
          sent.push('COMMIT');
          return result;
        } catch (error) {
          sent.push('ROLLBACK');
          throw error;
        }
      },
      close: () => Promise.resolve(),
    };
    const tenantDb = tenantDbFactory(db);
    await expect(
      tenantDb(A).transaction((tx) => {
        void tx.query('select slow');
        return Promise.resolve();
      }),
    ).rejects.toMatchObject({ code: 'tenancy-unawaited' });
    let stray: Promise<unknown> | undefined;
    await expect(
      tenantDb(A).transaction((tx) => {
        stray = tenantDb(A).transaction((inner) => inner.query('select slow'));
        return tx.query('select 1');
      }),
    ).rejects.toMatchObject({ code: 'tenancy-unawaited' });
    // The stray unit's own next statement is refused once the unit it joined has ended, and it says so.
    await expect(stray).rejects.toMatchObject({ code: 'tenancy-scope-ended' });
    expect(sent.filter((line) => line === 'COMMIT')).toEqual([]);
  });

  it('refuses a nested unit of another tenant with tenancy-nested, and sends nothing for it', async () => {
    const { db, sent } = recordingDatabase();
    const tenantDb = tenantDbFactory(db);
    await tenantDb(A).transaction(async () => {
      await expect(tenantDb(B).query('select 1')).rejects.toMatchObject({ code: 'tenancy-nested' });
      await expect(tenantDb(B).transaction(() => Promise.resolve())).rejects.toMatchObject({ code: 'tenancy-nested' });
    });
    expect(sent).toEqual(['BEGIN', `${SET_TENANT} ["${A.tenantId}"]`, 'COMMIT']);
    // Outside any unit, B gets its own.
    await tenantDb(B).query('select 2');
    expect(sent.slice(3)).toEqual(['BEGIN', `${SET_TENANT} ["${B.tenantId}"]`, 'select 2', 'COMMIT']);
  });

  it('gives a timer that outlived its unit a unit of its own', async () => {
    const { db, sent } = recordingDatabase();
    const tenantDb = tenantDbFactory(db);
    let later: (() => Promise<unknown>) | undefined;
    await tenantDb(A).transaction(() => {
      later = () => tenantDb(B).query('select 1');
      return Promise.resolve();
    });
    await later!();
    expect(sent.filter((line) => line === 'BEGIN')).toHaveLength(2);
  });

  it('refuses a statement that would end or open the transaction', async () => {
    const { db, sent } = recordingDatabase();
    await tenantDbFactory(db)(A).transaction(async (tx) => {
      const control = [
        'commit',
        ' COMMIT;',
        'rollback',
        'begin',
        'end',
        'abort',
        'start transaction',
        'Begin Work',
        '/* x */ commit',
        '-- a note\ncommit',
        '/* a */ -- b\n  /* c */ rollback',
      ];
      for (const text of control)
        await expect(tx.query(text), text).rejects.toMatchObject({ code: 'tenancy-transaction-control' });
      // `E'\''` is one quote; the plain-string rule would read past it and swallow `; commit`.
      for (const text of [
        'select 1; commit',
        'select 1;select 2',
        'update t set a = 1; /* x */ begin',
        "select E'\\''; commit --'",
        "select e'a\\\\'; commit",
      ])
        await expect(tx.query(text), text).rejects.toMatchObject({ code: 'tenancy-multi-statement' });
      await tx.query('savepoint s1');
      await tx.query('rollback to savepoint s1');
      await tx.query("select 'commit; begin'");
      await tx.query('select 1; -- trailing note');
      await tx.query('select $$a; commit$$');
      await tx.query("select E'it\\'s; commit', date'2026-10-30'");
    });
    expect(sent).toEqual([
      'BEGIN',
      `${SET_TENANT} ["${A.tenantId}"]`,
      'savepoint s1',
      'rollback to savepoint s1',
      "select 'commit; begin'",
      'select 1; -- trailing note',
      'select $$a; commit$$',
      "select E'it\\'s; commit', date'2026-10-30'",
      'COMMIT',
    ]);
  });

  it('revokes the querier when its unit ends: a late query throws tenancy-scope-ended and sends nothing', async () => {
    const { db, sent } = recordingDatabase();
    let kept: { query(text: string): Promise<unknown> } | undefined;
    await tenantDbFactory(db)(A).transaction((tx) => {
      kept = tx;
      return Promise.resolve();
    });
    const before = sent.length;
    await expect(kept!.query('select 1')).rejects.toMatchObject({ code: 'tenancy-scope-ended' });
    expect(sent).toHaveLength(before);
  });

  it('revokes it on a rollback too', async () => {
    const { db } = recordingDatabase();
    let kept: { query(text: string): Promise<unknown> } | undefined;
    await expect(
      tenantDbFactory(db)(A).transaction((tx) => {
        kept = tx;
        return Promise.reject(new Error('boom'));
      }),
    ).rejects.toThrow('boom');
    await expect(kept!.query('select 1')).rejects.toMatchObject({ code: 'tenancy-scope-ended' });
  });
});

describe('forEachTenant (spec §19.8 guard 6)', () => {
  it('serves every tenant in its own unit and goes on past a failing one, logging the job and the tenant', async () => {
    const { db, sent } = recordingDatabase();
    const C = scopeOf({ id: '00000000-0000-4000-8000-00000000000c', slug: 'c' });
    const error = vi.fn();
    const seen: TenantScope[] = [];
    const pass = await forEachTenant(
      { directory: { list: () => Promise.resolve([A, B, C]) }, db: tenantDbFactory(db), log: { error } },
      'capture-retention',
      async (tx, scope) => {
        seen.push(scope);
        expect(tx.scope).toBe(scope);
        if (scope === B) throw new Error('B failed');
        await tx.query('delete from captures');
      },
    );
    expect(seen).toEqual([A, B, C]);
    expect(pass).toEqual({ served: 2, failed: [B.tenantId] });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toMatchObject({ job: 'capture-retention', tenantId: B.tenantId });
    expect(sent.filter((line) => line === 'ROLLBACK')).toHaveLength(1);
    expect(sent.filter((line) => line === 'delete from captures')).toHaveLength(2);
  });
});

describe('the start-up checks (spec §19.1, §19.4)', () => {
  const answering = (row: Record<string, unknown>): Querier => ({
    query: () => Promise.resolve({ rows: [row as never], rowCount: 1 }),
  });

  it('refuses PostgreSQL before 15 with server-postgres-too-old', async () => {
    await expect(checkPostgresVersion(answering({ version: '140011' }))).rejects.toMatchObject({
      code: 'server-postgres-too-old',
      message: expect.stringContaining('version 14') as unknown,
    });
    await expect(checkPostgresVersion(answering({ version: '150000' }))).resolves.toBeUndefined();
    await expect(checkPostgresVersion(answering({ version: '160015' }))).resolves.toBeUndefined();
  });

  const role = (overrides: object) =>
    answering({ role: 'wirebench', superuser: false, bypassRls: false, ownedTables: 0, ...overrides });

  it('refuses a bypassing app role in hosted mode', async () => {
    for (const bypass of [{ superuser: true }, { bypassRls: true }, { ownedTables: 36 }]) {
      const warn = vi.fn();
      await expect(checkAppRole(role(bypass), 'hosted', warn)).rejects.toMatchObject({
        code: 'tenancy-role-bypasses',
      });
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it('warns about it in self-hosted mode, naming why, and starts', async () => {
    const warn = vi.fn();
    await checkAppRole(role({ superuser: true, ownedTables: 3 }), 'self-hosted', warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/wirebench is a superuser, owns 3 of the server's tables/);
  });

  it('is silent for an app role the policy applies to, in either mode', async () => {
    const warn = vi.fn();
    await checkAppRole(role({}), 'hosted', warn);
    await checkAppRole(role({}), 'self-hosted', warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('scopedContext (plan, Global Constraints)', () => {
  it('throws tenancy-unscoped on db, and passes license and log writes through to the shared context', async () => {
    const shared = await testContext();
    const scoped = scopedContext(shared);
    expect(() => scoped.db).toThrow(expect.objectContaining({ code: 'tenancy-unscoped' }));
    const license = { ...shared.license };
    scoped.license = license;
    expect(shared.license).toBe(license);
    const log = { info: vi.fn() } as unknown as ServerContext['log'];
    (scoped as { log: ServerContext['log'] }).log = log;
    expect(shared.log).toBe(log);
    expect(scoped.log).toBe(log);
    expect(scoped.tenancy).toBe(shared.tenancy);
    expect(scoped.config).toBe(shared.config);
  });
});

describe('the raw statement log (Task 5 review M8)', () => {
  it("records what went through ctx.db, not the tenant database's units", async () => {
    const { db } = recordingDatabase();
    const ctx = await testContext({ db });
    await ctx.db.query('select * from teams');
    await ctx.db.transaction((tx) => tx.query('update workspaces set name = $1', ['x']));
    await ctx.tenancy.db(A).query('select * from schedules');
    expect(rawStatementsOf(ctx)).toEqual(['select * from teams', 'update workspaces set name = $1']);
    expect(() => {
      expectNoRawStatementsOn(ctx, ['workspaces']);
    }).toThrow();
    expectNoRawStatementsOn(ctx, ['schedules', 'team']);
  });
});
