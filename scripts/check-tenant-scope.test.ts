import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkTenantScope, findScopeMints, findUrlReads, isAllowed } from './check-tenant-scope.js';

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

  it('passes the real tree', async () => {
    expect(await checkTenantScope(join(import.meta.dirname, '..'))).toEqual([]);
  });

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
    expect(isAllowed('packages/server/src/tenancy/jobs.ts')).toBe(true);
    expect(isAllowed('packages/server/src/tenancy-extra/x.ts')).toBe(false);
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
});
