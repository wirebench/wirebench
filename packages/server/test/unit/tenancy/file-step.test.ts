/**
 * The file step's pre-flight and moves without a database (hosted edition spec §19.10), so they run on every OS the
 * server's unit tests run on, Windows included: the moves, the conflict and cross-device refusals before anything
 * moves, the prefix scan over the state files only, in every spelling a writer uses, and the size cap.
 */
import { lstat, mkdir, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moveFiles, planMove } from '../../../src/tenancy/file-step.js';
import { renameWithRetry } from '../../../src/tenancy/rename.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';

const T = '00000000-0000-4000-8000-0000000000aa';
const USER = '01JB3Z9K7Q4ZJ6X1V8W2M5N0PA';
const WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';

async function tree(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).map((p) => p.split('\\').join('/')).sort();
}

describe('the file step without a database', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkTempDir('wbs-file-step-unit-');
    await mkdir(join(dataDir, 'repos', `${WS}.git`), { recursive: true });
    await mkdir(join(dataDir, 'checkouts', USER, 'workspaces', WS, 'tree'), { recursive: true });
    await writeFile(join(dataDir, 'checkouts', USER, 'workspace-state.json'), '{"version":1}');
    await mkdir(join(dataDir, 'tmp', `removed-${WS}-1`), { recursive: true });
    await mkdir(join(dataDir, 'tmp', USER), { recursive: true });
  });
  afterEach(() => removeTempDir(dataDir));

  it('moves repos/ and checkouts/, keeps removed-… and deletes the rest of tmp/', async () => {
    const plan = await moveFiles(dataDir, T);
    expect(plan.empty).toBe(false);
    expect((await readdir(dataDir)).sort()).toEqual(['tenants']);
    expect((await readdir(join(dataDir, 'tenants', T))).sort()).toEqual(['checkouts', 'repos', 'tmp']);
    expect(await readdir(join(dataDir, 'tenants', T, 'tmp'))).toEqual([`removed-${WS}-1`]);
  });

  it('reports an empty data directory as empty, and one already moved as not', async () => {
    const empty = await mkTempDir('wbs-file-step-empty-');
    try {
      expect((await planMove(empty, T)).empty).toBe(true);
    } finally {
      await removeTempDir(empty);
    }
    await moveFiles(dataDir, T);
    expect((await planMove(dataDir, T)).empty).toBe(false);
  });

  it('refuses a source on another filesystem before anything moves, naming it', async () => {
    const before = await tree(dataDir);
    const real = async (path: string) => (await lstat(path).catch(() => undefined))?.dev;
    const fs = {
      // checkouts/ is a mount point: another device than the data directory's.
      device: async (path: string) => (path === join(dataDir, 'checkouts') ? -1 : real(path)),
      isLink: () => Promise.resolve(false),
      rename: renameWithRetry,
    };
    const error = await moveFiles(dataDir, T, { fs }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'tenancy-move-cross-device' });
    expect((error as Error).message).toContain('checkouts');
    expect((error as Error).message).not.toContain('repos');
    expect(await tree(dataDir)).toEqual(before);
  });

  it('compares against the tenant root when it exists: a root on its own mount refuses too (fix-round review m3)', async () => {
    await mkdir(join(dataDir, 'tenants', T), { recursive: true });
    const before = await tree(dataDir);
    const real = async (path: string) => (await lstat(path).catch(() => undefined))?.dev;
    const fs = {
      device: async (path: string) => (path === join(dataDir, 'tenants', T) ? -1 : real(path)),
      isLink: () => Promise.resolve(false),
      rename: renameWithRetry,
    };
    const error = await moveFiles(dataDir, T, { fs }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'tenancy-move-cross-device' });
    expect(await tree(dataDir)).toEqual(before);
  });

  it('refuses a source that is a symbolic link before anything moves, naming it (fix-round review I1)', async () => {
    const big = await mkTempDir('wbs-file-step-big-');
    try {
      await rename(join(dataDir, 'repos'), join(big, 'repos'));
      await symlink(join(big, 'repos'), join(dataDir, 'repos'), 'dir');
      const before = await tree(dataDir);
      const error = await moveFiles(dataDir, T).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'tenancy-move-link' });
      expect((error as Error).message).toContain('repos/');
      expect((error as Error).message).toContain('is a symbolic link');
      expect(await tree(dataDir)).toEqual(before);
      expect((await lstat(join(dataDir, 'repos'))).isSymbolicLink()).toBe(true);
    } finally {
      await removeTempDir(big);
    }
  });

  it('refuses both locations present before anything moves', async () => {
    await mkdir(join(dataDir, 'tenants', T, 'checkouts'), { recursive: true });
    const before = await tree(dataDir);
    await expect(moveFiles(dataDir, T)).rejects.toMatchObject({ code: 'tenancy-move-conflict' });
    expect(await tree(dataDir)).toEqual(before);
  });

  it('finds the old prefix in a state file as JSON writes it, on this OS, before anything moves', async () => {
    // JSON escapes each backslash of a Windows path; on POSIX the string is the path itself.
    const linked = join(dataDir, 'checkouts', USER, 'projects', 'linked');
    await writeFile(join(dataDir, 'checkouts', USER, 'workspace-state.json'), JSON.stringify({ linked }));
    const before = await tree(dataDir);
    const error = await moveFiles(dataDir, T).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'tenancy-prefix-found' });
    expect((error as Error).message).toContain(`${USER}/workspace-state.json`);
    expect(await tree(dataDir)).toEqual(before);
  });

  it('reads only the state files: history, session logs and drafts may mention the path', async () => {
    const prefix = join(dataDir, 'checkouts');
    for (const dir of ['history', 'session-logs', 'unsaved', 'cookie-jars']) {
      await mkdir(join(dataDir, 'checkouts', USER, dir), { recursive: true });
      await writeFile(join(dataDir, 'checkouts', USER, dir, 'x.txt'), `ls ${prefix}/`);
    }
    await writeFile(join(dataDir, 'checkouts', USER, 'workspaces', WS, 'tree', 'notes.txt'), prefix);
    await expect(moveFiles(dataDir, T)).resolves.toMatchObject({ skipped: [] });
  });

  it('skips a state file over 8 MiB without calling it a match, and says which', async () => {
    const big = join(dataDir, 'checkouts', USER, 'workspaces', WS, 'share.yaml');
    await writeFile(big, `path: ${join(dataDir, 'checkouts')}\n${'x'.repeat(9 * 1024 * 1024)}`);
    const plan = await moveFiles(dataDir, T);
    expect(plan.skipped).toEqual([`${USER}/workspaces/${WS}/share.yaml`]);
  });

  it('names at most 20 files in a refusal, then how many more', async () => {
    for (let i = 0; i < 25; i += 1) {
      const id = `${WS.slice(0, 24)}${String(i).padStart(2, '0')}`;
      await mkdir(join(dataDir, 'checkouts', USER, 'workspaces', id), { recursive: true });
      await writeFile(join(dataDir, 'checkouts', USER, 'workspaces', id, 'share.yaml'), join(dataDir, 'checkouts'));
    }
    const error = await moveFiles(dataDir, T).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain('and 5 more');
  });
});

describe('renameWithRetry', () => {
  it('retries a transient EBUSY and gives up on anything else', async () => {
    let calls = 0;
    const flaky = (): Promise<void> => {
      calls += 1;
      return calls < 3 ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) : Promise.resolve();
    };
    await renameWithRetry('a', 'b', { rename: flaky, delay: () => Promise.resolve() });
    expect(calls).toBe(3);
    const fatal = () => Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    await expect(renameWithRetry('a', 'b', { rename: fatal, delay: () => Promise.resolve() })).rejects.toThrow('gone');
  });
});
