import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/context.js';
import { createDatabase } from '../../../src/db/pool.js';
import { createTenancy, type Tenancy } from '../../../src/tenancy/tenancy.js';
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
    await tenancy.directory.load();
  });
  afterAll(async () => {
    await one.close();
    await db.close();
  });

  it('sets the tenant inside a unit, and the pooled connection comes back without it', async () => {
    const scope = tenancy.directory.defaultScope();
    const inside = await tenancy
      .db(scope)
      .transaction(async (tx) => (await tx.query<{ tenant: string; pid: number }>(SETTING)).rows[0]!);
    expect(inside.tenant).toBe(scope.tenantId);
    const after = (await one.query<{ tenant: string | null; pid: number }>(SETTING)).rows[0]!;
    expect(after.pid).toBe(inside.pid);
    expect(after.tenant ?? '').toBe('');
  });

  it('rolls a throwing unit back', async () => {
    const scope = tenancy.directory.defaultScope();
    await expect(
      tenancy.db(scope).transaction(async (tx) => {
        await tx.query("insert into teams (id, name) values ('T-rolled-back', 'Rolled back')");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await one.query("select 1 from teams where id = 'T-rolled-back'")).rowCount).toBe(0);
  });

  it('destroys a client whose rollback failed, and runs the next unit on a fresh one', async () => {
    const scope = tenancy.directory.defaultScope();
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
    const scope = tenancy.directory.defaultScope();
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
    await logged.directory.load();
    const scope = logged.directory.defaultScope();
    await logged.db(scope).query('select 1');
    await logged.db(scope).transaction(async (tx) => {
      await tx.query('select 2');
    });
    expectAllScoped(log, scope.tenantId);
    expect(log.entries.filter((e) => e.kind === 'statement').map((e) => e.text)).toEqual(['select 1', 'select 2']);
  });

  it('lists the tenants, creates one, tells its listeners, and serves each in forEachTenant', async () => {
    const listener = vi.fn();
    const off = tenancy.directory.onChange(listener);
    const acme = await tenancy.directory.create({ slug: 'acme', name: 'Acme' });
    off();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(acme).toMatchObject({ slug: 'acme', name: 'Acme', edition: 'community', status: 'active', region: 'eu' });
    expect((await tenancy.directory.get(acme.id))?.scope).toEqual(acme.scope);
    expect(await tenancy.directory.get('00000000-0000-4000-8000-000000000000')).toBeUndefined();
    const listed = await tenancy.directory.list();
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
    expect(pass).toEqual({ served: 1, failed: [tenancy.directory.defaultScope().tenantId] });
    expect(error.mock.calls[0]![0]).toMatchObject({
      job: 'probe',
      tenantId: tenancy.directory.defaultScope().tenantId,
    });
  });
});
