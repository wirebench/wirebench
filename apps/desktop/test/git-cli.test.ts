// @vitest-environment node
/**
 * `git-cli.ts`: discovery (`findGit`, `parseGitVersion`), the hardened `GitCli.run`, error
 * mapping and `assertRemoteUrl`. Every test here injects a fake `Runner` — the one smoke test
 * that spawns the real `git --version` is last and skips itself when no git is installed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { assertRemoteUrl, findGit, GIT_SUBCOMMANDS, GitCli, parseGitVersion } from '../src/main/sync/git-cli.js';
import type { Runner } from '../src/main/sync/git-cli.js';

describe('parseGitVersion', () => {
  it.each([
    ['git version 2.39.2 (Apple Git-143)', '2.39.2'],
    ['git version 2.42.0.windows.1', '2.42.0.windows.1'],
    ['not a git output at all', undefined],
    ['', undefined],
  ])('parses %s', (stdout, expected) => {
    expect(parseGitVersion(stdout)).toBe(expected);
  });
});

/** Builds a fake `Runner` that answers by matching on the candidate `file` path. */
function fakeRunner(
  answers: Record<string, { stdout?: string; stderr?: string; exitCode: number } | 'enoent'>,
): Runner {
  return (file) => {
    const answer = answers[file];
    if (answer === undefined) {
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 127 });
    }
    if (answer === 'enoent') {
      const error: NodeJS.ErrnoException = new Error(`spawn ${file} ENOENT`);
      error.code = 'ENOENT';
      return Promise.reject(error);
    }
    return Promise.resolve({ stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', exitCode: answer.exitCode });
  };
}

describe('findGit', () => {
  it('picks the configured path first when it is usable', async () => {
    const run = fakeRunner({
      '/configured/git': { stdout: 'git version 2.40.0', exitCode: 0 },
      '/usr/bin/git': { stdout: 'git version 2.41.0', exitCode: 0 },
    });
    const location = await findGit({
      configuredPath: '/configured/git',
      platform: 'darwin',
      env: {},
      exists: () => true,
      run,
    });
    expect(location).toEqual({ path: '/configured/git', version: '2.40.0' });
  });

  it('skips a candidate whose run exits non-zero (the Xcode shim) and falls through', async () => {
    const run = fakeRunner({
      '/usr/bin/git': { stdout: '', stderr: 'xcrun: error', exitCode: 1 },
      '/opt/homebrew/bin/git': { stdout: 'git version 2.41.0', exitCode: 0 },
    });
    const location = await findGit({ platform: 'darwin', env: {}, exists: () => true, run });
    expect(location).toEqual({ path: '/opt/homebrew/bin/git', version: '2.41.0' });
  });

  it('skips a candidate whose version is below the 2.20.0 minimum', async () => {
    const run = fakeRunner({
      '/usr/bin/git': { stdout: 'git version 2.19.0', exitCode: 0 },
      '/opt/homebrew/bin/git': { stdout: 'git version 2.20.0', exitCode: 0 },
    });
    const location = await findGit({ platform: 'darwin', env: {}, exists: () => true, run });
    expect(location).toEqual({ path: '/opt/homebrew/bin/git', version: '2.20.0' });
  });

  it('returns the first PATH hit on darwin/linux, splitting on ":"', async () => {
    const run = fakeRunner({
      '/opt/a/git': 'enoent',
      '/opt/b/git': { stdout: 'git version 2.30.0', exitCode: 0 },
    });
    const location = await findGit({
      platform: 'linux',
      env: { PATH: '/opt/a:/opt/b' },
      exists: () => true,
      run,
    });
    expect(location).toEqual({ path: '/opt/b/git', version: '2.30.0' });
  });

  it('returns the first PATH hit on win32, splitting on ";" and trying git.exe', async () => {
    const run = fakeRunner({
      'C:\\a\\git.exe': 'enoent',
      'C:\\b\\git.exe': { stdout: 'git version 2.42.0.windows.1', exitCode: 0 },
    });
    const location = await findGit({
      platform: 'win32',
      env: { PATH: 'C:\\a;C:\\b' },
      exists: () => true,
      run,
    });
    expect(location).toEqual({ path: 'C:\\b\\git.exe', version: '2.42.0.windows.1' });
  });

  it('falls through to a platform default candidate', async () => {
    const run = fakeRunner({
      '/usr/bin/git': { stdout: 'git version 2.35.0', exitCode: 0 },
    });
    const location = await findGit({ platform: 'linux', env: {}, exists: () => true, run });
    expect(location).toEqual({ path: '/usr/bin/git', version: '2.35.0' });
  });

  it('resolves undefined when nothing usable is found', async () => {
    const run = fakeRunner({});
    const location = await findGit({ platform: 'linux', env: {}, exists: () => true, run });
    expect(location).toBeUndefined();
  });
});

describe('GitCli.run', () => {
  const hooksDir = '/tmp/wirebench-git-hooks-empty';

  it('passes the hardened env and -c prefix, and returns trimmed stdout/stderr', async () => {
    let seenFile: string | undefined;
    let seenArgs: readonly string[] | undefined;
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const run: Runner = (file, args, options) => {
      // The `core.sshCommand` lookup `run()` issues internally must not stand in for the
      // tracked call below — answer it "unset" (exit 1) without recording it.
      if (args[0] === 'config') {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 });
      }
      seenFile = file;
      seenArgs = args;
      seenEnv = options.env;
      return Promise.resolve({ stdout: 'ok\n', stderr: '', exitCode: 0 });
    };
    const cli = new GitCli({ path: '/usr/bin/git', version: '2.40.0' }, { hooksDir, run, env: { CUSTOM: '1' } });

    const result = await cli.run('/tree', ['status']);

    expect(seenFile).toBe('/usr/bin/git');
    expect(seenArgs).toEqual([
      '-c',
      'core.autocrlf=false',
      '-c',
      'merge.conflictstyle=merge',
      '-c',
      `core.hooksPath=${hooksDir}`,
      'status',
    ]);
    expect(seenEnv).toMatchObject({
      CUSTOM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      LC_ALL: 'C',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    });
    expect(result).toEqual({ stdout: 'ok\n', stderr: '' });
  });

  it('does not override an explicit GIT_SSH_COMMAND already in process.env', async () => {
    const original = process.env['GIT_SSH_COMMAND'];
    process.env['GIT_SSH_COMMAND'] = 'ssh -custom';
    try {
      let seenEnv: NodeJS.ProcessEnv | undefined;
      const run: Runner = (_file, _args, options) => {
        seenEnv = options.env;
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      };
      const cli = new GitCli({ path: '/usr/bin/git', version: '2.40.0' }, { hooksDir, run });
      await cli.run('/tree', ['status']);
      expect(seenEnv?.['GIT_SSH_COMMAND']).toBe('ssh -custom');
    } finally {
      if (original === undefined) {
        delete process.env['GIT_SSH_COMMAND'];
      } else {
        process.env['GIT_SSH_COMMAND'] = original;
      }
    }
  });

  describe('the GIT_SSH_COMMAND default', () => {
    const originalEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      originalEnv['GIT_SSH_COMMAND'] = process.env['GIT_SSH_COMMAND'];
      originalEnv['GIT_SSH'] = process.env['GIT_SSH'];
      delete process.env['GIT_SSH_COMMAND'];
      delete process.env['GIT_SSH'];
    });
    afterEach(() => {
      for (const key of ['GIT_SSH_COMMAND', 'GIT_SSH']) {
        if (originalEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalEnv[key];
        }
      }
    });

    /** A fake `Runner` that answers `git config --get core.sshCommand` and counts those calls. */
    function configAwareRunner(configValue: string | undefined): {
      run: Runner;
      configCalls: () => number;
      seenEnv: () => NodeJS.ProcessEnv | undefined;
    } {
      let configCalls = 0;
      let seenEnv: NodeJS.ProcessEnv | undefined;
      const run: Runner = (_file, args, options) => {
        if (args[0] === 'config' && args[1] === '--get' && args[2] === 'core.sshCommand') {
          configCalls += 1;
          return configValue === undefined
            ? Promise.resolve({ stdout: '', stderr: '', exitCode: 1 })
            : Promise.resolve({ stdout: `${configValue}\n`, stderr: '', exitCode: 0 });
        }
        seenEnv = options.env;
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      };
      return { run, configCalls: () => configCalls, seenEnv: () => seenEnv };
    }

    it('applies the default when nothing else names an SSH transport', async () => {
      const { run, seenEnv, configCalls } = configAwareRunner(undefined);
      const cli = new GitCli({ path: '/usr/bin/git', version: '2.40.0' }, { hooksDir, run });

      await cli.run('/tree', ['status']);

      expect(seenEnv()?.['GIT_SSH_COMMAND']).toBe('ssh -o BatchMode=yes');
      expect(configCalls()).toBe(1);
    });

    it('does not apply the default when the process env has GIT_SSH', async () => {
      process.env['GIT_SSH'] = '/usr/bin/plink';
      const { run, seenEnv } = configAwareRunner(undefined);
      const cli = new GitCli({ path: '/usr/bin/git', version: '2.40.0' }, { hooksDir, run });

      await cli.run('/tree', ['status']);

      expect(seenEnv()?.['GIT_SSH_COMMAND']).toBeUndefined();
    });

    it("does not apply the default when the constructor's env carries GIT_SSH_COMMAND, and that value reaches the runner", async () => {
      const { run, seenEnv } = configAwareRunner(undefined);
      const cli = new GitCli(
        { path: '/usr/bin/git', version: '2.40.0' },
        { hooksDir, run, env: { GIT_SSH_COMMAND: 'ssh -custom-ctor' } },
      );

      await cli.run('/tree', ['status']);

      expect(seenEnv()?.['GIT_SSH_COMMAND']).toBe('ssh -custom-ctor');
    });

    it('does not apply the default when git config --get core.sshCommand returns a value', async () => {
      const { run, seenEnv, configCalls } = configAwareRunner('ssh -F /custom/config');
      const cli = new GitCli({ path: '/usr/bin/git', version: '2.40.0' }, { hooksDir, run });

      await cli.run('/tree', ['status']);

      expect(seenEnv()?.['GIT_SSH_COMMAND']).toBeUndefined();
      expect(configCalls()).toBe(1);
    });

    it('runs the config lookup once across several run() calls', async () => {
      const { run, configCalls } = configAwareRunner(undefined);
      const cli = new GitCli({ path: '/usr/bin/git', version: '2.40.0' }, { hooksDir, run });

      await cli.run('/tree', ['status']);
      await cli.run('/tree', ['fetch']);
      await cli.run('/tree', ['diff']);

      expect(configCalls()).toBe(1);
    });
  });

  it('refuses a subcommand outside GIT_SUBCOMMANDS without running it', async () => {
    let ran = false;
    const run: Runner = () => {
      ran = true;
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    };
    const cli = new GitCli({ path: '/usr/bin/git', version: '2.40.0' }, { hooksDir, run });

    await expect(cli.run('/tree', ['!dangerous'])).rejects.toMatchObject({
      code: 'git-failed',
    });
    expect(ran).toBe(false);
  });

  it('exposes the constructed version', () => {
    const cli = new GitCli(
      { path: '/usr/bin/git', version: '2.40.0' },
      { hooksDir, run: () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }) },
    );
    expect(cli.version).toBe('2.40.0');
  });

  it.each([
    ['Authentication failed for https://example.test/repo.git', 'git-auth-failed'],
    ['fatal: could not read Username for https://example.test', 'git-auth-failed'],
    ['Permission denied (publickey).', 'git-auth-failed'],
    ['Host key verification failed.', 'git-auth-failed'],
    ['terminal prompts disabled', 'git-auth-failed'],
    ['remote: Invalid username or password.', 'git-auth-failed'],
    ['fatal: unable to access: Could not resolve host: example.test', 'git-offline'],
    ['ssh: connect to host example.test port 22: Connection refused', 'git-offline'],
    ['ssh: connect to host example.test port 22: Connection timed out', 'git-offline'],
    ['Network is unreachable', 'git-offline'],
    ['Could not read from remote repository.', 'git-offline'],
    ['fatal: something else entirely went wrong', 'git-failed'],
  ])('maps stderr %s to %s', async (stderr, expectedCode) => {
    const run: Runner = () => Promise.resolve({ stdout: '', stderr, exitCode: 1 });
    const cli = new GitCli({ path: '/usr/bin/git', version: '2.40.0' }, { hooksDir, run });

    await expect(cli.run('/tree', ['fetch'])).rejects.toMatchObject({ code: expectedCode });
  });

  it('maps a spawn failure (git disappeared) to git-not-found', async () => {
    const run: Runner = () => {
      const error: NodeJS.ErrnoException = new Error('spawn git ENOENT');
      error.code = 'ENOENT';
      return Promise.reject(error);
    };
    const cli = new GitCli({ path: '/usr/bin/git', version: '2.40.0' }, { hooksDir, run });

    await expect(cli.run('/tree', ['status'])).rejects.toMatchObject({ code: 'git-not-found' });
  });

  it('maps a timeout to git-failed with details.timedOut', async () => {
    const run: Runner = () => {
      const error = new Error('timed out') as Error & { killed?: boolean; signal?: string };
      error.killed = true;
      error.signal = 'SIGTERM';
      return Promise.reject(error);
    };
    const cli = new GitCli({ path: '/usr/bin/git', version: '2.40.0' }, { hooksDir, run });

    await expect(cli.run('/tree', ['fetch'], { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'git-failed',
      details: expect.objectContaining({ timedOut: true }) as unknown,
    });
  });

  it('does not classify an ordinary non-zero-exit error (signal: null, killed: false) as a timeout', async () => {
    // What Node's execFile actually throws for a normal failure — e.g. `git rev-parse` outside
    // a repo — is an Error with `code` set to the exit code, `killed: false` and `signal: null`
    // (not `undefined`). A `!== undefined` check alone misclassifies every such failure as a
    // timeout.
    const run: Runner = () => {
      const error = Object.assign(new Error('Command failed'), {
        code: 128,
        killed: false,
        signal: null,
        stdout: '',
        stderr: 'fatal: not a git repository (or any of the parent directories): .git',
      });
      return Promise.reject(error);
    };
    const cli = new GitCli({ path: '/usr/bin/git', version: '2.40.0' }, { hooksDir, run });

    let caught: WirebenchError | undefined;
    try {
      await cli.run('/tree', ['rev-parse', '--is-inside-work-tree']);
    } catch (error) {
      caught = error as WirebenchError;
    }
    expect(caught?.code).toBe('git-failed');
    expect(caught?.details).not.toHaveProperty('timedOut');
  });

  it('never includes the environment in error details, strips credentials from a URL argument, and trims stderr to 2 KiB', async () => {
    const longStderr = 'x'.repeat(3000);
    const run: Runner = () => Promise.resolve({ stdout: '', stderr: longStderr, exitCode: 1 });
    const cli = new GitCli({ path: '/usr/bin/git', version: '2.40.0' }, { hooksDir, run, env: { SECRET: 'shh' } });

    let caught: WirebenchError | undefined;
    try {
      await cli.run('/tree', ['fetch', 'https://user:token@example.test/repo.git']);
    } catch (error) {
      caught = error as WirebenchError;
    }
    expect(caught).toBeInstanceOf(WirebenchError);
    const details = caught?.details as Record<string, unknown>;
    expect(details).not.toHaveProperty('env');
    expect(JSON.stringify(details)).not.toContain('shh');
    expect(details['args']).toEqual(['fetch', 'https://example.test/repo.git']);
    expect((details['stderr'] as string).length).toBeLessThanOrEqual(2048);
    expect(details['exitCode']).toBe(1);
  });
});

describe('assertRemoteUrl', () => {
  it.each(['https://x/y.git', 'ssh://git@x/y', 'git@x:y/z.git', 'file:///tmp/r'])(
    'accepts %s and returns the trimmed value',
    (url) => {
      expect(assertRemoteUrl(url)).toBe(url);
      expect(assertRemoteUrl(`  ${url}  `)).toBe(url);
    },
  );

  it.each([
    '',
    '-oProxyCommand=x',
    'ext::sh',
    'http://x',
    'x/y',
    // Bypass attempts a naive scheme/prefix check would miss.
    'ssh://-oProxyCommand=x/y',
    'git@-oProxyCommand:x',
    'https:x',
    'file:/etc/r',
    'ssh:-oProxyCommand=evil',
    'https://x/y\nrm -rf /',
    'https://x/y\t/etc',
  ])('refuses %s', (url) => {
    expect(() => assertRemoteUrl(url)).toThrow(WirebenchError);
    try {
      assertRemoteUrl(url);
    } catch (error) {
      expect((error as WirebenchError).code).toBe('git-remote-refused');
      if (url.length > 0) {
        expect((error as WirebenchError).message).not.toContain(url);
        expect(JSON.stringify((error as WirebenchError).details)).not.toContain(url);
      }
    }
  });

  it('carries only the scheme (never the URL) in details, and a generic message', () => {
    try {
      assertRemoteUrl('http://user:token@evil.test/repo.git');
      throw new Error('expected assertRemoteUrl to throw');
    } catch (error) {
      expect((error as WirebenchError).details).toEqual({ scheme: 'http' });
      expect((error as WirebenchError).message).toBe(
        'This remote URL is not allowed: use https://, ssh://, file:// or user@host:path.',
      );
    }
  });

  it('labels a refused scp-like remote as scp-like', () => {
    try {
      assertRemoteUrl('git@-oProxyCommand:x');
      throw new Error('expected assertRemoteUrl to throw');
    } catch (error) {
      expect((error as WirebenchError).details).toEqual({ scheme: 'scp-like' });
    }
  });
});

describe('GIT_SUBCOMMANDS', () => {
  it('is a fixed allow-list of git subcommands', () => {
    expect(GIT_SUBCOMMANDS).toContain('fetch');
    expect(GIT_SUBCOMMANDS).toContain('push');
    expect(GIT_SUBCOMMANDS).not.toContain('!dangerous');
  });
});

describe('findGit against the real system git (smoke test)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wirebench-git-smoke-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds a usable git on this machine, or skips with a warning', async () => {
    const location = await findGit({});
    if (location === undefined) {
      console.warn('No system git found; skipping the real-git smoke test.');
      return;
    }
    expect(location.version).toMatch(/^\d+\.\d+\.\d+/);
    const cli = new GitCli(location, { hooksDir: dir });
    const result = await cli.run(undefined, ['--version']);
    expect(result.stdout).toContain('git version');
  });

  it('maps a real ordinary failure (rev-parse outside a repo) to git-failed, not a timeout', async () => {
    const location = await findGit({});
    if (location === undefined) {
      console.warn('No system git found; skipping the real-git smoke test.');
      return;
    }
    const nonRepoDir = mkdtempSync(join(tmpdir(), 'wirebench-git-non-repo-'));
    try {
      const cli = new GitCli(location, { hooksDir: dir });
      let caught: WirebenchError | undefined;
      try {
        await cli.run(nonRepoDir, ['rev-parse', '--is-inside-work-tree']);
      } catch (error) {
        caught = error as WirebenchError;
      }
      expect(caught?.code).toBe('git-failed');
      const details = caught?.details as Record<string, unknown> | undefined;
      expect(details).not.toHaveProperty('timedOut');
      expect(details?.['exitCode']).toBeTypeOf('number');
      expect(details?.['exitCode']).not.toBe(0);
      expect((details?.['stderr'] as string | undefined)?.length ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(nonRepoDir, { recursive: true, force: true });
    }
  });
});
