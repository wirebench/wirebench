/**
 * This machine's side of the browser suite (hosted edition spec §18.7): an echo server on `127.0.0.1` that
 * only the paired agent can reach, and the headless `wirebench agent` from the built CLI, run here on the
 * runner and never in Docker (a container's loopback is not the person's).
 *
 * Global setup starts both before the seed (the seed names the echo server's port) and stops them at
 * teardown; the spec pairs the agent with {@link pairAgent} once the tab has shown it a code.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { CLI_BIN } from './stack.js';

const run = promisify(execFile);

/** How long the agent may take to listen: it loads its bundle and the engine first. */
const AGENT_START_MS = 60_000;

/** How long it may take to stop after SIGTERM before it is killed. */
const AGENT_STOP_MS = 10_000;

export interface LocalEcho {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  readonly url: string;
  close(): Promise<void>;
}

/** An echo server on this machine's loopback: answers every request with its method, path and headers. */
export async function startLocalEcho(): Promise<LocalEcho> {
  const server: Server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ echo: 'local', method: request.method, url: request.url, headers: request.headers }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** The agent's environment: its own folder, and no proxy, so its calls to the server go straight there. */
function agentEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, WIREBENCH_AGENT_HOME: home };
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) delete env[name];
  return env;
}

function assertBuilt(): void {
  if (!existsSync(CLI_BIN)) {
    throw new Error(`The CLI is not built (${CLI_BIN} is missing): run pnpm --filter @wirebench/cli build first`);
  }
}

export interface RunningAgent {
  readonly port: number;
  stop(): Promise<void>;
}

/**
 * `wirebench agent` in `home`, resolved once it prints the port it listens on. Its stderr goes to this
 * process's, so CI's log shows what it refused; its stdout is echoed with a prefix.
 */
export async function startAgent(home: string): Promise<RunningAgent> {
  assertBuilt();
  const child: ChildProcess = spawn(process.execPath, [CLI_BIN, 'agent'], {
    env: agentEnv(home),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), AGENT_STOP_MS);
    await exited;
    clearTimeout(timer);
  };

  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => {
      reject(new Error(`wirebench agent did not listen within ${String(AGENT_START_MS / 1000)} s:\n${out}`));
    }, AGENT_START_MS);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      process.stdout.write(chunk.replace(/^(?=.)/gm, '[agent] '));
      out += chunk;
      const listening = /listening on 127\.0\.0\.1:(\d+)/.exec(out);
      if (listening?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(Number(listening[1]));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`wirebench agent exited (${String(code ?? signal)}) before it listened:\n${out}`));
    });
  }).catch(async (error: unknown) => {
    await stop();
    throw error;
  });
  return { port, stop };
}

/**
 * `wirebench agent pair <code> --server <url>` in `home`, as the person would type it from the tab's
 * *This machine*. The running agent's status file gives the pairing its port; the agent reads the new
 * pairing from its file within seconds. Throws with the command's output when it fails.
 */
export async function pairAgent(home: string, code: string, serverUrl: string): Promise<string> {
  assertBuilt();
  try {
    const { stdout } = await run(process.execPath, [CLI_BIN, 'agent', 'pair', code, '--server', serverUrl], {
      env: agentEnv(home),
      timeout: 60_000,
    });
    return stdout;
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(`wirebench agent pair failed: ${failed.message}\n${failed.stdout ?? ''}${failed.stderr ?? ''}`);
  }
}

/**
 * `wirebench agent unpair`: every pairing in `home`, at the server and here. Best effort: a failure is
 * logged, since it runs at the end of a run whose own result matters more.
 */
export async function unpairAgent(home: string): Promise<void> {
  try {
    await run(process.execPath, [CLI_BIN, 'agent', 'unpair'], { env: agentEnv(home), timeout: 60_000 });
  } catch (error) {
    console.error('wirebench agent unpair failed:', error);
  }
}

/**
 * Leaves `home` with no pairing, whatever an earlier attempt left: `unpair` at the server (best effort),
 * then `unpair --local` for anything a server could not be asked about. Throws when `status` still lists
 * one, since the loopback step needs a machine with no agent connected.
 */
export async function ensureUnpaired(home: string): Promise<void> {
  assertBuilt();
  await unpairAgent(home);
  const env = agentEnv(home);
  await run(process.execPath, [CLI_BIN, 'agent', 'unpair', '--local'], { env, timeout: 60_000 });
  const { stdout } = await run(process.execPath, [CLI_BIN, 'agent', 'status'], { env, timeout: 60_000 });
  if (!stdout.includes('Pairings: none')) throw new Error(`the agent is still paired:\n${stdout}`);
}
