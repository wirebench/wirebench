import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/db/querier.js';
import { createDatabase } from '../../../src/db/pool.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { createTenancy, directoryOf, type Tenancy } from '../../../src/tenancy/tenancy.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { expectAllScoped, loggedTenancy } from '../../helpers/tenancy.js';

const SETTING = "select current_setting('wirebench.tenant_id', true) as tenant, pg_backend_pid() as pid";

/** Plan Task 5: the tenant database over a real pool, as the app role (spec §19.4). */
describeDb('the tenant database and directory (hosted spec §19.4, §19.8)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  // One connection, so the next unit gets back the very client the last one used, or a fresh one.
  let one: Database;
  let tenancy: Tenancy;
  beforeAll(async () => {
    db = await testDatabase();
    one = createDatabase(db.url, { max: 1 });
    tenancy = createTenancy(one);
    await directoryOf(tenancy).load();
  });
  afterAll(async () => {
    await one.close();
    await db.close();
  });

  it('a read-only snapshot unit is repeatable read and read only, with its tenant set, and never joins a unit', async () => {
    const scope = directoryOf(tenancy).defaultScope();
    const inside = await tenancy.db(scope).transaction(
      async (tx) =>
        (
          await tx.query<{ tenant: string; isolation: string; readOnly: string }>(
            `select current_setting('wirebench.tenant_id', true) as tenant,
                    current_setting('transaction_isolation') as isolation,
                    current_setting('transaction_read_only') as "readOnly"`,
          )
        ).rows[0]!,
      { readOnlySnapshot: true },
    );
    expect(inside).toEqual({ tenant: scope.tenantId, isolation: 'repeatable read', readOnly: 'on' });
    await expect(
      tenancy.db(scope).transaction((tx) => tx.query("insert into teams (id, name) values ('T-ro', 'Read only')"), {
        readOnlySnapshot: true,
      }),
    ).rejects.toMatchObject({ code: '25006' });
    await expect(
      tenancy
        .db(scope)
        .transaction(() => tenancy.db(scope).transaction(() => Promise.resolve(1), { readOnlySnapshot: true })),
    ).rejects.toMatchObject({ code: 'tenancy-snapshot-joined' });
  });

  it('sets the tenant inside a unit, and the pooled connection comes back without it', async () => {
    const scope = directoryOf(tenancy).defaultScope();
    const inside = await tenancy
      .db(scope)
      .transaction(async (tx) => (await tx.query<{ tenant: string; pid: number }>(SETTING)).rows[0]!);
    expect(inside.tenant).toBe(scope.tenantId);
    const after = (await one.query<{ tenant: string | null; pid: number }>(SETTING)).rows[0]!;
    expect(after.pid).toBe(inside.pid);
    expect(after.tenant ?? '').toBe('');
  });

  it('rolls a throwing unit back', async () => {
    const scope = directoryOf(tenancy).defaultScope();
    await expect(
      tenancy.db(scope).transaction(async (tx) => {
        await tx.query("insert into teams (id, name) values ('T-rolled-back', 'Rolled back')");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await one.query("select 1 from teams where id = 'T-rolled-back'")).rowCount).toBe(0);
  });

  // `pg-pool` drops a client whose socket closed whatever `release` is given, so this shows the next unit gets a
  // live connection, not that `release(err)` is called: `test/unit/db/pool.test.ts` pins that over a stub.
  it('runs the next unit on a fresh connection after one died mid-unit', async () => {
    const scope = directoryOf(tenancy).defaultScope();
    let pid = 0;
    await expect(
      tenancy.db(scope).transaction(async (tx) => {
        pid = (await tx.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
        // The connection goes away under the unit, so its rollback cannot be sent.
        await tx.query('select pg_terminate_backend(pg_backend_pid())').catch(() => undefined);
        throw new Error('boom');
      }),
    ).rejects.toThrow();
    // With one connection in the pool, a reused dead client would fail here.
    const next = await tenancy
      .db(scope)
      .transaction(async (tx) => (await tx.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid);
    expect(next).not.toBe(pid);
  });

  it('throws tenancy-scope-ended for a querier used after its unit, and runs nothing', async () => {
    const scope = directoryOf(tenancy).defaultScope();
    let late: Promise<unknown> | undefined;
    await tenancy.db(scope).transaction(async (tx) => {
      await tx.query('select 1');
      // Not awaited: it is only sent after the unit has ended.
      late = Promise.resolve()
        .then(() => new Promise((done) => setTimeout(done, 20)))
        .then(() => tx.query("insert into teams (id, name) values ('T-late', 'Late')"));
    });
    await expect(late).rejects.toMatchObject({ code: 'tenancy-scope-ended' });
    expect((await one.query("select 1 from teams where id = 'T-late'")).rowCount).toBe(0);
  });

  it('logs every statement after the set_config of its unit', async () => {
    const { tenancy: logged, log } = loggedTenancy(one);
    await directoryOf(logged).load();
    const scope = directoryOf(logged).defaultScope();
    await logged.db(scope).query('select 1');
    await logged.db(scope).transaction(async (tx) => {
      await tx.query('select 2');
    });
    expectAllScoped(log, scope.tenantId);
    expect(log.entries.filter((e) => e.kind === 'statement').map((e) => e.text)).toEqual(['select 1', 'select 2']);
  });

  it("lists the tenants, creates one off ctx.tenancy, tells the directory's listeners, and serves each in forEachTenant", async () => {
    const listener = vi.fn();
    const off = directoryOf(tenancy).onChange(listener);
    const acme = await new TenantAdmin(one, directoryOf(tenancy)).create({ slug: 'acme', name: 'Acme' });
    off();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(acme).toMatchObject({ slug: 'acme', name: 'Acme', edition: 'community', status: 'active', region: 'eu' });
    expect((await directoryOf(tenancy).get(acme.id))?.scope).toEqual(acme.scope);
    expect(await directoryOf(tenancy).get('00000000-0000-4000-8000-000000000000')).toBeUndefined();
    const listed = await directoryOf(tenancy).list();
    expect(listed.map((s) => s.slug)).toEqual(['default', 'acme']);

    await one.query("update tenants set status = 'deleting' where slug = 'acme'").catch(() => undefined);
    const error = vi.fn();
    const seen: string[] = [];
    await one.query("update tenants set status = 'active' where slug = 'acme'");
    await one.query(
      "insert into tenants (id, slug, name, status) values (gen_random_uuid(), 'gone', 'Gone', 'deleting')",
    );
    const pass = await tenancy.forEachTenant(
      'probe',
      async (tx, scope) => {
        const tenant = (await tx.query<{ tenant: string }>(SETTING)).rows[0]!.tenant;
        seen.push(`${scope.slug}:${tenant === scope.tenantId ? 'set' : 'unset'}`);
        if (scope.slug === 'default') throw new Error('one tenant fails');
      },
      { error },
    );
    expect(seen).toEqual(['default:set', 'acme:set']);
    expect(pass).toEqual({ served: 1, failed: [directoryOf(tenancy).defaultScope().tenantId] });
    expect(error.mock.calls[0]![0]).toMatchObject({
      job: 'probe',
      tenantId: directoryOf(tenancy).defaultScope().tenantId,
    });
  });
});
