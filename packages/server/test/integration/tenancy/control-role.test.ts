/**
 * The control role (hosted edition spec §22.2, ADR-0039): `wirebench_control`, the one role past row-level security,
 * created and granted by `admin tenancy role` in hosted mode and checked at start-up. The roles script creates the
 * suite's `wirebench_control`, since only a superuser may give a role BYPASSRLS; the throwaway roles here are made by
 * the superuser and dropped after each test.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { loadConfig, type ServerConfig } from '../../../src/config.js';
import { createDatabase } from '../../../src/db/pool.js';
import type { Database } from '../../../src/db/querier.js';
import { checkAppRole, checkControlRole } from '../../../src/tenancy/checks.js';
import { runTenancyRoleWith } from '../../../src/tenancy/cli.js';
import { ensureControlRole } from '../../../src/tenancy/roles.js';
import { SCOPED_TABLES } from '../../helpers/catalog.js';
import {
  APP_ROLE,
  CONTROL_ROLE,
  describeDb,
  OWNER_ROLE,
  TEST_DATABASE_URL,
  testDatabase,
} from '../../helpers/database.js';
import { defaultTenantDb } from '../../helpers/tenancy.js';

/** `base` with another user, password and this schema on the search path. */
function urlAs(base: string, role: string, password: string, schema: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = password;
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: { write: (t: string) => out.push(t) }, stderr: { write: (t: string) => err.push(t) }, env: {} },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
};

const NAMES = { app: APP_ROLE, owner: OWNER_ROLE };
const DML = ['DELETE', 'INSERT', 'SELECT', 'UPDATE'];

describeDb('the control role (hosted spec §22.2)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  /** The superuser: the one role here that may create a BYPASSRLS role, and the one that drops the throwaways. */
  let admin: Database;
  const pools: Database[] = [];
  const made: string[] = [];
  const freshRole = (): string => {
    const role = `wb_test_ctl_${randomBytes(4).toString('hex')}`;
    made.push(role);
    return role;
  };
  const roleExists = async (role: string) =>
    ((await admin.query('select 1 from pg_roles where rolname = $1', [role])).rowCount ?? 0) > 0;
  const poolAs = (role: string, password: string): Database => {
    const pool = createDatabase(urlAs(TEST_DATABASE_URL!, role, password, db.schema));
    pools.push(pool);
    return pool;
  };
  /** A hosted configuration over this schema, built directly: `loadConfig` still refuses hosted mode (§22.1). */
  const hosted = (controlUrl: string): ServerConfig => ({
    ...loadConfig(
      {
        WIREBENCH_SERVER_DATABASE_URL: db.url,
        WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
        WIREBENCH_SERVER_PUBLIC_URL: 'https://app.test',
      },
      '0.0.0',
    ),
    mode: 'hosted',
    controlDatabaseUrl: controlUrl,
  });

  // A run that crashed before its afterEach leaves throwaway roles behind; only this file makes `wb_test_ctl_` ones.
  beforeAll(async () => {
    const sweeper = createDatabase(TEST_DATABASE_URL!);
    try {
      const stale = await sweeper.query<{ role: string }>(
        "select rolname as role from pg_roles where rolname like 'wb\\_test\\_ctl\\_%'",
      );
      for (const { role } of stale.rows) {
        await sweeper.query(`drop owned by "${role}"`).catch(() => undefined);
        await sweeper.query(`drop role "${role}"`).catch(() => undefined);
      }
    } finally {
      await sweeper.close();
    }
  });

  beforeEach(async () => {
    db = await testDatabase();
    const url = new URL(TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${db.schema}`);
    admin = createDatabase(url.toString());
  });
  afterEach(async () => {
    for (const pool of pools.splice(0)) await pool.close();
    for (const role of made.splice(0)) {
      if (await roleExists(role)) {
        await admin.query(`drop owned by "${role}"`);
        await admin.query(`drop role "${role}"`);
      }
    }
    await admin.close();
    await db.close();
  });

  it('grants the control role the tenants row and a read of every scoped table, and nothing else', async () => {
    expect(await ensureControlRole(db.owner, db.controlUrl, db.url)).toMatchObject({
      role: CONTROL_ROLE,
      exists: true,
      schema: db.schema,
    });
    const attributes = await admin.query(
      'select rolsuper, rolbypassrls, rolinherit, rolcanlogin from pg_roles where rolname = $1',
      [CONTROL_ROLE],
    );
    expect(attributes.rows).toEqual([{ rolsuper: false, rolbypassrls: true, rolinherit: false, rolcanlogin: true }]);
    const rows = await admin.query<{ table: string; privileges: string[] }>(
      `select c.relname as table,
          coalesce(array_agg(g.privilege_type::text order by g.privilege_type::text)
            filter (where g.privilege_type is not null), '{}') as privileges
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        left join information_schema.role_table_grants g
          on g.table_schema = n.nspname and g.table_name = c.relname and g.grantee = $2
        where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f')
        group by c.relname order by c.relname`,
      [db.schema, CONTROL_ROLE],
    );
    const granted = Object.fromEntries(rows.rows.map((row) => [row.table, row.privileges]));
    const expected = Object.fromEntries(
      Object.keys(granted).map((table) => [
        table,
        table === 'tenants' ? DML : SCOPED_TABLES.includes(table) ? ['SELECT'] : [],
      ]),
    );
    expect(granted).toEqual(expected);
    expect(Object.keys(granted)).toEqual(expect.arrayContaining([...SCOPED_TABLES, 'tenants']));
    // A second run changes nothing and refuses nothing.
    expect(await ensureControlRole(db.owner, db.controlUrl, db.url)).toMatchObject({ exists: true });
  });

  it('passes the start-up check, and reads every tenant past the policy while the app role still cannot', async () => {
    await ensureControlRole(db.owner, db.controlUrl, db.url);
    const control = createDatabase(db.controlUrl);
    pools.push(control);
    expect(await checkControlRole(control, NAMES)).toMatchObject({ role: CONTROL_ROLE, bypassRls: true });
    const tdb = await defaultTenantDb(db);
    await tdb.query(
      "insert into users (id, email, email_lower, display_name) values ('U1', 'A@example.com', 'a@example.com', 'A')",
    );
    // The app role outside a unit: the raw pool, past the helper's refusal, so the policy itself is what answers.
    const rawApp = createDatabase(db.url);
    pools.push(rawApp);
    expect((await rawApp.query('select id from users')).rowCount).toBe(0);
    expect((await control.query('select id from users')).rows).toEqual([{ id: 'U1' }]);
    expect((await control.query('select count(*)::int as n from tenants')).rows[0]).toEqual({ n: 1 });
    // No write on a scoped table: every per-tenant write runs in that tenant's unit on the app role.
    await expect(control.query("update users set display_name = 'B'")).rejects.toMatchObject({ code: '42501' });
    await expect(control.query('delete from schema_migrations')).rejects.toMatchObject({ code: '42501' });
    // And the app role is still one the policy applies to.
    expect(await checkAppRole(db, 'hosted', () => undefined)).toMatchObject({
      role: APP_ROLE,
      superuser: false,
      bypassRls: false,
      ownedTables: 0,
    });
  });

  it('refuses a superuser control role', async () => {
    await expect(checkControlRole(admin, NAMES)).rejects.toMatchObject({ code: 'control-plane-role-superuser' });
  });

  it('refuses a control role that is the app role or the owner', async () => {
    await expect(checkControlRole(db, NAMES)).rejects.toMatchObject({ code: 'control-plane-role-shared' });
    await expect(checkControlRole(db.owner, NAMES)).rejects.toMatchObject({ code: 'control-plane-role-shared' });
  });

  it('refuses a control role that owns a table, itself or as a member of the owner', async () => {
    const role = freshRole();
    await admin.query(`create role "${role}" login bypassrls noinherit password 'ctl-pw'`);
    await admin.query(`grant ${OWNER_ROLE} to "${role}"`);
    await expect(checkControlRole(poolAs(role, 'ctl-pw'), NAMES)).rejects.toMatchObject({
      code: 'control-plane-role-owns',
    });
  });

  it('refuses a control role without BYPASSRLS', async () => {
    const role = freshRole();
    await admin.query(`create role "${role}" login nobypassrls noinherit password 'ctl-pw'`);
    await expect(checkControlRole(poolAs(role, 'ctl-pw'), NAMES)).rejects.toMatchObject({
      code: 'control-plane-role-no-bypass',
    });
  });

  it('tells an owner that may not create a BYPASSRLS role to use --print-sql, and creates nothing', async () => {
    const role = freshRole();
    await expect(
      ensureControlRole(db.owner, urlAs(TEST_DATABASE_URL!, role, 'x', db.schema), db.url),
    ).rejects.toMatchObject({
      code: 'tenancy-control-role-create-refused',
      message: expect.stringContaining('admin tenancy role --print-sql') as unknown,
    });
    expect(await roleExists(role)).toBe(false);
  });

  it('refuses a control URL that names the app role or the owner', async () => {
    await expect(ensureControlRole(db.owner, db.url, db.url)).rejects.toMatchObject({
      code: 'control-plane-role-shared',
    });
    await expect(ensureControlRole(db.owner, db.ownerUrl, db.url)).rejects.toMatchObject({
      code: 'control-plane-role-shared',
    });
  });

  it('creates a missing control role as a superuser, with a SCRAM verifier, signing in with the URL’s password', async () => {
    const role = freshRole();
    const password = randomBytes(12).toString('hex');
    expect(await ensureControlRole(admin, urlAs(TEST_DATABASE_URL!, role, password, db.schema), db.url)).toMatchObject({
      role,
      exists: false,
    });
    const stored = await admin.query<{ rolbypassrls: boolean; rolinherit: boolean; rolsuper: boolean; scram: boolean }>(
      `select rolbypassrls, rolinherit, rolsuper, rolpassword like 'SCRAM-SHA-256$4096:%' as scram
        from pg_authid where rolname = $1`,
      [role],
    );
    expect(stored.rows).toEqual([{ rolbypassrls: true, rolinherit: false, rolsuper: false, scram: true }]);
    expect(await checkControlRole(poolAs(role, password), NAMES)).toMatchObject({ role, bypassRls: true });
  });

  it('admin tenancy role --print-sql prints the control role’s statements, never its password, and creates nothing', async () => {
    const role = freshRole();
    const password = `pw-${randomBytes(8).toString('hex')}`;
    const printed = io();
    const config = hosted(urlAs(TEST_DATABASE_URL!, role, password, db.schema));
    expect(await runTenancyRoleWith({ command: 'admin-tenancy-role', printSql: true }, printed.io, config)).toBe(0);
    const out = printed.stdout();
    expect(out).not.toContain(password);
    expect(out).toMatch(/-- As a superuser[^\n]*\n/);
    expect(out).toContain(`create role ${role} login nosuperuser bypassrls noinherit password 'SCRAM-SHA-256$4096:`);
    expect(out).toContain(`grant usage on schema "${db.schema}" to "${role}";`);
    expect(await roleExists(role)).toBe(false);

    // Applied as printed (the superuser may run all of it, the owner's part included), the role passes the check.
    await admin.query(out);
    expect(await checkControlRole(poolAs(role, password), NAMES)).toMatchObject({ role, bypassRls: true });
  });

  it('admin tenancy role refuses with tenancy-control-role-create-refused when the owner may not create it', async () => {
    const out = io();
    const config = hosted(urlAs(TEST_DATABASE_URL!, freshRole(), 'x', db.schema));
    expect(await runTenancyRoleWith({ command: 'admin-tenancy-role', printSql: false }, out.io, config)).toBe(1);
    expect(out.stderr()).toMatch(/^tenancy-control-role-create-refused: .*--print-sql/);
  });

  it('admin tenancy role grants an existing control role in hosted mode, and prints only grants for it', async () => {
    const run = io();
    expect(
      await runTenancyRoleWith({ command: 'admin-tenancy-role', printSql: false }, run.io, hosted(db.controlUrl)),
    ).toBe(0);
    expect(run.stdout()).toContain(`control role ${CONTROL_ROLE}: exists; privileges granted on schema ${db.schema}`);
    const printed = io();
    expect(
      await runTenancyRoleWith({ command: 'admin-tenancy-role', printSql: true }, printed.io, hosted(db.controlUrl)),
    ).toBe(0);
    expect(printed.stdout()).not.toMatch(/create role/);
    expect(printed.stdout()).toContain(`to "${CONTROL_ROLE}"`);
  });
});
