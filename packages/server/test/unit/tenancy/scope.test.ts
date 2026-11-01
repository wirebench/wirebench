import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Database, Querier } from '../../../src/db/querier.js';
import { checkAppRole, checkPostgresVersion } from '../../../src/tenancy/checks.js';
import { forEachTenant, STOP_PASS } from '../../../src/tenancy/jobs.js';
import { scopeOf, type TenantScope } from '../../../src/tenancy/scope.js';
import { SET_TENANT, tenantDbFactory } from '../../../src/tenancy/tenant-db.js';
import { announce } from '../../../src/context.js';
import { TenantDirectory } from '../../../src/tenancy/directory.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { testContext } from '../../helpers/context.js';
import { statementLog } from '../../helpers/tenancy.js';

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

  it("runs a function's afterUnit once its unit committed, outside any unit, before the next tenant (Task 17)", async () => {
    const { db, sent } = recordingDatabase();
    const tenantDb = tenantDbFactory(db);
    const error = vi.fn();
    const pass = await forEachTenant(
      { directory: { list: () => Promise.resolve([A, B]) }, db: tenantDb, log: { error } },
      'audit-forwarder',
      async (tx, scope) => {
        await tx.query(`claim ${scope.slug}`);
        return {
          afterUnit: async () => {
            sent.push(`send ${scope.slug}`);
            // Outside the unit: a unit of the same tenant opened here is a unit of its own, not a join.
            await tenantDb(scope).query(`delete ${scope.slug}`);
            if (scope === A) throw new Error('A failed after its unit');
            return STOP_PASS;
          },
        };
      },
    );
    expect(sent.filter((line) => !line.startsWith('select set_config'))).toEqual([
      'BEGIN',
      'claim a',
      'COMMIT',
      'send a',
      'BEGIN',
      'delete a',
      'COMMIT',
      'BEGIN',
      'claim b',
      'COMMIT',
      'send b',
      'BEGIN',
      'delete b',
      'COMMIT',
    ]);
    // A's throw counts as A's failure; B's STOP_PASS ends the pass after it.
    expect(pass).toEqual({ served: 1, failed: [A.tenantId] });
    expect(error.mock.calls[0]![0]).toMatchObject({ job: 'audit-forwarder', tenantId: A.tenantId });
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

describe('the context a module registers with (spec §19.8 guard 2)', () => {
  it('has no raw database, only the tenancy', async () => {
    const ctx = await testContext();
    expect('db' in ctx).toBe(false);
  });

  it("hands a module no tenant directory, so no scope but the request's or the job loop's (Task 6 review m2)", async () => {
    const ctx = await testContext();
    expect(Object.keys(ctx.tenancy).sort()).toEqual(['db', 'forEachTenant', 'reachable']);
    expect('directory' in ctx.tenancy).toBe(false);
    // The start-up, the resolver and the admin command line reach it through `directoryOf` alone.
    expect(directoryOf(ctx.tenancy)).toBeInstanceOf(TenantDirectory);
    expect(() => directoryOf({ ...ctx.tenancy })).toThrow(expect.objectContaining({ code: 'tenancy-not-loaded' }));
  });
});

describe('units of two factories (Task 8 review M2)', () => {
  it("a unit of one factory opened inside another's never hides the outer one", async () => {
    const { db } = recordingDatabase();
    const logA = statementLog();
    const logB = statementLog();
    const first = tenantDbFactory(db, { onStatement: logA.onStatement });
    const second = tenantDbFactory(db, { onStatement: logB.onStatement });
    await first(A).transaction(async (outer) => {
      await outer.query('select 1');
      await second(B).transaction(async (inner) => {
        await inner.query('select 2');
        // Through the first factory again: it joins the first factory's unit rather than opening another.
        await first(A).query('select 3');
      });
    });
    const statementsOf = (log: typeof logA) =>
      log.entries.filter((entry) => entry.kind === 'statement').map((entry) => [entry.unit, entry.text]);
    expect(statementsOf(logA)).toEqual([
      [1, 'select 1'],
      [1, 'select 3'],
    ]);
    expect(statementsOf(logB)).toEqual([[1, 'select 2']]);
    expect(logA.entries.filter((entry) => entry.kind === 'set-config')).toHaveLength(1);
  });
});

describe('announcements run outside the tenant unit (Task 6 re-review R4)', () => {
  /** A database whose `select 1` takes a while, as a real one's does: the unit ends before it answers. */
  const slowDatabase = (): Database => {
    const querier: Querier = {
      query: (text: string) =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ rows: [], rowCount: 0 }), text === 'select 1' ? 20 : 0);
        }),
    };
    return { ...querier, transaction: (fn) => fn(querier), close: () => Promise.resolve() };
  };
  /** A listener that queries in `A` and does not wait: what a hub or audit listener does. */
  const querying = (tenancy: ReturnType<typeof tenantDbFactory>) => (): void => {
    void tenancy(A).query('select 1');
  };

  it('a listener reaching the tenant database inside a unit runs in a unit of its own', async () => {
    const db = slowDatabase();
    const log = statementLog();
    const tenancy = tenantDbFactory(db, { onStatement: log.onStatement });
    const warn = vi.fn();
    await tenancy(A).transaction(async (tx) => {
      await tx.query('select 0');
      announce([querying(tenancy)], {}, { warn } as unknown as FastifyBaseLogger);
    });
    await vi.waitFor(() => {
      expect(log.entries.filter((entry) => entry.text === 'select 1')).toHaveLength(1);
    });
    const units = new Set(log.entries.filter((entry) => entry.kind === 'statement').map((entry) => entry.unit));
    expect(units.size).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  // Calls the listener straight from the unit, not through `announce`: this is what `announce` would do without
  // `outsideTenantUnit`, so the case above failing without the wrap and this one failing as it stands are the
  // same failure. (Checked by hand: unwrapping `announce` makes the case above fail.)
  it('without that, the same listener joins the unit and rolls it back (the control)', async () => {
    const db = slowDatabase();
    const tenancy = tenantDbFactory(db);
    await expect(
      tenancy(A).transaction(async (tx) => {
        await tx.query('select 0');
        querying(tenancy)();
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'tenancy-unawaited' }));
  });
});
