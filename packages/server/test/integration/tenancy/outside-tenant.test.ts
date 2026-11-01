/**
 * Plan Task 17: outside a tenant unit every scoped table is empty and refuses writes (spec §19.4, "unset means
 * deny"), as the app role and as the owner, since `0021` forces the policy on the owner too. The fixture fills
 * every table first, and each check has its positive control: the same statement inside the default tenant sees
 * the rows, so an empty answer means the policy, not an empty table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../src/db/querier.js';
import { migrate } from '../../../src/db/migrate.js';
import { createDatabase } from '../../../src/db/pool.js';
import { newId } from '../../../src/identity/tokens.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { allMigrations } from '../../../src/serve.js';
import { loadFixture0019 } from '../../fixtures/tenancy/load.js';
import { SCOPED_TABLES } from '../../helpers/catalog.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { defaultTenantDb } from '../../helpers/tenancy.js';

const ROLLED_BACK = 'rolled back on purpose';

describeDb('scoped tables outside a tenant unit (hosted spec §19.4, plan Task 17)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let dataDir: string;
  let tenantId: string;
  /** The app role with nothing in front of it: the test helper's own refusal of such statements is not the policy. */
  let app: Database;
  /** The owner likewise, past the helper's refusal of its reads once the tables are forced. */
  let owner: Database;
  const roles = (): readonly (readonly [string, Database])[] => [
    ['the app role', app],
    ['the owner', owner],
  ];

  /** Runs `fn` in a transaction with `tenant` set ('' for none), then rolls it back, so nothing a check wrote stays. */
  const rolledBack = async <T>(
    role: Database,
    tenant: string,
    fn: (tx: Pick<Database, 'query'>) => Promise<T>,
  ): Promise<T> => {
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
  /** Postgres' error code, or `ok` when the statement ran. */
  const outcome = (run: Promise<unknown>): Promise<string> =>
    run.then(
      () => 'ok',
      (error: unknown) => {
        const code = (error as { code?: unknown }).code;
        return typeof code === 'string' ? code : (error as Error).message;
      },
    );

  beforeAll(async () => {
    db = await testDatabase({ migrated: false });
    dataDir = await mkTempDir('wbs-outside-tenant-');
    await loadFixture0019(db.owner, dataDir);
    await migrate(db.owner, await allMigrations(BUILTIN_MODULES));
    await db.grant();
    app = createDatabase(db.url);
    owner = createDatabase(db.ownerUrl);
    const tdb = await defaultTenantDb(db);
    tenantId = tdb.scope.tenantId;
    // The one table the fixture cannot fill: 0020 made it.
    const [admin] = (await tdb.query<{ id: string }>('select id from users order by id limit 1')).rows;
    await tdb.query(
      `insert into host_leases (user_id, holder, acquired_at, renewed_at, expires_at)
       values ($1, $2, now(), now(), now() + interval '1 minute')`,
      [admin!.id, newId()],
    );
  });
  afterAll(async () => {
    await app.close();
    await owner.close();
    await db.close();
    await removeTempDir(dataDir);
  });

  for (const [who, index] of [
    ['the app role', 0],
    ['the owner', 1],
  ] as const) {
    describe(who, () => {
      const role = () => roles()[index]![1];

      it('reads every scoped table as empty outside a unit, and its rows inside the default tenant', async () => {
        for (const table of SCOPED_TABLES) {
          expect(await count(role(), table), `${table} with no setting`).toBe(0);
          expect(await rolledBack(role(), '', (tx) => count(tx, table)), `${table} with an empty setting`).toBe(0);
          expect(
            await rolledBack(role(), tenantId, (tx) => count(tx, table)),
            `${table} in the tenant`,
          ).toBeGreaterThan(0);
        }
      });

      it('updates and deletes nothing outside a unit', async () => {
        for (const table of SCOPED_TABLES) {
          const [updated, deleted] = await rolledBack(role(), '', async (tx) => [
            (await tx.query(`update ${table} set tenant_id = tenant_id`)).rowCount,
            (await tx.query(`delete from ${table}`)).rowCount,
          ]);
          expect({ table, updated, deleted }).toEqual({ table, updated: 0, deleted: 0 });
          // The positive control, rolled back like the rest: the same update in the tenant reaches its rows.
          const inTenant = await rolledBack(
            role(),
            tenantId,
            async (tx) => (await tx.query(`update ${table} set tenant_id = tenant_id`)).rowCount,
          );
          expect(inTenant, table).toBeGreaterThan(0);
        }
      });

      it('refuses an insert outside a unit, whether it names the tenant or leaves it to the default', async () => {
        for (const table of SCOPED_TABLES) {
          const [explicit, defaulted] = await rolledBack(role(), tenantId, async (tx) => {
            // A copy of one of the tenant's rows, taken while the tenant is set; then the setting goes.
            await tx.query(`create temporary table copied on commit drop as select * from ${table} limit 1`);
            await tx.query("select set_config('wirebench.tenant_id', '', true)");
            await tx.query('savepoint named');
            // Naming the default tenant explicitly: `with check` refuses it.
            const named = await outcome(tx.query(`insert into ${table} select * from copied`));
            await tx.query('rollback to savepoint named');
            // Leaving `tenant_id` to its default: the default is null now, not the default tenant.
            await tx.query('alter table copied drop column tenant_id');
            const columns = (
              await tx.query<{ name: string }>(
                `select string_agg(quote_ident(attname), ', ' order by attnum) as name from pg_attribute
                  where attrelid = 'copied'::regclass and attnum > 0 and not attisdropped`,
              )
            ).rows[0]!.name;
            const left = await outcome(tx.query(`insert into ${table} (${columns}) select ${columns} from copied`));
            return [named, left];
          });
          expect(explicit, `${table}, naming the tenant`).toBe('42501');
          // A null tenant fails `not null` before the policy is asked; either way the row never lands.
          expect(['23502', '42501'], `${table}, by default: ${defaulted}`).toContain(defaulted);
        }
      });
    });
  }
});
