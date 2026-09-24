import { HELP_TEXT, parseServerArgs, UsageError } from './args.js';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import { ExitCode, packageVersion, type ServerIo } from './io.js';

// `serve`/`migrate` await real work from Task 7 onward; the signature is async now so callers
// don't change later.
// eslint-disable-next-line @typescript-eslint/require-await
export async function main(argv: readonly string[], io: ServerIo): Promise<number> {
  let command;
  try {
    command = parseServerArgs(argv);
  } catch (error) {
    io.stderr.write(`${error instanceof UsageError ? error.message : String(error)}\ntry --help\n`);
    return ExitCode.Config;
  }
  switch (command.command) {
    case 'help':
      io.stdout.write(HELP_TEXT);
      return ExitCode.Ok;
    case 'version':
      io.stdout.write(`${packageVersion()}\n`);
      return ExitCode.Ok;
    case 'config-check': {
      for (const row of describeConfig(io.env)) {
        io.stdout.write(`${row.variable.padEnd(46)} ${row.status}\n`);
      }
      try {
        loadConfig(io.env, packageVersion());
        return ExitCode.Ok;
      } catch (error) {
        if (error instanceof ConfigError) {
          for (const problem of error.problems) io.stderr.write(`${problem.variable}: ${problem.message}\n`);
          return ExitCode.Config;
        }
        throw error;
      }
    }
    case 'serve':
    case 'migrate':
      io.stderr.write(`${command.command} is not available yet\n`);
      return ExitCode.Config;
  }
}
