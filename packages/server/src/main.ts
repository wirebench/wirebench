import { HELP_TEXT, parseServerArgs, UsageError } from './args.js';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import { ExitCode, packageVersion, type ServerIo } from './io.js';
import { BUILTIN_MODULES } from './modules.js';
import { runMigrate, startServer, StartupError, type StartOptions } from './serve.js';

/** `serveOptions` exists for tests (signals, exit, drain time, modules); the bin passes none. */
export async function main(argv: readonly string[], io: ServerIo, serveOptions: StartOptions = {}): Promise<number> {
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
        const config = loadConfig(io.env, packageVersion());
        if (config.oidcIssuer !== undefined) {
          io.stdout.write(
            `OIDC redirect URI to register at the issuer: ${config.publicUrl}/api/v1/auth/oidc/callback\n`,
          );
        }
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
      return runMigrate(io.env, io, command.check, serveOptions.modules ?? BUILTIN_MODULES);
    case 'serve': {
      try {
        const server = await startServer(io.env, io, { modules: BUILTIN_MODULES, ...serveOptions });
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
