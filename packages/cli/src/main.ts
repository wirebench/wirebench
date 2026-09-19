import { createRequire } from 'node:module';
import { ExitCode } from './exit-codes.js';
import { HELP_TEXT, UsageError, parseCliArgs } from './args.js';

/** The I/O surface `main` writes through, so tests can capture output without touching the real process. */
export interface CliIo {
  readonly stdout: NodeJS.WritableStream & { readonly isTTY?: boolean };
  readonly stderr: NodeJS.WritableStream;
  readonly env: NodeJS.ProcessEnv;
}

const require = createRequire(import.meta.url);

/**
 * Entry point shared by `bin.ts` and tests. Returns the process exit code; never throws.
 *
 * Not `async` today: `help`, `version` and the stubs are all synchronous. Tasks 13–14 make `run`
 * and `secrets-list` await the engine, at which point this goes back to returning a value from an
 * `async` body instead of wrapping it in `Promise.resolve`.
 */
export function main(
  argv: readonly string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr, env: process.env },
): Promise<number> {
  return Promise.resolve(run(argv, io));
}

function run(argv: readonly string[], io: CliIo): number {
  try {
    const args = parseCliArgs(argv);

    switch (args.command) {
      case 'help': {
        io.stdout.write(`${HELP_TEXT}\n`);
        return ExitCode.Ok;
      }
      case 'version': {
        const { version } = require('../package.json') as { readonly version: string };
        io.stdout.write(`${version}\n`);
        return ExitCode.Ok;
      }
      case 'run':
      case 'secrets-list': {
        io.stderr.write('not implemented\n');
        return ExitCode.Usage;
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
