/**
 * Slice 8 Task 2 (hosted edition spec §23.3): migration `0024`. `custom_domains` is a tenant table and passes guard 3
 * as every scoped table does (§19.8); `tenant_hosts` is unscoped, the custom-name counterpart of `tenants.slug`, and
 * joins the allowlist with the app role's four privileges. Each refusal has its positive control.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../src/db/querier.js';
import { createDatabase } from '../../../src/db/pool.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { allMigrations } from '../../../src/serve.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { tenantDbFactory, type TenantDb } from '../../../src/tenancy/tenant-db.js';
import { createTenancy, directoryOf } from '../../../src/tenancy/tenancy.js';
import {
  columnsOf,
  keysOf,
  policiesOf,
  POLICY_EXPRESSION,
  rowSecurityOf,
  SETTING_EXPRESSION,
  UNSCOPED_TABLES,
} from '../../helpers/catalog.js';
import { APP_ROLE, describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { defaultTenantDb } from '../../helpers/tenancy.js';

const CLAIM = "insert into custom_domains (name, token) values ('app.customer.test', 'token-a')";
const STATES = ['pending', 'verified', 'active', 'failing', 'lapsed', 'paused', 'expired'];
const ROLLED_BACK = 'rolled back on purpose';

describeDb('migration 0024: custom domains and tenant hosts (hosted spec §23.3)', () => {
  let db: TestDatabase;
  let tdb: TenantDb;
  let tenantId: string;
  let app: Database;
  let owner: Database;

  const outcome = (run: Promise<unknown>): Promise<string> =>
    run.then(
      () => 'ok',
      (error: unknown) => {
        const code = (error as { code?: unknown }).code;
        return typeof code === 'string' ? code : (error as Error).message;
      },
    );
  /** Runs `fn` with `tenant` set ('' for none) and rolls it back. */
  const rolledBack = async <T>(role: Database, tenant: string, fn: (tx: Pick<Database, 'query'>) => Promise<T>) => {
    let result: T | undefined;
    await expect(
      role.transaction(async (tx) => {
        await tx.query("select set_config('wirebench.tenant_id', $1, true)", [tenant]);
        result = await fn(tx);
        throw new Error(ROLLED_BACK);
      }),
    ).rejects.toThrow(ROLLED_BACK);
    return result as T;
  };
  const count = async (tx: Pick<Database, 'query'>, table: string) =>
    Number((await tx.query<{ n: string }>(`select count(*)::text as n from ${table}`)).rows[0]!.n);
  const newTenant = async (slug: string) => {
    const created = await new TenantAdmin(db, directoryOf(createTenancy(db))).create({ slug, name: slug });
    return { id: created.scope.tenantId, tdb: tenantDbFactory(db)(created.scope) };
  };

  beforeAll(async () => {
    db = await testDatabase();
    tdb = await defaultTenantDb(db);
    tenantId = tdb.scope.tenantId;
    await tdb.query(CLAIM);
    // Past the test helper's own refusal of statements outside a unit: what is under test here is the policy.
    app = createDatabase(db.url);
    owner = createDatabase(db.ownerUrl);
  });
  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await db?.close();
  });

  it("is migration 24, from its own folder, between the control plane's 0023 and 0025", async () => {
    const migrations = await allMigrations(BUILTIN_MODULES);
    expect(migrations.slice(-5).map((m) => `${m.version}_${m.name}`)).toEqual([
      '23_control-plane',
      '24_custom-domains',
      '25_signup-ref',
      '26_user-profile',
      '27_two-factor',
    ]);
    const ledger = await db.owner.query<{ v: number }>('select max(version)::int as v from schema_migrations');
    expect(ledger.rows[0]!.v).toBe(27);
  });

  describe('custom_domains, a tenant table (guard 3, spec §19.8)', () => {
    it('has the columns of §23.3, tenant_id first with the setting default', async () => {
      const columns = (await columnsOf(db.owner)).filter((column) => column.table === 'custom_domains');
      expect(columns[0]).toEqual({
        table: 'custom_domains',
        column: 'tenant_id',
        type: 'uuid',
        notNull: true,
        default: SETTING_EXPRESSION,
      });
      expect(columns.map((c) => [c.column, c.type, c.notNull])).toEqual([
        ['tenant_id', 'uuid', true],
        ['name', 'text', true],
        ['token', 'text', true],
        ['state', 'text', true],
        ['created_by', 'text', false],
        ['created_at', 'timestamp with time zone', true],
        ['checked_at', 'timestamp with time zone', false],
        ['verified_at', 'timestamp with time zone', false],
        ['active_at', 'timestamp with time zone', false],
        ['failing_since', 'timestamp with time zone', false],
        ['last_result', 'jsonb', false],
      ]);
      expect(columns.find((c) => c.column === 'state')?.default).toBe("'pending'::text");
    });

    it('forces row-level security under exactly one tenant_isolation policy', async () => {
      expect((await rowSecurityOf(db.owner)).find((row) => row.table === 'custom_domains')).toEqual({
        table: 'custom_domains',
        enabled: true,
        forced: true,
      });
      expect((await policiesOf(db.owner)).filter((policy) => policy.table === 'custom_domains')).toEqual([
        {
          table: 'custom_domains',
          name: 'tenant_isolation',
          permissive: true,
          command: '*',
          roles: '{0}',
          using: POLICY_EXPRESSION,
          check: POLICY_EXPRESSION,
        },
      ]);
    });

    it('has the primary key (tenant_id), so one claim per tenant, and references tenants only', async () => {
      const own = (await keysOf(db.owner)).filter((key) => key.table === 'custom_domains');
      expect(own.filter((key) => key.kind === 'p').map((key) => [key.name, key.columns])).toEqual([
        ['custom_domains_pkey', ['tenant_id']],
      ]);
      expect(own.filter((key) => key.kind === 'u' || key.kind === 'i')).toEqual([]);
      expect(own.filter((key) => key.kind === 'f').map((key) => [key.columns, key.references])).toEqual([
        [['tenant_id'], { table: 'tenants', columns: ['id'] }],
      ]);
      expect(
        await outcome(tdb.query("insert into custom_domains (name, token) values ('site.customer.test', 't')")),
      ).toBe('23505');
    });

    it('takes each state of §23.2 and refuses any other', async () => {
      for (const state of STATES) {
        expect(
          await rolledBack(app, tenantId, (tx) => outcome(tx.query('update custom_domains set state = $1', [state]))),
          state,
        ).toBe('ok');
      }
      expect(
        await rolledBack(app, tenantId, (tx) => outcome(tx.query("update custom_domains set state = 'held'"))),
      ).toBe('23514');
    });

    for (const [who, index] of [
      ['the app role', 0],
      ['the owner', 1],
    ] as const) {
      it(`reads as empty and refuses writes outside a tenant unit, as ${who}`, async () => {
        const role = [app, owner][index]!;
        expect(await count(role, 'custom_domains')).toBe(0);
        expect(await rolledBack(role, '', (tx) => count(tx, 'custom_domains'))).toBe(0);
        expect(await rolledBack(role, tenantId, (tx) => count(tx, 'custom_domains'))).toBe(1);
        expect(['23502', '42501']).toContain(
          await rolledBack(role, '', (tx) =>
            outcome(tx.query("insert into custom_domains (name, token) values ('x.customer.test', 't')")),
          ),
        );
        expect(
          await rolledBack(role, '', (tx) =>
            outcome(
              tx.query("insert into custom_domains (tenant_id, name, token) values ($1, 'x.customer.test', 't')", [
                tenantId,
              ]),
            ),
          ),
        ).toBe('42501');
        const [updated, deleted] = await rolledBack(role, '', async (tx) => [
          (await tx.query("update custom_domains set state = 'verified'")).rowCount,
          (await tx.query('delete from custom_domains')).rowCount,
        ]);
        expect({ updated, deleted }).toEqual({ updated: 0, deleted: 0 });
      });
    }

    it("keeps two tenants' claims apart, the same name included", async () => {
      const other = await newTenant('cd-0024-b');
      try {
        await other.tdb.query(CLAIM.replace('token-a', 'token-b'));
        const tokens = async (t: TenantDb) =>
          (await t.query<{ token: string }>('select token from custom_domains')).rows.map((row) => row.token);
        expect(await tokens(other.tdb)).toEqual(['token-b']);
        expect(await tokens(tdb)).toEqual(['token-a']);
        // B's unit reaches none of A's rows by naming A either.
        expect(
          (await other.tdb.query('update custom_domains set state = $1 where tenant_id = $2', ['active', tenantId]))
            .rowCount,
        ).toBe(0);
      } finally {
        await other.tdb.query('delete from custom_domains');
        await db.owner.query('delete from tenants where id = $1', [other.id]);
      }
    });
  });

  describe('tenant_hosts, unscoped (spec §23.3)', () => {
    it('is on the allowlist, with the columns of §23.3 and no policy', async () => {
      expect(UNSCOPED_TABLES).toContain('tenant_hosts');
      const columns = (await columnsOf(db.owner)).filter((column) => column.table === 'tenant_hosts');
      expect(columns).toEqual([
        { table: 'tenant_hosts', column: 'host', type: 'text', notNull: true, default: null },
        { table: 'tenant_hosts', column: 'tenant_id', type: 'uuid', notNull: true, default: null },
        { table: 'tenant_hosts', column: 'live', type: 'boolean', notNull: true, default: 'false' },
        { table: 'tenant_hosts', column: 'since', type: 'timestamp with time zone', notNull: true, default: 'now()' },
      ]);
      const own = (await keysOf(db.owner)).filter((key) => key.table === 'tenant_hosts');
      expect(own.filter((key) => key.kind === 'p').map((key) => key.columns)).toEqual([['host']]);
      expect(own.filter((key) => key.kind === 'f').map((key) => [key.columns, key.references])).toEqual([
        [['tenant_id'], { table: 'tenants', columns: ['id'] }],
      ]);
      expect((await rowSecurityOf(db.owner)).find((row) => row.table === 'tenant_hosts')).toEqual({
        table: 'tenant_hosts',
        enabled: false,
        forced: false,
      });
      expect((await policiesOf(db.owner)).filter((policy) => policy.table === 'tenant_hosts')).toEqual([]);
    });

    it('lets the app role select, insert, update and delete it, and nothing more', async () => {
      const privileges = await db.owner.query<{ p: string }>(
        `select privilege_type as p from information_schema.role_table_grants
        where table_schema = current_schema() and table_name = 'tenant_hosts' and grantee = $1 order by 1`,
        [APP_ROLE],
      );
      expect(privileges.rows.map((row) => row.p)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      await app.query("insert into tenant_hosts (host, tenant_id) values ('app.customer.test', $1)", [tenantId]);
      expect((await app.query("update tenant_hosts set live = true where host = 'app.customer.test'")).rowCount).toBe(
        1,
      );
      expect((await app.query("delete from tenant_hosts where host = 'app.customer.test'")).rowCount).toBe(1);
      expect(await outcome(app.query('truncate tenant_hosts'))).toBe('42501');
    });

    it('holds a name once: a second tenant cannot insert the same host', async () => {
      const other = await newTenant('cd-0024-c');
      try {
        await app.query("insert into tenant_hosts (host, tenant_id) values ('site.customer.test', $1)", [tenantId]);
        expect(
          await outcome(
            app.query("insert into tenant_hosts (host, tenant_id) values ('site.customer.test', $1)", [other.id]),
          ),
        ).toBe('23505');
      } finally {
        await app.query("delete from tenant_hosts where host = 'site.customer.test'");
        await db.owner.query('delete from tenants where id = $1', [other.id]);
      }
    });

    it('refuses a host that is not a lower-case domain name, and takes one that is', async () => {
      for (const host of [
        'App.customer.test',
        'customer',
        'app.customer.test.',
        '*.customer.test',
        'https://app.customer.test',
        'app.customer.test:443',
        '10.0.0.1',
        '-app.customer.test',
        'app..customer.test',
        `${'a'.repeat(64)}.customer.test`,
        `${'abcdefghi.'.repeat(25)}customer.test`,
        '',
      ]) {
        expect(
          await outcome(app.query('insert into tenant_hosts (host, tenant_id) values ($1, $2)', [host, tenantId])),
          host,
        ).toBe('23514');
      }
      expect(
        await outcome(
          app.query("insert into tenant_hosts (host, tenant_id) values ('wirebench.app-1.customer.test', $1)", [
            tenantId,
          ]),
        ),
      ).toBe('ok');
      await app.query("delete from tenant_hosts where host = 'wirebench.app-1.customer.test'");
    });

    it('goes with its tenant: deleting the tenant deletes its hosts', async () => {
      const other = await newTenant('cd-0024-d');
      await app.query("insert into tenant_hosts (host, tenant_id) values ('gone.customer.test', $1)", [other.id]);
      await db.owner.query('delete from tenants where id = $1', [other.id]);
      expect(
        (await app.query("select count(*)::int as n from tenant_hosts where host = 'gone.customer.test'")).rows,
      ).toEqual([{ n: 0 }]);
    });
  });
});
