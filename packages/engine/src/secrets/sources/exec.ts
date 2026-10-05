/**
 * Runs a secret manager's own CLI (ADR-0020): found on PATH, spawned with `execFile` and no shell, the
 * user's environment passed through so their login works, stdin closed, bounded in time and output.
 * Same discipline as `sync/git-cli.ts`.
 *
 * On Windows only an `.exe` is accepted: Node refuses to run a `.cmd`/`.bat` without a shell, and a shell
 * is what this module exists to avoid (secret sources spec, amendment A1).
 */

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { secretSourceError, TOOL_INSTALL_PAGES } from './errors.js';

export const SOURCE_TIMEOUT_MS = 20_000;
export const SOURCE_STDOUT_MAX = 64 * 1024;
export const SOURCE_STDERR_MAX = 4 * 1024;
/** How much of a failing tool's stderr an error shows, after masking. */
export const SOURCE_STDERR_SHOWN = 1024;

export interface SourceToolOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
  readonly isFile?: (path: string) => Promise<boolean>;
}

export type FindSourceTool = (tool: string, options?: SourceToolOptions) => Promise<string>;
export type RunSourceTool = (
  path: string,
  args: readonly string[],
  options?: SourceToolOptions,
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function installHint(tool: string): string {
  const page = TOOL_INSTALL_PAGES[tool];
  return page !== undefined ? ` Install it (${page}) and make sure it is on PATH.` : ' Make sure it is on PATH.';
}

async function locate(tool: string, options: SourceToolOptions): Promise<string> {
  const env = options.env ?? process.env;
  const windows = (options.platform ?? process.platform) === 'win32';
  const isFile = options.isFile ?? isRegularFile;
  const entries = (env['PATH'] ?? env['Path'] ?? '').split(windows ? ';' : ':').filter((entry) => entry.length > 0);
  const sep = windows ? '\\' : '/';
  const at = (dir: string, file: string): string => (dir.endsWith(sep) ? `${dir}${file}` : `${dir}${sep}${file}`);
  let wrapper: string | undefined;
  for (const dir of entries) {
    if (!windows) {
      if (await isFile(at(dir, tool))) {
        return at(dir, tool);
      }
      continue;
    }
    if (await isFile(at(dir, `${tool}.exe`))) {
      return at(dir, `${tool}.exe`);
    }
    for (const ext of ['.cmd', '.bat']) {
      if (wrapper === undefined && (await isFile(at(dir, `${tool}${ext}`)))) {
        wrapper = `${tool}${ext}`;
      }
    }
  }
  if (wrapper !== undefined) {
    throw secretSourceError(
      'secret-source-unsupported',
      '',
      '',
      `${wrapper} is a script wrapper, which Wirebench does not run on Windows (it would need a shell). Map this name to another kind on this machine.`,
    );
  }
  throw secretSourceError('secret-source-unavailable', '', '', `The ${tool} command was not found.${installHint(tool)}`);
}

const found = new Map<string, Promise<string>>();

/** The tool's path, memoised per tool, PATH and platform; a failed lookup is retried next time. */
export const findSourceTool: FindSourceTool = (tool, options = {}) => {
  if (options.isFile !== undefined) {
    return locate(tool, options);
  }
  const env = options.env ?? process.env;
  const key = `${options.platform ?? process.platform}\0${tool}\0${env['PATH'] ?? env['Path'] ?? ''}`;
  let pending = found.get(key);
  if (pending === undefined) {
    pending = locate(tool, options);
    found.set(key, pending);
    pending.catch(() => {
      found.delete(key);
    });
  }
  return pending;
};

/** Runs the tool; resolves with its exit code, and rejects as `secret-source-failed` on a timeout or oversize output. */
export const runSourceTool: RunSourceTool = (path, args, options = {}) =>
  new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? SOURCE_TIMEOUT_MS;
    const windows = (options.platform ?? process.platform) === 'win32';
    const pathSep = windows ? ';' : ':';
    let env: NodeJS.ProcessEnv;
    if (options.env === undefined) {
      env = process.env;
    } else {
      env = { ...process.env, ...options.env };
      const pathKey = windows ? 'Path' : 'PATH';
      const providedPath = options.env[pathKey];
      const systemPath = process.env[pathKey];
      if (providedPath && systemPath) {
        env[pathKey] = `${providedPath}${pathSep}${systemPath}`;
      }
    }
    const child = execFile(
      path,
      [...args],
      {
        env,
        timeout: timeoutMs,
        maxBuffer: SOURCE_STDOUT_MAX,
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const shown = stderr.slice(0, SOURCE_STDERR_MAX);
        if (error === null) {
          resolve({ stdout, stderr: shown, exitCode: 0 });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null; code?: string | number };
        if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(secretSourceError('secret-source-failed', '', '', `The command's output passed ${String(SOURCE_STDOUT_MAX / 1024)} KiB.`));
          return;
        }
        if (failure.killed === true || (failure.signal !== null && failure.signal !== undefined)) {
          reject(secretSourceError('secret-source-failed', '', '', `The command did not finish within ${String(timeoutMs / 1000)} s.`));
          return;
        }
        if (typeof failure.code === 'number') {
          resolve({ stdout, stderr: shown, exitCode: failure.code });
          return;
        }
        reject(secretSourceError('secret-source-unavailable', '', '', `The command could not be started (${String(failure.code ?? 'error')}).`));
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end();
  });
