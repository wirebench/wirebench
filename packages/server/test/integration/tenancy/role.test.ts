import { afterAll, beforeAll, expect, it } from 'vitest';
import { defaultTenantDb } from '../../helpers/tenancy.js';
import { describeDb, testDatabase } from '../../helpers/database.js';

// A type alias, not an interface: `query<T>` wants `T` to have an index signature.
type RoleRow = {
  readonly name: string;
  readonly superuser: boolean;
  readonly bypassrls: boolean;
  readonly inherit: boolean;
  /** Roles this one is a member of: any of them could be `set role` to. */
  readonly memberships: number;
  /** Relations, schemas and functions it owns anywhere in the database. */
  readonly tables: number;
  readonly schemas: number;
  readonly functions: number;
};

/** The connected role's attributes, memberships and ownership. */
const ROLE_SQL = `select current_user::text as name, r.rolsuper as superuser, r.rolbypassrls as bypassrls,
    r.rolinherit as inherit,
    (select count(*)::int from pg_auth_members m where m.member = r.oid) as memberships,
    (select count(*)::int from pg_class c where c.relowner = r.oid) as tables,
    (select count(*)::int from pg_namespace n where n.nspowner = r.oid) as schemas,
    (select count(*)::int from pg_proc p where p.proowner = r.oid) as functions
  from pg_roles r where r.rolname = current_user`;

/**
 * Every table the migrations create, and what the app role holds on it (spec §19.4). A new table fails
 * the last test until it is classified here: read-only, or the four DML privileges. `server_identity` also
 * grants `update (tenancy_step)`, a column privilege, checked on its own below.
 */
const READ = ['SELECT'];
const DML = ['DELETE', 'INSERT', 'SELECT', 'UPDATE'];
const EXPECTED_GRANTS: Readonly<Record<string, readonly string[]>> = {
  agent_nonces: DML,
  agent_pairing_codes: DML,
  agent_pairings: DML,
  audit_chain_anchor: DML,
  audit_events: DML,
  audit_forward_queue: DML,
  browser_flows: DML,
  captures: DML,
  catch_urls: DML,
  ci_tokens: DML,
  device_tokens: DML,
  host_leases: DML,
  invitations: DML,
  license: DML,
  local_credentials: DML,
  oidc_flows: DML,
  oidc_identities: DML,
  provisioned_memberships: DML,
  saml_flows: DML,
  saml_identities: DML,
  schedule_alert_outbox: DML,
  schedule_results: DML,
  schedule_runs: DML,
  schedules: DML,
  schema_migrations: READ,
  scim_group_members: DML,
  scim_groups: DML,
  scim_tokens: DML,
  scim_users: DML,
  server_identity: READ,
  session_log_chunks: DML,
  session_logs: DML,
  team_invitations: DML,
  team_members: DML,
  teams: DML,
  tenants: DML,
  users: DML,
  workspace_grants: DML,
  workspaces: DML,
};

/** Writes on the read-only tables, each of which the app role must be refused (`42501`). */
const READ_ONLY_WRITES = [
  "insert into schema_migrations (version, name) values (999, 'app')",
  'update schema_migrations set name = name',
  'delete from schema_migrations',
  'truncate schema_migrations',
  'insert into server_identity (server_id) values (gen_random_uuid())',
  'update server_identity set created_at = created_at',
  'update server_identity set server_id = server_id',
  'update server_identity set default_tenant_id = default_tenant_id',
  'update server_identity set tenancy_step = tenancy_step, created_at = created_at',
  'delete from server_identity',
];

// Spec §19.13: the suites query as a role that row-level security applies to. If CI or the helper ever
// connects as a superuser, a BYPASSRLS role or an owner, every isolation test would pass vacuously; this
// file fails instead.
describeDb('the test database roles (§19.4)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => {
    db = await testDatabase();
  });
  afterAll(() => db.close());

  it('runs queries as an app role that bypasses nothing, inherits nothing, joins no role and owns nothing', async () => {
    const app = (await db.query<RoleRow>(ROLE_SQL)).rows[0]!;
    expect(app).toEqual({
      name: 'wirebench_app',
      superuser: false,
      bypassrls: false,
      inherit: false,
      memberships: 0,
      tables: 0,
      schemas: 0,
      functions: 0,
    });
  });

  it('migrates as an owner that is no superuser and does not bypass RLS, and owns the schema', async () => {
    const owner = (await db.owner.query<RoleRow>(ROLE_SQL)).rows[0]!;
    expect(owner).toMatchObject({ name: 'wirebench_owner', superuser: false, bypassrls: false });
    expect(owner.tables).toBeGreaterThan(0);
    const schema = await db.query<{ owner: string }>(
      'select nspowner::regrole::text as owner from pg_namespace where nspname = $1',
      [db.schema],
    );
    expect(schema.rows[0]!.owner).toBe('wirebench_owner');
  });

  it('lets the app role read and write an ordinary table in a tenant unit, but make no DDL', async () => {
    const tdb = await defaultTenantDb(db);
    await tdb.query(
      "insert into users (id, email, email_lower, display_name) values ('U1', 'A@example.com', 'a@example.com', 'A')",
    );
    await tdb.query("update users set display_name = 'Ada' where id = 'U1'");
    expect((await tdb.query('select display_name from users')).rows).toEqual([{ display_name: 'Ada' }]);
    await tdb.query("delete from users where id = 'U1'");
    expect((await tdb.query('select id from users')).rowCount).toBe(0);
    await expect(db.query('create table app_made (id int)')).rejects.toMatchObject({ code: '42501' });
    await expect(tdb.query('alter table workspaces add column x int')).rejects.toMatchObject({ code: '42501' });
  });

  it('leaves the app role a reader of schema_migrations and server_identity, but for tenancy_step', async () => {
    expect((await db.query('select server_id from server_identity')).rowCount).toBe(1);
    expect((await db.query('select version from schema_migrations')).rowCount).toBeGreaterThan(0);
    for (const sql of READ_ONLY_WRITES) {
      await expect(db.query(sql), sql).rejects.toMatchObject({ code: '42501' });
    }
    // The file step's one write (spec §19.10).
    expect((await db.query('update server_identity set tenancy_step = tenancy_step')).rowCount).toBe(1);
  });

  it('grants every table exactly what EXPECTED_GRANTS says, so a new table needs a decision', async () => {
    const rows = await db.owner.query<{ table: string; privileges: string[] }>(
      `select c.relname as table,
          coalesce(array_agg(g.privilege_type::text order by g.privilege_type::text)
            filter (where g.privilege_type is not null), '{}') as privileges
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        left join information_schema.role_table_grants g
          on g.table_schema = n.nspname and g.table_name = c.relname and g.grantee = 'wirebench_app'
        where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f')
        group by c.relname order by c.relname`,
      [db.schema],
    );
    expect(Object.fromEntries(rows.rows.map((row) => [row.table, row.privileges]))).toEqual(EXPECTED_GRANTS);
    const columns = await db.owner.query<{ table: string; column: string; privilege: string }>(
      `select table_name as table, column_name as column, privilege_type as privilege
        from information_schema.column_privileges
        where table_schema = $1 and grantee = 'wirebench_app' and privilege_type <> 'SELECT'
          and table_name = any($2)`,
      [db.schema, ['schema_migrations', 'server_identity']],
    );
    expect(columns.rows).toEqual([{ table: 'server_identity', column: 'tenancy_step', privilege: 'UPDATE' }]);
  });
});
