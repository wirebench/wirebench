import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeDb, testDatabase } from '../../helpers/database.js';

// A type alias, not an interface: `query<T>` wants `T` to have an index signature.
type RoleRow = {
  readonly name: string;
  readonly superuser: boolean;
  readonly bypassrls: boolean;
  readonly owned: number;
};

/** The connected role's attributes, and how many relations it owns anywhere in the database. */
const ROLE_SQL = `select current_user as name, r.rolsuper as superuser, r.rolbypassrls as bypassrls,
    (select count(*)::int from pg_class c where c.relowner = r.oid) as owned
  from pg_roles r where r.rolname = current_user`;

// Spec §19.13: the suites query as a role that row-level security applies to. If CI or the helper ever
// connects as a superuser, a BYPASSRLS role or a table owner, every isolation test would pass vacuously;
// this file fails instead.
describeDb('the test database roles (§19.4)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => {
    db = await testDatabase();
  });
  afterAll(() => db.close());

  it('runs queries as an app role that is no superuser, does not bypass RLS and owns no table', async () => {
    const app = (await db.query<RoleRow>(ROLE_SQL)).rows[0]!;
    expect(app).toEqual({ name: 'wirebench_app', superuser: false, bypassrls: false, owned: 0 });
    const member = await db.query<{ member: boolean }>(
      "select pg_has_role(current_user, 'wirebench_owner', 'member') as member",
    );
    expect(member.rows[0]!.member).toBe(false);
  });

  it('migrates as an owner that is no superuser and does not bypass RLS, and owns the schema', async () => {
    const owner = (await db.owner.query<RoleRow>(ROLE_SQL)).rows[0]!;
    expect(owner).toMatchObject({ name: 'wirebench_owner', superuser: false, bypassrls: false });
    expect(owner.owned).toBeGreaterThan(0);
    const schema = await db.query<{ owner: string }>(
      'select nspowner::regrole::text as owner from pg_namespace where nspname = $1',
      [db.schema],
    );
    expect(schema.rows[0]!.owner).toBe('wirebench_owner');
  });

  it('gives the app role the migrated tables, but no DDL and only a read of the migration ledger', async () => {
    expect((await db.query('select count(*) from workspaces')).rowCount).toBe(1);
    await expect(db.query('create table app_made (id int)')).rejects.toMatchObject({ code: '42501' });
    await expect(db.query("insert into schema_migrations (version, name) values (999, 'app')")).rejects.toMatchObject({
      code: '42501',
    });
    expect((await db.query('select version from schema_migrations')).rowCount).toBeGreaterThan(0);
  });
});
