/**
 * `wirebench-server admin …` (identity spec §3.7): the same code as the admin endpoints, run by
 * an operator who cannot sign in yet — on a fresh server, the first admin comes from here.
 * It refuses to run against an unmigrated database rather than guessing at the schema.
 */
import type { KeyObject } from 'node:crypto';
import { WirebenchError } from '@wirebench/engine';
import type { ServerCommand } from '../args.js';
import { ConfigError, forgetDatabaseUrls, loadConfig, type ServerConfig } from '../config.js';
import { auditHook } from '../audit-log/hook.js';
import { chainKeys } from '../audit-log/chain/keys.js';
import { runAuditCommand, runVerifyCommand } from '../audit-log/cli.js';
import { SYSTEM_SOURCE, serverHooks } from '../context.js';
import { pendingMigrations } from '../db/migrate.js';
import { ADMIN_APPLICATION_NAME, createDatabase } from '../db/pool.js';
import { ExitCode, packageVersion, type ServerIo } from '../io.js';
import { PRODUCTION_PUBLIC_KEYS } from '../licensing/keys.js';
import { MISSING_SERVER_ID, serverId as readServerId } from '../licensing/repo.js';
import { runLicenseCommand } from '../licensing/cli.js';
import { runSchedulesCommand } from '../schedules/cli.js';
import { createLicenseService } from '../licensing/service.js';
import { BUILTIN_MODULES } from '../modules.js';
import { allMigrations, StartupError } from '../serve.js';
import { runScimGroupCommand, runScimTokenCommand } from '../sso/cli.js';
import type { TenantScope } from '../tenancy/scope.js';
import { createTenancy, directoryOf, isDefaultTenant, type Tenancy } from '../tenancy/tenancy.js';
import { tenantUrl } from '../tenancy/urls.js';
import { identitySettings, type InvitationEnv } from './env.js';
import { createInvitation, invitationSummary, isOpen, revokeOpenInvitation } from './invitations.js';
import * as repo from './repo.js';

// `admin tenancy role` runs as the owner, not the app role, so it has its own runner (tenancy/cli.ts).
type AdminCommand = Exclude<Extract<ServerCommand, { command: `admin-${string}` }>, { command: 'admin-tenancy-role' }>;

/**
 * The tenant the command line works in (spec §19.11): the one `--tenant` names, or, without it, the default one,
 * which is the only one a self-hosted server has. `runAdmin` has already checked `--tenant` against the mode. The
 * one file outside `src/tenancy/` that `check:tenant-scope` lets name the default scope.
 */
async function cliScope(tenancy: Tenancy, slug: string | undefined): Promise<TenantScope> {
  const directory = directoryOf(tenancy);
  if (!(await directory.load())) {
    throw new StartupError(ExitCode.Migration, 'migration 0020 is not applied: the server has no tenants');
  }
  if (slug === undefined) return directory.defaultScope();
  const found = (await directory.list()).find((scope) => scope.slug === slug);
  if (found === undefined) throw new WirebenchError('tenancy-tenant-unknown', `no tenant has the slug "${slug}"`);
  return found;
}

/**
 * The audit commands' tenant: {@link cliScope}'s, or, when `server_identity` has lost its row and no `--tenant` was
 * given, the server's only tenant, so export and verify still run on a damaged database (licensing spec §3.7).
 * That tenant is the default one: only a self-hosted server has one tenant.
 */
async function auditScope(
  tenancy: Tenancy,
  slug: string | undefined,
): Promise<{ readonly scope: TenantScope; readonly isDefault: (scope: TenantScope) => boolean }> {
  try {
    const scope = await cliScope(tenancy, slug);
    return { scope, isDefault: (of) => isDefaultTenant(tenancy, of) };
  } catch (error) {
    if (slug !== undefined || !(error instanceof WirebenchError) || error.code !== 'server-identity-missing')
      throw error;
    const only = await directoryOf(tenancy).onlyTenant();
    if (only === undefined) throw error;
    return { scope: only, isDefault: (of) => of.tenantId === only.tenantId };
  }
}

/**
 * Hosted mode serves no SCIM, nor its token and group admin routes, until per-tenant SSO in slice 7 (spec §19.1;
 * Task 15 review M2): the command line refuses them the same way.
 */
function assertScimServed(config: Pick<ServerConfig, 'mode'>): void {
  if (config.mode === 'hosted') {
    throw new WirebenchError(
      'sso-scim-hosted-off',
      'SCIM is not served in hosted mode until each tenant has its own SSO',
    );
  }
}

/** Why `--tenant` cannot go with this configuration's mode (spec §19.11), or `undefined` when it can. */
function tenantMisuse(mode: ServerConfig['mode'], tenant: string | undefined): string | undefined {
  if (mode === 'hosted' && tenant === undefined) return '--tenant <slug> is required in hosted mode';
  if (mode !== 'hosted' && tenant !== undefined) {
    return '--tenant applies to hosted mode only: a self-hosted server has one tenant';
  }
  return undefined;
}

/**
 * `now` exists for tests, as does `configure`: a hosted configuration, which `loadConfig` refuses (spec §19.1). The
 * bin passes nothing.
 */
export async function runAdmin(
  command: AdminCommand,
  io: ServerIo,
  options: {
    readonly now?: () => Date;
    readonly publicKeys?: readonly KeyObject[];
    readonly configure?: (config: ServerConfig) => ServerConfig;
  } = {},
): Promise<number> {
  let config: ReturnType<typeof loadConfig>;
  let db: ReturnType<typeof createDatabase>;
  let publicKeys: readonly KeyObject[];
  let hooks: ReturnType<typeof serverHooks>;
  const now = options.now ?? (() => new Date());
  try {
    const loaded = loadConfig(io.env, packageVersion());
    config = options.configure?.(loaded) ?? loaded;
    forgetDatabaseUrls();
    const misuse = tenantMisuse(config.mode, command.tenant);
    if (misuse !== undefined) {
      io.stderr.write(`${misuse}\ntry --help\n`);
      return ExitCode.Config;
    }
    db = createDatabase(config.databaseUrl, { applicationName: ADMIN_APPLICATION_NAME });
    publicKeys = options.publicKeys ?? PRODUCTION_PUBLIC_KEYS;
    hooks = serverHooks();
    // Events the CLI records are queued like the server's, for the running server to forward.
    hooks.audit.push(auditHook(now, { forward: Boolean(config.auditForwardUrl) }));
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
    // The audit commands need no license, so they never check the server id: export and verify are the
    // forensics path. They do read the default tenant (its row and `server_identity`'s pointer to it), since
    // each tenant has its own chain and key (spec §19.7).
    if (command.command === 'admin-audit-export' || command.command === 'admin-audit-verify') {
      const tenancy = createTenancy(db);
      const { scope, isDefault } = await auditScope(tenancy, command.tenant);
      if (command.command === 'admin-audit-export') {
        return await runAuditCommand(command, { db: tenancy.db(scope), hooks, now }, io);
      }
      const configured = config.auditChainKey;
      const key = configured === undefined ? undefined : chainKeys(configured, config.mode, isDefault)(scope);
      return await runVerifyCommand(command, { db: tenancy.db(scope), hooks, key }, io);
    }
    // No license either: a server whose license lapsed can still have its schedules switched off.
    if (
      command.command === 'admin-schedules-list' ||
      command.command === 'admin-schedules-enable' ||
      command.command === 'admin-schedules-disable' ||
      command.command === 'admin-schedules-runs'
    ) {
      // In the command line's tenant, as every schedules route works in the request's.
      const tenancy = createTenancy(db);
      const scope = await cliScope(tenancy, command.tenant);
      return await runSchedulesCommand(command, { db: tenancy.db(scope), hooks, now }, io);
    }
    // Only now: before migrations the server_identity table may not exist. A lost row is a configuration problem,
    // as `serve` reports it (exit 2), not a pending migration; the directory's load and the reader both see it.
    const lostIdentity = (error: unknown): never => {
      if (
        (error instanceof WirebenchError && error.code === 'server-identity-missing') ||
        (error instanceof Error && error.message === MISSING_SERVER_ID)
      ) {
        throw new StartupError(ExitCode.Config, MISSING_SERVER_ID);
      }
      throw error;
    };
    const tenancy = createTenancy(db);
    const scope = await cliScope(tenancy, command.tenant).catch(lostIdentity);
    const serverId = await readServerId(tenancy.db(scope)).catch(lostIdentity);
    const env: InvitationEnv = {
      ctx: {
        tenancy,
        config,
        hooks,
        license: createLicenseService({ tenancy, publicKeys, now, serverId: () => Promise.resolve(serverId) }),
      },
      settings: identitySettings(config),
      now,
    };
    switch (command.command) {
      case 'admin-invite': {
        const created = await createInvitation(env, scope, {
          email: command.email,
          serverAdmin: command.serverAdmin,
          createdBy: null,
          source: SYSTEM_SOURCE,
          serverUrl: tenantUrl(config, scope),
        });
        io.stdout.write(
          `Invitation for ${created.email} (${command.serverAdmin ? 'server admin' : 'member'})\n${created.url}\nExpires ${created.expiresAt}\n`,
        );
        return ExitCode.Ok;
      }
      case 'admin-list-invitations': {
        const now = env.now();
        const rows = await repo.listInvitations(tenancy.db(scope));
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
        if (!(await revokeOpenInvitation(env, scope, command.id, SYSTEM_SOURCE))) {
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
          {
            tenancy,
            publicKeys,
            now: env.now,
            serverId: () => Promise.resolve(serverId),
            license: env.ctx.license,
            hooks: env.ctx.hooks,
          },
          scope,
          io,
        );
      case 'admin-scim-token-create':
      case 'admin-scim-token-list':
      case 'admin-scim-token-revoke':
        assertScimServed(config);
        return await runScimTokenCommand(command, env, scope, io);
      case 'admin-scim-group-list':
      case 'admin-scim-group-link':
      case 'admin-scim-group-unlink':
        assertScimServed(config);
        return await runScimGroupCommand(command, env, scope, io);
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
