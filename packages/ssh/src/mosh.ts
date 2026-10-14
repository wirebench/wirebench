import type { ClientChannel } from 'ssh2';
import { HopProgress } from './connect-progress.js';
import { SshConnectError, dialChain, hostOf } from './dial.js';
import type { DialOptions, HopCredentials } from './dial.js';
import type { MoshSettings } from './host-mosh.js';

/** Where the mosh server listens and the session key it printed. The key is a secret: never logged or shown. */
export interface MoshEndpoint {
  readonly port: number;
  readonly key: string;
}

export type MoshBootstrapOptions = DialOptions & {
  readonly mosh?: MoshSettings | undefined;
  /** The host's variables, values resolved: passed as `-l NAME=VALUE`, mosh's only way to set them. */
  readonly env?: Readonly<Record<string, string>>;
  /** How long `mosh-server new` may take to answer; 20 s by default. */
  readonly timeoutMs?: number;
};

const DEFAULT_SERVER = 'mosh-server';
const BOOTSTRAP_TIMEOUT_MS = 20_000;
/** A remote shell's "no such command": exit 127, or its message when the status is lost. */
const NOT_FOUND = /command not found|not found|no such file or directory/i;
const CONNECT_LINE = /^MOSH CONNECT (\d{1,5}) ([A-Za-z0-9/+]{22})\s*$/m;

/** One POSIX shell word: single quotes, an embedded quote closed, escaped and reopened. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * `mosh-server new` as the remote shell runs it: `-s` binds to the address the SSH connection came in on,
 * `-c 256` matches xterm-256color, a UTF-8 locale, then each variable and the port range.
 */
export function moshServerCommand(mosh: MoshSettings | undefined, env: Readonly<Record<string, string>> = {}): string {
  const words = [mosh?.server ?? DEFAULT_SERVER, 'new', '-s', '-c', '256', '-l', 'LANG=C.UTF-8'];
  for (const [name, value] of Object.entries(env)) words.push('-l', `${name}=${value}`);
  if (mosh?.ports !== undefined) words.push('-p', mosh.ports);
  return words.map(shellWord).join(' ');
}

/** The server's `MOSH CONNECT <port> <key>` line, or undefined when it never printed one. */
export function parseMoshConnect(stdout: string): MoshEndpoint | undefined {
  const match = CONNECT_LINE.exec(stdout);
  if (!match) return undefined;
  const port = Number(match[1]);
  if (port < 1 || port > 65535) return undefined;
  return { port, key: match[2] as string };
}

/** The last non-empty line, cut short: the server's own words for what went wrong, never the key. */
function lastLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('MOSH CONNECT'));
  const last = lines[lines.length - 1];
  return last === undefined ? undefined : last.slice(0, 300);
}

/**
 * Why a bootstrap printed no `MOSH CONNECT`: `mosh-server-missing` when the remote shell could not find the
 * command, else `mosh-bootstrap-failed` with the server's last line.
 */
export function moshBootstrapError(
  result: {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut?: boolean;
  },
  host: string,
  server = DEFAULT_SERVER,
): SshConnectError {
  if (result.code === 127 || (result.code !== 0 && NOT_FOUND.test(result.stderr) && result.stderr.includes(server))) {
    return new SshConnectError(
      'mosh-server-missing',
      `${host}: ${server} was not found on the server. Install mosh there, or set the server command.`,
      { host, server },
    );
  }
  const said = lastLine(result.stderr) ?? lastLine(result.stdout);
  const why = result.timedOut === true ? 'did not answer in time' : 'did not start';
  return new SshConnectError('mosh-bootstrap-failed', `${host}: ${server} ${why}${said ? `: ${said}` : ''}`, {
    host,
    server,
    ...(result.code === null ? {} : { exitCode: result.code }),
    ...(said === undefined ? {} : { serverSaid: said }),
    ...(result.timedOut === true ? { timedOut: true } : {}),
  });
}

/**
 * Dials the chain, starts a mosh server on the target over SSH, and ends the connection: the session then
 * runs over UDP, which the caller starts with the answer.
 *
 * @throws SshConnectError every dial refusal, `mosh-server-missing`, `mosh-bootstrap-failed`
 */
export async function bootstrapMosh(options: MoshBootstrapOptions): Promise<MoshEndpoint> {
  const chain = await dialChain(options);
  try {
    const lastHop = options.hops[options.hops.length - 1] as HopCredentials;
    const host = hostOf(lastHop);
    const progress = new HopProgress(options.onProgress, options.hops.length - 1, options.hops.length, host);
    const server = options.mosh?.server ?? DEFAULT_SERVER;
    progress.start('shell', 'mosh-server');
    progress.log(`Starting ${server}${options.mosh?.ports === undefined ? '' : ` on UDP ${options.mosh.ports}`}`);
    const result = await execCollect(
      chain.client,
      moshServerCommand(options.mosh, options.env),
      options.timeoutMs ?? BOOTSTRAP_TIMEOUT_MS,
    );
    const endpoint = parseMoshConnect(result.stdout);
    if (!endpoint) {
      const error = moshBootstrapError(result, host, server);
      progress.fail(error.message);
      throw error;
    }
    progress.log(`${server} listens on UDP ${String(endpoint.port)}`);
    progress.done('shell', 'mosh-server');
    return endpoint;
  } finally {
    chain.endAll();
  }
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/**
 * Runs one command and gathers its output. Settles at the `MOSH CONNECT` line too: a server that keeps the
 * channel open after detaching must not hold the connect up.
 */
function execCollect(client: DialledClient, command: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const result: ExecResult = { code: null, stdout: '', stderr: '' };
    let settled = false;
    let channel: ClientChannel | undefined;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel?.close();
      resolve(result);
    };
    const timer = setTimeout(() => {
      result.timedOut = true;
      done();
    }, timeoutMs);
    try {
      client.exec(command, (error, ch) => {
        if (error) {
          result.stderr = error.message;
          return done();
        }
        channel = ch;
        if (settled) return ch.close();
        ch.on('data', (data: Buffer) => {
          result.stdout += data.toString('utf8');
          if (CONNECT_LINE.test(result.stdout)) setTimeout(done, 50);
        });
        ch.stderr.on('data', (data: Buffer) => {
          result.stderr += data.toString('utf8');
        });
        ch.on('exit', (code: number | null) => {
          result.code = code;
        });
        ch.on('close', done);
        ch.on('error', done);
      });
    } catch (error) {
      result.stderr = (error as Error).message;
      done();
    }
  });
}

type DialledClient = Awaited<ReturnType<typeof dialChain>>['client'];
