import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/context.js';
import { createDatabase } from '../../../src/db/pool.js';
import { main } from '../../../src/main.js';
import { startServer } from '../../../src/serve.js';
import { checkAppRole } from '../../../src/tenancy/checks.js';
import { appRolePlan, ensureAppRole } from '../../../src/tenancy/roles.js';
import { APP_ROLE, describeDb, OWNER_ROLE, TEST_DATABASE_URL, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { freePort } from '../../helpers/net.js';

/** `base` with another user, password and this schema on the search path. */
function urlAs(base: string, role: string, password: string, schema: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = password;
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

const io = (env: NodeJS.ProcessEnv) => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: { write: (t: string) => out.push(t) }, stderr: { write: (t: string) => err.push(t) }, env },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
};

describeDb('the app role (hosted spec §19.4)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  /** The superuser, here standing for an owner that may create roles; it creates and drops the throwaway roles. */
  let admin: Database;
  let adminUrl: string;
  const made: string[] = [];
  /** A role name no other file or run uses; dropped after the test. */
  const freshRole = (): string => {
    const role = `wb_test_app_${randomBytes(4).toString('hex')}`;
    made.push(role);
    return role;
  };
  const roleExists = async (role: string) =>
    ((await admin.query('select 1 from pg_roles where rolname = $1', [role])).rowCount ?? 0) > 0;

  // A run that crashed before its afterEach leaves throwaway roles on the cluster; the next run sweeps them.
  // Only this file makes `wb_test_app_` roles. One still granted something in another database cannot be
  // dropped from here, and is left alone.
  beforeAll(async () => {
    const sweeper = createDatabase(TEST_DATABASE_URL!);
    try {
      const stale = await sweeper.query<{ role: string }>(
        "select rolname as role from pg_roles where rolname like 'wb\\_test\\_app\\_%'",
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
    adminUrl = new URL(TEST_DATABASE_URL!).toString();
    const url = new URL(adminUrl);
    url.searchParams.set('options', `-c search_path=${db.schema}`);
    adminUrl = url.toString();
    admin = createDatabase(adminUrl);
  });
  afterEach(async () => {
    for (const role of made.splice(0)) {
      if (await roleExists(role)) {
        await admin.query(`drop owned by "${role}"`);
        await admin.query(`drop role "${role}"`);
      }
    }
    await admin.close();
    await db.close();
  });

  it('counts rights a role holds through membership: an owner, a superuser or a BYPASSRLS role it may become', async () => {
    const check = async (grant: (role: string) => Promise<void>) => {
      const role = freshRole();
      await admin.query(`create role "${role}" login noinherit password 'member-pw'`);
      await admin.query(`grant usage on schema ${db.schema} to "${role}"`);
      await grant(role);
      const member = createDatabase(urlAs(TEST_DATABASE_URL!, role, 'member-pw', db.schema));
      try {
        return await checkAppRole(member, 'hosted', () => undefined).then(
          () => 'started',
          (error: unknown) => (error as Error).message,
        );
      } finally {
        await member.close();
      }
    };
    expect(await check((role) => admin.query(`grant ${OWNER_ROLE} to "${role}"`).then(() => undefined))).toMatch(
      /owns \d+ of the server's tables/,
    );
    const bypass = freshRole();
    await admin.query(`create role "${bypass}" nologin bypassrls`);
    expect(await check((role) => admin.query(`grant "${bypass}" to "${role}"`).then(() => undefined))).toMatch(
      /has BYPASSRLS/,
    );
    const superuser = freshRole();
    await admin.query(`create role "${superuser}" nologin superuser`);
    expect(await check((role) => admin.query(`grant "${superuser}" to "${role}"`).then(() => undefined))).toMatch(
      /is a superuser/,
    );
    // The app role itself holds none of these.
    expect(await checkAppRole(db, 'hosted', () => undefined)).toMatchObject({ superuser: false, ownedTables: 0 });
  });

  it('creates a missing app role that signs in with the URL’s password, and a second run changes nothing', async () => {
    const role = freshRole();
    const password = randomBytes(12).toString('hex');
    const appUrl = urlAs(TEST_DATABASE_URL!, role, password, db.schema);
    expect(await ensureAppRole(admin, appUrl)).toMatchObject({ role, exists: false, schema: db.schema });
    const snapshot = async () => ({
      role: (
        await admin.query(
          'select rolsuper, rolbypassrls, rolinherit, rolcanlogin, rolpassword from pg_authid where rolname = $1',
          [role],
        )
      ).rows,
      grants: (
        await admin.query(
          `select table_name, privilege_type from information_schema.role_table_grants
             where grantee = $1 and table_schema = $2 order by 1, 2`,
          [role, db.schema],
        )
      ).rows,
      // This schema's only: other files change their own schemas' defaults meanwhile.
      defaults: (
        await admin.query(
          'select defaclacl::text from pg_default_acl where defaclnamespace = $1::regnamespace order by 1',
          [db.schema],
        )
      ).rows,
    });
    const first = await snapshot();
    expect(first.role).toEqual([
      expect.objectContaining({ rolsuper: false, rolbypassrls: false, rolinherit: false, rolcanlogin: true }),
    ]);
    expect(String((first.role[0] as { rolpassword: string }).rolpassword)).toMatch(/^SCRAM-SHA-256\$4096:/);
    expect(await ensureAppRole(admin, appUrl)).toMatchObject({ role, exists: true });
    expect(await snapshot()).toEqual(first);

    const app = createDatabase(appUrl);
    try {
      expect((await app.query<{ me: string }>('select current_user::text as me')).rows[0]!.me).toBe(role);
      expect((await app.query('select id from workspaces')).rowCount).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('applies SASLprep to the password, so a non-ASCII one signs in too', async () => {
    for (const password of ['\uFB01x-ligature-0019', 'no\u00A0break\u00A0space-0019', 'caf\u0065\u0301-0019']) {
      const role = freshRole();
      const appUrl = urlAs(TEST_DATABASE_URL!, role, password, db.schema);
      await ensureAppRole(admin, appUrl);
      const app = createDatabase(appUrl);
      try {
        expect((await app.query<{ me: string }>('select current_user::text as me')).rows[0]!.me, password).toBe(role);
      } finally {
        await app.close();
      }
    }
  });

  it('refuses to create an app role with no password in its URL, unless it names a client certificate', async () => {
    const role = freshRole();
    const url = new URL(urlAs(TEST_DATABASE_URL!, role, 'x', db.schema));
    url.password = '';
    await expect(ensureAppRole(admin, url.toString())).rejects.toMatchObject({ code: 'tenancy-app-password-missing' });
    expect(await roleExists(role)).toBe(false);
    url.searchParams.set('sslcert', '/etc/wirebench/app.crt');
    expect((await appRolePlan(admin, url.toString())).statements[0]).toMatch(
      /^create role \S+ login nosuperuser nobypassrls noinherit$/,
    );
  });

  it('carries on when another database of the cluster created the role a moment before (duplicate_object)', async () => {
    const role = freshRole();
    const appUrl = urlAs(TEST_DATABASE_URL!, role, 'pw-race-0019', db.schema);
    // The other database's server wins the race between this one's plan and its create role.
    const racing: Database = {
      ...admin,
      transaction: (fn) =>
        admin.transaction((tx) =>
          fn({
            query: async (text: string, params?: readonly unknown[]) => {
              if (text.startsWith('create role')) {
                const other = createDatabase(TEST_DATABASE_URL!);
                try {
                  await other.query(text);
                } finally {
                  await other.close();
                }
              }
              return tx.query(text, params);
            },
          }),
        ),
    };
    expect(await ensureAppRole(racing, appUrl)).toMatchObject({ role, exists: false });
    expect(await roleExists(role)).toBe(true);
    const grants = await admin.query('select 1 from information_schema.role_table_grants where grantee = $1', [role]);
    expect(grants.rowCount).toBeGreaterThan(0);
  });

  it('sets the password as a SCRAM-SHA-256 verifier, never the password itself', async () => {
    const role = freshRole();
    const password = `pw-${randomBytes(8).toString('hex')}`;
    const plan = await appRolePlan(admin, urlAs(TEST_DATABASE_URL!, role, password, db.schema));
    expect(plan.statements[0]).toMatch(
      // format('%I') quotes only a name that needs it; these test names do not.
      new RegExp(`^create role ${role} login nosuperuser nobypassrls noinherit password 'SCRAM-SHA-256\\$4096:`),
    );
    expect(plan.statements.join('\n')).not.toContain(password);
    expect(await roleExists(role)).toBe(false); // the plan only reads
  });

  it('grants a table a later migration creates', async () => {
    await db.owner.query('create table later_table (id int)');
    await db.owner.query('insert into later_table values (1)');
    expect((await db.query('select id from later_table')).rowCount).toBe(1);
    await expect(db.query('insert into later_table values (2)')).resolves.toBeDefined();
  });

  it('tells an owner that may not create roles to use --print-sql, and creates nothing', async () => {
    const role = freshRole();
    const appUrl = urlAs(TEST_DATABASE_URL!, role, 'x', db.schema);
    await expect(ensureAppRole(db.owner, appUrl)).rejects.toMatchObject({
      code: 'tenancy-role-not-creatable',
      message: expect.stringContaining('admin tenancy role --print-sql') as unknown,
    });
    expect(await roleExists(role)).toBe(false);
  });

  it('refuses an app URL that names the owner', async () => {
    await expect(ensureAppRole(db.owner, db.ownerUrl)).rejects.toMatchObject({ code: 'tenancy-app-role-is-owner' });
  });

  it('admin tenancy role --print-sql prints the statements and creates nothing; without it, creates the role', async () => {
    const role = freshRole();
    const password = `pw-${randomBytes(8).toString('hex')}`;
    const env = {
      WIREBENCH_SERVER_MIGRATION_DATABASE_URL: adminUrl,
      WIREBENCH_SERVER_DATABASE_URL: urlAs(TEST_DATABASE_URL!, role, password, db.schema),
      WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
    };
    const printed = io(env);
    expect(await main(['admin', 'tenancy', 'role', '--print-sql'], printed.io)).toBe(0);
    expect(printed.stdout()).toContain(`create role ${role} login nosuperuser nobypassrls noinherit password 'SCRAM`);
    expect(printed.stdout()).toContain(`grant usage on schema "${db.schema}" to "${role}";`);
    expect(printed.stdout()).not.toContain(password);
    expect(printed.stdout()).toMatch(
      /^-- Secret: .*\n-- As a role that may create roles \(CREATEROLE\):\ncreate role /,
    );
    expect(printed.stdout()).toContain(`-- As the owner, wirebench:\ngrant usage`);
    expect(await roleExists(role)).toBe(false);

    const run = io(env);
    expect(await main(['admin', 'tenancy', 'role'], run.io)).toBe(0);
    expect(run.stdout()).toBe(`app role ${role}: created; privileges granted on schema ${db.schema}\n`);
    expect(await roleExists(role)).toBe(true);
    const again = io(env);
    expect(await main(['admin', 'tenancy', 'role'], again.io)).toBe(0);
    expect(again.stdout()).toContain(`app role ${role}: exists`);
  });

  it('admin tenancy role needs two roles, and names no URL when it says so', async () => {
    for (const env of [
      { WIREBENCH_SERVER_DATABASE_URL: db.ownerUrl },
      { WIREBENCH_SERVER_DATABASE_URL: db.ownerUrl, WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl },
    ]) {
      const out = io({ ...env, WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test' });
      expect(await main(['admin', 'tenancy', 'role'], out.io)).toBe(2);
      expect(out.stderr()).toContain('admin tenancy role needs two roles');
      expect(out.stderr()).not.toContain('postgres://');
    }
  });

  it('admin tenancy role refuses keyword-form connection strings, as serve does', async () => {
    const out = io({
      WIREBENCH_SERVER_DATABASE_URL: db.url,
      WIREBENCH_SERVER_MIGRATION_DATABASE_URL: 'host=127.0.0.1 user=wirebench_owner',
      WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
    });
    expect(await main(['admin', 'tenancy', 'role'], out.io)).toBe(2);
    expect(out.stderr()).toContain('tenancy-app-url-invalid: WIREBENCH_SERVER_MIGRATION_DATABASE_URL must be');
  });

  it('an owner that may not create roles fails with the hint on stderr, exit 1', async () => {
    const role = freshRole();
    const out = io({
      WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
      WIREBENCH_SERVER_DATABASE_URL: urlAs(TEST_DATABASE_URL!, role, 'x', db.schema),
      WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
    });
    expect(await main(['admin', 'tenancy', 'role'], out.io)).toBe(1);
    expect(out.stderr()).toMatch(
      /^tenancy-role-not-creatable: .*--print-sql, apply its create role as a role that may create roles, and the rest as the owner/,
    );
  });
});

describeDb('serve and migrate with one URL or two (hosted spec §19.4)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let dataDir: string;
  let port: number;
  const env = (urls: Record<string, string>) => ({
    ...urls,
    WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
    WIREBENCH_SERVER_DATA_DIR: dataDir,
    WIREBENCH_SERVER_HOST: '127.0.0.1',
    WIREBENCH_SERVER_PORT: String(port),
    WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
  });
  const start = (urls: Record<string, string>) =>
    startServer(env(urls), io(env(urls)).io, { signals: new EventEmitter(), exit: vi.fn() });
  const appMayRead = async (table: string) =>
    (
      await db.owner.query<{ may: boolean }>('select has_table_privilege($1, $2, $3) as may', [
        APP_ROLE,
        `${db.schema}.${table}`,
        'select',
      ])
    ).rows[0]!.may;
  const tableOwner = async (table: string) =>
    (
      await db.owner.query<{ owner: string }>(
        'select tableowner::text as owner from pg_tables where schemaname = $1 and tablename = $2',
        [db.schema, table],
      )
    ).rows[0]?.owner;

  beforeEach(async () => {
    db = await testDatabase({ migrated: false });
    dataDir = await mkTempDir();
    port = await freePort();
  });
  afterEach(async () => {
    await db.close();
    await removeTempDir(dataDir);
  });

  it('with one URL, the one role migrates and queries, and nothing is granted, as before', async () => {
    const server = await start({ WIREBENCH_SERVER_DATABASE_URL: db.ownerUrl });
    try {
      const me = await server.ctx.db.query<{ me: string }>('select current_user::text as me');
      expect(me.rows[0]!.me).toBe(OWNER_ROLE);
    } finally {
      await server.close();
    }
    expect(await tableOwner('workspaces')).toBe(OWNER_ROLE);
    expect(await appMayRead('workspaces')).toBe(false);
  });

  it('with two, serve migrates as the owner, grants, and queries as the app role', async () => {
    const urls = { WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl, WIREBENCH_SERVER_DATABASE_URL: db.url };
    const server = await start(urls);
    try {
      const me = await server.ctx.db.query<{ me: string }>('select current_user::text as me');
      expect(me.rows[0]!.me).toBe(APP_ROLE);
      expect((await server.ctx.db.query('select version from schema_migrations')).rowCount).toBe(1);
    } finally {
      await server.close();
    }
    expect(await tableOwner('workspaces')).toBe(OWNER_ROLE);
    expect(await appMayRead('workspaces')).toBe(true);
    // Neither URL is left in the environment, where git's child processes would inherit it.
    expect(process.env.WIREBENCH_SERVER_MIGRATION_DATABASE_URL).toBeUndefined();
  });

  it('migrate with two URLs runs as the owner and grants; --check reads as the owner too', async () => {
    const urls = { WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl, WIREBENCH_SERVER_DATABASE_URL: db.url };
    const check = io(env(urls));
    expect(await main(['migrate', '--check'], check.io, { modules: [] })).toBe(1);
    const run = io(env(urls));
    expect(await main(['migrate'], run.io, { modules: [] })).toBe(0);
    expect(run.stdout()).toBe('migrations: applied 1\n');
    expect(await tableOwner('schema_migrations')).toBe(OWNER_ROLE);
    expect(await appMayRead('schema_migrations')).toBe(true);
    await expect(db.query("insert into schema_migrations (version, name) values (9, 'x')")).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('with two URLs naming one role, serve migrates over the migration URL, as migrate does', async () => {
    // The same role in a second schema of this file's: what lands there is what the migration URL ran.
    const other = await testDatabase({ migrated: false });
    try {
      const server = await start({
        WIREBENCH_SERVER_MIGRATION_DATABASE_URL: other.ownerUrl,
        WIREBENCH_SERVER_DATABASE_URL: db.ownerUrl,
      });
      await server.close();
      const tables = async (schema: string) =>
        (await db.owner.query('select 1 from pg_tables where schemaname = $1', [schema])).rowCount;
      expect(await tables(other.schema)).toBeGreaterThan(0);
      expect(await tables(db.schema)).toBe(0);
    } finally {
      await other.close();
    }
  });

  it('refuses to start when the app role exists with another password, naming the fix', async () => {
    const wrong = new URL(db.url);
    wrong.password = 'not-the-password';
    const urls = {
      WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
      WIREBENCH_SERVER_DATABASE_URL: wrong.toString(),
    };
    const refusal = await start(urls).catch((error: unknown) => error);
    expect(refusal).toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('alter role ... password') as unknown,
    });
    expect(String((refusal as Error).message)).not.toContain('not-the-password');
  });

  it('refuses a keyword-form connection string beside a migration URL, before connecting', async () => {
    const urls = {
      WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
      WIREBENCH_SERVER_DATABASE_URL: 'host=db user=app',
    };
    await expect(start(urls)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('tenancy-app-url-invalid') as unknown,
    });
    const run = io(env(urls));
    expect(await main(['migrate'], run.io, { modules: [] })).toBe(2);
    expect(run.stderr()).toContain('tenancy-app-url-invalid');
  });
});
