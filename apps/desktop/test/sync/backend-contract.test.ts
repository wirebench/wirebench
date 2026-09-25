// @vitest-environment node
/**
 * Runs the shared backend contract (`./backend-contract.ts`) against `GitBackend`, with real system
 * git, a temp bare remote and two clones, and against `FakeServerBackend`, with one in-memory shared
 * "remote" and two clients. The server package runs the same suite against two real `ServerBackend`s
 * (server-sync spec §11, O4).
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe } from 'vitest';
import type { GitShareSettings } from '@wirebench/engine';
import { DEFAULT_GIT_SHARE_SETTINGS } from '@wirebench/engine';
import { GitBackend } from '../../src/main/sync/git-backend.js';
import { defineContract, ensureWrite, readIfExists, removeIfExists, type Fixture } from './backend-contract.js';
import { createFakeServerPair } from './fake-server-backend.js';
import {
  createBareRemote,
  describeGit,
  hermeticGitEnv,
  makeTestGitCli,
  mkTempDir,
  removeTempDir,
} from './git-fixture.js';

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
    deleteA(path) {
      a.delete(path);
      return Promise.resolve();
    },
    deleteB(path) {
      b.delete(path);
      return Promise.resolve();
    },
    readA(path) {
      return Promise.resolve(a.read(path));
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
    async deleteA(path) {
      await removeIfExists(join(treeA, path));
    },
    async deleteB(path) {
      await removeIfExists(join(treeB, path));
    },
    async readA(path) {
      return readIfExists(join(treeA, path));
    },
    async readB(path) {
      return readIfExists(join(treeB, path));
    },
    async cleanup() {
      await removeTempDir(root);
    },
  };
}

describe('fake-server backend contract', () => {
  defineContract(makeFake);
});

// Each case runs dozens of real git processes; process start-up on hosted Windows runners
// takes several times longer than elsewhere, well past the 5 s default.
describeGit('git backend contract', { timeout: 30_000 }, () => {
  defineContract(makeGit);
});
