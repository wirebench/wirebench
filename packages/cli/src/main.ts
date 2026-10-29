import { agentCommand } from './commands/agent.js';
import { callCommand } from './commands/call.js';
import { diffContractCommand } from './commands/diff-contract.js';
import { exportCommand } from './commands/export.js';
import { lintCommand } from './commands/lint.js';
import { mcpCommand } from './commands/mcp.js';
import { mockCommand } from './commands/mock.js';
import { mockCheckCommand } from './commands/mock-check.js';
import { mockRecordCommand } from './commands/mock-record.js';
import { opCommand } from './commands/ops.js';
import { pluginCommand } from './commands/plugin.js';
import { runCommand } from './commands/run.js';
import { scriptsConvertCommand } from './commands/scripts-convert.js';
import { secretsListCommand } from './commands/secrets-list.js';
import { sshForwardCommand } from './commands/ssh-forward.js';
import { ExitCode } from './exit-codes.js';
import { disposeCliPluginHost } from './features.js';
import { cliVersion } from './version.js';
import { HELP_TEXT, HELP_TOPICS, UsageError, parseCliArgs } from './args.js';

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
        const topic = args.topic !== undefined ? HELP_TOPICS[args.topic] : undefined;
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
      case 'scripts-convert': {
        return await scriptsConvertCommand(args, io);
      }
      case 'op': {
        return await opCommand(args, io);
      }
      case 'call': {
        return await callCommand(args, io);
      }
      case 'diff-contract': {
        return await diffContractCommand(args, io);
      }
      case 'lint': {
        return await lintCommand(args, io);
      }
      case 'mcp': {
        return await mcpCommand(args, io);
      }
      case 'mock': {
        return await mockCommand(args, io);
      }
      case 'mock-check': {
        return await mockCheckCommand(args, io);
      }
      case 'mock-record': {
        return await mockRecordCommand(args, io);
      }
      case 'export': {
        return await exportCommand(args, io);
      }
      case 'ssh-forward': {
        return await sshForwardCommand(args, io);
      }
      case 'agent-run':
      case 'agent-pair':
      case 'agent-unpair':
      case 'agent-status':
      case 'agent-allow-env':
      case 'agent-disallow-env':
      case 'agent-allowed-env': {
        return await agentCommand(args, io);
      }
      case 'plugin-install':
      case 'plugin-list':
      case 'plugin-remove': {
        return await pluginCommand(args, io);
      }
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\ntry --help\n`);
      return ExitCode.Usage;
    }
    io.stderr.write(`internal-error: ${error instanceof Error ? error.message : String(error)}\n`);
    return ExitCode.RunError;
  } finally {
    await disposeCliPluginHost();
  }
}
