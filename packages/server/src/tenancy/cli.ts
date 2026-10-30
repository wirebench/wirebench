/**
 * `wirebench-server admin tenancy role [--print-sql]` (hosted edition spec §19.4): the operator's switch to an
 * app role outside compose. It connects as the owner (`WIREBENCH_SERVER_MIGRATION_DATABASE_URL`) and runs what
 * `serve` runs at every start with two URLs: create the app role of `WIREBENCH_SERVER_DATABASE_URL` when it is
 * missing, then grant it its privileges. `--print-sql` only reads, and prints the statements for a role that
 * may create roles to apply.
 */
import { WirebenchError } from '@wirebench/engine';
import type { ServerCommand } from '../args.js';
import { ConfigError, forgetDatabaseUrls, loadConfig, type ServerConfig } from '../config.js';
import { ADMIN_APPLICATION_NAME, createDatabase } from '../db/pool.js';
import { ExitCode, packageVersion, type ServerIo } from '../io.js';
import { appRolePlan, ensureAppRole, roleMode } from './roles.js';

type TenancyRoleCommand = Extract<ServerCommand, { command: 'admin-tenancy-role' }>;

const NEEDS_TWO_ROLES =
  'admin tenancy role needs two roles: WIREBENCH_SERVER_MIGRATION_DATABASE_URL set to the owner of the schema, and WIREBENCH_SERVER_DATABASE_URL to the app role';

export async function runTenancyRole(command: TenancyRoleCommand, io: ServerIo): Promise<number> {
  let config: ServerConfig;
  try {
    config = loadConfig(io.env, packageVersion());
    forgetDatabaseUrls();
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.problems) io.stderr.write(`${problem.variable}: ${problem.message}\n`);
      return ExitCode.Config;
    }
    throw error;
  }
  // The same rule as `serve` and `migrate`, so the three never disagree about a configuration.
  let mode: 'one-role' | 'two-roles';
  try {
    mode = roleMode(config);
  } catch (error) {
    if (!(error instanceof WirebenchError)) throw error;
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return ExitCode.Config;
  }
  if (mode === 'one-role' || config.migrationDatabaseUrl === undefined) {
    io.stderr.write(`${NEEDS_TWO_ROLES}\n`);
    return ExitCode.Config;
  }
  const owner = createDatabase(config.migrationDatabaseUrl, { applicationName: ADMIN_APPLICATION_NAME });
  try {
    if (command.printSql) {
      // Read-only: the plan comes from the catalog, and nothing is run.
      // Who may run what: `create role` needs CREATEROLE, the grants and default privileges need the owner.
      // The verifier in `create role` is not the password, but it allows guessing at it offline.
      const plan = await appRolePlan(owner, config.databaseUrl);
      const [first, ...rest] = plan.statements;
      if (!plan.exists) {
        io.stdout.write('-- Secret: the next statement holds the app role password as a SCRAM-SHA-256 verifier.\n');
        io.stdout.write('-- As a role that may create roles (CREATEROLE):\n');
        io.stdout.write(`${first!};\n`);
      }
      io.stdout.write(`-- As the owner, ${plan.owner}:\n`);
      for (const statement of plan.exists ? plan.statements : rest) io.stdout.write(`${statement};\n`);
      return ExitCode.Ok;
    }
    const plan = await ensureAppRole(owner, config.databaseUrl);
    io.stdout.write(
      `app role ${plan.role}: ${plan.exists ? 'exists' : 'created'}; privileges granted on schema ${plan.schema}\n`,
    );
    return ExitCode.Ok;
  } catch (error) {
    if (error instanceof WirebenchError) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    await owner.close();
  }
}
