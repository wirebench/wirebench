// @vitest-environment node
/**
 * Unit-level coverage for `GitBackend`'s own parsing and branching logic: most cases run against
 * a mocked `Runner` (no real git process, no `describeGit` guard needed) so they're fast and
 * exercise exact `git` output shapes precisely; the filesystem/hooks-dependent cases at the
 * bottom run against a real git and are skipped (loudly) only when this machine has none.
 */

import { spawnSync } from 'node:child_process';
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
  gitLocation,
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

  it('parses status --porcelain=v2 -z, including a rename, a non-ASCII path, a spaced path, and a conflict', async () => {
    // `-z` NUL-terminates every record and NUL-separates a rename's original path into its own
    // token — never C-quoted, so `café.yaml` and `new file.yaml` round-trip as raw bytes.
    const statusOutput = [
      '1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb environments/qa.yaml',
      '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 projects/api/wirebench.yaml',
      'projects/old/wirebench.yaml',
      'u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb cccccc environments/staging.yaml',
      '? environments/café.yaml',
      '? environments/new file.yaml',
      '',
    ].join('\x00');
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
      { path: 'environments/café.yaml', status: 'added' },
      { path: 'environments/new file.yaml', status: 'added' },
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

  it('reads identity from `git config --get user.name`/`user.email`, and reports undefined when either is unset', async () => {
    const answers = (values: Record<string, string | undefined>): Runner =>
      mockRunner((args) => {
        if (args[0] === 'config' && args[1] === '--get') {
          const value = values[args[2] ?? ''];
          return value === undefined ? { exitCode: 1 } : { stdout: `${value}\n` };
        }
        throw new Error(`unexpected args ${JSON.stringify(args)}`);
      });
    const backendFor = (runner: Runner): GitBackend =>
      new GitBackend({
        git: new GitCli({ path: 'git', version: '2.55.0' }, { hooksDir: tree, run: runner }),
        tree,
        settings,
      });

    await expect(
      backendFor(answers({ 'user.name': 'Alice', 'user.email': 'alice@example.com' })).identity(),
    ).resolves.toEqual({ name: 'Alice', email: 'alice@example.com' });
    await expect(backendFor(answers({ 'user.name': 'Alice' })).identity()).resolves.toBeUndefined();
    await expect(backendFor(answers({ 'user.email': 'alice@example.com' })).identity()).resolves.toBeUndefined();
    await expect(
      backendFor(answers({ 'user.name': '  ', 'user.email': 'alice@example.com' })).identity(),
    ).resolves.toBeUndefined();
  });

  it('merge() is a no-op when origin/<branch> does not resolve', async () => {
    const runner = mockRunner((args) => {
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        // `--verify --quiet` on a ref that doesn't exist exits 1 with empty stderr.
        return { stdout: '', stderr: '', exitCode: 1 };
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

  it('propagates an unexpected git-offline failure instead of treating it as "no remote"', async () => {
    const runner = mockRunner((args) => {
      if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) {
        return { stdout: 'true\n' };
      }
      if (args[0] === 'status') {
        return { stdout: '' };
      }
      if (args[0] === 'remote') {
        return { stdout: '', stderr: 'fatal: Could not resolve host: example.com', exitCode: 128 };
      }
      throw new Error(`unexpected args ${JSON.stringify(args)}`);
    });
    const cli = new GitCli({ path: 'git', version: '2.55.0' }, { hooksDir: tree, run: runner });
    const backend = new GitBackend({ git: cli, tree, settings });

    await expect(backend.probe()).rejects.toMatchObject({ code: 'git-offline' });
  });

  it('propagates an unexpected timeout instead of treating identity as absent', async () => {
    const runner: Runner = (_file, fullArgs) => {
      const args = realArgs(fullArgs);
      if (args[0] === 'config' && args.includes('core.sshCommand')) {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 });
      }
      if (args[0] === 'config' && args.includes('user.name')) {
        const error = new Error('timed out') as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        error.killed = true;
        throw error;
      }
      throw new Error(`unexpected args ${JSON.stringify(args)}`);
    };
    const cli = new GitCli({ path: 'git', version: '2.55.0' }, { hooksDir: tree, run: runner });
    const backend = new GitBackend({ git: cli, tree, settings });

    await expect(backend.identity()).rejects.toMatchObject({ code: 'git-failed', details: { timedOut: true } });
  });

  it('refuses an injected branch name before spawning anything (init/clone/fetch/merge/push)', async () => {
    const evilBranch = '--upload-pack=touch pwned';
    const spawnedCalls: string[][] = [];
    const runner: Runner = (_file, fullArgs) => {
      spawnedCalls.push(realArgs(fullArgs));
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    };
    const cli = new GitCli({ path: 'git', version: '2.55.0' }, { hooksDir: tree, run: runner });
    const evilSettings = (): GitShareSettings => ({ ...DEFAULT_GIT_SHARE_SETTINGS, branch: evilBranch });
    const backend = new GitBackend({ git: cli, tree, settings: evilSettings });

    await expect(GitBackend.init(cli, tree, evilBranch)).rejects.toMatchObject({ code: 'git-branch-refused' });
    await expect(GitBackend.clone(cli, 'https://example.com/x.git', evilBranch, tree)).rejects.toMatchObject({
      code: 'git-branch-refused',
    });
    await expect(backend.fetch()).rejects.toMatchObject({ code: 'git-branch-refused' });
    await expect(backend.merge()).rejects.toMatchObject({ code: 'git-branch-refused' });
    await expect(backend.push()).rejects.toMatchObject({ code: 'git-branch-refused' });

    expect(spawnedCalls).toEqual([]);
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

  it('reports no identity when user.name/user.email are unset, even where git could guess one', async () => {
    root = await mkTempDir();
    const tree = join(root, 'a');
    const hooksDir = join(root, 'hooks');
    await mkdir(hooksDir, { recursive: true });
    // Hermetic: an empty global config, no system config, and no `user.useConfigOnly`, so git
    // itself would fall back to a guessed `user@host` identity.
    const env = await hermeticGitEnv(root);
    const git = makeTestGitCli(hooksDir, env);
    await GitBackend.init(git, tree, 'main');
    const backend = new GitBackend({ git, tree, settings });

    await expect(backend.identity()).resolves.toBeUndefined();
    await backend.setIdentity('Alice', 'alice@example.com');
    await expect(backend.identity()).resolves.toEqual({ name: 'Alice', email: 'alice@example.com' });
  });

  it('writes .gitattributes on a real init', async () => {
    root = await mkTempDir();
    const treeA = join(root, 'a');
    const hooksDir = join(root, 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const env = await hermeticGitEnv(root);
    const git = makeTestGitCli(hooksDir, env);

    await GitBackend.init(git, treeA, 'main');
    const attrsAfterInit = await readFile(join(treeA, '.gitattributes'), 'utf8');
    expect(attrsAfterInit.length).toBeGreaterThan(0);
  });

  it('clone leaves a committed .gitattributes alone', async () => {
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
    // Overwrite what `init` wrote with custom content *before* the first commit, so the
    // committed (and therefore cloned) tree genuinely differs from `GIT_ATTRIBUTES` — a test
    // where the clone's content already equals what `ensureGitAttributes` would write can't
    // distinguish "left alone" from "overwritten with the same bytes".
    const customContent = 'custom\n';
    await writeFile(join(treeA, '.gitattributes'), customContent, 'utf8');

    await git.run(treeA, ['remote', 'add', 'origin', bare.url]);
    const settingsA: GitShareSettings = { ...DEFAULT_GIT_SHARE_SETTINGS, branch: 'main' };
    const a = new GitBackend({ git, tree: treeA, settings: () => settingsA });
    await a.setIdentity('Alice', 'alice@example.com');
    await a.commit('Initial commit');
    await a.push();

    await GitBackend.clone(git, bare.url, 'main', treeB);
    const attrsAfterClone = await readFile(join(treeB, '.gitattributes'), 'utf8');
    expect(attrsAfterClone).toBe(customContent);
  });

  it('keeps definition cache bytes exact through a clone, so their hashes still match', async () => {
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
    await git.run(treeA, ['remote', 'add', 'origin', bare.url]);
    const settingsA: GitShareSettings = { ...DEFAULT_GIT_SHARE_SETTINGS, branch: 'main' };
    const a = new GitBackend({ git, tree: treeA, settings: () => settingsA });
    await a.setIdentity('Alice', 'alice@example.com');
    // A definition served with CRLF line endings, cached as fetched (its manifest records the hash).
    const definition = join('projects', 'Calc', 'interfaces', 'Calculator', 'definition');
    const wsdl = Buffer.from('<?xml version="1.0"?>\r\n<definitions/>\r\n', 'utf8');
    const xsd = Buffer.from('<schema>\r\n</schema>\r\n', 'utf8');
    await mkdir(join(treeA, definition), { recursive: true });
    await writeFile(join(treeA, definition, 'calculator.wsdl'), wsdl);
    await writeFile(join(treeA, definition, 'types.xsd'), xsd);
    await a.commit('Add Calculator');
    await a.push();

    await GitBackend.clone(git, bare.url, 'main', treeB);

    expect(await readFile(join(treeB, definition, 'calculator.wsdl'))).toEqual(wsdl);
    expect(await readFile(join(treeB, definition, 'types.xsd'))).toEqual(xsd);
    expect((await git.run(treeB, ['status', '--porcelain'])).stdout).toBe('');
  });

  it('clone writes .gitattributes when the cloned tree lacks one', async () => {
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
    // Remove what `init` wrote before the first commit, so the pushed remote's tree genuinely
    // has no `.gitattributes` at all.
    await rm(join(treeA, '.gitattributes'));

    await git.run(treeA, ['remote', 'add', 'origin', bare.url]);
    const settingsA: GitShareSettings = { ...DEFAULT_GIT_SHARE_SETTINGS, branch: 'main' };
    const a = new GitBackend({ git, tree: treeA, settings: () => settingsA });
    await a.setIdentity('Alice', 'alice@example.com');
    await writeFile(join(treeA, 'workspace.yaml'), 'name: Test\n', 'utf8');
    await a.commit('Initial commit without .gitattributes');
    await a.push();

    await GitBackend.clone(git, bare.url, 'main', treeB);
    const attrsAfterClone = await readFile(join(treeB, '.gitattributes'), 'utf8');
    expect(attrsAfterClone).toContain('* text=auto eol=lf');
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

    // Control: the same hook in the same repository *does* fire for a git run without the
    // override, so the commit above passed because of `core.hooksPath`, not a hook git ignored.
    await writeFile(join(treeA, 'environments.txt'), 'control\n', 'utf8');
    const control = spawnSync(
      gitLocation?.path ?? 'git',
      ['commit', '-a', '--allow-empty', '-m', 'Blocked by the hook'],
      {
        cwd: treeA,
        env: {
          ...process.env,
          ...env,
          GIT_AUTHOR_NAME: 'Alice',
          GIT_AUTHOR_EMAIL: 'alice@example.com',
          GIT_COMMITTER_NAME: 'Alice',
          GIT_COMMITTER_EMAIL: 'alice@example.com',
        },
        encoding: 'utf8',
      },
    );
    expect(control.status).not.toBe(0);
    expect(await a.log(5)).toHaveLength(1);
  });

  it("fetch's forced refspec keeps working after the remote branch is rewritten (force-pushed)", async () => {
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
    await git.run(treeA, ['remote', 'add', 'origin', bare.url]);
    const settings: GitShareSettings = { ...DEFAULT_GIT_SHARE_SETTINGS, branch: 'main' };
    const a = new GitBackend({ git, tree: treeA, settings: () => settings });
    await a.setIdentity('Alice', 'alice@example.com');
    await mkdir(join(treeA, 'environments'), { recursive: true });
    await writeFile(join(treeA, 'environments', 'qa.yaml'), 'name: QA\n', 'utf8');
    await a.commit('Initial commit');
    await a.push();

    await GitBackend.clone(git, bare.url, 'main', treeB);
    const b = new GitBackend({ git, tree: treeB, settings: () => settings });
    await b.setIdentity('Bob', 'bob@example.com');

    // B is in sync right after cloning.
    await b.fetch();
    expect(await b.probe()).toMatchObject({ state: 'clean', ahead: 0, behind: 0 });

    // A rewrites its own history (an amend) and force-pushes — a real rewrite, not a fast-
    // forward. The force-push itself goes through a direct `git` call, not `GitBackend.push`,
    // which never gains a force option.
    await writeFile(join(treeA, 'environments', 'qa.yaml'), 'name: QA (amended)\n', 'utf8');
    await git.run(treeA, ['add', '-A', '--', '.']);
    await git.run(treeA, ['commit', '--amend', '-m', 'Initial commit (amended)']);
    await git.run(treeA, ['push', '--force', 'origin', 'HEAD:refs/heads/main']);

    // Before the `+` fix, this fetch would fail outright ("non-fast-forward") and every fetch
    // after it would keep failing the same way, leaving the workspace stuck offline for good —
    // a plain `await` here is the assertion: an unhandled rejection fails the test.
    await b.fetch();

    // B's local `origin/main` now really did move to A's rewritten commit …
    const remoteHead = (await git.run(treeB, ['rev-parse', 'origin/main'])).stdout.trim();
    const aHead = (await git.run(treeA, ['rev-parse', 'HEAD'])).stdout.trim();
    expect(remoteHead).toBe(aHead);

    // … while B's own HEAD is still the pre-rewrite commit — a real divergence (two unrelated
    // commits since the rewrite), correctly reported rather than thrown.
    expect(await b.probe()).toMatchObject({ state: 'diverged', ahead: 1, behind: 1 });
  });
});

describe('GitBackend.finishMerge (mocked runner)', () => {
  it('commits the resolved merge and reports what that commit brought in, NUL-parsed', async () => {
    const calls: string[][] = [];
    const runner = mockRunner((args) => {
      if (args.length === 0) {
        return {};
      }
      calls.push([...args]);
      if (args[0] === 'commit') {
        return {};
      }
      if (args[0] === 'diff') {
        return { stdout: ['environments/qa.yaml', 'projects/api/new file.yaml', ''].join('\x00') };
      }
      throw new Error(`unexpected args ${JSON.stringify(args)}`);
    });
    const tree = await mkTempDir('wirebench-sync-unit-');
    try {
      const cli = new GitCli({ path: 'git', version: '2.55.0' }, { hooksDir: tree, run: runner });
      const backend = new GitBackend({ git: cli, tree, settings });

      await expect(backend.finishMerge()).resolves.toEqual({
        changedPaths: ['environments/qa.yaml', 'projects/api/new file.yaml'],
      });
      expect(calls).toEqual([
        ['commit', '--no-edit'],
        ['diff', '--name-only', '-z', 'HEAD~1', 'HEAD'],
      ]);
    } finally {
      await removeTempDir(tree);
    }
  });
});
