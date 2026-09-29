/**
 * `wirebench mcp` (spec §4): the ops as MCP tools over stdio. The project is checked before the
 * server starts, so a wrong `--project` fails in the terminal rather than in every tool call.
 * Only protocol frames go to stdout; the startup line and every warning go to stderr.
 */
import { createRequire } from 'node:module';
import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpArgs } from '../args.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { createMcpServer } from '../mcp/server.js';
import type { OpsBase } from '../ops/context.js';
import { exitCodeForError, toOpsError } from '../ops/errors.js';
import { openProject } from '../ops/project.js';
import { opsBaseFor } from './ops.js';

const require = createRequire(import.meta.url);

export function cliVersion(): string {
  return (require('../../package.json') as { readonly version: string }).version;
}

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
  const server = createMcpServer(base, cliVersion());
  const ended = new Promise<void>((resolve) => {
    stdin.once('end', resolve);
    stdin.once('close', resolve);
  });
  await server.connect(new StdioServerTransport(stdin as Readable, io.stdout as Writable));
  io.stderr.write(`wirebench mcp: serving ${base.projectDir} on stdio (${describeGates(base)})\n`);
  await ended;
  await server.close();
  return ExitCode.Ok;
}
