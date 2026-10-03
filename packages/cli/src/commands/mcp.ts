/**
 * `wirebench mcp` (spec §4): the ops, and each contract operation (#33), as MCP tools over stdio or
 * `--http`. The project and the contract tool count are checked before the server starts, so a wrong
 * `--project` or a set over the cap fails in the terminal rather than in every tool call.
 * Only protocol frames go to stdout; the startup line and every warning go to stderr.
 */
import { format } from 'node:util';
import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpArgs } from '../args.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { startContractTools } from '../mcp/contract-tools.js';
import type { ContractToolsHost } from '../mcp/contract-tools.js';
import { InvalidTokenError, resolveToken, startHttpServer, TOKEN_VARIABLE } from '../mcp/http.js';
import { createMcpServer } from '../mcp/server.js';
import type { OpsBase } from '../ops/context.js';
import { exitCodeForError, toOpsError } from '../ops/errors.js';
import { openProject } from '../ops/project.js';
import { cliVersion } from '../version.js';
import { opsBaseFor } from './ops.js';

export function mcpBaseFor(args: McpArgs, io: Pick<CliIo, 'stderr' | 'env'>): OpsBase {
  return opsBaseFor(
    {
      project: args.project,
      historyDir: args.historyDir,
      gates: {
        write: args.allowWrite,
        send: args.allowSend,
        ...(args.environments !== undefined ? { environments: args.environments } : {}),
      },
      origin: 'mcp',
    },
    io,
  );
}

export function describeGates(base: OpsBase): string {
  const environments =
    base.gates.environments !== undefined ? `, environments ${base.gates.environments.join(', ')}` : '';
  return `write ${base.gates.write ? 'on' : 'off'}, send ${base.gates.send ? 'on' : 'off'}${environments}`;
}

/** Loads the project once; the exit code, after its error is printed, when it cannot be served. */
export async function checkProject(base: OpsBase, io: Pick<CliIo, 'stderr'>): Promise<ExitCode | undefined> {
  try {
    await openProject(base);
    return undefined;
  } catch (error) {
    const failure = toOpsError(error);
    io.stderr.write(`${failure.code}: ${failure.message}\n`);
    return exitCodeForError(failure);
  }
}

/**
 * Points `console.log`, `console.info` and `console.debug` at stderr, so a stray log call in any
 * dependency cannot put a non-frame line on stdout. Returns the restore.
 *
 * This covers the main thread only. The engine's worker threads (XPath/JSONPath evaluation, the REST
 * contract check, the script checker) keep Node's default, where a worker's stdout is piped to the
 * process's: their output is not guarded here. None of them writes to stdout today; docs/security.md
 * says the same.
 */
function keepConsoleOffStdout(io: Pick<CliIo, 'stderr'>): () => void {
  const saved = { log: console.log, info: console.info, debug: console.debug };
  const toStderr = (...parts: unknown[]): void => {
    io.stderr.write(`${format(...parts)}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  return () => {
    console.log = saved.log;
    console.info = saved.info;
    console.debug = saved.debug;
  };
}

/** Resolves when `stop` aborts, or, without one, on the process's first SIGINT or SIGTERM. */
function stopped(stop: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (stop !== undefined) {
      if (stop.aborted) {
        resolve();
      } else {
        stop.addEventListener('abort', () => resolve(), { once: true });
      }
      return;
    }
    const onSignal = (): void => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}

/** `wirebench mcp: <n> contract tools`, after the serving line, when there are any. */
function writeToolCount(io: Pick<CliIo, 'stderr'>, host: ContractToolsHost): void {
  const count = host.current().tools.length;
  if (count > 0) {
    io.stderr.write(`wirebench mcp: ${String(count)} contract tools\n`);
  }
}

/**
 * Serves Streamable HTTP until `stop` aborts (SIGINT or SIGTERM when none is given). The generated
 * token is printed once, to stderr: stdout stays free of it, and no later line repeats it.
 */
async function serveHttp(
  port: number,
  base: OpsBase,
  io: Pick<CliIo, 'stderr' | 'env'>,
  stop: AbortSignal | undefined,
  host: ContractToolsHost,
): Promise<ExitCode> {
  let resolved;
  try {
    resolved = resolveToken(io.env);
  } catch (error) {
    if (error instanceof InvalidTokenError) {
      io.stderr.write(`${error.message}\n`);
      return ExitCode.Usage;
    }
    throw error;
  }
  const { token, generated } = resolved;
  let running;
  try {
    running = await startHttpServer({
      port,
      token,
      createServer: () => createMcpServer(base, cliVersion(), host),
      log: (line) => io.stderr.write(`${line}\n`),
    });
  } catch (error) {
    io.stderr.write(`wirebench mcp: cannot listen on 127.0.0.1:${String(port)}: ${(error as Error).message}\n`);
    return ExitCode.RunError;
  }
  io.stderr.write(`wirebench mcp: serving ${base.projectDir} at ${running.url} (${describeGates(base)})\n`);
  writeToolCount(io, host);
  if (generated) {
    io.stderr.write(`bearer token (set ${TOKEN_VARIABLE} to choose your own): ${token}\n`);
  }
  await stopped(stop);
  await running.close();
  return ExitCode.Ok;
}

export interface McpCommandOptions {
  /** Where stdio mode reads frames from; the process's stdin by default. */
  readonly stdin?: NodeJS.ReadableStream;
  /** Ends `--http` serving when it aborts; without one, SIGINT or SIGTERM does. */
  readonly stop?: AbortSignal;
}

export async function mcpCommand(args: McpArgs, io: CliIo, options: McpCommandOptions = {}): Promise<ExitCode> {
  const stdin = options.stdin ?? process.stdin;
  const base = mcpBaseFor(args, io);
  const refused = await checkProject(base, io);
  if (refused !== undefined) {
    return refused;
  }
  let host: ContractToolsHost;
  try {
    // Above the cap, or with an unknown --tools name, nothing is served (spec §2.1): exit 2.
    host = await startContractTools(base, args.tools !== undefined ? { containers: args.tools } : {});
  } catch (error) {
    const failure = toOpsError(error);
    io.stderr.write(`${failure.code}: ${failure.message}\n`);
    return exitCodeForError(failure);
  }
  try {
    if (args.httpPort !== undefined) {
      return await serveHttp(args.httpPort, base, io, options.stop, host);
    }
    const restoreConsole = keepConsoleOffStdout(io);
    try {
      const server = createMcpServer(base, cliVersion(), host);
      // Serving ends when stdin does, or when the transport closes itself (the SDK's stdio transport
      // does so for a line over 10 MiB). Calls still in flight at that point are dropped, as MCP's
      // shutdown semantics allow.
      const ended = new Promise<void>((resolve) => {
        stdin.once('end', resolve);
        stdin.once('close', resolve);
        const unsubscribe = server.server.onclose;
        server.server.onclose = () => {
          unsubscribe?.();
          resolve();
        };
      });
      server.server.onerror = (error) => {
        io.stderr.write(`mcp: ${error.message}\n`);
      };
      await server.connect(new StdioServerTransport(stdin as Readable, io.stdout as Writable));
      io.stderr.write(`wirebench mcp: serving ${base.projectDir} on stdio (${describeGates(base)})\n`);
      writeToolCount(io, host);
      await ended;
      await server.close();
      return ExitCode.Ok;
    } finally {
      restoreConsole();
    }
  } finally {
    host.close();
  }
}
