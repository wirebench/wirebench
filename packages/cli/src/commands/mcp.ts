/**
 * `wirebench mcp` (spec §4): the ops as MCP tools over stdio. The project is checked before the
 * server starts, so a wrong `--project` fails in the terminal rather than in every tool call.
 * Only protocol frames go to stdout; the startup line and every warning go to stderr.
 */
import { format } from 'node:util';
import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpArgs } from '../args.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
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

/**
 * Serves Streamable HTTP until SIGINT or SIGTERM. The generated token is printed once, to stderr:
 * stdout stays free of it, and no later line repeats it.
 */
async function serveHttp(port: number, base: OpsBase, io: Pick<CliIo, 'stderr' | 'env'>): Promise<ExitCode> {
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
      createServer: () => createMcpServer(base, cliVersion()),
      log: (line) => io.stderr.write(`${line}\n`),
    });
  } catch (error) {
    io.stderr.write(`wirebench mcp: cannot listen on 127.0.0.1:${String(port)}: ${(error as Error).message}\n`);
    return ExitCode.RunError;
  }
  io.stderr.write(`wirebench mcp: serving ${base.projectDir} at ${running.url} (${describeGates(base)})\n`);
  if (generated) {
    io.stderr.write(`bearer token (set ${TOKEN_VARIABLE} to choose your own): ${token}\n`);
  }
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await running.close();
  return ExitCode.Ok;
}

export async function mcpCommand(
  args: McpArgs,
  io: CliIo,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<ExitCode> {
  const base = mcpBaseFor(args, io);
  const refused = await checkProject(base, io);
  if (refused !== undefined) {
    return refused;
  }
  if (args.httpPort !== undefined) {
    return await serveHttp(args.httpPort, base, io);
  }
  const restoreConsole = keepConsoleOffStdout(io);
  try {
    const server = createMcpServer(base, cliVersion());
    // Serving ends when stdin does, or when the transport closes itself (the SDK's stdio transport
    // does so for a line over 10 MiB). Calls still in flight at that point are dropped, as MCP's
    // shutdown semantics allow.
    const ended = new Promise<void>((resolve) => {
      stdin.once('end', resolve);
      stdin.once('close', resolve);
      server.server.onclose = resolve;
    });
    server.server.onerror = (error) => {
      io.stderr.write(`mcp: ${error.message}\n`);
    };
    await server.connect(new StdioServerTransport(stdin as Readable, io.stdout as Writable));
    io.stderr.write(`wirebench mcp: serving ${base.projectDir} on stdio (${describeGates(base)})\n`);
    await ended;
    await server.close();
    return ExitCode.Ok;
  } finally {
    restoreConsole();
  }
}
