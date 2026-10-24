/**
 * Per-path history (API Overview spec §3.2): `GitBackend.pathLog` lists only the commits that touched
 * one folder, and a backend without per-path history leaves the method out, which `SyncService`
 * reports as `undefined`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_GIT_SHARE_SETTINGS, type GitShareSettings } from '@wirebench/engine';
import { FolderBackend } from '../../src/main/sync/folder-backend.js';
import { GitBackend } from '../../src/main/sync/git-backend.js';
import { describeGit, hermeticGitEnv, makeTestGitCli, mkTempDir, removeTempDir } from './git-fixture.js';

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await removeTempDir(root);
  root = undefined;
});

const settings = (): GitShareSettings => ({ ...DEFAULT_GIT_SHARE_SETTINGS, branch: 'main' });

async function touch(tree: string, path: string, text: string): Promise<void> {
  await mkdir(join(tree, path, '..'), { recursive: true });
  await writeFile(join(tree, path), text, 'utf8');
}

describeGit('GitBackend.pathLog', () => {
  it('lists only the commits that touched the folder, newest first, up to the limit', async () => {
    root = await mkTempDir('wirebench-pathlog-');
    const tree = join(root, 'tree');
    const hooks = join(root, 'hooks');
    await mkdir(tree, { recursive: true });
    await mkdir(hooks, { recursive: true });
    const git = makeTestGitCli(hooks, await hermeticGitEnv(root));
    await GitBackend.init(git, tree, 'main');
    const backend = new GitBackend({ git, tree, settings });
    await backend.setIdentity('Alice', 'alice@example.com');

    await touch(tree, 'projects/caas/apis/Cards API/api.yaml', 'name: Cards\n');
    await backend.commit('Add the Cards API');
    await touch(tree, 'projects/caas/apis/Ledger/api.yaml', 'name: Ledger\n');
    await backend.commit('Add the Ledger API');
    await touch(tree, 'projects/caas/apis/Cards API/requests/issue.yaml', 'method: POST\n');
    await backend.commit('Cards: issue a card');

    const cards = await backend.pathLog('projects/caas/apis/Cards API', 10);
    expect(cards.map((entry) => entry.subject)).toEqual(['Cards: issue a card', 'Add the Cards API']);
    expect(cards[0]?.author).toBe('Alice');
    expect(Number.isNaN(Date.parse(cards[0]?.at ?? ''))).toBe(false);

    const ledger = await backend.pathLog('projects/caas/apis/Ledger', 10);
    expect(ledger.map((entry) => entry.subject)).toEqual(['Add the Ledger API']);

    expect(await backend.pathLog('projects/caas/apis/Cards API', 1)).toHaveLength(1);
    expect(await backend.pathLog('projects/caas/apis/Nothing here', 10)).toEqual([]);
  });

  it('answers an empty list before the first commit', async () => {
    root = await mkTempDir('wirebench-pathlog-');
    const tree = join(root, 'tree');
    const hooks = join(root, 'hooks');
    await mkdir(tree, { recursive: true });
    await mkdir(hooks, { recursive: true });
    const git = makeTestGitCli(hooks, await hermeticGitEnv(root));
    await GitBackend.init(git, tree, 'main');
    const backend = new GitBackend({ git, tree, settings });

    await expect(backend.pathLog('apis/Cards', 5)).resolves.toEqual([]);
  });
});

describe('a backend without per-path history', () => {
  it('leaves pathLog out', () => {
    expect(new FolderBackend().pathLog).toBeUndefined();
  });
});
