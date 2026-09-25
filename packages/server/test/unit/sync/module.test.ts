import { readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { NO_HOOKS_DIR, RepoStore } from '../../../src/repos/repo-store.js';
import { buildServer } from '../../../src/server.js';
import { syncModule } from '../../../src/sync/module.js';
import { testContext } from '../../helpers/context.js';
import { describeGit, mkTempDir, removeTempDir, testGit } from '../../helpers/git.js';

const ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';

describeGit('syncModule (§5.1)', () => {
  it('is server-sync with no migrations; at start-up it sweeps leftover index files and adds the sync capability', async () => {
    const dataDir = await mkTempDir();
    try {
      await RepoStore.prepare(dataDir);
      writeFileSync(join(dataDir, 'tmp', `${ID}-0badc0de.idx`), 'left by a crash');
      writeFileSync(join(dataDir, 'tmp', 'keep.txt'), 'not ours');
      const git = testGit(join(dataDir, NO_HOOKS_DIR));
      const ctx = await testContext({ dataDir, git, repos: new RepoStore({ git, dataDir }) });
      const sync = syncModule();
      expect(sync.name).toBe('server-sync');
      expect(sync.migrationsDir).toBeUndefined();
      const app = await buildServer(ctx, { modules: [sync] });
      try {
        expect(readdirSync(join(dataDir, 'tmp'))).toEqual(['keep.txt']);
        const meta = await app.inject({ method: 'GET', url: '/api/v1/meta' });
        expect(meta.json()).toMatchObject({ capabilities: ['sync'] });
      } finally {
        await app.close();
      }
    } finally {
      await removeTempDir(dataDir);
    }
  });

  it('hands the commit store an absolute tmp dir even from a relative data dir', async () => {
    const dataDir = await mkTempDir();
    try {
      await RepoStore.prepare(dataDir);
      writeFileSync(join(dataDir, 'tmp', `${ID}-0badc0de.idx`), 'left by a crash');
      const git = testGit(join(dataDir, NO_HOOKS_DIR));
      const base = await testContext({ dataDir, git, repos: new RepoStore({ git, dataDir }) });
      // Git resolves GIT_INDEX_FILE against the repository, Node's rm against its own cwd: a relative
      // tmp dir would name two different places. The store refuses one, so this build would throw.
      const ctx = { ...base, config: { ...base.config, dataDir: relative(process.cwd(), dataDir) } };
      const app = await buildServer(ctx, { modules: [syncModule()] });
      try {
        expect(readdirSync(join(dataDir, 'tmp'))).toEqual([]);
      } finally {
        await app.close();
      }
    } finally {
      await removeTempDir(dataDir);
    }
  });
});
