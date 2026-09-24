import { HELP_TEXT, parseServerArgs, UsageError } from './args.js';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import { ExitCode, packageVersion, type ServerIo } from './io.js';
import { runMigrate, startServer, StartupError } from './serve.js';

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
    case 'migrate':
      return runMigrate(io.env, io, command.check);
    case 'serve': {
      try {
        const server = await startServer(io.env, io);
        await new Promise<void>((resolve) => server.app.server.once('close', resolve));
        await server.close(); // the same promise the signal started: resolves once the pool is closed
        return ExitCode.Ok;
      } catch (error) {
        if (error instanceof StartupError) {
          io.stderr.write(`${error.message}\n`);
          return error.exitCode;
        }
        throw error;
      }
    }
  }
}
