import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkTenantScope, findRawDatabase, findScopeMints, findUrlReads } from './check-tenant-scope.js';

describe('check:tenant-scope', () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  const tree = async (files: Record<string, string>) => {
    const root = await mkdtemp(join(tmpdir(), 'wb-tenant-scope-'));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), content);
    }
    return root;
  };

  it('refuses a defaultScope planted in a route', async () => {
    const root = await tree({
      'packages/server/src/teams/routes/teams.ts': 'const scope = ctx.tenancy.directory.defaultScope();\n',
      'packages/server/src/tenancy/directory.ts': 'defaultScope(): TenantScope {\n',
    });
    expect(await checkTenantScope(root)).toEqual([
      {
        file: 'packages/server/src/teams/routes/teams.ts',
        line: 1,
        text: 'const scope = ctx.tenancy.directory.defaultScope();',
        rule: 'default-scope',
      },
    ]);
  });

  // Scans every server source file; under coverage instrumentation on CI that takes over 5 s.
  it('passes the real tree', async () => {
    expect(await checkTenantScope(join(import.meta.dirname, '..'))).toEqual([]);
  }, 30_000);

  it('catches every spelling of defaultScope, and skips comments', () => {
    const route = 'packages/server/src/teams/routes/teams.ts';
    const spellings = [
      'dir.defaultScope?.()',
      'const { defaultScope } = ctx.tenancy.directory;',
      "dir['defaultScope']()",
      'const pick = dir.defaultScope.bind(dir);',
      'const scope = dir\n  .defaultScope\n  ();',
      '/* first */ dir.defaultScope();',
      'x.defaultScope ()',
    ];
    for (const text of spellings) expect(findScopeMints(route, text), text).toHaveLength(1);
    expect(findScopeMints(route, '// never call defaultScope() here\n/** defaultScope( in a doc */\n')).toEqual([]);
  });

  it('gates scopeOf too, and keeps both names to their files inside src/tenancy/', () => {
    const forged = "const scope = scopeOf({ id: defaultId, slug: 'default' });";
    expect(findScopeMints('packages/server/src/teams/routes/teams.ts', forged)).toMatchObject([{ rule: 'scope-of' }]);
    expect(
      findScopeMints('packages/server/src/teams/x.ts', "import { scopeOf } from '../tenancy/scope.js';"),
    ).toHaveLength(1);
    // A wrapper elsewhere in src/tenancy/ would re-export the default tenant to every module.
    expect(
      findScopeMints('packages/server/src/tenancy/jobs.ts', 'export const fallback = (d) => d.defaultScope();'),
    ).toHaveLength(1);
    expect(findScopeMints('packages/server/src/tenancy/resolve.ts', 'return directory.defaultScope();')).toEqual([]);
    expect(findScopeMints('packages/server/src/tenancy/directory.ts', 'return rows.map(scopeOf);')).toEqual([]);
  });

  it('keeps the tenant directory to start-up, the resolver and the admin command line (m2)', () => {
    const leak =
      "import { directoryOf } from '../tenancy/tenancy.js';\nconst all = await directoryOf(ctx.tenancy).list();";
    expect(findScopeMints('packages/server/src/teams/routes/teams.ts', leak)).toMatchObject([
      { line: 1, rule: 'directory-of' },
      { line: 2, rule: 'directory-of' },
    ]);
    expect(findScopeMints('packages/server/src/server.ts', 'directoryOf(ctx.tenancy)')).toEqual([]);
    expect(findScopeMints('packages/server/src/identity/cli.ts', 'directoryOf(t).defaultScope()')).toEqual([]);
  });

  it('keeps TenantDirectory and TenantAdmin inside src/tenancy/, however they are named (Task 8 review I2)', async () => {
    const root = await tree({
      'packages/server/src/teams/routes/teams.ts': [
        "import { TenantDirectory as Dir } from '../../tenancy/directory.js';",
        'const all = await new Dir(ctx.db).list();',
        'const admin = new tenancy.TenantAdmin(ctx.db, dir);',
        "type T = import('../../tenancy/directory.js').TenantDirectory;",
      ].join('\n'),
      'packages/server/src/tenancy/jobs.ts': "import type { TenantDirectory } from './directory.js';\n",
    });
    expect(await checkTenantScope(root)).toMatchObject([
      { file: 'packages/server/src/teams/routes/teams.ts', line: 1, rule: 'tenant-directory' },
      { line: 3, rule: 'tenant-directory' },
      { line: 4, rule: 'tenant-directory' },
    ]);
  });

  it('refuses stateWithoutScope everywhere, the jobs included (tenancy Task 14)', () => {
    const route = 'packages/server/src/teams/routes/workspaces.ts';
    expect(findScopeMints(route, 'const s = await ctx.license.stateWithoutScope();')).toMatchObject([
      { rule: 'license-without-scope' },
    ]);
    for (const job of [
      'packages/server/src/audit-log/forward/forwarder.ts',
      'packages/server/src/schedules/scheduler.ts',
    ]) {
      expect(findScopeMints(job, 'await this.deps.license().stateWithoutScope();'), job).toHaveLength(1);
    }
  });

  it('refuses a new raw read of the public URL, in any spelling', () => {
    const file = 'packages/server/src/teams/routes/teams.ts';
    const reads = [
      'reply.send({ url: ctx.config.publicUrl });',
      'const url = env.ctx?.config?.publicUrl;',
      "const url = ctx.config['publicUrl'];",
      'const link = `${config.publicUrl}/invite/${secret}`;',
      "type Urls = Pick<ServerConfig, 'publicUrl'>;",
    ];
    for (const read of reads) expect(findUrlReads(file, read), read).toHaveLength(1);
    // A response field that happens to be called that is not a read; the value it carries is checked instead.
    expect(findUrlReads(file, 'return { publicUrl: tenantUrl(ctx.config, request) };')).toEqual([]);
    expect(findUrlReads(file, '// ctx.config.publicUrl in a comment\n/** config.publicUrl */')).toEqual([]);
  });

  it('refuses a copy made at registration', () => {
    const file = 'packages/server/src/hooks/module.ts';
    expect(
      findUrlReads(
        file,
        'async register(app, ctx) {\n  const { publicUrl } = ctx.config;\n  routes(publicUrl)(app);\n}',
      ),
    ).toMatchObject([{ line: 2, rule: 'public-url' }]);
    expect(findUrlReads(file, 'const { publicUrl: base, port } = config;')).toMatchObject([{ rule: 'public-url' }]);
    expect(findUrlReads(file, 'const settings = { linkUrl: config.publicUrl };')).toMatchObject([
      { rule: 'public-url' },
    ]);
    // The unscoped URL is a copy for every tenant: only its listed callers may take it.
    expect(findUrlReads(file, 'const base = urlWithoutScope(ctx.config);')).toMatchObject([
      { rule: 'url-without-scope' },
    ]);
    expect(findUrlReads('packages/server/src/sso/module.ts', 'const base = urlWithoutScope(ctx.config);')).toEqual([]);
  });

  it('keeps operatorPublicUrl to main.ts and serve.ts, and the configured URL to config.ts', () => {
    const call = 'log.info({ url: operatorPublicUrl(config) });';
    expect(findUrlReads('packages/server/src/serve.ts', call)).toEqual([]);
    expect(findUrlReads('packages/server/src/main.ts', call)).toEqual([]);
    expect(findUrlReads('packages/server/src/agent/routes.ts', call)).toMatchObject([{ rule: 'operator-url' }]);
    expect(findUrlReads('packages/server/src/agent/routes.ts', 'const f = operatorPublicUrl;')).toHaveLength(1);
    expect(findUrlReads('packages/server/src/config.ts', 'const url = new URL(config.publicUrl);')).toEqual([]);
  });

  it('finds a planted read in a tree, and passes src/tenancy/', async () => {
    const root = await tree({
      'packages/server/src/agent/routes.ts': 'const origin = ctx.config.publicUrl;\n',
      'packages/server/src/tenancy/urls.ts': 'return config.publicUrl;\n',
    });
    expect(await checkTenantScope(root)).toEqual([
      {
        file: 'packages/server/src/agent/routes.ts',
        line: 1,
        text: 'const origin = ctx.config.publicUrl;',
        rule: 'public-url',
      },
    ]);
  });

  it('allows the configured URL in tenancy/urls.ts only, not the whole folder, and its variable in config.ts only', () => {
    const read = 'return config.publicUrl;';
    expect(findUrlReads('packages/server/src/tenancy/urls.ts', read)).toEqual([]);
    expect(findUrlReads('packages/server/src/tenancy/jobs.ts', read)).toMatchObject([{ rule: 'public-url' }]);
    expect(
      findUrlReads('packages/server/src/tenancy/other.ts', 'export const unscoped = (c) => urlWithoutScope(c);'),
    ).toMatchObject([{ rule: 'url-without-scope' }]);
    for (const env of [
      'const url = process.env.WIREBENCH_SERVER_PUBLIC_URL;',
      "const url = process.env['WIREBENCH_SERVER_PUBLIC_URL'];",
    ])
      expect(findUrlReads('packages/server/src/hooks/module.ts', env), env).toMatchObject([{ rule: 'public-url' }]);
    expect(findUrlReads('packages/server/src/config.ts', "env: 'WIREBENCH_SERVER_PUBLIC_URL',")).toEqual([]);
  });

  it('refuses the database URLs outside config.ts, src/db/, src/tenancy/ and the start-up (Part C review M4)', () => {
    const module = 'packages/server/src/hooks/module.ts';
    for (const read of [
      'const url = ctx.config.databaseUrl;',
      'const url = (ctx.config as ServerConfig).migrationDatabaseUrl;',
      "const url = ctx.config['databaseUrl'];",
      'const { databaseUrl } = config;',
      'const { migrationDatabaseUrl: owner } = config;',
      "type Urls = Pick<ServerConfig, 'databaseUrl'>;",
    ]) {
      expect(findUrlReads(module, read), read).toMatchObject([{ rule: 'database-url' }]);
    }
    const read = 'const db = createDatabase(config.databaseUrl);';
    for (const file of [
      'packages/server/src/config.ts',
      'packages/server/src/serve.ts',
      'packages/server/src/identity/cli.ts',
      'packages/server/src/tenancy/cli.ts',
      'packages/server/src/db/pool.ts',
    ]) {
      expect(findUrlReads(file, read), file).toEqual([]);
    }
    expect(findUrlReads(module, '// config.databaseUrl in a comment')).toEqual([]);
  });

  it('finds a planted database URL read in a tree', async () => {
    const root = await tree({ 'packages/server/src/agent/routes.ts': 'const url = ctx.config.databaseUrl;\n' });
    expect(await checkTenantScope(root)).toMatchObject([
      { file: 'packages/server/src/agent/routes.ts', line: 1, rule: 'database-url' },
    ]);
  });

  it('refuses the raw pool and its types outside src/db/, src/tenancy/ and the start-up (Task 17)', () => {
    const route = 'packages/server/src/teams/routes/teams.ts';
    const spellings = [
      "import { createDatabase } from '../../db/pool.js';",
      "import type { Querier } from '../../db/querier.js';",
      "import type { Database as Db } from '../../db/querier';",
      "export { createDatabase } from '../../db/pool.js';",
      "export type * from '../../db/querier.js';",
      "const pool = await import('../../db/pool.js');",
      "type Q = import('../../db/querier.js').Querier;",
      "import pool = require('../../db/pool.js');",
    ];
    for (const text of spellings) expect(findRawDatabase(route, text), text).toMatchObject([{ rule: 'raw-db' }]);
    const allowed = "import { createDatabase } from './db/pool.js';";
    for (const file of [
      'packages/server/src/serve.ts',
      'packages/server/src/identity/cli.ts',
      'packages/server/src/db/migrate.ts',
      'packages/server/src/tenancy/tenancy.ts',
    ]) {
      expect(findRawDatabase(file, allowed), file).toEqual([]);
    }
    expect(findRawDatabase('packages/server/src/main.ts', allowed)).toHaveLength(1);
    // A module of another name, and a comment, are not the pool.
    expect(findRawDatabase(route, "import { x } from './db/pool-size.js';\n// import from '../db/pool.js'\n")).toEqual(
      [],
    );
  });

  it('refuses SQL that sets the tenant or reads the tenants table, outside src/tenancy/ (Task 17)', () => {
    const route = 'packages/server/src/schedules/repo.ts';
    const statements = [
      'db.query("select set_config(\'wirebench.tenant_id\', $1, true)")',
      "db.query('select current_setting($1)', ['wirebench.tenant_id'])",
      'db.query(`select id from tenants where slug = $1`)',
      "db.query('select s.slug from schedules x join  tenants s on s.id = x.tenant_id')",
      'db.query(`select ${cols} from public.tenants`)',
      'db.query(\'SELECT * FROM "tenants"\')',
    ];
    for (const text of statements) expect(findRawDatabase(route, text), text).toMatchObject([{ rule: 'tenant-sql' }]);
    // Another table, a column named tenants, and a comment pass; src/tenancy/ may name them.
    for (const text of [
      "db.query('select * from tenants_archive')",
      "db.query('select tenants from x')",
      '// select set_config(...) from tenants',
    ]) {
      expect(findRawDatabase(route, text), text).toEqual([]);
    }
    expect(findRawDatabase('packages/server/src/tenancy/directory.ts', statements[2]!)).toEqual([]);
  });

  it('refuses for_each_tenant everywhere in the source, src/tenancy/ included (spec §19.4)', () => {
    for (const file of ['packages/server/src/audit-log/repo.ts', 'packages/server/src/tenancy/jobs.ts']) {
      expect(findRawDatabase(file, "db.query('select for_each_tenant($1)', [sql])"), file).toMatchObject([
        { rule: 'for-each-tenant' },
      ]);
      expect(findRawDatabase(file, 'const for_each_tenant = 1;'), file).toMatchObject([{ rule: 'for-each-tenant' }]);
    }
  });

  it('finds a planted file of each new kind in a tree', async () => {
    const root = await tree({
      'packages/server/src/agent/raw.ts': "import { createDatabase } from '../db/pool.js';\n",
      'packages/server/src/agent/sql.ts': "export const SQL = 'select id from tenants';\n",
      'packages/server/src/tenancy/loop.ts': "export const SQL = 'select for_each_tenant($1)';\n",
      'packages/server/src/tenancy/ok.ts': "export const SQL = 'select id from tenants';\n",
    });
    expect((await checkTenantScope(root)).map((hit) => [hit.file, hit.rule])).toEqual(
      expect.arrayContaining([
        ['packages/server/src/agent/raw.ts', 'raw-db'],
        ['packages/server/src/agent/sql.ts', 'tenant-sql'],
        ['packages/server/src/tenancy/loop.ts', 'for-each-tenant'],
      ]),
    );
    expect((await checkTenantScope(root)).map((hit) => hit.file)).not.toContain('packages/server/src/tenancy/ok.ts');
  });

  it('refuses the database driver in a module, and a comma join to tenants (Task 17 review M3)', async () => {
    const route = 'packages/server/src/agent/routes.ts';
    for (const text of [
      "import pg from 'pg';",
      "import { Pool } from 'pg-pool';",
      "const { Client } = await import('pg');",
      "import Cursor from 'pg-cursor';",
      "import postgres from 'postgres';",
    ]) {
      expect(findRawDatabase(route, text), text).toMatchObject([{ rule: 'raw-db' }]);
    }
    // The pool itself may.
    expect(findRawDatabase('packages/server/src/db/pool.ts', "import pg from 'pg';")).toEqual([]);
    // A module of a similar name is not the driver.
    expect(findRawDatabase(route, "import x from 'pgp-signer';")).toEqual([]);
    for (const text of [
      "db.query('select u.id from users u, tenants t where t.id = u.tenant_id')",
      'db.query(`select 1 from users,tenants`)',
    ]) {
      expect(findRawDatabase(route, text), text).toMatchObject([{ rule: 'tenant-sql' }]);
    }
    expect(findRawDatabase(route, "db.query('select a, tenants from x')")).toEqual([]);
    const root = await tree({
      'packages/server/src/agent/driver.ts': "import pg from 'pg';\n",
      'packages/server/src/agent/comma.ts': "export const SQL = 'select 1 from users u, tenants t';\n",
    });
    expect((await checkTenantScope(root)).map((hit) => [hit.file, hit.rule])).toEqual([
      ['packages/server/src/agent/comma.ts', 'tenant-sql'],
      ['packages/server/src/agent/driver.ts', 'raw-db'],
    ]);
  });
});
