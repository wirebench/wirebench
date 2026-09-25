/**
 * `wirebench-server admin …` (identity spec §3.7): the same code as the admin endpoints, run by
 * an operator who cannot sign in yet — on a fresh server, the first admin comes from here.
 * It refuses to run against an unmigrated database rather than guessing at the schema.
 */
import { WirebenchError } from '@wirebench/engine';
import type { ServerCommand } from '../args.js';
import { ConfigError, loadConfig } from '../config.js';
import { serverHooks } from '../context.js';
import { pendingMigrations } from '../db/migrate.js';
import { createDatabase } from '../db/pool.js';
import { ExitCode, packageVersion, type ServerIo } from '../io.js';
import { BUILTIN_MODULES } from '../modules.js';
import { allMigrations, StartupError } from '../serve.js';
import { identitySettings, type InvitationEnv } from './env.js';
import { createInvitation, invitationSummary, isOpen, revokeOpenInvitation } from './invitations.js';
import * as repo from './repo.js';

type AdminCommand = Extract<ServerCommand, { command: `admin-${string}` }>;

/** `now` exists for tests; the bin passes nothing. */
export async function runAdmin(
  command: AdminCommand,
  io: ServerIo,
  options: { readonly now?: () => Date } = {},
): Promise<number> {
  let env: InvitationEnv;
  let db: ReturnType<typeof createDatabase>;
  try {
    const config = loadConfig(io.env, packageVersion());
    delete process.env.WIREBENCH_SERVER_DATABASE_URL;
    db = createDatabase(config.databaseUrl);
    env = {
      ctx: { db, config, hooks: serverHooks() },
      settings: identitySettings(config),
      now: options.now ?? (() => new Date()),
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.problems) io.stderr.write(`${problem.variable}: ${problem.message}\n`);
      return ExitCode.Config;
    }
    throw error;
  }
  try {
    const pending = await pendingMigrations(db, await allMigrations(BUILTIN_MODULES));
    if (pending.length > 0) {
      io.stderr.write(`${pending.length} migrations are pending; run wirebench-server migrate first\n`);
      return ExitCode.Migration;
    }
    switch (command.command) {
      case 'admin-invite': {
        const created = await createInvitation(env, {
          email: command.email,
          serverAdmin: command.serverAdmin,
          createdBy: null,
        });
        io.stdout.write(
          `Invitation for ${created.email} (${command.serverAdmin ? 'server admin' : 'member'})\n${created.url}\nExpires ${created.expiresAt}\n`,
        );
        return ExitCode.Ok;
      }
      case 'admin-list-invitations': {
        const now = env.now();
        const rows = await repo.listInvitations(db);
        io.stdout.write(`${'id'.padEnd(26)}  ${'email'.padEnd(40)}  admin  status    expires\n`);
        for (const row of rows) {
          const summary = invitationSummary(row);
          const status =
            row.acceptedAt !== null
              ? 'accepted'
              : row.revokedAt !== null
                ? 'revoked'
                : isOpen(row, now)
                  ? 'open'
                  : 'expired';
          io.stdout.write(
            `${summary.id}  ${summary.email.padEnd(40)}  ${summary.serverAdmin ? 'yes  ' : 'no   '}  ${status.padEnd(8)}  ${summary.expiresAt}\n`,
          );
        }
        return ExitCode.Ok;
      }
      case 'admin-revoke-invitation': {
        if (!(await revokeOpenInvitation(env, command.id))) {
          io.stderr.write(`identity-not-found: no open invitation with id ${command.id}\n`);
          return 1;
        }
        io.stdout.write(`Revoked ${command.id}\n`);
        return ExitCode.Ok;
      }
    }
  } catch (error) {
    if (error instanceof WirebenchError) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return 1;
    }
    if (error instanceof StartupError) {
      io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  } finally {
    await db.close();
  }
}
