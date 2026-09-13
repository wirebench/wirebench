// @vitest-environment node
/**
 * Runs the same assertions against `GitBackend` (real system git, a temp bare remote and two
 * clones) and `FakeServerBackend` (one in-memory shared "remote", two clients) — proving the
 * `SyncBackend` contract itself rather than either implementation. Spec 2's server backend will
 * later have to pass this same suite.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitShareSettings } from '@wirebench/engine';
import { DEFAULT_GIT_SHARE_SETTINGS } from '@wirebench/engine';
import type { SyncBackend } from '../../src/main/sync/backend.js';
import { GitBackend } from '../../src/main/sync/git-backend.js';
import { createFakeServerPair } from './fake-server-backend.js';
import {
  createBareRemote,
  describeGit,
  hermeticGitEnv,
  makeTestGitCli,
  mkTempDir,
  removeTempDir,
} from './git-fixture.js';

/** What each factory below hands the shared test bodies: two backends over one shared remote. */
interface Fixture {
  readonly a: SyncBackend;
  readonly b: SyncBackend;
  writeA(path: string, content: string): Promise<void>;
  writeB(path: string, content: string): Promise<void>;
  readB(path: string): Promise<string | undefined>;
  cleanup(): Promise<void>;
}

async function ensureWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function makeFake(): Promise<Fixture> {
  const { a, b } = createFakeServerPair();
  await a.setIdentity('Alice', 'alice@example.com');
  await b.setIdentity('Bob', 'bob@example.com');
  return {
    a,
    b,
    writeA(path, content) {
      a.write(path, content);
      return Promise.resolve();
    },
    writeB(path, content) {
      b.write(path, content);
      return Promise.resolve();
    },
    readB(path) {
      return Promise.resolve(b.read(path));
    },
    cleanup() {
      // Nothing to release — everything lives on the JS heap.
      return Promise.resolve();
    },
  };
}

/**
 * A temp bare remote plus two clones, both already carrying one shared "initial" commit (a real
 * clone needs at least one commit to check a branch out) — that baseline is what "fresh probe is
 * clean" below is asserting about, not an untouched `git init`.
 */
async function makeGit(): Promise<Fixture> {
  const root = await mkTempDir();
  const remoteDir = join(root, 'remote.git');
  const treeA = join(root, 'a-tree');
  const treeB = join(root, 'b-tree');
  const hooksDir = join(root, 'hooks');
  await mkdir(hooksDir, { recursive: true });
  const env = await hermeticGitEnv(root);
  const git = makeTestGitCli(hooksDir, env);

  const bare = await createBareRemote(git, remoteDir);
  await GitBackend.init(git, treeA, 'main');
  await git.run(treeA, ['remote', 'add', 'origin', bare.url]);

  const settings: GitShareSettings = { ...DEFAULT_GIT_SHARE_SETTINGS, branch: 'main' };
  const a = new GitBackend({ git, tree: treeA, settings: () => settings });
  await a.setIdentity('Alice', 'alice@example.com');
  await ensureWrite(join(treeA, 'environments', 'qa.yaml'), 'name: QA\n');
  await a.commit('Initial commit');
  await a.push();

  await GitBackend.clone(git, bare.url, 'main', treeB);
  const b = new GitBackend({ git, tree: treeB, settings: () => settings });
  await b.setIdentity('Bob', 'bob@example.com');

  return {
    a,
    b,
    async writeA(path, content) {
      await ensureWrite(join(treeA, path), content);
    },
    async writeB(path, content) {
      await ensureWrite(join(treeB, path), content);
    },
    async readB(path) {
      return readIfExists(join(treeB, path));
    },
    async cleanup() {
      await removeTempDir(root);
    },
  };
}

function defineContract(factory: () => Promise<Fixture>): void {
  let fixture: Fixture;

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('reports a fresh clean status for both sides', async () => {
    fixture = await factory();
    expect(await fixture.a.probe()).toMatchObject({ state: 'clean', ahead: 0, behind: 0 });
    expect(await fixture.b.probe()).toMatchObject({ state: 'clean', ahead: 0, behind: 0 });
  });

  it('runs the full pull/merge/conflict lifecycle', async () => {
    fixture = await factory();
    const { a, b } = fixture;

    // A commits a new file — locally ahead, not yet visible to B.
    await fixture.writeA('environments/staging.yaml', 'name: Staging\n');
    expect(await a.commit('Add staging environment')).toEqual({ committed: true });
    expect(await a.probe()).toMatchObject({ ahead: 1 });
    await a.push();
    expect(await a.probe()).toMatchObject({ ahead: 0, state: 'clean' });

    // B doesn't see it until it fetches.
    expect(await b.probe()).toMatchObject({ behind: 0 });
    await b.fetch();
    expect(await b.probe()).toMatchObject({ behind: 1 });

    // Merging pulls the new file in cleanly.
    const merged = await b.merge();
    expect(merged.conflicts).toEqual([]);
    expect(merged.changedPaths).toContain('environments/staging.yaml');
    expect(await b.probe()).toMatchObject({ state: 'clean', ahead: 0, behind: 0 });

    // Both sides now commit a divergent change to the same file since their common ancestor —
    // a genuine conflict (an uncommitted-only edit on B would just make a plain `git merge`
    // refuse outright, never enter a conflicted state, so B commits its side first).
    await fixture.writeA('environments/qa.yaml', 'name: QA\nurl: https://a.example\n');
    await a.commit('Update QA (A)');
    await a.push();

    await fixture.writeB('environments/qa.yaml', 'name: QA\nurl: https://b.example\n');
    await b.commit('Update QA (B)');
    await b.fetch();
    const conflict = await b.merge();
    expect(conflict.changedPaths).toEqual([]);
    expect(conflict.conflicts).toHaveLength(1);
    expect(conflict.conflicts[0]).toMatchObject({
      path: 'environments/qa.yaml',
      entity: { kind: 'environment', name: 'qa' },
    });
    expect(await b.probe()).toMatchObject({ state: 'conflict' });
    expect(await b.conflicts()).toEqual(conflict.conflicts);

    // Resolving with "theirs" and finishing the merge lands on A's content, with nothing left
    // in conflict or behind the remote (B is left ahead by its own now-superseded commit(s)
    // until it pushes — that part is exactly what `push` is for, not asserted here).
    await b.resolve('environments/qa.yaml', 'theirs');
    await b.finishMerge();
    expect(await b.conflicts()).toEqual([]);
    expect(await b.probe()).toMatchObject({ behind: 0 });
    expect(await fixture.readB('environments/qa.yaml')).toBe('name: QA\nurl: https://a.example\n');

    // Nothing left to commit.
    expect(await b.commit('nothing to see here')).toEqual({ committed: false });

    // History and identity.
    const log = await a.log(2);
    expect(log.map((entry) => entry.subject)).toEqual(['Update QA (A)', 'Add staging environment']);
    expect(await a.identity()).toEqual({ name: 'Alice', email: 'alice@example.com' });
  });

  it('aborts a merge back to the pre-merge content', async () => {
    fixture = await factory();
    const { a, b } = fixture;

    await fixture.writeA('environments/qa.yaml', 'name: QA\nurl: https://a.example\n');
    await a.commit('Update QA (A)');
    await a.push();

    const beforeMergeContent = 'name: QA\nurl: https://pre-merge.example\n';
    await fixture.writeB('environments/qa.yaml', beforeMergeContent);
    await b.commit('Update QA (B, to be aborted)');
    await b.fetch();
    const merged = await b.merge();
    expect(merged.conflicts).toHaveLength(1);

    await b.abortMerge();
    expect(await b.conflicts()).toEqual([]);
    expect(await fixture.readB('environments/qa.yaml')).toBe(beforeMergeContent);
  });
}

describe('fake-server backend contract', () => {
  defineContract(makeFake);
});

describeGit('git backend contract', () => {
  defineContract(makeGit);
});
