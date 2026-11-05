/**
 * `wirebench-server admin domains …` (hosted edition spec §23.6): the operator's view of the custom names, for abuse
 * or a support case. `list` reads every tenant's claim, each in its own unit, and prints the slug, the name, the state
 * and the last check, never a token. `check --tenant` checks a name now, as the job and `POST …/check` do, without
 * the route's once a minute. `remove --tenant` releases it, as `DELETE` does. Hosted only: `identity/cli.ts` refuses
 * the three on a self-hosted server and finds the tenant before it calls here.
 */
import type { FastifyBaseLogger } from 'fastify';
import { WirebenchError } from '@wirebench/engine';
import type { ServerCommand } from '../args.js';
import type { ModuleConfig } from '../config.js';
import { SYSTEM_SOURCE, type LicenseService, type ServerHooks } from '../context.js';
import { ExitCode, type ServerIo } from '../io.js';
import type { TenantScope } from '../tenancy/scope.js';
import { tenantHostsChanged, type Tenancy } from '../tenancy/tenancy.js';
import { checkDepsOf, type CheckDepsOverrides } from './deps.js';
import { checkTenant } from './job.js';
import { listAll, type ClaimListing } from './repo.js';
import { removeAudited } from './routes.js';

export type DomainsCommand = Extract<ServerCommand, { command: `admin-domains-${string}` }>;

export const isDomainsCommand = (command: { readonly command: string }): command is DomainsCommand =>
  command.command.startsWith('admin-domains-');

/** The command line's refusal on a self-hosted server, as the routes' `404`. */
export const DOMAINS_HOSTED_ONLY =
  'custom-domains-hosted-only: admin domains applies to hosted mode only: a self-hosted server sets its own public URL';

export interface DomainsEnv {
  readonly config: ModuleConfig;
  readonly tenancy: Tenancy;
  readonly hooks: ServerHooks;
  readonly license: LicenseService;
  readonly now: () => Date;
  /** Tests only: the check's DNS, probe and mail. */
  readonly overrides?: CheckDepsOverrides;
  /**
   * Runs `fn` with the notification bus listening and drains it after (`identity/cli.ts` opens it, as `admin tenant`
   * does), so a name `check` or `remove` made live or released reloads every running instance's tenant map (spec
   * §23.5, §20.3).
   */
  readonly withBus: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** The table `admin domains list` prints: a header, then one row per claim. Never a token. */
export function formatClaims(rows: readonly ClaimListing[]): string {
  const lines = [['SLUG', 'NAME', 'STATE', 'CHECKED']];
  for (const row of rows) {
    lines.push([row.slug, row.name, row.state, row.checkedAt === null ? '-' : row.checkedAt.toISOString()]);
  }
  const widths = lines[0]!.map((_, column) => Math.max(...lines.map((line) => line[column]!.length)));
  return lines
    .map((line) =>
      line.map((cell, column) => (column === line.length - 1 ? cell : cell.padEnd(widths[column]!))).join('  '),
    )
    .join('\n');
}

/** The job loop's and the bus's log: warnings and errors on stderr, by message only, the rest nowhere. */
export function busLog(io: ServerIo): FastifyBaseLogger {
  const quiet = (): void => undefined;
  const write = (level: string) => (first: unknown, second?: unknown) => {
    const message = typeof first === 'string' ? first : typeof second === 'string' ? second : '';
    io.stderr.write(`${level}: ${message}\n`);
  };
  const log = {
    level: 'warn',
    fatal: write('fatal'),
    error: write('error'),
    warn: write('warn'),
    info: quiet,
    debug: quiet,
    trace: quiet,
    silent: quiet,
    child: () => log,
  };
  return log;
}

const noClaim = (scope: TenantScope) =>
  new WirebenchError('custom-domains-none', `the tenant "${scope.slug}" has no custom domain`);

/**
 * Runs `command`; `scope` is `--tenant`'s tenant, which `check` and `remove` need and `list` ignores.
 *
 * @throws WirebenchError `custom-domains-none` when `check` or `remove` finds no claim.
 */
export async function runDomainsCommand(
  command: DomainsCommand,
  env: DomainsEnv,
  scope: TenantScope | undefined,
  io: ServerIo,
): Promise<number> {
  const log = busLog(io);
  switch (command.command) {
    case 'admin-domains-list': {
      const rows = [...(await listAll(env.tenancy, log))].sort((a, b) => a.slug.localeCompare(b.slug));
      io.stdout.write(`${formatClaims(rows)}\n`);
      if (rows.length === 0) io.stdout.write('no team has a custom domain\n');
      return ExitCode.Ok;
    }
    case 'admin-domains-check': {
      const deps = await checkDepsOf(
        {
          config: env.config,
          tenancy: env.tenancy,
          hooks: env.hooks,
          license: () => env.license,
          log,
          hostsChanged: () => {
            tenantHostsChanged(env.tenancy);
          },
        },
        { now: env.now, ...env.overrides },
      );
      const checked = await env.withBus(() => checkTenant(deps, scope!));
      if (checked === undefined) throw noClaim(scope!);
      const checkedAt = checked.checkedAt === null ? '-' : checked.checkedAt.toISOString();
      io.stdout.write(`${checked.name}  ${checked.state}  checked ${checkedAt}\n`);
      if (checked.lastResult !== null) io.stdout.write(`${checked.lastResult.message}\n`);
      return ExitCode.Ok;
    }
    case 'admin-domains-remove': {
      const removed = await env.withBus(async () => {
        const gone = await env.tenancy.db(scope!).transaction((tx) => removeAudited(env.hooks, tx, SYSTEM_SOURCE));
        if (gone?.released === true) tenantHostsChanged(env.tenancy);
        return gone;
      });
      if (removed === undefined) throw noClaim(scope!);
      io.stdout.write(`Removed ${removed.name}\n`);
      return ExitCode.Ok;
    }
  }
}
