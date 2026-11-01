/**
 * The per-tenant layout (hosted edition spec §19.6): `tenantRoot` is the one builder of `tenants/<id>`, and every
 * tenant path derives from it.
 */
import { chmodSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostDirectories } from '../../../src/host/server-platform.js';
import { tenantPaths, tenantRoot, tenantTmpDirs, TENANTS_DIR } from '../../../src/tenancy/paths.js';
import { scopeOf } from '../../../src/tenancy/scope.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { canSymlink } from '../../helpers/symlink.js';

const A = scopeOf({ id: '00000000-0000-4000-8000-00000000000a', slug: 'acme' });
const B = scopeOf({ id: '00000000-0000-4000-8000-00000000000b', slug: 'beta' });
const USER = '01JB3Z9K7Q4ZJ6X1V8W2M5N0PA';

describe('tenant paths', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkTempDir('wbs-paths-');
  });
  afterEach(() => removeTempDir(dataDir));

  it('roots every tenant under tenants/<tenantId>, and two tenants never share a directory', () => {
    expect(tenantRoot(dataDir, A)).toBe(join(dataDir, TENANTS_DIR, A.tenantId));
    const a = tenantPaths(dataDir, A);
    const b = tenantPaths(dataDir, B);
    expect(a).toEqual({
      root: join(dataDir, 'tenants', A.tenantId),
      repos: join(dataDir, 'tenants', A.tenantId, 'repos'),
      checkouts: join(dataDir, 'tenants', A.tenantId, 'checkouts'),
      tmp: join(dataDir, 'tenants', A.tenantId, 'tmp'),
      schedules: join(dataDir, 'tenants', A.tenantId, 'tmp', 'schedules'),
      hosts: join(dataDir, 'tenants', A.tenantId, 'tmp', 'hosts'),
    });
    for (const pa of Object.values(a) as string[]) {
      for (const pb of Object.values(b) as string[]) {
        // Neither is the other, nor inside it.
        expect(relative(pa, pb).startsWith('..')).toBe(true);
        expect(relative(pb, pa).startsWith('..')).toBe(true);
      }
    }
  });

  it("puts a user's host checkout and scratch under the tenant", () => {
    expect(hostDirectories(dataDir, A, USER)).toEqual({
      checkout: join(dataDir, 'tenants', A.tenantId, 'checkouts', USER),
      temp: join(dataDir, 'tenants', A.tenantId, 'tmp', 'hosts', USER),
    });
    const a = hostDirectories(dataDir, A, USER);
    const b = hostDirectories(dataDir, B, USER);
    expect(a.checkout).not.toBe(b.checkout);
    expect(a.temp).not.toBe(b.temp);
  });

  it('accepts only a canonical lower-case UUID', () => {
    for (const id of [
      '',
      'default',
      '..',
      `../${A.tenantId}`,
      '00000000-0000-4000-8000-00000000000A',
      '00000000000040008000000000000000a',
      `${A.tenantId}/x`,
      `{${A.tenantId}}`,
    ]) {
      expect(() => tenantRoot(dataDir, scopeOf({ id, slug: 'x' })), id).toThrow(
        expect.objectContaining({ code: 'tenancy-tenant-path-refused' }),
      );
    }
  });

  it.skipIf(!canSymlink)('refuses a tenant root that is a symlink, even one pointing at another tenant', () => {
    mkdirSync(join(dataDir, 'tenants', B.tenantId), { recursive: true });
    symlinkSync(join(dataDir, 'tenants', B.tenantId), join(dataDir, 'tenants', A.tenantId), 'dir');
    expect(() => tenantRoot(dataDir, A)).toThrow(expect.objectContaining({ code: 'tenancy-tenant-path-refused' }));
    expect(() => tenantPaths(dataDir, A)).toThrow(expect.objectContaining({ code: 'tenancy-tenant-path-refused' }));
    expect(tenantRoot(dataDir, B)).toBe(join(dataDir, 'tenants', B.tenantId));
  });

  it.skipIf(!canSymlink)(
    'refuses a tenant root that resolves outside <dataDir>/tenants: tenants/ itself a link elsewhere',
    () => {
      const outside = join(dataDir, 'elsewhere');
      mkdirSync(join(outside, A.tenantId), { recursive: true });
      symlinkSync(outside, join(dataDir, 'tenants'), 'dir');
      // The root is a real directory, but it is not under the data directory's own tenants/.
      expect(() => tenantRoot(dataDir, A)).toThrow(expect.objectContaining({ code: 'tenancy-tenant-path-refused' }));
    },
  );

  it.skipIf(!canSymlink)(
    'refuses a missing root behind a tenants/ that links elsewhere, and the store writes nothing there (Task 21 review I1)',
    async () => {
      const outside = join(dataDir, 'elsewhere');
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(dataDir, 'tenants'), 'dir');
      expect(() => tenantRoot(dataDir, A)).toThrow(expect.objectContaining({ code: 'tenancy-tenant-path-refused' }));
      const { NO_HOOKS_DIR, RepoStore } = await import('../../../src/repos/repo-store.js');
      const { testGit } = await import('../../helpers/git.js');
      const store = new RepoStore({ git: testGit(join(dataDir, NO_HOOKS_DIR)), dataDir });
      await expect(store.create(A, '01J8ZC5Q0V7R3T9XK2M4N6P8QA')).rejects.toMatchObject({
        code: 'tenancy-tenant-path-refused',
      });
      expect(readdirSync(outside)).toEqual([]);
    },
  );

  it.skipIf(!canSymlink)(
    'refuses a directory beneath the root that links into another tenant (Task 21 review M2)',
    () => {
      mkdirSync(join(dataDir, 'tenants', B.tenantId, 'repos'), { recursive: true });
      mkdirSync(join(dataDir, 'tenants', A.tenantId, 'tmp'), { recursive: true });
      symlinkSync(join(dataDir, 'tenants', B.tenantId, 'repos'), join(dataDir, 'tenants', A.tenantId, 'repos'), 'dir');
      expect(() => tenantPaths(dataDir, A)).toThrow(expect.objectContaining({ code: 'tenancy-tenant-path-refused' }));
      expect(tenantPaths(dataDir, B).repos).toBe(join(dataDir, 'tenants', B.tenantId, 'repos'));
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses a root it cannot read with a message that names no path (Task 21 review M1)',
    () => {
      mkdirSync(join(dataDir, 'tenants', A.tenantId), { recursive: true });
      chmodSync(join(dataDir, 'tenants'), 0o000);
      try {
        let caught: unknown;
        try {
          tenantRoot(dataDir, A);
        } catch (error) {
          caught = error;
        }
        expect(caught).toMatchObject({ code: 'tenancy-tenant-path-refused' });
        expect((caught as Error).message).not.toContain(A.tenantId);
        expect((caught as Error).message).not.toContain(dataDir);
        expect(JSON.stringify(caught)).not.toContain(A.tenantId);
      } finally {
        chmodSync(join(dataDir, 'tenants'), 0o755);
      }
    },
  );

  it('accepts a root that does not exist yet: the store creates it', () => {
    expect(tenantRoot(dataDir, A)).toBe(join(dataDir, 'tenants', A.tenantId));
  });

  it('refuses a tenant root that is not a directory', async () => {
    const { writeFile } = await import('node:fs/promises');
    mkdirSync(join(dataDir, 'tenants'), { recursive: true });
    await writeFile(join(dataDir, 'tenants', A.tenantId), 'not a directory');
    expect(() => tenantRoot(dataDir, A)).toThrow(expect.objectContaining({ code: 'tenancy-tenant-path-refused' }));
  });

  it.skipIf(!canSymlink)('accepts a data directory reached through a symlink (macOS /var → /private/var)', () => {
    mkdirSync(join(dataDir, 'real', 'tenants', A.tenantId), { recursive: true });
    symlinkSync(join(dataDir, 'real'), join(dataDir, 'linked'), 'dir');
    expect(tenantRoot(join(dataDir, 'linked'), A)).toBe(join(dataDir, 'linked', 'tenants', A.tenantId));
  });

  it.skipIf(!canSymlink)(
    "lists every tenant's tmp/ for the start-up sweeps, skipping what is no tenant id and refusing a symlinked root",
    async () => {
      expect(await tenantTmpDirs(dataDir)).toEqual([]);
      mkdirSync(join(dataDir, 'tenants', A.tenantId), { recursive: true });
      mkdirSync(join(dataDir, 'tenants', 'not-a-tenant'), { recursive: true });
      expect(await tenantTmpDirs(dataDir)).toEqual([tenantPaths(dataDir, A).tmp]);
      mkdirSync(join(dataDir, 'elsewhere'), { recursive: true });
      symlinkSync(join(dataDir, 'elsewhere'), join(dataDir, 'tenants', B.tenantId), 'dir');
      await expect(tenantTmpDirs(dataDir)).rejects.toMatchObject({ code: 'tenancy-tenant-path-refused' });
    },
  );
});
