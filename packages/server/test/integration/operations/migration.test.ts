/**
 * Slice 5 Task 1 (hosted edition spec §20.2, §20.6, §20.7): migration `0022`. Its three scoped tables pass guard 3
 * as every slice 4 table does (§19.8), and its unscoped `server_instances` joins the allowlist with the app role's
 * four privileges. Outside a tenant unit the scoped three read as empty and refuse writes, as the app role and as
 * the owner, each check with its positive control in a tenant.
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
  tablesOf,
  UNSCOPED_TABLES,
} from '../../helpers/catalog.js';
import { APP_ROLE, describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { defaultTenantDb } from '../../helpers/tenancy.js';

/** 0022's scoped tables, with the primary key each must have. */
const SCOPED_0022: Readonly<Record<string, readonly string[]>> = {
  limiter_buckets: ['tenant_id', 'key'],
  send_slots: ['tenant_id', 'slot'],
  terminal_share_locations: ['tenant_id', 'share_id'],
};
const TABLES = Object.keys(SCOPED_0022);

/** One row of each, without `tenant_id`: the default fills it from the setting. */
const ROW: Readonly<Record<string, string>> = {
  limiter_buckets: "insert into limiter_buckets (key, tokens, updated_at) values ('sign-in:x', 5, now())",
  send_slots: 'insert into send_slots (slot, holder, expires_at) values (3, gen_random_uuid(), now())',
  terminal_share_locations:
    "insert into terminal_share_locations (share_id, holder, created_at) values ('share-x', gen_random_uuid(), now())",
};

/** A second row of each, with another key: the positive control's insert. */
const OTHER_ROW: Readonly<Record<string, string>> = {
  limiter_buckets: "insert into limiter_buckets (key, tokens, updated_at) values ('sign-in:y', 5, now())",
  send_slots: 'insert into send_slots (slot, holder, expires_at) values (4, gen_random_uuid(), now())',
  terminal_share_locations:
    "insert into terminal_share_locations (share_id, holder, created_at) values ('share-y', gen_random_uuid(), now())",
};

const ROLLED_BACK = 'rolled back on purpose';

describeDb(
  'migration 0022: instances, buckets, send slots and share locations (hosted spec §20.2, §20.6, §20.7)',
  () => {
    let db: TestDatabase;
    let tdb: TenantDb;
    let tenantId: string;
    let app: Database;
    let owner: Database;

    /** Runs `fn` with `tenant` set ('' for none) and rolls it back; the result is Postgres' error code or `ok`. */
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
    const outcome = (run: Promise<unknown>): Promise<string> =>
      run.then(
        () => 'ok',
        (error: unknown) => {
          const code = (error as { code?: unknown }).code;
          return typeof code === 'string' ? code : (error as Error).message;
        },
      );
    const count = async (tx: Pick<Database, 'query'>, table: string) =>
      Number((await tx.query<{ n: string }>(`select count(*)::text as n from ${table}`)).rows[0]!.n);

    beforeAll(async () => {
      db = await testDatabase();
      tdb = await defaultTenantDb(db);
      tenantId = tdb.scope.tenantId;
      for (const table of TABLES) await tdb.query(ROW[table]!);
      // Past the test helper's own refusal of statements outside a unit: what is under test here is the policy.
      app = createDatabase(db.url);
      owner = createDatabase(db.ownerUrl);
    });
    afterAll(async () => {
      await app?.close();
      await owner?.close();
      await db?.close();
    });

    it('is the last migration, from its own folder, after the tenancy ones', async () => {
      const migrations = await allMigrations(BUILTIN_MODULES);
      expect(migrations.at(-1)).toMatchObject({ version: 22, name: 'operations' });
      const ledger = await db.owner.query<{ v: number }>('select max(version)::int as v from schema_migrations');
      expect(ledger.rows[0]!.v).toBe(22);
    });

    it('creates server_instances as spec §20.2 has it, unscoped and on the allowlist', async () => {
      expect(UNSCOPED_TABLES).toContain('server_instances');
      const columns = (await columnsOf(db.owner)).filter((column) => column.table === 'server_instances');
      expect(columns).toEqual([
        { table: 'server_instances', column: 'holder', type: 'uuid', notNull: true, default: null },
        { table: 'server_instances', column: 'url', type: 'text', notNull: false, default: null },
        { table: 'server_instances', column: 'version', type: 'text', notNull: true, default: null },
        {
          table: 'server_instances',
          column: 'started_at',
          type: 'timestamp with time zone',
          notNull: true,
          default: 'now()',
        },
        {
          table: 'server_instances',
          column: 'renewed_at',
          type: 'timestamp with time zone',
          notNull: true,
          default: 'now()',
        },
      ]);
      const pkey = (await keysOf(db.owner)).find((key) => key.table === 'server_instances' && key.kind === 'p');
      expect(pkey?.columns).toEqual(['holder']);
      const security = (await rowSecurityOf(db.owner)).find((row) => row.table === 'server_instances');
      expect(security).toEqual({ table: 'server_instances', enabled: false, forced: false });
      expect((await policiesOf(db.owner)).filter((policy) => policy.table === 'server_instances')).toEqual([]);
    });

    it('lets the app role select, insert, update and delete server_instances, outside any tenant', async () => {
      const privileges = await db.owner.query<{ p: string }>(
        `select privilege_type as p from information_schema.role_table_grants
        where table_schema = current_schema() and table_name = 'server_instances' and grantee = $1 order by 1`,
        [APP_ROLE],
      );
      expect(privileges.rows.map((row) => row.p)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      await app.query("insert into server_instances (holder, url, version) values (gen_random_uuid(), null, '6.2.0')");
      expect((await app.query("update server_instances set renewed_at = now() where version = '6.2.0'")).rowCount).toBe(
        1,
      );
      expect((await app.query('select count(*)::int as n from server_instances')).rows).toEqual([{ n: 1 }]);
      expect((await app.query("delete from server_instances where version = '6.2.0'")).rowCount).toBe(1);
    });

    it('makes the buckets and the send slots unlogged, and the share locations logged', async () => {
      const persistence = await db.owner.query<{ table: string; p: string }>(
        `select relname as table, relpersistence as p from pg_class
        where relnamespace = to_regnamespace(current_schema()) and relname = any($1::text[]) order by 1`,
        [TABLES],
      );
      expect(persistence.rows).toEqual([
        { table: 'limiter_buckets', p: 'u' },
        { table: 'send_slots', p: 'u' },
        { table: 'terminal_share_locations', p: 'p' },
      ]);
    });

    describe('guard 3 on the three scoped tables (spec §19.8)', () => {
      it('gives each tenant_id uuid not null with the setting default, first in its columns', async () => {
        const columns = await columnsOf(db.owner);
        for (const table of TABLES) {
          const own = columns.filter((column) => column.table === table);
          expect(own[0], table).toEqual({
            table,
            column: 'tenant_id',
            type: 'uuid',
            notNull: true,
            default: SETTING_EXPRESSION,
          });
        }
        expect(columns.filter((c) => c.table === 'limiter_buckets').map((c) => [c.column, c.type, c.notNull])).toEqual([
          ['tenant_id', 'uuid', true],
          ['key', 'text', true],
          ['tokens', 'double precision', true],
          ['updated_at', 'timestamp with time zone', true],
        ]);
        expect(columns.filter((c) => c.table === 'send_slots').map((c) => [c.column, c.type, c.notNull])).toEqual([
          ['tenant_id', 'uuid', true],
          ['slot', 'smallint', true],
          ['holder', 'uuid', true],
          ['expires_at', 'timestamp with time zone', true],
        ]);
        expect(
          columns.filter((c) => c.table === 'terminal_share_locations').map((c) => [c.column, c.type, c.notNull]),
        ).toEqual([
          ['tenant_id', 'uuid', true],
          ['share_id', 'text', true],
          ['holder', 'uuid', true],
          ['created_at', 'timestamp with time zone', true],
        ]);
      });

      it('enables and forces row-level security under exactly one tenant_isolation policy', async () => {
        const security = await rowSecurityOf(db.owner);
        const policies = await policiesOf(db.owner);
        for (const table of TABLES) {
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

      it('leads each primary key with tenant_id, and references tenants only', async () => {
        const keys = await keysOf(db.owner);
        for (const [table, columns] of Object.entries(SCOPED_0022)) {
          const own = keys.filter((key) => key.table === table);
          expect(own.filter((key) => key.kind === 'p').map((key) => [key.name, key.columns])).toEqual([
            [`${table}_pkey`, columns],
          ]);
          expect(own.filter((key) => key.kind === 'u' || key.kind === 'i')).toEqual([]);
          const foreign = own.filter((key) => key.kind === 'f');
          expect(foreign.map((key) => [key.columns, key.references])).toEqual([
            [['tenant_id'], { table: 'tenants', columns: ['id'] }],
          ]);
        }
      });

      it('leaves no table off both lists: every table is scoped or on the allowlist', async () => {
        const security = await rowSecurityOf(db.owner);
        const forced = security.filter((row) => row.enabled && row.forced).map((row) => row.table);
        const rest = (await tablesOf(db.owner)).filter((table) => !forced.includes(table));
        expect(rest.sort()).toEqual([...UNSCOPED_TABLES].sort());
      });
    });

    for (const [who, index] of [
      ['the app role', 0],
      ['the owner', 1],
    ] as const) {
      describe(`outside a tenant unit, as ${who}`, () => {
        const role = () => [app, owner][index]!;

        it('reads each of the three as empty, and its row inside the tenant', async () => {
          for (const table of TABLES) {
            expect(await count(role(), table), `${table} with no setting`).toBe(0);
            expect(await rolledBack(role(), '', (tx) => count(tx, table)), `${table} with an empty setting`).toBe(0);
            expect(await rolledBack(role(), tenantId, (tx) => count(tx, table)), `${table} in the tenant`).toBe(1);
          }
        });

        it('refuses an insert, defaulted or naming the tenant, and updates and deletes nothing', async () => {
          for (const table of TABLES) {
            // The column default is null outside a unit: `not null` or the policy refuses it.
            expect(['23502', '42501'], table).toContain(
              await rolledBack(role(), '', (tx) => outcome(tx.query(ROW[table]!))),
            );
            // Naming the tenant: `with check` refuses it.
            const named = ROW[table]!.replace(`into ${table} (`, `into ${table} (tenant_id, `).replace(
              'values (',
              `values ('${tenantId}', `,
            );
            expect(await rolledBack(role(), '', (tx) => outcome(tx.query(named))), table).toBe('42501');
            const [updated, deleted] = await rolledBack(role(), '', async (tx) => [
              (await tx.query(`update ${table} set tenant_id = tenant_id`)).rowCount,
              (await tx.query(`delete from ${table}`)).rowCount,
            ]);
            expect({ table, updated, deleted }).toEqual({ table, updated: 0, deleted: 0 });
            // The positive control: in the tenant, the same insert goes in.
            expect(await rolledBack(role(), tenantId, (tx) => outcome(tx.query(OTHER_ROW[table]!))), table).toBe('ok');
          }
        });
      });
    }

    it("keeps two tenants' rows with the same key apart", async () => {
      const other = await new TenantAdmin(db, directoryOf(createTenancy(db))).create({ slug: 'ops-0022', name: 'Ops' });
      const otherDb = tenantDbFactory(db)(other.scope);
      try {
        // The same primary key past tenant_id as the default tenant's rows: no conflict.
        for (const table of TABLES) await otherDb.query(ROW[table]!);
        for (const table of TABLES) {
          expect(await count(otherDb, table), table).toBe(1);
          expect(await count(tdb, table), table).toBe(1);
        }
      } finally {
        for (const table of TABLES) await otherDb.query(`delete from ${table}`);
        await db.owner.query('delete from tenants where id = $1', [other.scope.tenantId]);
      }
    });
  },
);
