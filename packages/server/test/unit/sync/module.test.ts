import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { NO_HOOKS_DIR, RepoStore } from '../../../src/repos/repo-store.js';
import { buildServer } from '../../../src/server.js';
import { syncModule } from '../../../src/sync/module.js';
import { tenantPaths } from '../../../src/tenancy/paths.js';
import { scopeOf } from '../../../src/tenancy/scope.js';
import { testContext } from '../../helpers/context.js';
import { describeGit, mkTempDir, removeTempDir, testGit } from '../../helpers/git.js';

const ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const A = scopeOf({ id: '00000000-0000-4000-8000-000000000001', slug: 'default' });
const B = scopeOf({ id: '00000000-0000-4000-8000-000000000002', slug: 'other' });

/** Each tenant's tmp/, made, with a crash's leftover index file in it. */
function leftovers(dataDir: string): string[] {
  return [A, B].map((scope) => {
    const tmp = tenantPaths(dataDir, scope).tmp;
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, `${ID}-0badc0de.idx`), 'left by a crash');
    return tmp;
  });
}

describeGit('syncModule (§5.1)', () => {
  it("is server-sync with no migrations; at start-up it sweeps every tenant's leftover index files and adds the sync capability", async () => {
    const dataDir = await mkTempDir();
    try {
      await RepoStore.prepare(dataDir);
      const [inA, inB] = leftovers(dataDir);
      writeFileSync(join(inA!, 'keep.txt'), 'not ours');
      const git = testGit(join(dataDir, NO_HOOKS_DIR));
      const ctx = await testContext({ dataDir, git, repos: new RepoStore({ git, dataDir }) });
      const sync = syncModule();
      expect(sync.name).toBe('server-sync');
      expect(sync.migrationsDir).toBeUndefined();
      const app = await buildServer(ctx, { modules: [sync] });
      try {
        expect(readdirSync(inA!)).toEqual(['keep.txt']);
        expect(readdirSync(inB!)).toEqual([]);
        const meta = await app.inject({ method: 'GET', url: '/api/v1/meta' });
        expect(meta.json()).toMatchObject({ capabilities: ['sync'] });
      } finally {
        await app.close();
      }
    } finally {
      await removeTempDir(dataDir);
    }
  });

  it('sweeps the absolute tenant tmp dirs even from a relative data dir', async () => {
    const dataDir = await mkTempDir();
    try {
      await RepoStore.prepare(dataDir);
      const tmps = leftovers(dataDir);
      const git = testGit(join(dataDir, NO_HOOKS_DIR));
      // Git resolves GIT_INDEX_FILE against the repository, Node's rm against its own cwd: the store resolves
      // the data directory once, so every tenant's tmp dir it hands out is absolute.
      const repos = new RepoStore({ git, dataDir: relative(process.cwd(), dataDir) });
      expect(repos.tmpDir(A)).toBe(tmps[0]);
      const base = await testContext({ dataDir, git, repos });
      const ctx = { ...base, config: { ...base.config, dataDir: relative(process.cwd(), dataDir) } };
      const app = await buildServer(ctx, { modules: [syncModule()] });
      try {
        for (const tmp of tmps) expect(readdirSync(tmp)).toEqual([]);
      } finally {
        await app.close();
      }
    } finally {
      await removeTempDir(dataDir);
    }
  });
});
