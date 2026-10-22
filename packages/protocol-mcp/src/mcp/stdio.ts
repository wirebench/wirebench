/**
 * The stdio transport (#79): an MCP server as a local process, one JSON-RPC message per line.
 *
 * The process is spawned with no shell, so `command` and `args` reach it exactly as saved and
 * nothing in them is interpreted. Its environment is a short allowlist of the parent's variables
 * plus the transport's own (already expanded) entries, so a server never sees the user's other
 * secrets by accident. stderr is kept, its last 64 KiB, for the exchange and for the error of a
 * server that exits early.
 *
 * Closing ends stdin, which is how a well-behaved server knows to stop. One that does not is sent
 * `SIGTERM` after 2 s and `SIGKILL` 2 s after that; a forced close (the deadline, a cancel) kills
 * it at once. On Windows a process has no signals: `kill()` terminates it, and is all that is used.
 * `close` resolves only once the process has exited, so a send never leaves a child behind.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { McpError } from '#core/errors';
import {
  MCP_MAX_MESSAGE_BYTES,
  MCP_STDERR_CAP_BYTES,
  MCP_STDIO_KILL_GRACE_MS,
  MCP_STDIO_TERM_GRACE_MS,
} from './limits.js';
import type { McpWireCloseOptions, McpWireHandlers, McpWireTransport } from './transport.js';

/** The parent variables a stdio server inherits, where they are set. Everything else is the transport's own `env`. */
export const MCP_STDIO_PARENT_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SYSTEMROOT'] as const;

/**
 * What Windows adds to the allowlist: the profile and system folders a process there needs to start
 * a launcher such as `npx` (which reads `APPDATA`), find a program's extension (`PATHEXT`) or a temp
 * folder. Windows also gives a new process several of these itself.
 */
export const MCP_STDIO_WINDOWS_ENV = [
  'APPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'LOGONSERVER',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SYSTEMDRIVE',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
] as const;

/** The parent variables a stdio server inherits on `platform`. */
export function mcpStdioParentEnvNames(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === 'win32' ? [...MCP_STDIO_PARENT_ENV, ...MCP_STDIO_WINDOWS_ENV] : MCP_STDIO_PARENT_ENV;
}

/** How much of stderr's end an early-exit error carries in its details. */
const STDERR_TAIL_BYTES = 4 * 1024;

/** Options for {@link openStdioTransport}. Every string is already expanded. */
export interface McpStdioOptions {
  readonly command: string;
  readonly args: readonly string[];
  /** Absolute; see {@link resolveMcpCwd}. */
  readonly cwd: string;
  /** The transport's own variables, added over the allowlisted parent ones. */
  readonly env: Readonly<Record<string, string>>;
  /** Where the allowlisted variables come from. Default `process.env`. */
  readonly parentEnv?: NodeJS.ProcessEnv;
  /** Default {@link MCP_STDIO_TERM_GRACE_MS}. */
  readonly termGraceMs?: number;
  /** Default {@link MCP_STDIO_KILL_GRACE_MS}. */
  readonly killGraceMs?: number;
}

/** A stdio transport, with what the exchange records about the process. */
export interface McpStdioTransport extends McpWireTransport {
  /** stderr as text: its last 64 KiB. */
  readonly stderr: string;
  /** True when stderr was longer than what {@link stderr} kept. */
  readonly stderrTruncated: boolean;
  /** Null until the process has exited, and when a signal ended it. */
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  /** The process id, once it has started. */
  readonly pid: number | undefined;
}

/** The folder a stdio server runs in: `cwd` against the project folder, or the project folder itself. */
export function resolveMcpCwd(projectDir: string, cwd: string | undefined): string {
  return cwd === undefined || cwd.trim() === '' ? resolve(projectDir) : resolve(projectDir, cwd);
}

/** A stdio server's environment: the allowlisted parent variables that are set, then `env` over them. */
export function mcpStdioEnv(
  parentEnv: NodeJS.ProcessEnv,
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const names = mcpStdioParentEnvNames(platform);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    // Windows names are case-insensitive: a copy of its environment may hold `Path` for `PATH`.
    const key = platform === 'win32' ? name.toUpperCase() : name;
    if (names.includes(key)) out[name] = value;
  }
  return { ...out, ...env };
}

/** Kept bytes of a stream, its last `cap` of them. */
class TailBuffer {
  private chunks: Buffer[] = [];
  private length = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
    while (this.length > this.cap && this.chunks.length > 0) {
      const over = this.length - this.cap;
      const first = this.chunks[0]!;
      this.truncated = true;
      if (first.length <= over) {
        this.chunks.shift();
        this.length -= first.length;
      } else {
        this.chunks[0] = first.subarray(over);
        this.length -= over;
      }
    }
  }

  /** The last `bytes` as text, never starting halfway through a UTF-8 character. */
  text(bytes: number = this.cap): string {
    const all = Buffer.concat(this.chunks);
    let start = Math.max(0, all.length - bytes);
    while (start < all.length && (all[start]! & 0xc0) === 0x80) start += 1;
    return all.subarray(start).toString('utf8');
  }
}

/** Open a stdio transport. Nothing is spawned until `start`. */
export function openStdioTransport(options: McpStdioOptions): McpStdioTransport {
  const termGraceMs = options.termGraceMs ?? MCP_STDIO_TERM_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? MCP_STDIO_KILL_GRACE_MS;
  const stderr = new TailBuffer(MCP_STDERR_CAP_BYTES);
  const windows = process.platform === 'win32';

  let child: ChildProcess | undefined;
  let handlers: McpWireHandlers | undefined;
  let closing = false;
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let stdoutFailed = false;
  let pending: Buffer = Buffer.alloc(0);
  let closePromise: Promise<void> | undefined;
  let resolveExit: () => void = () => undefined;
  const exitPromise = new Promise<void>((done) => {
    resolveExit = done;
  });

  const exitedError = (): McpError => {
    const how = exitSignal !== null ? `was ended by ${exitSignal}` : `exited with code ${String(exitCode)}`;
    const tail = stderr.text(STDERR_TAIL_BYTES).trimEnd();
    const lastLine = tail.split('\n').at(-1)?.trim() ?? '';
    return new McpError(
      'mcp-server-exited',
      `The MCP server ${how} before the session finished${lastLine !== '' ? `: ${lastLine}` : ''}`,
      { details: { command: options.command, exitCode, signal: exitSignal, stderrTail: tail } },
    );
  };

  const tooLarge = (bytes: number): void => {
    stdoutFailed = true;
    pending = Buffer.alloc(0);
    handlers?.onError(
      new McpError(
        'mcp-message-too-large',
        `The MCP server sent a message larger than ${MCP_MAX_MESSAGE_BYTES} bytes`,
        { details: { bytes, limit: MCP_MAX_MESSAGE_BYTES } },
      ),
    );
  };

  const emitLine = (line: Buffer): void => {
    const end = line.length > 0 && line[line.length - 1] === 0x0d ? line.length - 1 : line.length;
    const text = line.subarray(0, end).toString('utf8');
    if (text.trim() === '') return;
    handlers?.onMessage(text);
  };

  const onStdout = (chunk: Buffer): void => {
    if (stdoutFailed) return;
    const data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    for (let nl = data.indexOf(0x0a, start); nl !== -1; nl = data.indexOf(0x0a, start)) {
      const line = data.subarray(start, nl);
      start = nl + 1;
      if (line.length > MCP_MAX_MESSAGE_BYTES) return tooLarge(line.length);
      emitLine(line);
      if (stdoutFailed) return;
    }
    // Copied, so a small remainder does not keep a large chunk alive.
    pending = Buffer.from(data.subarray(start));
    if (pending.length > MCP_MAX_MESSAGE_BYTES) tooLarge(pending.length);
  };

  /** Ends the process without grace: `SIGKILL` where there are signals, `kill()` on Windows. */
  const killHard = (): void => {
    if (child === undefined || exited) return;
    child.kill(windows ? undefined : 'SIGKILL');
  };

  const waitExit = (ms: number): Promise<boolean> => {
    if (exited) return Promise.resolve(true);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((done) => {
      timer = setTimeout(() => done(false), ms);
    });
    return Promise.race([exitPromise.then(() => true), timeout]).finally(() => clearTimeout(timer));
  };

  return {
    get stderr() {
      return stderr.text();
    },
    get stderrTruncated() {
      return stderr.truncated;
    },
    get exitCode() {
      return exitCode;
    },
    get exitSignal() {
      return exitSignal;
    },
    get pid() {
      return child?.pid;
    },

    start(given: McpWireHandlers): Promise<void> {
      handlers = given;
      return new Promise<void>((started, failed) => {
        let proc: ChildProcess;
        try {
          proc = spawn(options.command, [...options.args], {
            cwd: options.cwd,
            env: mcpStdioEnv(options.parentEnv ?? process.env, options.env),
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });
        } catch (err) {
          failed(spawnFailed(options, err));
          return;
        }
        child = proc;
        let spawned = false;
        proc.once('spawn', () => {
          spawned = true;
          started();
        });
        proc.once('error', (err) => {
          // Before 'spawn', this is the process failing to start (ENOENT, EACCES, a missing cwd).
          // After it, the only error left is a failed kill, which the exit wait below outlasts.
          if (!spawned) {
            exited = true;
            resolveExit();
            failed(spawnFailed(options, err));
          }
        });
        proc.stdout!.on('data', onStdout);
        proc.stdout!.on('end', () => {
          if (!stdoutFailed && pending.length > 0) emitLine(pending);
          pending = Buffer.alloc(0);
        });
        proc.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
        // A write to a server that has gone is reported by its exit, not by the pipe.
        proc.stdin!.on('error', () => undefined);
        proc.once('exit', (code, signal) => {
          exited = true;
          exitCode = code;
          exitSignal = signal;
          resolveExit();
        });
        // 'close' comes after stdout has been read to its end, so every line is delivered first.
        proc.once('close', () => {
          if (!spawned) return;
          handlers?.onClose(closing ? undefined : exitedError());
        });
      });
    },

    send(text: string): Promise<void> {
      const proc = child;
      if (proc === undefined || exited || closing || proc.stdin === null || proc.stdin.writableEnded) {
        return Promise.reject(
          exited ? exitedError() : new McpError('mcp-connection-closed', 'The MCP server connection is closed'),
        );
      }
      return new Promise<void>((written, failed) => {
        proc.stdin!.write(`${text}\n`, (err) => {
          if (err === null || err === undefined) written();
          else failed(exited ? exitedError() : new McpError('mcp-connection-closed', err.message, { cause: err }));
        });
      });
    },

    close(closeOptions: McpWireCloseOptions = {}): Promise<void> {
      if (closePromise !== undefined) {
        if (closeOptions.force === true) killHard();
        return closePromise;
      }
      closing = true;
      closePromise = (async () => {
        const proc = child;
        if (proc === undefined || exited) return;
        if (closeOptions.force === true) {
          killHard();
        } else {
          proc.stdin?.end();
          if (!(await waitExit(termGraceMs))) {
            proc.kill(windows ? undefined : 'SIGTERM');
            if (!(await waitExit(killGraceMs))) killHard();
          }
        }
        if (!(await waitExit(killGraceMs))) {
          // A process that outlives SIGKILL is beyond help; let go of its pipes so this side can finish.
          proc.stdout?.destroy();
          proc.stderr?.destroy();
        }
      })();
      return closePromise;
    },
  };
}

function spawnFailed(options: McpStdioOptions, err: unknown): McpError {
  const reason = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  return new McpError('mcp-spawn-failed', `Could not start the MCP server "${options.command}": ${reason}`, {
    details: { command: options.command, cwd: options.cwd, ...(typeof code === 'string' ? { code } : {}) },
    cause: err,
  });
}
