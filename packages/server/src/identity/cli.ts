/**
 * `wirebench-server admin …` (identity spec §3.7): the same code as the admin endpoints, run by
 * an operator who cannot sign in yet — on a fresh server, the first admin comes from here.
 * It refuses to run against an unmigrated database rather than guessing at the schema.
 */
import type { KeyObject } from 'node:crypto';
import { WirebenchError } from '@wirebench/engine';
import type { ServerCommand } from '../args.js';
import { ConfigError, loadConfig } from '../config.js';
import { auditHook } from '../audit-log/hook.js';
import { runAuditCommand, runVerifyCommand } from '../audit-log/cli.js';
import { SYSTEM_SOURCE, serverHooks } from '../context.js';
import { pendingMigrations } from '../db/migrate.js';
import { createDatabase } from '../db/pool.js';
import { ExitCode, packageVersion, type ServerIo } from '../io.js';
import { PRODUCTION_PUBLIC_KEYS } from '../licensing/keys.js';
import { runLicenseCommand } from '../licensing/cli.js';
import { createLicenseService } from '../licensing/service.js';
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
  options: { readonly now?: () => Date; readonly publicKeys?: readonly KeyObject[] } = {},
): Promise<number> {
  let env: InvitationEnv;
  let db: ReturnType<typeof createDatabase>;
  let publicKeys: readonly KeyObject[];
  let serverId: string;
  try {
    const config = loadConfig(io.env, packageVersion());
    delete process.env.WIREBENCH_SERVER_DATABASE_URL;
    db = createDatabase(config.databaseUrl);
    const now = options.now ?? (() => new Date());
    publicKeys = options.publicKeys ?? PRODUCTION_PUBLIC_KEYS;
    const hooks = serverHooks();
    // Events the CLI records are queued like the server's, for the running server to forward.
    hooks.audit.push(auditHook(now, { forward: Boolean(config.auditForwardUrl) }));
    serverId = ''; // Task 2 reads the minted id
    env = {
      ctx: {
        db,
        config,
        hooks,
        license: createLicenseService({ db, publicKeys, now, serverId }),
      },
      settings: identitySettings(config),
      now,
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
          source: SYSTEM_SOURCE,
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
        if (!(await revokeOpenInvitation(env, command.id, SYSTEM_SOURCE))) {
          io.stderr.write(`identity-not-found: no open invitation with id ${command.id}\n`);
          return 1;
        }
        io.stdout.write(`Revoked ${command.id}\n`);
        return ExitCode.Ok;
      }
      case 'admin-license-install':
      case 'admin-license-show':
      case 'admin-license-remove':
        return await runLicenseCommand(
          command,
          { db, publicKeys, now: env.now, serverId, license: env.ctx.license, hooks: env.ctx.hooks },
          io,
        );
      case 'admin-audit-export':
        return await runAuditCommand(command, { db, hooks: env.ctx.hooks, now: env.now }, io);
      case 'admin-audit-verify':
        return await runVerifyCommand(command, { db, hooks: env.ctx.hooks, key: env.ctx.config.auditChainKey }, io);
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
