import { callCommand } from './commands/call.js';
import { exportCommand } from './commands/export.js';
import { mcpCommand } from './commands/mcp.js';
import { opCommand } from './commands/ops.js';
import { runCommand } from './commands/run.js';
import { secretsListCommand } from './commands/secrets-list.js';
import { ExitCode } from './exit-codes.js';
import { cliVersion } from './version.js';
import { HELP_TEXT, UsageError, parseCliArgs } from './args.js';
import { VERB_HELP } from './args-ops.js';

/** The I/O surface `main` writes through, so tests can capture output without touching the real process. */
export interface CliIo {
  readonly stdout: NodeJS.WritableStream & { readonly isTTY?: boolean };
  readonly stderr: NodeJS.WritableStream;
  readonly env: NodeJS.ProcessEnv;
}

/** Entry point shared by `bin.ts` and tests. Returns the process exit code; never throws. */
export async function main(
  argv: readonly string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr, env: process.env },
): Promise<number> {
  try {
    const args = parseCliArgs(argv);

    switch (args.command) {
      case 'help': {
        const topic = args.topic !== undefined ? VERB_HELP[args.topic] : undefined;
        io.stdout.write(`${topic ?? HELP_TEXT}\n`);
        return ExitCode.Ok;
      }
      case 'version': {
        io.stdout.write(`${cliVersion()}\n`);
        return ExitCode.Ok;
      }
      case 'run': {
        return await runCommand(args, io);
      }
      case 'secrets-list': {
        return await secretsListCommand(args, io);
      }
      case 'op': {
        return await opCommand(args, io);
      }
      case 'call': {
        return await callCommand(args, io);
      }
      case 'mcp': {
        return await mcpCommand(args, io);
      }
      case 'export': {
        return await exportCommand(args, io);
      }
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\ntry --help\n`);
      return ExitCode.Usage;
    }
    io.stderr.write(`internal-error: ${error instanceof Error ? error.message : String(error)}\n`);
    return ExitCode.RunError;
  }
}
