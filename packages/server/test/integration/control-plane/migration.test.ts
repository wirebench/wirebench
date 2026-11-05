/**
 * Slice 7 Task 2 (hosted edition spec §22.2, §22.3): migration `0023`. The tenants' new columns; the four unscoped
 * control tables on guard 3's allowlist, which the control role reads and writes and the app role cannot touch; and
 * the three scoped tables, which pass guard 3 as every slice 4 table does (§19.8), keep two tenants apart, and are
 * read across tenants by the control role only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTROL_PLANE_MIGRATIONS_DIR } from '../../../src/control-plane/module.js';
import { createDatabase } from '../../../src/db/pool.js';
import type { Database } from '../../../src/db/querier.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { allMigrations } from '../../../src/serve.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { ensureControlRole } from '../../../src/tenancy/roles.js';
import { tenantDbFactory, type TenantDb } from '../../../src/tenancy/tenant-db.js';
import { createTenancy, directoryOf } from '../../../src/tenancy/tenancy.js';
import {
  columnsOf,
  keysOf,
  otherConstraintsOf,
  policiesOf,
  POLICY_EXPRESSION,
  rowSecurityOf,
  SCOPED_TABLES,
  SETTING_EXPRESSION,
  UNSCOPED_TABLES,
} from '../../helpers/catalog.js';
import { APP_ROLE, CONTROL_ROLE, describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { defaultTenantDb } from '../../helpers/tenancy.js';

/** 0023's unscoped tables, with the primary key each must have. */
const UNSCOPED_0023: Readonly<Record<string, readonly string[]>> = {
  tenant_slugs_retired: ['slug'],
  signups: ['id'],
  billing_events: ['provider', 'event_id'],
  tenant_deletions: ['tenant_id'],
};

/** 0023's scoped tables, with the primary key each must have. */
const SCOPED_0023: Readonly<Record<string, readonly string[]>> = {
  subscriptions: ['tenant_id'],
  tenant_exports: ['tenant_id', 'id'],
  tenant_settings: ['tenant_id', 'section'],
};
const SCOPED = Object.keys(SCOPED_0023);

/** One row of each scoped table, without `tenant_id`: the default fills it from the setting. */
const ROW: Readonly<Record<string, (marker: string) => string>> = {
  subscriptions: (marker) =>
    `insert into subscriptions (provider, provider_ref, plan, seats, status, last_event_at)
      values ('paddle', 'sub_${marker}', 'team', 5, 'active', now())`,
  tenant_exports: (marker) =>
    `insert into tenant_exports (id, requested_by, status) values ('export-${marker}', 'operator', 'ready')`,
  tenant_settings: (marker) =>
    `insert into tenant_settings (section, value, updated_by) values ('mail', '{"from": "${marker}"}', 'operator')`,
};

const count = async (db: Pick<Database, 'query'>, table: string) =>
  Number((await db.query<{ n: string }>(`select count(*)::text as n from ${table}`)).rows[0]!.n);

describeDb('migration 0023: the control plane (hosted spec §22.2, §22.3)', () => {
  let db: TestDatabase;
  let tdb: TenantDb;
  let other: TenantDb;
  let otherId: string;
  let control: Database;
  let rawApp: Database;

  beforeAll(async () => {
    db = await testDatabase();
    tdb = await defaultTenantDb(db);
    const created = await new TenantAdmin(db, directoryOf(createTenancy(db))).create({ slug: 'cp-0023', name: 'B' });
    otherId = created.scope.tenantId;
    other = tenantDbFactory(db)(created.scope);
    for (const table of SCOPED) {
      await tdb.query(ROW[table]!('default'));
      await other.query(ROW[table]!('other'));
    }
    await ensureControlRole(db.owner, db.controlUrl, db.url);
    control = createDatabase(db.controlUrl);
    // Past the test helper's own refusal of statements outside a unit: what is under test here is the grants.
    rawApp = createDatabase(db.url);
  });
  afterAll(async () => {
    await control?.close();
    await rawApp?.close();
    await db?.close();
  });

  it('is migration 23, from the control-plane module, after the operations one', async () => {
    const migrations = await allMigrations(BUILTIN_MODULES);
    expect(migrations.find((m) => m.version === 23)).toMatchObject({ name: 'control-plane' });
    expect(migrations.find((m) => m.version === 22)).toMatchObject({ name: 'operations' });
    expect(BUILTIN_MODULES.find((module) => module.name === 'control-plane')?.migrationsDir).toBe(
      CONTROL_PLANE_MIGRATIONS_DIR,
    );
    // Slice 8's 0024 and this module's 0025 follow it; this file pins 0023 by number, not as the last.
    const ledger = await db.owner.query<{ v: string }>('select name as v from schema_migrations where version = 23');
    expect(ledger.rows[0]!.v).toBe('control-plane');
  });

  it("is followed by 0025, the control plane's too, adding what a signup's completion bound it to, all nullable", async () => {
    const migrations = await allMigrations(BUILTIN_MODULES);
    expect(migrations.at(-1)).toMatchObject({ version: 25, name: 'signup-ref' });
    const columns = (await columnsOf(db.owner)).filter((column) => column.table === 'signups').slice(-8);
    expect(columns.map(({ column, type, notNull }) => [column, type, notNull])).toEqual([
      ['provider', 'text', false],
      ['provider_ref', 'text', false],
      ['customer_ref', 'text', false],
      ['subscription_status', 'text', false],
      ['current_period_end', 'timestamp with time zone', false],
      ['paid_seats', 'integer', false],
      ['event_occurred_at', 'timestamp with time zone', false],
      ['bound_at', 'timestamp with time zone', false],
    ]);
    expect((await rowSecurityOf(db.owner)).find((row) => row.table === 'signups')).toEqual({
      table: 'signups',
      enabled: false,
      forced: false,
    });
  });

  it("adds the tenants' billing and lifecycle columns, defaulting an existing tenant to a license", async () => {
    const columns = (await columnsOf(db.owner)).filter((column) => column.table === 'tenants').slice(-5);
    expect(columns).toEqual([
      { table: 'tenants', column: 'edition_source', type: 'text', notNull: true, default: "'license'::text" },
      { table: 'tenants', column: 'suspended_reason', type: 'text', notNull: false, default: null },
      {
        table: 'tenants',
        column: 'suspended_at',
        type: 'timestamp with time zone',
        notNull: false,
        default: null,
      },
      {
        table: 'tenants',
        column: 'deletion_requested_at',
        type: 'timestamp with time zone',
        notNull: false,
        default: null,
      },
      { table: 'tenants', column: 'deletion_requested_by', type: 'text', notNull: false, default: null },
    ]);
    const row = await tdb.query(
      `select edition_source, suspended_reason, suspended_at, deletion_requested_at, deletion_requested_by
        from tenants where id = $1`,
      [tdb.scope.tenantId],
    );
    expect(row.rows).toEqual([
      {
        edition_source: 'license',
        suspended_reason: null,
        suspended_at: null,
        deletion_requested_at: null,
        deletion_requested_by: null,
      },
    ]);
    const checks = (await otherConstraintsOf(db.owner)).filter((c) => c.table === 'tenants').map((c) => c.definition);
    expect(checks.join('\n')).toContain("'subscription'::text");
    expect(checks.join('\n')).toContain("'importing'::text");
    await expect(
      control.query("update tenants set edition_source = 'gift' where id = $1", [otherId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      control.query("update tenants set suspended_reason = 'bored' where id = $1", [otherId]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  describe('the four unscoped control tables', () => {
    it('are on the allowlist, with no row-level security, no tenant_id foreign key and their keys', async () => {
      const security = await rowSecurityOf(db.owner);
      const keys = await keysOf(db.owner);
      for (const [table, pkey] of Object.entries(UNSCOPED_0023)) {
        expect(UNSCOPED_TABLES).toContain(table);
        expect(security.find((row) => row.table === table)).toEqual({ table, enabled: false, forced: false });
        expect(keys.filter((key) => key.table === table && key.kind === 'p').map((key) => key.columns)).toEqual([pkey]);
        expect(keys.filter((key) => key.table === table && key.kind === 'f')).toEqual([]);
      }
      expect((await policiesOf(db.owner)).filter((policy) => policy.table in UNSCOPED_0023)).toEqual([]);
      expect(keys.filter((key) => key.table === 'signups' && key.kind !== 'p').map((key) => key.columns)).toEqual(
        expect.arrayContaining([['token_hash'], ['slug']]),
      );
    });

    it('give the app role nothing, so it cannot read or write signups or billing_events', async () => {
      const privileges = await db.owner.query<{ table: string }>(
        `select table_name as table from information_schema.role_table_grants
          where table_schema = current_schema() and grantee = $1 and table_name = any($2::text[])`,
        [APP_ROLE, Object.keys(UNSCOPED_0023)],
      );
      expect(privileges.rows).toEqual([]);
      for (const table of Object.keys(UNSCOPED_0023)) {
        // `select *`: the app role reads three columns of tenant_slugs_retired for the resolver (Task 7), never all.
        await expect(rawApp.query(`select * from ${table}`), table).rejects.toMatchObject({ code: '42501' });
      }
      await expect(
        rawApp.query(
          "insert into billing_events (provider, event_id, event_type, occurred_at, outcome) values ('p', 'e', 't', now(), 'ok')",
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('give the control role select, insert, update and delete on each', async () => {
      const privileges = await db.owner.query<{ table: string; p: string }>(
        `select table_name as table, privilege_type as p from information_schema.role_table_grants
          where table_schema = current_schema() and grantee = $1 and table_name = any($2::text[]) order by 1, 2`,
        [CONTROL_ROLE, Object.keys(UNSCOPED_0023)],
      );
      for (const table of Object.keys(UNSCOPED_0023)) {
        expect(
          privileges.rows.filter((row) => row.table === table).map((row) => row.p),
          table,
        ).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      }
      await control.query(
        "insert into billing_events (provider, event_id, event_type, occurred_at, outcome) values ('paddle', 'evt_1', 'subscription.created', now(), 'applied')",
      );
      expect(await count(control, 'billing_events')).toBe(1);
      expect((await control.query("delete from billing_events where event_id = 'evt_1'")).rowCount).toBe(1);
    });

    it('hold one open signup per slug: a completed one frees it', async () => {
      const signup = (id: string, status: string) =>
        control.query(
          `insert into signups (id, email_lower, name, slug, seats, token_hash, status, expires_at)
            values ($1, 'a@example.com', 'A', 'taken', 3, $2, $3, now() + interval '1 day')`,
          [id, `hash-${id}`, status],
        );
      try {
        await signup('00000000-0000-4000-8000-000000000001', 'completed');
        await signup('00000000-0000-4000-8000-000000000002', 'pending');
        await expect(signup('00000000-0000-4000-8000-000000000003', 'verified')).rejects.toMatchObject({
          code: '23505',
        });
        await expect(signup('00000000-0000-4000-8000-000000000004', 'expired')).rejects.toMatchObject({
          code: '23514',
        });
      } finally {
        await control.query('delete from signups');
      }
    });
  });

  describe('guard 3 on the three scoped tables (spec §19.8)', () => {
    it('are on the scoped list, each tenant_id uuid not null with the setting default, first in its columns', async () => {
      const columns = await columnsOf(db.owner);
      for (const table of SCOPED) {
        expect(SCOPED_TABLES).toContain(table);
        expect(columns.filter((column) => column.table === table)[0], table).toEqual({
          table,
          column: 'tenant_id',
          type: 'uuid',
          notNull: true,
          default: SETTING_EXPRESSION,
        });
      }
    });

    it('enables and forces row-level security under exactly one tenant_isolation policy', async () => {
      const security = await rowSecurityOf(db.owner);
      const policies = await policiesOf(db.owner);
      for (const table of SCOPED) {
        expect(security.find((row) => row.table === table)).toEqual({ table, enabled: true, forced: true });
        expect(policies.filter((policy) => policy.table === table)).toEqual([
          {
            table,
            name: 'tenant_isolation',
            permissive: true,
            command: '*',
            roles: '{0}',
            using: POLICY_EXPRESSION,
            check: POLICY_EXPRESSION,
          },
        ]);
      }
    });

    it('leads every primary key and unique index with tenant_id, and references tenants only', async () => {
      const keys = await keysOf(db.owner);
      for (const [table, columns] of Object.entries(SCOPED_0023)) {
        const own = keys.filter((key) => key.table === table);
        expect(own.filter((key) => key.kind === 'p').map((key) => [key.name, key.columns])).toEqual([
          [`${table}_pkey`, columns],
        ]);
        for (const key of own.filter((k) => k.kind !== 'f')) expect(key.columns[0], key.name).toBe('tenant_id');
        expect(own.filter((key) => key.kind === 'f').map((key) => [key.columns, key.references])).toEqual([
          [['tenant_id'], { table: 'tenants', columns: ['id'] }],
        ]);
      }
      expect(
        keys.filter((key) => key.table === 'subscriptions' && key.kind === 'i').map((key) => [key.name, key.columns]),
      ).toEqual([['subscriptions_ref', ['tenant_id', 'provider', 'provider_ref']]]);
    });
  });

  it("keeps two tenants' rows apart in each scoped table, with the same keys", async () => {
    for (const table of SCOPED) {
      expect(await count(tdb, table), table).toBe(1);
      expect(await count(other, table), table).toBe(1);
      expect((await tdb.query(`select tenant_id from ${table}`)).rows, table).toEqual([
        { tenant_id: tdb.scope.tenantId },
      ]);
      expect((await other.query(`select tenant_id from ${table}`)).rows, table).toEqual([{ tenant_id: otherId }]);
      // Outside any unit the app role sees none of them.
      expect(await count(rawApp, table), table).toBe(0);
    }
    // Each tenant's single subscription row: the default tenant's update reaches only its own.
    expect((await tdb.query("update subscriptions set status = 'past_due'")).rowCount).toBe(1);
    expect((await other.query('select status from subscriptions')).rows).toEqual([{ status: 'active' }]);
    await tdb.query("update subscriptions set status = 'active'");
  });

  it("lets the control role read every tenant's subscriptions, and write none of them", async () => {
    const refs = await control.query<{ ref: string }>('select provider_ref as ref from subscriptions order by 1');
    expect(refs.rows).toEqual([{ ref: 'sub_default' }, { ref: 'sub_other' }]);
    for (const table of SCOPED) expect(await count(control, table), table).toBe(2);
    expect((await tdb.query('select provider_ref as ref from subscriptions')).rows).toEqual([{ ref: 'sub_default' }]);
    await expect(control.query("update subscriptions set status = 'canceled'")).rejects.toMatchObject({
      code: '42501',
    });
  });
});
