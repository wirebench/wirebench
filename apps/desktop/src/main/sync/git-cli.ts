/**
 * A small, Electron-free wrapper around the system `git` executable: discovery ({@link findGit}),
 * a hardened {@link GitCli.run}, error mapping and remote URL validation ({@link assertRemoteUrl}).
 *
 * This file must never import `electron` — `SyncService` (and the server backend of spec 2)
 * runs it in plain Node, and `ipc/git.ts` is the only place that bridges it to Electron.
 *
 * Git is never bundled: it is found on the machine it runs on, or the user is asked to locate
 * it (`git.locate`). Every invocation goes through {@link GitCli.run}, which never opens a
 * shell, never prompts, never runs a hook, and refuses any subcommand outside
 * {@link GIT_SUBCOMMANDS} before a process is even spawned.
 */

import { execFile } from 'node:child_process';
import { delimiter as posixDelimiter } from 'node:path';
import { promisify } from 'node:util';
import { WirebenchError } from '@wirebench/engine';

/**
 * The only git subcommands `GitCli.run` will spawn. A `-`-prefixed first argument, or any
 * subcommand not on this list, is refused before a process is spawned — see `run`.
 */
export const GIT_SUBCOMMANDS = [
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
] as const;

/** One of the subcommands {@link GIT_SUBCOMMANDS} allows. */
export type GitSubcommand = (typeof GIT_SUBCOMMANDS)[number];

/**
 * How a git process is actually spawned. Resolves — never rejects — on a non-zero exit; it
 * rejects only when the executable itself could not be spawned (`ENOENT`/`EACCES`), which
 * {@link findGit} treats as "this candidate is not usable" and {@link GitCli.run} maps to
 * `git-not-found`.
 */
export type Runner = (
  file: string,
  args: readonly string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** A located, usable git executable. */
export interface GitLocation {
  readonly path: string;
  readonly version: string;
}

const execFileAsync = promisify(execFile);

/** Bytes above which `execFile`'s buffered stdout/stderr is truncated (16 MiB). */
const MAX_BUFFER = 16 * 1024 * 1024;

/** The default {@link Runner}: `execFile`, resolving `{ exitCode }` instead of rejecting on it. */
const defaultRunner: Runner = async (file, args, options) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args as string[], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
      killed?: boolean;
      signal?: string | null;
    };
    // ENOENT/EACCES mean the executable could not be spawned at all — not "git ran and failed" —
    // so this must still reject, per the contract above.
    if (nodeError.code === 'ENOENT' || nodeError.code === 'EACCES') {
      throw error;
    }
    if (nodeError.killed === true || nodeError.signal !== undefined) {
      // A timeout kill: surface it distinctly so `run` can report `details.timedOut`.
      throw error;
    }
    const exitCode = typeof nodeError.code === 'number' ? nodeError.code : 1;
    return { stdout: nodeError.stdout ?? '', stderr: nodeError.stderr ?? '', exitCode };
  }
};

/** Parses `git version 2.39.2 (Apple Git-143)` (or `... 2.42.0.windows.1`) → the version string. */
export function parseGitVersion(stdout: string): string | undefined {
  const match = /git version (\S+)/.exec(stdout);
  return match?.[1];
}

/** Compares two dot-separated version strings numerically, ignoring trailing non-numeric parts. */
function compareVersions(a: string, b: string): number {
  const toParts = (version: string): number[] =>
    version
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((n) => (Number.isNaN(n) ? 0 : n));
  const partsA = toParts(a);
  const partsB = toParts(b);
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/** The minimum git version `findGit` accepts; older candidates are skipped. */
const MINIMUM_VERSION = '2.20.0';

/** How long a discovery probe (`git --version`) may take before it is abandoned. */
const PROBE_TIMEOUT_MS = 5_000;

/** Platform-specific fallback locations, tried after `configuredPath` and the `PATH` entries. */
function platformDefaultCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') {
    return ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'];
  }
  if (platform === 'win32') {
    const programFiles = env['ProgramFiles'];
    const localAppData = env['LocalAppData'];
    const candidates: string[] = [];
    if (programFiles !== undefined) {
      candidates.push(`${programFiles}\\Git\\cmd\\git.exe`);
    }
    if (localAppData !== undefined) {
      candidates.push(`${localAppData}\\Programs\\Git\\cmd\\git.exe`);
    }
    return candidates;
  }
  return ['/usr/bin/git'];
}

/** Splits `PATH` into per-entry git candidates for `platform` (`;` on win32, `:` elsewhere). */
function pathCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const raw = env['PATH'] ?? env['Path'] ?? '';
  const delimiter = platform === 'win32' ? ';' : posixDelimiter;
  const entries = raw.split(delimiter).filter((entry) => entry.length > 0);
  const exeName = platform === 'win32' ? 'git.exe' : 'git';
  const join = platform === 'win32' ? '\\' : '/';
  return entries.map((entry) => (entry.endsWith(join) ? `${entry}${exeName}` : `${entry}${join}${exeName}`));
}

/**
 * Finds a usable system git: the configured path first, then every `PATH` entry, then a
 * platform default. The first candidate whose `--version` probe exits 0 with a parsable,
 * sufficiently recent version wins; every other outcome (spawn failure, non-zero exit, unparsable
 * output, too old) just skips to the next candidate.
 */
export async function findGit(options: {
  configuredPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  run?: Runner;
}): Promise<GitLocation | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRunner;
  const candidates = [
    ...(options.configuredPath !== undefined ? [options.configuredPath] : []),
    ...pathCandidates(platform, env),
    ...platformDefaultCandidates(platform, env),
  ];
  for (const candidate of candidates) {
    if (options.exists !== undefined && !options.exists(candidate)) {
      continue;
    }
    let result;
    try {
      result = await run(candidate, ['--version'], { env, timeoutMs: PROBE_TIMEOUT_MS });
    } catch {
      // Could not spawn at all (ENOENT/EACCES, or a fake run() that throws) — not usable.
      continue;
    }
    if (result.exitCode !== 0) {
      continue;
    }
    const version = parseGitVersion(result.stdout);
    if (version === undefined) {
      continue;
    }
    if (compareVersions(version, MINIMUM_VERSION) < 0) {
      continue;
    }
    return { path: candidate, version };
  }
  return undefined;
}

/** `git@host:path` remotes (the scp-like syntax `assertRemoteUrl` accepts alongside URL schemes). */
const SCP_LIKE_REMOTE = /^[\w.-]+@[\w.-]+:[^\s]+$/;

/** Schemes `assertRemoteUrl` accepts. */
const ALLOWED_SCHEMES = ['https:', 'ssh:', 'file:'];

/**
 * Refuses anything that is not a `https://`, `ssh://`, `file://` URL or a `git@host:path`
 * remote — in particular an empty string, a `-`-prefixed value (which `git` would parse as a
 * flag) and `ext::…` (git's "run an arbitrary command" transport).
 */
export function assertRemoteUrl(url: string): void {
  const trimmed = url.trim();
  const fail = (): never => {
    throw new WirebenchError('git-remote-refused', `"${url}" is not an accepted git remote URL.`, {
      details: { url },
    });
  };
  if (trimmed.length === 0 || trimmed.startsWith('-') || trimmed.startsWith('ext::')) {
    fail();
  }
  if (SCP_LIKE_REMOTE.test(trimmed)) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    fail();
  }
  if (!ALLOWED_SCHEMES.includes(parsed!.protocol)) {
    fail();
  }
}

/** Regexes classifying git's stderr for `run`'s error mapping. */
const AUTH_FAILED_PATTERN =
  /Authentication failed|could not read Username|Permission denied \(publickey|Host key verification failed|terminal prompts disabled|Invalid username or password/i;
const OFFLINE_PATTERN =
  /Could not resolve host|unable to access|Connection (refused|timed out)|Network is unreachable|Could not read from remote repository/i;

/** Bytes of stderr kept in error `details` (2 KiB from the end). */
const STDERR_DETAIL_BYTES = 2 * 1024;

/** Strips `user:token@` userinfo from any `https://`-style URL argument, for safe error details. */
function redactArg(arg: string): string {
  return arg.replace(/^(https?:\/\/)[^/@]+@/i, '$1');
}

/** Default timeout for a `GitCli.run` call, when the caller does not name one. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Runs the system git found by {@link findGit}, with every hardening constraint the plan
 * requires: no shell, no prompt, no hooks, a fixed subcommand allow-list, and error `details`
 * that never carry the environment or a credential-bearing URL.
 */
export class GitCli {
  readonly version: string;
  private readonly path: string;
  private readonly hooksDir: string;
  private readonly runner: Runner;
  private readonly extraEnv: NodeJS.ProcessEnv;

  constructor(location: GitLocation, options: { hooksDir: string; run?: Runner; env?: NodeJS.ProcessEnv }) {
    this.path = location.path;
    this.version = location.version;
    this.hooksDir = options.hooksDir;
    this.runner = options.run ?? defaultRunner;
    this.extraEnv = options.env ?? {};
  }

  async run(
    cwd: string | undefined,
    args: readonly string[],
    options?: { timeoutMs?: number },
  ): Promise<{
    stdout: string;
    stderr: string;
  }> {
    const subcommand = args[0];
    if (!(GIT_SUBCOMMANDS as readonly string[]).includes(subcommand ?? '')) {
      throw new WirebenchError('git-failed', `"${subcommand ?? ''}" is not an allowed git subcommand.`, {
        details: { args: args.map(redactArg) },
      });
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.extraEnv,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      LC_ALL: 'C',
      GIT_SSH_COMMAND: process.env['GIT_SSH_COMMAND'] ?? 'ssh -o BatchMode=yes',
    };
    const fullArgs = [
      '-c',
      'core.autocrlf=false',
      '-c',
      'merge.conflictstyle=merge',
      '-c',
      `core.hooksPath=${this.hooksDir}`,
      ...args,
    ];
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let result;
    try {
      result = await this.runner(this.path, fullArgs, { ...(cwd !== undefined ? { cwd } : {}), env, timeoutMs });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
      if (nodeError.code === 'ENOENT' || nodeError.code === 'EACCES') {
        throw new WirebenchError('git-not-found', 'The configured git executable could not be run.', {
          details: { args: args.map(redactArg) },
          cause: error,
        });
      }
      if (nodeError.killed === true || nodeError.signal !== undefined) {
        throw new WirebenchError('git-failed', `git ${subcommand ?? ''} timed out.`, {
          details: { args: args.map(redactArg), timedOut: true },
          cause: error,
        });
      }
      throw new WirebenchError('git-failed', 'git could not be run.', {
        details: { args: args.map(redactArg) },
        cause: error,
      });
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.slice(-STDERR_DETAIL_BYTES);
      const details = { args: args.map(redactArg), exitCode: result.exitCode, stderr: stderr.trim() };
      if (AUTH_FAILED_PATTERN.test(result.stderr)) {
        throw new WirebenchError('git-auth-failed', 'git could not authenticate with the remote.', { details });
      }
      if (OFFLINE_PATTERN.test(result.stderr)) {
        throw new WirebenchError('git-offline', 'git could not reach the remote.', { details });
      }
      throw new WirebenchError('git-failed', `git ${subcommand ?? ''} failed.`, { details });
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }
}
