import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tenantPaths } from '../../src/tenancy/paths.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { GitCli } from '@wirebench/engine';
import { isWorkspaceId, NO_HOOKS_DIR, RepoStore } from '../../src/repos/repo-store.js';
import { describeGit, mkTempDir, removeTempDir, testGit } from '../helpers/git.js';
import { scopeOf } from '../../src/tenancy/scope.js';
import { canSymlink } from '../helpers/symlink.js';

/** Any tenant: most of these cases are about one workspace id, not tenants. */
const LOCK_SCOPE = scopeOf({ id: '00000000-0000-4000-8000-000000000001', slug: 'default' });
const OTHER_SCOPE = scopeOf({ id: '00000000-0000-4000-8000-000000000002', slug: 'other' });

const ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const OTHER = '01J8ZC5Q0V7R3T9XK2M4N6P8QB';

describeGit('RepoStore', () => {
  let dataDir: string;
  let store: RepoStore;
  beforeEach(async () => {
    dataDir = await mkTempDir();
    await RepoStore.prepare(dataDir);
    store = new RepoStore({ git: testGit(join(dataDir, NO_HOOKS_DIR)), dataDir });
  });
  afterEach(() => removeTempDir(dataDir));

  it('prepare creates tenants/ and an empty no-hooks/ only (spec §19.6)', () => {
    expect(readdirSync(dataDir).sort()).toEqual([NO_HOOKS_DIR, 'tenants']);
    expect(readdirSync(join(dataDir, NO_HOOKS_DIR))).toEqual([]);
    expect(readdirSync(join(dataDir, 'tenants'))).toEqual([]);
  });

  it("lands a new workspace's repository under its tenant", async () => {
    await store.create(LOCK_SCOPE, ID);
    const dir = join(dataDir, 'tenants', LOCK_SCOPE.tenantId, 'repos', `${ID}.git`);
    expect(store.path(LOCK_SCOPE, ID)).toBe(dir);
    expect(existsSync(join(dir, 'HEAD'))).toBe(true);
    expect(readdirSync(dataDir).sort()).toEqual([NO_HOOKS_DIR, 'tenants']);
  });

  it('gives one workspace id in two tenants two repositories, each created, found and removed on its own', async () => {
    await store.create(LOCK_SCOPE, ID);
    expect(await store.exists(OTHER_SCOPE, ID)).toBe(false);
    await store.create(OTHER_SCOPE, ID);
    expect(store.path(LOCK_SCOPE, ID)).not.toBe(store.path(OTHER_SCOPE, ID));
    expect(await store.exists(LOCK_SCOPE, ID)).toBe(true);
    expect(await store.exists(OTHER_SCOPE, ID)).toBe(true);
    await store.remove(LOCK_SCOPE, ID);
    expect(await store.exists(LOCK_SCOPE, ID)).toBe(false);
    expect(await store.exists(OTHER_SCOPE, ID)).toBe(true);
    // The moved-away repository is in its own tenant's tmp/, not the other's.
    expect(readdirSync(tenantPaths(dataDir, LOCK_SCOPE).tmp).some((n) => n.startsWith(`removed-${ID}-`))).toBe(true);
    expect(readdirSync(tenantPaths(dataDir, OTHER_SCOPE).tmp).some((n) => n.startsWith('removed-'))).toBe(false);
    expect((await store.tmpDirs()).sort()).toEqual(
      [tenantPaths(dataDir, LOCK_SCOPE).tmp, tenantPaths(dataDir, OTHER_SCOPE).tmp].sort(),
    );
  });

  it.skipIf(!canSymlink)('refuses a tenant whose root is a symlink, and a non-UUID tenant id', async () => {
    const { mkdirSync, symlinkSync } = await import('node:fs');
    mkdirSync(join(dataDir, 'tenants', OTHER_SCOPE.tenantId), { recursive: true });
    symlinkSync(join(dataDir, 'tenants', OTHER_SCOPE.tenantId), join(dataDir, 'tenants', LOCK_SCOPE.tenantId), 'dir');
    await expect(store.create(LOCK_SCOPE, ID)).rejects.toMatchObject({ code: 'tenancy-tenant-path-refused' });
    expect(() => store.path(LOCK_SCOPE, ID)).toThrow(expect.objectContaining({ code: 'tenancy-tenant-path-refused' }));
    const bad = scopeOf({ id: '../x', slug: 'x' });
    expect(() => store.path(bad, ID)).toThrow(expect.objectContaining({ code: 'tenancy-tenant-path-refused' }));
    expect(readdirSync(join(dataDir, 'tenants', OTHER_SCOPE.tenantId))).toEqual([]);
  });

  it('creates a bare repository on main with hooks disabled and non-fast-forwards denied', async () => {
    await store.create(LOCK_SCOPE, ID);
    expect(await store.exists(LOCK_SCOPE, ID)).toBe(true);
    const git = testGit(join(dataDir, NO_HOOKS_DIR));
    const dir = store.path(LOCK_SCOPE, ID);
    expect((await git.run(dir, ['symbolic-ref', 'HEAD'])).stdout.trim()).toBe('refs/heads/main');
    expect((await git.run(dir, ['config', 'core.hooksPath'])).stdout.trim()).toBe(join(dataDir, NO_HOOKS_DIR));
    expect((await git.run(dir, ['config', 'receive.denyNonFastForwards'])).stdout.trim()).toBe('true');
    expect((await git.run(dir, ['rev-parse', '--is-bare-repository'])).stdout.trim()).toBe('true');
  });

  it('refuses to create twice and to touch an invalid id', async () => {
    await store.create(LOCK_SCOPE, ID);
    await expect(store.create(LOCK_SCOPE, ID)).rejects.toMatchObject({ code: 'server-repo-exists' });
    for (const bad of ['../etc', 'abc', ID.toLowerCase(), `${ID}/x`]) {
      expect(isWorkspaceId(bad)).toBe(false);
      await expect(store.create(LOCK_SCOPE, bad)).rejects.toMatchObject({ code: 'server-workspace-id-invalid' });
      expect(() => store.path(LOCK_SCOPE, bad)).toThrow();
    }
  });

  it("remove moves the repository under the tenant's tmp/ instead of deleting it", async () => {
    await store.create(LOCK_SCOPE, ID);
    await store.remove(LOCK_SCOPE, ID);
    expect(await store.exists(LOCK_SCOPE, ID)).toBe(false);
    const moved = readdirSync(tenantPaths(dataDir, LOCK_SCOPE).tmp).filter((name) => name.startsWith(`removed-${ID}-`));
    expect(moved).toHaveLength(1);
    expect(existsSync(join(tenantPaths(dataDir, LOCK_SCOPE).tmp, moved[0]!, 'HEAD'))).toBe(true);
  });

  it('withLock serialises callers per workspace in FIFO order and isolates workspaces', async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const a1 = store.withLock(LOCK_SCOPE, ID, async () => {
      order.push('a1-start');
      await gate;
      order.push('a1-end');
      return 1;
    });
    const a2 = store.withLock(LOCK_SCOPE, ID, () => {
      order.push('a2');
      return Promise.resolve(2);
    });
    const b = store.withLock(LOCK_SCOPE, OTHER, () => {
      order.push('b');
      return Promise.resolve(3);
    });
    expect(await b).toBe(3);
    expect(order).toEqual(['a1-start', 'b']);
    releaseFirst();
    expect(await Promise.all([a1, a2])).toEqual([1, 2]);
    expect(order).toEqual(['a1-start', 'b', 'a1-end', 'a2']);
  });

  it('withLock keys on the tenant too: one workspace id in two tenants never serialises (spec §19.8 guard 5)', async () => {
    const other = scopeOf({ id: '00000000-0000-4000-8000-000000000002', slug: 'other' });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = store.withLock(LOCK_SCOPE, ID, () => gate);
    // Would wait for `held` if the queue were keyed by the workspace id alone.
    expect(await store.withLock(other, ID, () => Promise.resolve('other tenant'))).toBe('other tenant');
    let sameTenant = false;
    const queued = store.withLock(LOCK_SCOPE, ID, () => {
      sameTenant = true;
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(sameTenant).toBe(false);
    release();
    await Promise.all([held, queued]);
    expect(sameTenant).toBe(true);
  });

  it('withLock releases the lock when the function throws', async () => {
    await expect(store.withLock(LOCK_SCOPE, ID, () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await store.withLock(LOCK_SCOPE, ID, () => Promise.resolve('ok'))).toBe('ok');
  });

  it("builds under the tenant's tmp/ and renames into place: a failed init leaves nothing at the real path", async () => {
    const real = testGit(join(dataDir, NO_HOOKS_DIR));
    const failing = {
      run: (dir: string, args: readonly string[]) =>
        args[0] === 'config' ? Promise.reject(new Error('config failed')) : real.run(dir, args),
    } as unknown as GitCli;
    const broken = new RepoStore({ git: failing, dataDir });
    await expect(broken.create(LOCK_SCOPE, ID)).rejects.toThrow('config failed');
    expect(existsSync(store.path(LOCK_SCOPE, ID))).toBe(false);
    expect(await store.exists(LOCK_SCOPE, ID)).toBe(false);
    // The failed attempt's staging directory stays in tmp/ (the store never deletes); a retry works.
    expect(
      readdirSync(tenantPaths(dataDir, LOCK_SCOPE).tmp).filter((name) => name.startsWith(`creating-${ID}-`)),
    ).toHaveLength(1);
    await store.create(LOCK_SCOPE, ID);
    expect(await store.exists(LOCK_SCOPE, ID)).toBe(true);
    expect(
      readdirSync(tenantPaths(dataDir, LOCK_SCOPE).tmp).filter((name) => name.startsWith(`creating-${ID}-`)),
    ).toHaveLength(1);
  });

  it('drain waits for running and queued work, whatever its outcome, then refuses new work with a 503', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done: string[] = [];
    const running = store.withLock(LOCK_SCOPE, ID, async () => {
      await gate;
      done.push('running');
    });
    // Caught at once, so its rejection is never unhandled while the drain is pending.
    const failing = store
      .withLock(LOCK_SCOPE, ID, () => Promise.reject(new Error('boom')))
      .catch((error: unknown) => error);
    const queued = store.withLock(LOCK_SCOPE, ID, () => {
      done.push('queued');
      return Promise.resolve();
    });
    const other = store.withLock(LOCK_SCOPE, OTHER, async () => {
      await gate;
      done.push('other');
    });
    let drained = false;
    const draining = store.drain().then(() => {
      drained = true;
    });

    // Refused as a rejected promise (never a throw), for every workspace, as soon as the drain began.
    await expect(store.withLock(LOCK_SCOPE, ID, () => Promise.resolve('late'))).rejects.toMatchObject({
      code: 'server-shutting-down',
      details: { status: 503 },
    });
    await expect(store.withLock(LOCK_SCOPE, OTHER, () => Promise.resolve('late'))).rejects.toMatchObject({
      code: 'server-shutting-down',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drained).toBe(false);

    release();
    await draining;
    expect(drained).toBe(true);
    expect([...done].sort()).toEqual(['other', 'queued', 'running']);
    expect(await failing).toMatchObject({ message: 'boom' });
    await Promise.all([running, queued, other]);
  });

  it('drain resolves at once when nothing is queued, and again when called twice', async () => {
    await store.drain();
    await store.drain();
    await expect(store.withLock(LOCK_SCOPE, ID, () => Promise.resolve(1))).rejects.toMatchObject({
      code: 'server-shutting-down',
    });
    // An invalid id is still a programming error, thrown before the drain check.
    expect(() => store.withLock(LOCK_SCOPE, '../etc', () => Promise.resolve(1))).toThrow();
  });
});
