import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkTenantScope, findDefaultScopeCalls, isAllowed } from './check-tenant-scope.js';

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

  it('refuses a defaultScope( planted in a route', async () => {
    const root = await tree({
      'packages/server/src/teams/routes/teams.ts': 'const scope = ctx.tenancy.directory.defaultScope();\n',
      'packages/server/src/tenancy/directory.ts': 'defaultScope(): TenantScope {\n',
    });
    expect(await checkTenantScope(root)).toEqual([
      {
        file: 'packages/server/src/teams/routes/teams.ts',
        line: 1,
        text: 'const scope = ctx.tenancy.directory.defaultScope();',
      },
    ]);
  });

  it('passes the real tree', async () => {
    expect(await checkTenantScope(join(import.meta.dirname, '..'))).toEqual([]);
  });

  it('allows src/tenancy/ only, and skips comments', () => {
    expect(isAllowed('packages/server/src/tenancy/jobs.ts')).toBe(true);
    expect(isAllowed('packages/server/src/tenancy-extra/x.ts')).toBe(false);
    expect(findDefaultScopeCalls('a.ts', '// never call defaultScope() here\n * defaultScope( in a doc\n')).toEqual([]);
    expect(findDefaultScopeCalls('a.ts', 'x.defaultScope ()')).toHaveLength(1);
  });
});
