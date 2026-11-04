/**
 * `wirebench-server admin tenant …` (hosted edition spec §22.14): the operator's lifecycle commands, on the control
 * role through {@link TenantLifecycle}. `list`, `create`, `set-edition`, `suspend`, `resume`, `rename`,
 * `delete [--cancel]` and `settings`; `export` and `import` come with their parts. Each runs in hosted mode only and
 * refuses elsewhere with `admin-tenant-hosted-only`. The slug is positional, never `--tenant`.
 *
 * It opens the control pool from the control role's URL, and the app pool for the tenants' units (the audit rows,
 * the first admin's invitation), as `admin` does. A write is announced on the notification bus (spec §20.3), so
 * every running instance reloads its tenant map: the bus starts before the command and is drained before exit.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { KeyObject } from 'node:crypto';
import { WirebenchError } from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import type { ServerCommand } from '../args.js';
import { auditHook } from '../audit-log/hook.js';
import {
  ConfigError,
  egressPolicyOf,
  forgetDatabaseUrls,
  loadConfig,
  migrationUrlOf,
  type ServerConfig,
} from '../config.js';
import { SYSTEM_SOURCE, serverHooks, type ServerHooks } from '../context.js';
import { pendingMigrations } from '../db/migrate.js';
import { ADMIN_APPLICATION_NAME, createDatabase, openSession } from '../db/pool.js';
import { identitySettings } from '../identity/env.js';
import { createInvitation } from '../identity/invitations.js';
import { ExitCode, packageVersion, type ServerIo } from '../io.js';
import { PRODUCTION_PUBLIC_KEYS } from '../licensing/keys.js';
import { cachedServerId, createLicenseService } from '../licensing/service.js';
import { BUILTIN_MODULES } from '../modules.js';
import { NotificationBus } from '../operations/bus.js';
import { sendAlertMail } from '../schedules/alerts/smtp.js';
import { clearSection, saveSection } from '../settings/save.js';
import { isSettingsSection } from '../settings/sections.js';
import { createTenantSettings, type TenantSettings } from '../settings/service.js';
import { allMigrations, StartupError } from '../serve.js';
import type { TenantRow } from '../tenancy/directory.js';
import { environmentKeyRoot } from '../tenancy/keys.js';
import { createTenancy, shareTenancyCaches } from '../tenancy/tenancy.js';
import { tenantUrl } from '../tenancy/urls.js';
import { openControlDb } from './control-db.js';
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
  /** A hosted configuration, which `loadConfig` refuses until Part H (spec §22.1); the bin passes nothing. */
  readonly configure?: (config: ServerConfig) => ServerConfig;
  readonly mail?: InvitationMail;
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
      case 'admin-tenant-settings':
        return await tenantSettings(command, io, {
          config,
          lifecycle,
          settings: createTenantSettings({ config, tenancy, hooks, bus }),
          hooks,
        });
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

/**
 * `admin tenant settings <slug> get|set|clear` (spec §22.12, §22.14): the operator's view and writes of one tenant's
 * settings, in its own unit, with the API's checks and its `settings.changed` event. The operator may write
 * `budgets`. A secret is printed only as set or not.
 */
async function tenantSettings(
  command: Extract<AdminTenantCommand, { command: 'admin-tenant-settings' }>,
  io: ServerIo,
  deps: {
    readonly config: ServerConfig;
    readonly lifecycle: TenantLifecycle;
    readonly settings: TenantSettings;
    readonly hooks: ServerHooks;
  },
): Promise<number> {
  if (command.section !== undefined && !isSettingsSection(command.section)) {
    io.stderr.write(`settings-unknown-section: there is no settings section named "${command.section.slice(0, 40)}"\n`);
    return ExitCode.Config;
  }
  const section = command.section;
  const scope = await deps.lifecycle.tenantScope(command.slug);
  const options = { by: 'operator', operator: true, source: SYSTEM_SOURCE } as const;
  if (command.action === 'set') {
    let input: unknown;
    try {
      input = JSON.parse(await readFile(command.file!, 'utf8'));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      io.stderr.write(
        `settings-file-unreadable: ${command.file!} ${typeof code === 'string' ? `could not be read (${code})` : 'is not JSON'}\n`,
      );
      return ExitCode.Config;
    }
    await saveSection(
      {
        settings: deps.settings,
        hooks: deps.hooks,
        allowInsecure: deps.config.allowInsecurePublicUrl,
        egress: egressPolicyOf(deps.config),
      },
      scope,
      section!,
      input,
      options,
    );
    io.stdout.write(`Saved the ${section!} settings of ${command.slug}\n`);
    return ExitCode.Ok;
  }
  if (command.action === 'clear') {
    const cleared = await clearSection({ settings: deps.settings, hooks: deps.hooks }, scope, section!, options);
    io.stdout.write(
      cleared
        ? `Cleared the ${section!} settings of ${command.slug}\n`
        : `${command.slug} has no ${section!} settings\n`,
    );
    return ExitCode.Ok;
  }
  const view = await deps.settings.view(scope, { operator: true });
  io.stdout.write(`${JSON.stringify(section === undefined ? view : { [section]: view[section] }, null, 2)}\n`);
  return ExitCode.Ok;
}

/** The SMTP URL's host alone: never its credentials. */
function smtpHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}
