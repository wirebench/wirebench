// @vitest-environment node
/**
 * `GitCli`'s server-only plumbing (server-sync spec §3.3, R1): the second allow-list, the per-call
 * `env`, `input`, Buffer stdout and `maxBuffer`. The fake-runner tests pin exactly what reaches the
 * runner; the real-git block proves stdin and binary output end to end and skips without a system
 * git (`WIREBENCH_REQUIRE_GIT=1`, set on CI, turns that into a failure, as in the desktop and server
 * suites).
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WirebenchError } from '../../../src/errors.js';
import { findGit, GIT_CALL_ENV, GIT_PLUMBING_SUBCOMMANDS, GIT_SUBCOMMANDS, GitCli } from '../../../src/index.js';
import type { GitCallEnv, GitLocation, GitRunOptions, Runner } from '../../../src/index.js';

const LOCATION: GitLocation = { path: '/usr/bin/git', version: '2.45.0' };
const HOOKS = '/nonexistent-hooks';
const PREFIX = ['-c', 'core.autocrlf=false', '-c', 'merge.conflictstyle=merge', '-c', `core.hooksPath=${HOOKS}`];

type RunnerOptions = Parameters<Runner>[2];
type RunnerResult = Awaited<ReturnType<Runner>>;
interface Call {
  readonly fullArgs: readonly string[];
  readonly options: RunnerOptions;
}

/**
 * A fake runner: answers the `core.sshCommand` lookup every `run()` makes "unset", records every
 * other call, and counts every spawn (the lookup included) so "refused before spawning" is provable.
 */
function fakeRunner(
  answer: (args: readonly string[]) => RunnerResult = () => ({ stdout: '', stderr: '', exitCode: 0 }),
): {
  run: Runner;
  calls: Call[];
  spawned: () => number;
} {
  const calls: Call[] = [];
  let spawned = 0;
  const run: Runner = (_file, fullArgs, options) => {
    spawned += 1;
    if (fullArgs.includes('core.sshCommand')) {
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 });
    }
    calls.push({ fullArgs, options });
    return Promise.resolve(answer(fullArgs.slice(PREFIX.length)));
  };
  return { run, calls, spawned: () => spawned };
}

describe('the plumbing allow-list', () => {
  it('is a second list: GIT_SUBCOMMANDS is unchanged and the two share nothing', () => {
    expect([...GIT_SUBCOMMANDS]).toEqual([
      '--version',
      'init',
      'clone',
      'add',
      'commit',
      'fetch',
      'merge',
      'push',
      'status',
      'diff',
      'rev-list',
      'rev-parse',
      'log',
      'checkout',
      'remote',
      'config',
      'symbolic-ref',
      'var',
      'rm',
    ]);
    expect([...GIT_PLUMBING_SUBCOMMANDS]).toEqual([
      'ls-tree',
      'cat-file',
      'merge-base',
      'diff-tree',
      'read-tree',
      'hash-object',
      'update-index',
      'write-tree',
      'commit-tree',
      'update-ref',
    ]);
    expect(GIT_PLUMBING_SUBCOMMANDS.filter((name) => (GIT_SUBCOMMANDS as readonly string[]).includes(name))).toEqual(
      [],
    );
  });

  it.each(GIT_PLUMBING_SUBCOMMANDS)('refuses %s without plumbing, before spawning anything', async (subcommand) => {
    const { run, spawned } = fakeRunner();
    for (const cli of [
      new GitCli(LOCATION, { hooksDir: HOOKS, run }),
      new GitCli(LOCATION, { hooksDir: HOOKS, run, plumbing: false }),
    ]) {
      await expect(cli.run('/data/repos/W.git', [subcommand])).rejects.toMatchObject({
        code: 'git-failed',
        message: `"${subcommand}" is not an allowed git subcommand.`,
      });
    }
    expect(spawned()).toBe(0);
  });

  it.each(GIT_PLUMBING_SUBCOMMANDS)(
    'withPlumbing() runs %s behind the same -c prefix and hooks guard',
    async (subcommand) => {
      const { run, calls } = fakeRunner();
      const cli = new GitCli(LOCATION, { hooksDir: HOOKS, run }).withPlumbing();

      await cli.run('/data/repos/W.git', [subcommand, 'x']);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.fullArgs).toEqual([...PREFIX, subcommand, 'x']);
      expect(calls[0]?.options.cwd).toBe('/data/repos/W.git');
    },
  );

  it('a plumbing GitCli still runs the ordinary list, and still refuses everything else', async () => {
    const { run, calls } = fakeRunner();
    const cli = new GitCli(LOCATION, { hooksDir: HOOKS, run, plumbing: true });

    await cli.run('/data/repos/W.git', ['rev-parse', '--verify', 'refs/heads/main']);
    for (const refused of ['!dangerous', 'upload-pack', 'receive-pack', 'daemon', '--exec-path=/tmp', '-c', '']) {
      await expect(cli.run('/data/repos/W.git', [refused])).rejects.toMatchObject({ code: 'git-failed' });
    }
    expect(calls.map((call) => call.fullArgs[PREFIX.length])).toEqual(['rev-parse']);
  });

  it('withPlumbing() keeps the location, hooks dir, runner and env, and leaves the original alone', async () => {
    const { run, calls } = fakeRunner();
    const original = new GitCli(LOCATION, { hooksDir: HOOKS, run, env: { CUSTOM: '1' } });
    const plumbing = original.withPlumbing();

    expect(plumbing.version).toBe('2.45.0');
    await plumbing.run('/data/repos/W.git', ['write-tree']);
    expect(calls[0]?.fullArgs).toEqual([...PREFIX, 'write-tree']);
    expect(calls[0]?.options.env).toMatchObject({ CUSTOM: '1', GIT_TERMINAL_PROMPT: '0' });
    await expect(original.run('/data/repos/W.git', ['write-tree'])).rejects.toMatchObject({ code: 'git-failed' });
  });
});

describe('run() options', () => {
  const plumbingCli = (run: Runner): GitCli => new GitCli(LOCATION, { hooksDir: HOOKS, run }).withPlumbing();

  it('env: the seven named variables reach git, under the hardened keys', async () => {
    const { run, calls } = fakeRunner();
    const env = {
      GIT_INDEX_FILE: '/data/tmp/W-1.idx',
      GIT_AUTHOR_NAME: 'Ada Lovelace',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_AUTHOR_DATE: '2026-09-25T10:00:00Z',
      GIT_COMMITTER_NAME: 'Ada Lovelace',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
      GIT_COMMITTER_DATE: '2026-09-25T10:00:00Z',
    } satisfies Record<GitCallEnv, string>;
    expect(Object.keys(env).sort()).toEqual([...GIT_CALL_ENV].sort());

    await plumbingCli(run).run('/data/repos/W.git', ['commit-tree', 'abc', '-m', 'Save'], { env });

    expect(calls[0]?.options.env).toMatchObject({ ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', LC_ALL: 'C' });
  });

  it.each(['GIT_DIR', 'GIT_CONFIG_PARAMETERS', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH', 'PATH', 'LC_ALL'])(
    'env: refuses %s before spawning, naming the key but never the value',
    async (key) => {
      const { run, spawned } = fakeRunner();
      // The type already forbids it; this is a caller that got past the type.
      const options = { env: { [key]: 'secret-value' } } as unknown as GitRunOptions;

      const error = await plumbingCli(run)
        .run('/data/repos/W.git', ['update-ref', 'refs/heads/main', 'abc'], options)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(WirebenchError);
      expect(error).toMatchObject({ code: 'git-failed', details: { env: [key] } });
      expect((error as WirebenchError).message).not.toContain('secret-value');
      expect(JSON.stringify((error as WirebenchError).details)).not.toContain('secret-value');
      expect(spawned()).toBe(0);
    },
  );

  it('input: bytes and text go to the runner untouched; without it the runner sees no input key', async () => {
    const { run, calls } = fakeRunner();
    const cli = plumbingCli(run);
    const bytes = Uint8Array.from([0xff, 0x00, 0x80]);

    await cli.run('/data/repos/W.git', ['hash-object', '-w', '--stdin'], { input: bytes });
    await cli.run('/data/repos/W.git', ['hash-object', '-w', '--stdin'], { input: 'text\n' });
    await cli.run('/data/repos/W.git', ['write-tree']);

    expect(calls[0]?.options.input).toBe(bytes);
    expect(calls[1]?.options.input).toBe('text\n');
    expect(calls[2]?.options).not.toHaveProperty('input');
  });

  it("stdout: 'buffer' asks the runner for bytes and returns a Buffer; the default stays a string", async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00]);
    const { run, calls } = fakeRunner((args) => ({
      stdout: args[0] === 'cat-file' ? bytes : 'tree\n',
      stderr: '',
      exitCode: 0,
    }));
    const cli = plumbingCli(run);

    const binary = await cli.run('/data/repos/W.git', ['cat-file', 'blob', 'abc'], { stdout: 'buffer' });
    const text = await cli.run('/data/repos/W.git', ['write-tree']);

    expect(Buffer.isBuffer(binary.stdout)).toBe(true);
    expect(binary.stdout.equals(bytes)).toBe(true);
    expect(text.stdout).toBe('tree\n');
    expect(calls.map((call) => call.options.encoding)).toEqual(['buffer', 'utf8']);
  });

  it('a runner answering in the other shape is converted to what the caller asked for', async () => {
    const { run } = fakeRunner((args) => ({
      stdout: args[0] === 'cat-file' ? 'text' : Buffer.from('bytes', 'utf8'),
      stderr: '',
      exitCode: 0,
    }));
    const cli = plumbingCli(run);

    expect((await cli.run('/r', ['cat-file', 'blob', 'abc'], { stdout: 'buffer' })).stdout).toEqual(
      Buffer.from('text', 'utf8'),
    );
    expect((await cli.run('/r', ['write-tree'])).stdout).toBe('bytes');
  });

  it('maxBuffer: 16 MiB by default, per call when given', async () => {
    const { run, calls } = fakeRunner();
    const cli = plumbingCli(run);

    await cli.run('/r', ['ls-tree', '-r', 'abc']);
    await cli.run('/r', ['ls-tree', '-r', 'abc'], { maxBuffer: 40 * 1024 * 1024 });

    expect(calls.map((call) => call.options.maxBuffer)).toEqual([16 * 1024 * 1024, 40 * 1024 * 1024]);
  });

  it('a failed buffer call is still mapped from its UTF-8 stderr', async () => {
    const { run } = fakeRunner(() => ({
      stdout: Buffer.alloc(0),
      stderr: 'fatal: Not a valid object name abc',
      exitCode: 128,
    }));

    await expect(plumbingCli(run).run('/r', ['cat-file', 'blob', 'abc'], { stdout: 'buffer' })).rejects.toMatchObject({
      code: 'git-failed',
      details: { exitCode: 128, stderr: 'fatal: Not a valid object name abc' },
    });
  });

  it('output over maxBuffer is git-failed with outputTooLarge, not a timeout', async () => {
    const run: Runner = (_file, fullArgs) =>
      fullArgs.includes('core.sshCommand')
        ? Promise.resolve({ stdout: '', stderr: '', exitCode: 1 })
        : Promise.reject(
            Object.assign(new RangeError('stdout maxBuffer length exceeded'), {
              code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            }),
          );

    const error = await plumbingCli(run)
      .run('/r', ['cat-file', 'blob', 'abc'], { stdout: 'buffer', maxBuffer: 10 })
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'git-failed', details: { outputTooLarge: true } });
    expect((error as WirebenchError).details).not.toHaveProperty('timedOut');
  });
});

const REQUIRE_GIT = process.env['WIREBENCH_REQUIRE_GIT'] === '1';
const realGit: GitLocation | undefined = await findGit({});
if (realGit === undefined) {
  if (REQUIRE_GIT) {
    throw new Error('git is required (WIREBENCH_REQUIRE_GIT=1) but was not found');
  }
  console.warn('No system git found; skipping the real-git plumbing tests.');
}
/** Typed narrowly, as `describeGit` in packages/server/test/helpers/git.ts is: vitest 5's two branches differ. */
const describeRealGit: (name: string, factory: () => void) => void = realGit === undefined ? describe.skip : describe;

describeRealGit('GitCli plumbing against the real system git', () => {
  /** Not valid UTF-8: a lone 0xff, 0xfe, a NUL, a stray continuation byte, and a truncated sequence. */
  const BINARY = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0a, 0xc3]);
  let dir: string;
  let repo: string;
  let git: GitCli;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wirebench-git-plumbing-'));
    repo = join(dir, 'repo.git');
    const plain = new GitCli(realGit!, {
      hooksDir: join(dir, 'no-hooks'),
      env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, '.gitconfig-none') },
    });
    await plain.run(undefined, ['init', '--bare', repo]);
    git = plain.withPlumbing();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('input reaches stdin, and Buffer stdout gives back non-UTF-8 bytes exactly', async () => {
    const id = (await git.run(repo, ['hash-object', '-w', '--stdin'], { input: BINARY })).stdout.trim();
    expect(id).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
    expect((await git.run(repo, ['cat-file', '-s', id])).stdout.trim()).toBe(String(BINARY.length));

    const bytes = await git.run(repo, ['cat-file', 'blob', id], { stdout: 'buffer' });
    expect(Buffer.isBuffer(bytes.stdout)).toBe(true);
    expect(bytes.stdout.equals(BINARY)).toBe(true);

    // What Buffer mode exists to avoid: decoding as UTF-8 replaces the invalid bytes.
    const decoded = await git.run(repo, ['cat-file', 'blob', id]);
    expect(Buffer.from(decoded.stdout, 'utf8').equals(BINARY)).toBe(false);
  });

  it('a string input is written as UTF-8', async () => {
    const id = (await git.run(repo, ['hash-object', '-w', '--stdin'], { input: 'héllo\n' })).stdout.trim();
    expect((await git.run(repo, ['cat-file', 'blob', id])).stdout).toBe('héllo\n');
  });

  it('the per-call env reaches git: a private index file, then the author and committer', async () => {
    const blob = (await git.run(repo, ['hash-object', '-w', '--stdin'], { input: BINARY })).stdout.trim();
    const index = join(dir, 'private.idx');

    await git.run(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},projects/p/attachments/logo.bin`], {
      env: { GIT_INDEX_FILE: index },
    });
    const tree = (await git.run(repo, ['write-tree'], { env: { GIT_INDEX_FILE: index } })).stdout.trim();
    expect(existsSync(index)).toBe(true);
    expect(existsSync(join(repo, 'index'))).toBe(false);
    expect((await git.run(repo, ['ls-tree', '-r', '-z', '--name-only', tree])).stdout).toBe(
      'projects/p/attachments/logo.bin\0',
    );

    const commit = (
      await git.run(repo, ['commit-tree', tree, '-m', 'Add the logo'], {
        env: {
          GIT_AUTHOR_NAME: 'Ada Lovelace',
          GIT_AUTHOR_EMAIL: 'ada@example.com',
          GIT_AUTHOR_DATE: '2026-09-25T10:00:00Z',
          GIT_COMMITTER_NAME: 'Wirebench Server',
          GIT_COMMITTER_EMAIL: 'server@example.com',
          GIT_COMMITTER_DATE: '2026-09-25T10:00:01Z',
        },
      })
    ).stdout.trim();
    await git.run(repo, ['update-ref', 'refs/heads/main', commit, '']);

    // %at (seconds since the epoch) rather than %aI, whose UTC spelling differs between git versions.
    const log = await git.run(repo, ['log', '--format=%an|%ae|%at|%cn|%ce|%s', '-n', '1', 'refs/heads/main']);
    expect(log.stdout.trim()).toBe(
      `Ada Lovelace|ada@example.com|${String(Date.parse('2026-09-25T10:00:00Z') / 1000)}|Wirebench Server|server@example.com|Add the logo`,
    );
  });

  it('maxBuffer applies per call: a blob over the limit is outputTooLarge', async () => {
    const id = (
      await git.run(repo, ['hash-object', '-w', '--stdin'], { input: Buffer.alloc(64 * 1024, 0x61) })
    ).stdout.trim();

    await expect(git.run(repo, ['cat-file', 'blob', id], { stdout: 'buffer', maxBuffer: 1024 })).rejects.toMatchObject({
      code: 'git-failed',
      details: { outputTooLarge: true },
    });
    expect((await git.run(repo, ['cat-file', 'blob', id], { stdout: 'buffer' })).stdout).toHaveLength(64 * 1024);
  });
});
