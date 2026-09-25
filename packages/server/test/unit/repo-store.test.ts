import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { GitCli } from '@wirebench/engine';
import { isWorkspaceId, NO_HOOKS_DIR, RepoStore } from '../../src/repos/repo-store.js';
import { describeGit, mkTempDir, removeTempDir, testGit } from '../helpers/git.js';

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

  it('prepare creates repos/, tmp/ and an empty no-hooks/', () => {
    expect(readdirSync(dataDir).sort()).toEqual([NO_HOOKS_DIR, 'repos', 'tmp']);
    expect(readdirSync(join(dataDir, NO_HOOKS_DIR))).toEqual([]);
  });

  it('creates a bare repository on main with hooks disabled and non-fast-forwards denied', async () => {
    await store.create(ID);
    expect(await store.exists(ID)).toBe(true);
    const git = testGit(join(dataDir, NO_HOOKS_DIR));
    const dir = store.path(ID);
    expect((await git.run(dir, ['symbolic-ref', 'HEAD'])).stdout.trim()).toBe('refs/heads/main');
    expect((await git.run(dir, ['config', 'core.hooksPath'])).stdout.trim()).toBe(join(dataDir, NO_HOOKS_DIR));
    expect((await git.run(dir, ['config', 'receive.denyNonFastForwards'])).stdout.trim()).toBe('true');
    expect((await git.run(dir, ['rev-parse', '--is-bare-repository'])).stdout.trim()).toBe('true');
  });

  it('refuses to create twice and to touch an invalid id', async () => {
    await store.create(ID);
    await expect(store.create(ID)).rejects.toMatchObject({ code: 'server-repo-exists' });
    for (const bad of ['../etc', 'abc', ID.toLowerCase(), `${ID}/x`]) {
      expect(isWorkspaceId(bad)).toBe(false);
      await expect(store.create(bad)).rejects.toMatchObject({ code: 'server-workspace-id-invalid' });
      expect(() => store.path(bad)).toThrow();
    }
  });

  it('remove moves the repository under tmp/ instead of deleting it', async () => {
    await store.create(ID);
    await store.remove(ID);
    expect(await store.exists(ID)).toBe(false);
    const moved = readdirSync(join(dataDir, 'tmp')).filter((name) => name.startsWith(`removed-${ID}-`));
    expect(moved).toHaveLength(1);
    expect(existsSync(join(dataDir, 'tmp', moved[0]!, 'HEAD'))).toBe(true);
  });

  it('withLock serialises callers per workspace in FIFO order and isolates workspaces', async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const a1 = store.withLock(ID, async () => {
      order.push('a1-start');
      await gate;
      order.push('a1-end');
      return 1;
    });
    const a2 = store.withLock(ID, () => {
      order.push('a2');
      return Promise.resolve(2);
    });
    const b = store.withLock(OTHER, () => {
      order.push('b');
      return Promise.resolve(3);
    });
    expect(await b).toBe(3);
    expect(order).toEqual(['a1-start', 'b']);
    releaseFirst();
    expect(await Promise.all([a1, a2])).toEqual([1, 2]);
    expect(order).toEqual(['a1-start', 'b', 'a1-end', 'a2']);
  });

  it('withLock releases the lock when the function throws', async () => {
    await expect(store.withLock(ID, () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await store.withLock(ID, () => Promise.resolve('ok'))).toBe('ok');
  });

  it('builds under tmp/ and renames into place: a failed init leaves nothing at the real path', async () => {
    const real = testGit(join(dataDir, NO_HOOKS_DIR));
    const failing = {
      run: (dir: string, args: readonly string[]) =>
        args[0] === 'config' ? Promise.reject(new Error('config failed')) : real.run(dir, args),
    } as unknown as GitCli;
    const broken = new RepoStore({ git: failing, dataDir });
    await expect(broken.create(ID)).rejects.toThrow('config failed');
    expect(existsSync(store.path(ID))).toBe(false);
    expect(await store.exists(ID)).toBe(false);
    // The failed attempt's staging directory stays in tmp/ (the store never deletes); a retry works.
    expect(readdirSync(join(dataDir, 'tmp')).filter((name) => name.startsWith(`creating-${ID}-`))).toHaveLength(1);
    await store.create(ID);
    expect(await store.exists(ID)).toBe(true);
    expect(readdirSync(join(dataDir, 'tmp')).filter((name) => name.startsWith(`creating-${ID}-`))).toHaveLength(1);
  });

  it('drain waits for running and queued work, whatever its outcome, then refuses new work with a 503', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done: string[] = [];
    const running = store.withLock(ID, async () => {
      await gate;
      done.push('running');
    });
    // Caught at once, so its rejection is never unhandled while the drain is pending.
    const failing = store.withLock(ID, () => Promise.reject(new Error('boom'))).catch((error: unknown) => error);
    const queued = store.withLock(ID, () => {
      done.push('queued');
      return Promise.resolve();
    });
    const other = store.withLock(OTHER, async () => {
      await gate;
      done.push('other');
    });
    let drained = false;
    const draining = store.drain().then(() => {
      drained = true;
    });

    // Refused as a rejected promise (never a throw), for every workspace, as soon as the drain began.
    await expect(store.withLock(ID, () => Promise.resolve('late'))).rejects.toMatchObject({
      code: 'server-shutting-down',
      details: { status: 503 },
    });
    await expect(store.withLock(OTHER, () => Promise.resolve('late'))).rejects.toMatchObject({
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
    await expect(store.withLock(ID, () => Promise.resolve(1))).rejects.toMatchObject({ code: 'server-shutting-down' });
    // An invalid id is still a programming error, thrown before the drain check.
    expect(() => store.withLock('../etc', () => Promise.resolve(1))).toThrow();
  });
});
