// @vitest-environment node
/**
 * Unit-level coverage for `GitBackend`'s own parsing and branching logic: most cases run against
 * a mocked `Runner` (no real git process, no `describeGit` guard needed) so they're fast and
 * exercise exact `git` output shapes precisely; the filesystem/hooks-dependent cases at the
 * bottom run against a real git and are skipped (loudly) only when this machine has none.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitShareSettings } from '@wirebench/engine';
import { DEFAULT_GIT_SHARE_SETTINGS } from '@wirebench/engine';
import { GitBackend } from '../../src/main/sync/git-backend.js';
import { GitCli, type Runner } from '../../src/main/sync/git-cli.js';
import {
  createBareRemote,
  describeGit,
  hermeticGitEnv,
  makeTestGitCli,
  mkTempDir,
  removeTempDir,
} from './git-fixture.js';

/** Strips the fixed `-c core.autocrlf=false -c merge.conflictstyle=merge -c core.hooksPath=<dir>` prefix `GitCli.run` always adds. */
function realArgs(fullArgs: readonly string[]): string[] {
  return [...fullArgs].slice(6);
}

/** A `Runner` driven by a small per-call resolver, with `config --get core.sshCommand` (which every `GitCli.run` call probes once per cwd) answered "unset" automatically. */
function mockRunner(
  resolve: (args: readonly string[]) => { stdout?: string; stderr?: string; exitCode?: number },
): Runner {
  return (_file, fullArgs) => {
    const args = realArgs(fullArgs);
    if (args[0] === 'config' && args.includes('core.sshCommand')) {
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 });
    }
    const result = resolve(args);
    return Promise.resolve({
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 0,
    });
  };
}

const settings = (): GitShareSettings => ({ ...DEFAULT_GIT_SHARE_SETTINGS, branch: 'main' });

describe('GitBackend (mocked runner)', () => {
  let tree: string;

  beforeEach(async () => {
    tree = await mkdtemp(join(tmpdir(), 'wirebench-sync-unit-'));
  });

  afterEach(async () => {
    await rm(tree, { recursive: true, force: true });
  });

  it('parses status --porcelain=v2, including a rename and a conflict', async () => {
    const statusOutput = [
      '1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb environments/qa.yaml',
      '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 projects/api/wirebench.yaml\tprojects/old/wirebench.yaml',
      'u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb cccccc environments/staging.yaml',
      '? environments/new.yaml',
      '',
    ].join('\n');
    const runner = mockRunner((args) => {
      if (args[0] === 'status') {
        return { stdout: statusOutput };
      }
      throw new Error(`unexpected args ${JSON.stringify(args)}`);
    });
    const cli = new GitCli({ path: 'git', version: '2.55.0' }, { hooksDir: tree, run: runner });
    const backend = new GitBackend({ git: cli, tree, settings });

    const changes = await backend.changedPaths();
    expect(changes).toEqual([
      { path: 'environments/qa.yaml', status: 'modified' },
      { path: 'projects/api/wirebench.yaml', status: 'modified' },
      { path: 'environments/staging.yaml', status: 'modified' },
      { path: 'environments/new.yaml', status: 'added' },
    ]);
  });

  it('computes ahead/behind from `rev-list --left-right --count`', async () => {
    const runner = mockRunner((args) => {
      if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) {
        return { stdout: 'true\n' };
      }
      if (args[0] === 'status') {
        return { stdout: '' };
      }
      if (args[0] === 'remote') {
        return { stdout: 'https://example.com/repo.git\n' };
      }
      if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) {
        return { stdout: 'main\n' };
      }
      if (args[0] === 'rev-list') {
        expect(args).toContain('HEAD...origin/main');
        return { stdout: '3\t2\n' };
      }
      throw new Error(`unexpected args ${JSON.stringify(args)}`);
    });
    const cli = new GitCli({ path: 'git', version: '2.55.0' }, { hooksDir: tree, run: runner });
    const backend = new GitBackend({ git: cli, tree, settings });

    const status = await backend.probe();
    expect(status).toMatchObject({
      ahead: 3,
      behind: 2,
      state: 'diverged',
      remote: 'https://example.com/repo.git',
      branch: 'main',
    });
  });

  it('reports "git-not-a-repository" without throwing when rev-parse fails', async () => {
    const runner = mockRunner((args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 };
      }
      throw new Error(`unexpected args ${JSON.stringify(args)}`);
    });
    const cli = new GitCli({ path: 'git', version: '2.55.0' }, { hooksDir: tree, run: runner });
    const backend = new GitBackend({ git: cli, tree, settings });

    await expect(backend.probe()).resolves.toEqual({
      kind: 'git',
      gitAvailable: true,
      state: 'error',
      ahead: 0,
      behind: 0,
      uncommitted: 0,
      error: { code: 'git-not-a-repository', message: 'This folder is not a git repository.' },
    });
  });

  it("parses `git log`'s NUL-delimited format", async () => {
    const runner = mockRunner((args) => {
      if (args[0] === 'log') {
        return {
          stdout: [
            'aaa111\x00Update QA\x00Alice\x002026-09-13T10:00:00+00:00',
            'bbb222\x00Add staging environment\x00Bob\x002026-09-12T10:00:00+00:00',
            '',
          ].join('\n'),
        };
      }
      throw new Error(`unexpected args ${JSON.stringify(args)}`);
    });
    const cli = new GitCli({ path: 'git', version: '2.55.0' }, { hooksDir: tree, run: runner });
    const backend = new GitBackend({ git: cli, tree, settings });

    const log = await backend.log(2);
    expect(log).toEqual([
      { id: 'aaa111', subject: 'Update QA', author: 'Alice', at: '2026-09-13T10:00:00+00:00' },
      { id: 'bbb222', subject: 'Add staging environment', author: 'Bob', at: '2026-09-12T10:00:00+00:00' },
    ]);
  });

  it('returns [] from `log` on an unborn branch', async () => {
    const runner = mockRunner((args) => {
      if (args[0] === 'log') {
        return { stdout: '', stderr: "fatal: your current branch 'main' does not have any commits yet", exitCode: 128 };
      }
      throw new Error(`unexpected args ${JSON.stringify(args)}`);
    });
    const cli = new GitCli({ path: 'git', version: '2.55.0' }, { hooksDir: tree, run: runner });
    const backend = new GitBackend({ git: cli, tree, settings });

    await expect(backend.log(5)).resolves.toEqual([]);
  });

  it('parses identity from `git var GIT_COMMITTER_IDENT`, and reports undefined without one', async () => {
    const runnerWithIdentity = mockRunner((args) => {
      if (args[0] === 'var') {
        return { stdout: 'Alice <alice@example.com> 1700000000 +0000\n' };
      }
      throw new Error(`unexpected args ${JSON.stringify(args)}`);
    });
    const cliWith = new GitCli({ path: 'git', version: '2.55.0' }, { hooksDir: tree, run: runnerWithIdentity });
    const backendWith = new GitBackend({ git: cliWith, tree, settings });
    await expect(backendWith.identity()).resolves.toEqual({ name: 'Alice', email: 'alice@example.com' });

    const runnerWithout = mockRunner((args) => {
      if (args[0] === 'var') {
        return { stdout: '', stderr: 'fatal: no name is set', exitCode: 128 };
      }
      throw new Error(`unexpected args ${JSON.stringify(args)}`);
    });
    const cliWithout = new GitCli({ path: 'git', version: '2.55.0' }, { hooksDir: tree, run: runnerWithout });
    const backendWithout = new GitBackend({ git: cliWithout, tree, settings });
    await expect(backendWithout.identity()).resolves.toBeUndefined();
  });

  it('merge() is a no-op when origin/<branch> does not resolve', async () => {
    const runner = mockRunner((args) => {
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        return { stdout: '', stderr: 'fatal: needed a single revision', exitCode: 128 };
      }
      throw new Error(`unexpected args ${JSON.stringify(args)}`);
    });
    const cli = new GitCli({ path: 'git', version: '2.55.0' }, { hooksDir: tree, run: runner });
    const backend = new GitBackend({ git: cli, tree, settings });

    await expect(backend.merge()).resolves.toEqual({ conflicts: [], changedPaths: [] });
  });

  it('push() throws sync-no-remote when there is no origin', async () => {
    const runner = mockRunner((args) => {
      if (args[0] === 'remote') {
        return { stdout: '', stderr: 'error: No such remote', exitCode: 2 };
      }
      throw new Error(`unexpected args ${JSON.stringify(args)}`);
    });
    const cli = new GitCli({ path: 'git', version: '2.55.0' }, { hooksDir: tree, run: runner });
    const backend = new GitBackend({ git: cli, tree, settings });

    await expect(backend.push()).rejects.toMatchObject({ code: 'sync-no-remote' });
  });

  it('init() uses `init -b <branch>` on git >= 2.28 and writes .gitattributes', async () => {
    const calls: string[][] = [];
    const runner: Runner = (_file, fullArgs) => {
      if (fullArgs[0] === '-c') {
        calls.push(realArgs(fullArgs));
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    };
    const cli = new GitCli({ path: 'git', version: '2.42.0' }, { hooksDir: tree, run: runner });

    await GitBackend.init(cli, tree, 'main');

    expect(calls).toEqual([['init', '-b', 'main', tree]]);
    const attrs = await readFile(join(tree, '.gitattributes'), 'utf8');
    expect(attrs).toContain('* text=auto eol=lf');
  });

  it('init() falls back to `init` + `symbolic-ref` on git < 2.28', async () => {
    const calls: string[][] = [];
    const runner: Runner = (_file, fullArgs) => {
      if (fullArgs[0] === '-c') {
        calls.push(realArgs(fullArgs));
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    };
    const cli = new GitCli({ path: 'git', version: '2.25.3' }, { hooksDir: tree, run: runner });

    await GitBackend.init(cli, tree, 'main');

    expect(calls).toEqual([
      ['init', tree],
      ['symbolic-ref', 'HEAD', 'refs/heads/main'],
    ]);
  });

  it('init() leaves an existing .gitattributes alone', async () => {
    await writeFile(join(tree, '.gitattributes'), 'custom content\n', 'utf8');
    const runner: Runner = () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    const cli = new GitCli({ path: 'git', version: '2.55.0' }, { hooksDir: tree, run: runner });

    await GitBackend.init(cli, tree, 'main');

    const attrs = await readFile(join(tree, '.gitattributes'), 'utf8');
    expect(attrs).toBe('custom content\n');
  });
});

describeGit('GitBackend (real git)', () => {
  let root: string;

  afterEach(async () => {
    await removeTempDir(root);
  });

  it('writes .gitattributes on a real init, and clone adds it back only when missing', async () => {
    root = await mkTempDir();
    const remoteDir = join(root, 'remote.git');
    const treeA = join(root, 'a');
    const treeB = join(root, 'b');
    const hooksDir = join(root, 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const env = await hermeticGitEnv(root);
    const git = makeTestGitCli(hooksDir, env);

    const bare = await createBareRemote(git, remoteDir);
    await GitBackend.init(git, treeA, 'main');
    const attrsAfterInit = await readFile(join(treeA, '.gitattributes'), 'utf8');
    expect(attrsAfterInit.length).toBeGreaterThan(0);

    await git.run(treeA, ['remote', 'add', 'origin', bare.url]);
    const settingsA: GitShareSettings = { ...DEFAULT_GIT_SHARE_SETTINGS, branch: 'main' };
    const a = new GitBackend({ git, tree: treeA, settings: () => settingsA });
    await a.setIdentity('Alice', 'alice@example.com');
    await a.commit('Initial commit');
    await a.push();

    // The clone already carries the committed .gitattributes — `clone` must leave it alone.
    await GitBackend.clone(git, bare.url, 'main', treeB);
    const attrsAfterClone = await readFile(join(treeB, '.gitattributes'), 'utf8');
    expect(attrsAfterClone).toBe(attrsAfterInit);
  });

  it('never runs a hook, even a pre-commit that would exit 1', async () => {
    root = await mkTempDir();
    const remoteDir = join(root, 'remote.git');
    const treeA = join(root, 'a');
    const hooksDir = join(root, 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const env = await hermeticGitEnv(root);
    const git = makeTestGitCli(hooksDir, env);

    await createBareRemote(git, remoteDir);
    await GitBackend.init(git, treeA, 'main');

    // A hook living *inside the repo's own .git/hooks* (not the empty hooksDir GitCli forces via
    // `core.hooksPath`) — proof that `-c core.hooksPath=<empty dir>` is what keeps it from firing,
    // not merely the hook's own absence.
    const repoHooksDir = join(treeA, '.git', 'hooks');
    await mkdir(repoHooksDir, { recursive: true });
    await writeFile(join(repoHooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const settingsA: GitShareSettings = { ...DEFAULT_GIT_SHARE_SETTINGS, branch: 'main' };
    const a = new GitBackend({ git, tree: treeA, settings: () => settingsA });
    await a.setIdentity('Alice', 'alice@example.com');

    await expect(a.commit('Should not be blocked by the hook')).resolves.toEqual({ committed: true });
  });
});
