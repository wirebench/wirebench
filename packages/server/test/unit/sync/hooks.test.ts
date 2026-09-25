import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { SyncPushCommit } from '@wirebench/engine';
import { NO_HOOKS_DIR, RepoStore } from '../../../src/repos/repo-store.js';
import { CommitStore } from '../../../src/sync/commit-store.js';
import { describeGit, gitLocation, mkTempDir, removeTempDir, testGit } from '../../helpers/git.js';

const ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const HOOKS = ['reference-transaction', 'post-update'] as const;
const execFileAsync = promisify(execFile);

const edit = (content: string): SyncPushCommit => ({
  subject: `Set ${content}`,
  at: '2026-09-24T12:00:00.000Z',
  changes: [{ path: 'workspace.yaml', encoding: 'utf8', content }],
});

describeGit('repository hooks never run (§6, R11)', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkTempDir();
  });
  afterEach(() => removeTempDir(dataDir));

  it('planted reference-transaction and post-update hooks fire for plain git but never during appendCommits', async () => {
    await RepoStore.prepare(dataDir);
    const git = testGit(join(dataDir, NO_HOOKS_DIR));
    const repos = new RepoStore({ git, dataDir });
    await repos.create(ID);
    const store = new CommitStore({
      git: git.withPlumbing(),
      repos,
      tmpDir: join(dataDir, 'tmp'),
      limitBytes: 1024 * 1024,
    });
    const author = { name: 'Ed', email: 'ed@example.com' };
    const first = await store.appendCommits(ID, null, [edit('one')], author);

    const dir = repos.path(ID);
    await git.run(dir, ['config', '--unset', 'core.hooksPath']);
    const marker = join(dataDir, 'hook-ran');
    await mkdir(join(dir, 'hooks'), { recursive: true });
    for (const name of HOOKS) {
      await writeFile(join(dir, 'hooks', name), `#!/bin/sh\necho ${name} >> "${marker.replaceAll('\\', '/')}"\n`, {
        mode: 0o755,
      });
    }

    // Control: plain git, with no hooks guard and an empty global config, runs the planted hook.
    await execFileAsync(gitLocation!.path, ['update-ref', 'refs/heads/control', first.head], {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dataDir, '.gitconfig-none') },
    });
    expect(await readFile(marker, 'utf8')).toContain('reference-transaction');
    await rm(marker);

    const second = await store.appendCommits(ID, first.head, [edit('two')], author);
    expect(await store.head(ID)).toBe(second.head);
    expect(existsSync(marker)).toBe(false);
  });
});
