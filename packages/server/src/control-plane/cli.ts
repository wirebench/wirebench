/**
 * `wirebench-server admin tenant …` (hosted edition spec §22.14): the operator's lifecycle commands, on the control
 * role through {@link TenantLifecycle}. `list`, `create`, `set-edition`, `suspend`, `resume`, `rename` and
 * `delete [--cancel]` run in hosted mode only and refuse elsewhere with `admin-tenant-hosted-only`; `export` and
 * `import` (spec §22.9, §22.10) run on every server, and a self-hosted one exports, or fills, its one tenant;
 * `settings` comes with its part. The slug is positional, never `--tenant`.
 *
 * It opens the control pool from the control role's URL, and the app pool for the tenants' units (the audit rows,
 * the first admin's invitation), as `admin` does. A write is announced on the notification bus (spec §20.3), so
 * every running instance reloads its tenant map: the bus starts before the command and is drained before exit.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { findGit, GitCli, WirebenchError } from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import type { ServerCommand } from '../args.js';
import { chainKeys } from '../audit-log/chain/keys.js';
import { auditHook } from '../audit-log/hook.js';
import { ConfigError, forgetDatabaseUrls, loadConfig, migrationUrlOf, type ServerConfig } from '../config.js';
import { recordAudit, SYSTEM_SOURCE, serverHooks, type ServerHooks } from '../context.js';
import { pendingMigrations } from '../db/migrate.js';
import { ADMIN_APPLICATION_NAME, createDatabase, createLockPool, openSession } from '../db/pool.js';
import type { Database } from '../db/querier.js';
import { cliScope } from '../identity/cli.js';
import { identitySettings } from '../identity/env.js';
import { createInvitation } from '../identity/invitations.js';
import { ExitCode, packageVersion, type ServerIo } from '../io.js';
import { PRODUCTION_PUBLIC_KEYS } from '../licensing/keys.js';
import { cachedServerId, createLicenseService } from '../licensing/service.js';
import { BUILTIN_MODULES } from '../modules.js';
import { NotificationBus } from '../operations/bus.js';
import { DatabaseRepoLock, guardGit, REPO_LOCK_POOL_MAX, REPO_LOCK_WAIT_MS } from '../operations/repo-lock.js';
import { NO_HOOKS_DIR, RepoStore } from '../repos/repo-store.js';
import { sendAlertMail } from '../schedules/alerts/smtp.js';
import { allMigrations, StartupError } from '../serve.js';
import type { TenantRow } from '../tenancy/directory.js';
import { environmentKeyRoot } from '../tenancy/keys.js';
import type { TenantScope } from '../tenancy/scope.js';
import { createTenancy, isDefaultTenant, shareTenancyCaches, type Tenancy } from '../tenancy/tenancy.js';
import { tenantUrl } from '../tenancy/urls.js';
import { openControlDb, type ControlDb } from './control-db.js';
import { mailDeletionRequested } from './deletion-mail.js';
import type { ControlSend } from './mail.js';
import { writeExport } from './export/export.js';
import { importHosted, importSelfHosted, type ImportDeps, type ImportReport } from './export/import.js';
import { REDIRECT_DAYS, TenantLifecycle, type TenantListing } from './tenants.js';

export type AdminTenantCommand = Extract<ServerCommand, { command: `admin-tenant-${string}` }>;

/** How the first admin's invitation goes out: the operator's SMTP (`sendAlertMail`), or a test's fake. */
export type InvitationMail = (
  smtp: { readonly url: string; readonly from: string },
  to: string,
  mail: { readonly subject: string; readonly text: string },
) => Promise<void>;

const smtpMail: InvitationMail = (smtp, to, mail) => sendAlertMail(smtp, [to], mail);

export interface AdminTenantOptions {
  readonly now?: () => Date;
  readonly publicKeys?: readonly KeyObject[];
  /** Changes the loaded configuration, for a test that builds a hosted one in part; the bin passes nothing. */
  readonly configure?: (config: ServerConfig) => ServerConfig;
  readonly mail?: InvitationMail;
  /** How the deletion request's mail goes to every server admin; the operator's SMTP by default. */
  readonly send?: ControlSend;
}

const HOSTED_ONLY =
  'admin tenant runs on a hosted server only (WIREBENCH_SERVER_MODE=hosted): a self-hosted server has one tenant';

/** A logger for the bus and the tenant caches: warnings go to stderr, the rest nowhere. */
function stderrLog(io: ServerIo): FastifyBaseLogger {
  const quiet = (): void => undefined;
  const log = {
    level: 'warn',
    fatal: quiet,
    error: (_details: unknown, message?: string) => io.stderr.write(`${message ?? 'error'}\n`),
    warn: (_details: unknown, message?: string) => io.stderr.write(`${message ?? 'warning'}\n`),
    info: quiet,
    debug: quiet,
    trace: quiet,
    silent: quiet,
    child: () => log,
  };
  return log;
}

const date = (at: Date | null): string => (at === null ? '-' : at.toISOString());

/** `admin tenant list`'s table (spec §22.14): no user named. */
export function formatTenants(rows: readonly TenantListing[]): string {
  const lines = [['SLUG', 'STATUS', 'EDITION', 'SEATS', 'SUBSCRIPTION', 'DELETION']];
  for (const row of rows) {
    lines.push([
      row.slug,
      row.suspendedReason === null ? row.status : `${row.status} (${row.suspendedReason})`,
      `${row.edition} (${row.editionSource})`,
      row.seats === null ? '-' : String(row.seats),
      row.subscriptionStatus ?? '-',
      date(row.deletingAt),
    ]);
  }
  const widths = lines[0]!.map((_, column) => Math.max(...lines.map((line) => line[column]!.length)));
  return `${lines
    .map((line) =>
      line.map((cell, column) => (column === line.length - 1 ? cell : cell.padEnd(widths[column]!))).join('  '),
    )
    .join('\n')}\n`;
}

/** One line about a tenant after a write. */
function describe(row: TenantRow): string {
  const status = row.suspendedReason === null ? row.status : `${row.status} (${row.suspendedReason})`;
  const seats = row.seats === null ? 'no seat limit' : `${String(row.seats)} seats`;
  return `${row.slug}: ${status}, ${row.edition} (${row.editionSource}), ${seats}`;
}

export async function runAdminTenant(
  command: AdminTenantCommand,
  io: ServerIo,
  options: AdminTenantOptions = {},
): Promise<number> {
  let config: ServerConfig;
  try {
    const loaded = loadConfig(io.env, packageVersion());
    config = options.configure?.(loaded) ?? loaded;
    forgetDatabaseUrls();
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.problems) io.stderr.write(`${problem.variable}: ${problem.message}\n`);
      return ExitCode.Config;
    }
    throw error;
  }
  if (command.command === 'admin-tenant-export' || command.command === 'admin-tenant-import') {
    return runPortable(command, config, io, options);
  }
  if (config.mode !== 'hosted') {
    io.stderr.write(`admin-tenant-hosted-only: ${HOSTED_ONLY}\n`);
    return ExitCode.Config;
  }
  const controlUrl = config.controlDatabaseUrl;
  if (controlUrl === undefined) {
    io.stderr.write('WIREBENCH_SERVER_CONTROL_DATABASE_URL: required in hosted mode\n');
    return ExitCode.Config;
  }
  const now = options.now ?? (() => new Date());
  const log = stderrLog(io);
  const db = createDatabase(config.databaseUrl, { applicationName: ADMIN_APPLICATION_NAME });
  const control = openControlDb(controlUrl);
  let bus: NotificationBus | undefined;
  try {
    const pending = await pendingMigrations(db, await allMigrations(BUILTIN_MODULES));
    if (pending.length > 0) {
      io.stderr.write(`${pending.length} migrations are pending; run wirebench-server migrate first\n`);
      return ExitCode.Migration;
    }
    const tenancy = createTenancy(
      db,
      config.secretsKey !== undefined ? { keyRoot: environmentKeyRoot(config.secretsKey) } : {},
    );
    const hooks = serverHooks();
    hooks.audit.push(auditHook(now, { forward: Boolean(config.auditForwardUrl) }));
    const lifecycle = new TenantLifecycle({ control, tenancy, hooks, now });
    if (command.command === 'admin-tenant-list') {
      io.stdout.write(formatTenants(await lifecycle.list()));
      return ExitCode.Ok;
    }
    // A write: every running instance hears it on the bus (spec §20.3), so the bus listens first.
    const migrationUrl = migrationUrlOf(config);
    bus = new NotificationBus({
      db,
      holder: randomUUID(),
      hooks,
      open: () => openSession(migrationUrl, { applicationName: ADMIN_APPLICATION_NAME }),
      // Nothing here listens to another instance's event, so none needs its scope.
      scopeFor: () => Promise.resolve(undefined),
      log,
    });
    shareTenancyCaches(tenancy, hooks, bus, log);
    await bus.start();
    switch (command.command) {
      case 'admin-tenant-create': {
        const created = await lifecycle.create({
          slug: command.slug,
          name: command.name,
          edition: command.edition,
          editionSource: 'operator',
          ...(command.seats !== undefined ? { seats: command.seats } : {}),
        });
        io.stdout.write(`Created ${describe(created)}\n${tenantUrl(config, created.scope)}\n`);
        // The first server admin (spec §22.14): an invitation in the new tenant, mailed or printed.
        const env = {
          ctx: {
            tenancy,
            config,
            hooks,
            license: createLicenseService({
              tenancy,
              publicKeys: options.publicKeys ?? PRODUCTION_PUBLIC_KEYS,
              now,
              serverId: cachedServerId(),
              hosted: true,
            }),
          },
          settings: identitySettings(config),
          now,
        };
        const invited = await createInvitation(env, created.scope, {
          email: command.email,
          serverAdmin: true,
          createdBy: null,
          source: SYSTEM_SOURCE,
          serverUrl: tenantUrl(config, created.scope),
        });
        if (config.smtpUrl === undefined || config.smtpFrom === undefined) {
          io.stdout.write(
            `No SMTP is configured: send this server-admin invitation for ${invited.email} yourself.\n${invited.url}\nExpires ${invited.expiresAt}\n`,
          );
          return ExitCode.Ok;
        }
        try {
          await (options.mail ?? smtpMail)({ url: config.smtpUrl, from: config.smtpFrom }, invited.email, {
            subject: `You are invited to ${created.name} on Wirebench`,
            text: [
              `You are invited to be a server admin of ${created.name} on Wirebench.`,
              '',
              `Accept the invitation: ${invited.url}`,
              `It expires ${invited.expiresAt}.`,
              '',
            ].join('\n'),
          });
        } catch (error) {
          // Never the error's text: a transport's message can carry the SMTP URL, password included.
          const code = (error as { code?: unknown } | null)?.code;
          const shown = typeof code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(code) ? `, ${code}` : '';
          io.stderr.write(
            `the invitation could not be mailed (SMTP host ${smtpHost(config.smtpUrl)}${shown}); send its link yourself\n`,
          );
          io.stdout.write(`${invited.url}\nExpires ${invited.expiresAt}\n`);
          return 1;
        }
        io.stdout.write(`Mailed a server-admin invitation to ${invited.email}; it expires ${invited.expiresAt}\n`);
        return ExitCode.Ok;
      }
      case 'admin-tenant-set-edition': {
        const row = await lifecycle.setEdition(
          command.slug,
          command.subscription
            ? { subscription: true }
            : { edition: command.edition!, ...(command.seats !== undefined ? { seats: command.seats } : {}) },
        );
        io.stdout.write(`${describe(row)}\n`);
        return ExitCode.Ok;
      }
      case 'admin-tenant-suspend':
        io.stdout.write(`${describe(await lifecycle.suspend(command.slug))}\n`);
        return ExitCode.Ok;
      case 'admin-tenant-resume': {
        const row = await lifecycle.resume(command.slug);
        io.stdout.write(row === undefined ? `${command.slug} was not suspended\n` : `${describe(row)}\n`);
        return ExitCode.Ok;
      }
      case 'admin-tenant-rename': {
        const row = await lifecycle.rename(command.slug, command.to);
        io.stdout.write(
          `Renamed ${command.slug} to ${row.slug}: ${tenantUrl(config, row.scope)}; the old name redirects for ${String(REDIRECT_DAYS)} days\n`,
        );
        return ExitCode.Ok;
      }
      case 'admin-tenant-delete': {
        if (command.cancel) {
          const row = await lifecycle.cancelDeletion(command.slug);
          io.stdout.write(
            row === undefined
              ? `No deletion was asked for ${command.slug}\n`
              : `Cancelled the deletion of ${row.slug}\n`,
          );
          return ExitCode.Ok;
        }
        const row = await lifecycle.requestDeletion(command.slug);
        if (row?.deletingAt !== undefined && row.deletingAt !== null) {
          const smtp =
            config.smtpUrl !== undefined && config.smtpFrom !== undefined
              ? { url: config.smtpUrl, from: config.smtpFrom }
              : undefined;
          await mailDeletionRequested(
            {
              db: tenancy.db,
              config,
              log,
              mail:
                smtp === undefined
                  ? undefined
                  : {
                      send: options.send ?? ((to, mail) => sendAlertMail(smtp, to, mail)),
                      mailHost: smtpHost(smtp.url),
                    },
            },
            await lifecycle.tenantScope(row.id),
            { teamName: row.name, deletingAt: row.deletingAt, by: 'the operator' },
          );
        }
        io.stdout.write(
          row === undefined
            ? `The deletion of ${command.slug} was already asked for\n`
            : `${row.slug} will be deleted at ${date(row.deletingAt)}; cancel with admin tenant delete ${row.slug} --cancel. Cancel its subscription in Paddle first: the deletion waits while it is active.\n`,
        );
        return ExitCode.Ok;
      }
    }
    const never: never = command;
    return never;
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
    await bus?.stop();
    await control.close();
    await db.close();
  }
}

/** The SMTP URL's host alone: never its credentials. */
function smtpHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

type PortableCommand = Extract<AdminTenantCommand, { command: 'admin-tenant-export' | 'admin-tenant-import' }>;

/** The report of an import: what came in, and each item that did not, by id (spec §22.10). */
function reportText(slug: string, report: ImportReport): string {
  const rows = Object.values(report.tables).reduce((sum, n) => sum + n, 0);
  const lines = [
    `Imported into ${slug}: ${String(rows)} rows in ${String(Object.keys(report.tables).length)} tables, ${String(report.workspaces)} workspaces${report.resumed ? ' (resumed)' : ''}`,
    'Everyone signs in again: sessions, device tokens and pairings are not exported.',
  ];
  if (report.notRestored.length > 0) {
    lines.push('Not restored:');
    for (const item of report.notRestored) lines.push(`  ${item.table} ${item.id}: ${item.what}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Git as the server runs it, every step guarded by the repository lock (spec §20.4), with plumbing. */
async function locateGit(config: ServerConfig): Promise<GitCli> {
  const location = await findGit(config.gitPath !== undefined ? { configuredPath: config.gitPath } : {});
  if (location === undefined) {
    throw new WirebenchError('git-not-found', 'git was not found; install git or set WIREBENCH_SERVER_GIT_PATH');
  }
  return guardGit(new GitCli(location, { hooksDir: join(config.dataDir, NO_HOOKS_DIR) })).withPlumbing();
}

/**
 * `admin tenant export [<slug>] --out <file>` and `admin tenant import <file> […]` (spec §22.9, §22.10), on any server.
 * The repositories are taken under the same lock a running server takes, so either runs beside one.
 */
async function runPortable(
  command: PortableCommand,
  config: ServerConfig,
  io: ServerIo,
  options: AdminTenantOptions,
): Promise<number> {
  const hosted = config.mode === 'hosted';
  if (!hosted && command.slug !== undefined) {
    io.stderr.write(`admin-tenant-hosted-only: a self-hosted server has one tenant: drop the slug\n`);
    return ExitCode.Config;
  }
  if (
    !hosted &&
    command.command === 'admin-tenant-import' &&
    (command.name !== undefined || command.edition !== undefined || command.seats !== undefined)
  ) {
    io.stderr.write(
      'admin-tenant-hosted-only: a self-hosted import fills the one tenant: drop --name, --edition and --seats\n',
    );
    return ExitCode.Config;
  }
  if (hosted && command.command === 'admin-tenant-export' && command.slug === undefined) {
    io.stderr.write('admin tenant export needs the slug of the tenant in hosted mode\n');
    return ExitCode.Config;
  }
  const controlUrl = config.controlDatabaseUrl;
  if (hosted && controlUrl === undefined) {
    io.stderr.write('WIREBENCH_SERVER_CONTROL_DATABASE_URL: required in hosted mode\n');
    return ExitCode.Config;
  }
  const now = options.now ?? (() => new Date());
  const log = stderrLog(io);
  const db = createDatabase(config.databaseUrl, { applicationName: ADMIN_APPLICATION_NAME });
  const control = controlUrl !== undefined && hosted ? openControlDb(controlUrl) : undefined;
  const lockPool = createLockPool(migrationUrlOf(config), {
    max: REPO_LOCK_POOL_MAX,
    applicationName: `${ADMIN_APPLICATION_NAME}-repo-lock`,
    waitMs: REPO_LOCK_WAIT_MS,
  });
  let bus: NotificationBus | undefined;
  try {
    const pending = await pendingMigrations(db, await allMigrations(BUILTIN_MODULES));
    if (pending.length > 0) {
      io.stderr.write(`${pending.length} migrations are pending; run wirebench-server migrate first\n`);
      return ExitCode.Migration;
    }
    const tenancy = createTenancy(
      db,
      config.secretsKey !== undefined ? { keyRoot: environmentKeyRoot(config.secretsKey) } : {},
    );
    const hooks = serverHooks();
    hooks.audit.push(auditHook(now, { forward: Boolean(config.auditForwardUrl) }));
    const git = await locateGit(config);
    await RepoStore.prepare(config.dataDir);
    const repos = new RepoStore({ git, dataDir: config.dataDir, lock: new DatabaseRepoLock({ pool: lockPool }) });
    const keys =
      config.auditChainKey === undefined
        ? undefined
        : chainKeys(config.auditChainKey, config.mode, (scope) => isDefaultTenant(tenancy, scope));
    if (command.command === 'admin-tenant-export') {
      const scope = await cliScope(tenancy, command.slug, config.mode);
      const result = await writeExport(
        {
          db: tenancy.db,
          repos,
          git,
          dataDir: config.dataDir,
          version: config.version,
          chainKey: keys?.(scope),
          now,
        },
        scope,
        command.out,
      );
      await exported(hooks, tenancy, scope, result.sha256, result.size);
      io.stdout.write(
        `Exported ${scope.slug} to ${command.out}: ${String(Object.keys(result.manifest.tables).length)} tables, ${String(Object.keys(result.manifest.workspaces).length)} workspaces, sha256 ${result.sha256}\n` +
          'It holds password hashes and captures: keep it as safe as the database.\n',
      );
      return ExitCode.Ok;
    }
    const deps: ImportDeps = {
      db: tenancy.db,
      repos,
      git,
      dataDir: config.dataDir,
      hooks,
      chainKeyOf: (scope) => keys?.(scope),
    };
    if (!hosted) {
      const scope = await cliScope(tenancy, undefined, config.mode);
      io.stdout.write(reportText(scope.slug, await importSelfHosted(deps, scope, command.file)));
      return ExitCode.Ok;
    }
    // The new tenant is a write every running instance hears on the bus (spec §20.3).
    bus = await startBus(config, db, hooks, tenancy, log);
    const lifecycle = new TenantLifecycle({ control: control as ControlDb, tenancy, hooks, now });
    const done = await importHosted(deps, lifecycle, command.file, {
      ...(command.slug !== undefined ? { slug: command.slug } : {}),
      ...(command.name !== undefined ? { name: command.name } : {}),
      ...(command.edition !== undefined ? { edition: command.edition } : {}),
      ...(command.seats !== undefined ? { seats: command.seats } : {}),
    });
    io.stdout.write(
      `${reportText(done.tenant.slug, done.report)}${tenantUrl(config, done.scope)}\nIts custom name, if it had one, is claimed and verified again.\n`,
    );
    return ExitCode.Ok;
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
    await bus?.stop();
    await lockPool.close();
    await control?.close();
    await db.close();
  }
}

/** `tenant.exported`, by the operator, in the tenant's chain. */
async function exported(hooks: ServerHooks, tenancy: Tenancy, scope: TenantScope, sha256: string, size: number) {
  await tenancy.db(scope).transaction((tx) =>
    recordAudit(hooks, tx, {
      ...SYSTEM_SOURCE,
      action: 'tenant.exported',
      target: { kind: 'tenant', id: scope.tenantId },
      details: { sha256, sizeBytes: size, by: 'operator' },
    }),
  );
}

/** The bus a write announces on, started before it, as the lifecycle commands start it. */
async function startBus(
  config: ServerConfig,
  db: Database,
  hooks: ServerHooks,
  tenancy: Tenancy,
  log: FastifyBaseLogger,
): Promise<NotificationBus> {
  const migrationUrl = migrationUrlOf(config);
  const bus = new NotificationBus({
    db,
    holder: randomUUID(),
    hooks,
    open: () => openSession(migrationUrl, { applicationName: ADMIN_APPLICATION_NAME }),
    scopeFor: () => Promise.resolve(undefined),
    log,
  });
  shareTenancyCaches(tenancy, hooks, bus, log);
  await bus.start();
  return bus;
}
