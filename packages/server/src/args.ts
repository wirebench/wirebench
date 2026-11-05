import { parseArgs } from 'node:util';

/** The admin commands that work in one tenant: they take `--tenant <slug>` (hosted edition spec §19.11). */
type TenantAdminCommand =
  | { readonly command: 'admin-invite'; readonly email: string; readonly serverAdmin: boolean }
  | { readonly command: 'admin-list-invitations' }
  | { readonly command: 'admin-revoke-invitation'; readonly id: string }
  | { readonly command: 'admin-license-install'; readonly file: string }
  | { readonly command: 'admin-license-show' }
  | { readonly command: 'admin-license-remove' }
  | { readonly command: 'admin-scim-token-create'; readonly name: string }
  | { readonly command: 'admin-scim-token-list' }
  | { readonly command: 'admin-scim-token-revoke'; readonly id: string }
  | { readonly command: 'admin-scim-group-list' }
  | { readonly command: 'admin-scim-group-link'; readonly group: string; readonly team: string }
  | { readonly command: 'admin-scim-group-unlink'; readonly group: string }
  | {
      readonly command: 'admin-audit-export';
      readonly from?: string;
      readonly to?: string;
      readonly action?: string;
      readonly workspace?: string;
    }
  | {
      readonly command: 'admin-audit-verify';
      /** A head copied from the `audit chain sealed to <seq>:<hex>` log line. */
      readonly head?: { readonly seq: bigint; readonly hash: string };
      readonly json: boolean;
    }
  | { readonly command: 'admin-schedules-list'; readonly workspace?: string }
  | { readonly command: 'admin-schedules-enable'; readonly id: string }
  | { readonly command: 'admin-schedules-disable'; readonly id: string }
  | { readonly command: 'admin-schedules-runs'; readonly id: string; readonly limit: number }
  | { readonly command: 'admin-domains-check' }
  | { readonly command: 'admin-domains-remove' };

/**
 * The operator's tenant lifecycle commands (hosted edition spec §22.14): hosted mode only. The slug is positional;
 * `--tenant` is not used. `export`, `import` and `settings` arrive with their parts.
 */
export type AdminTenantCommand =
  | { readonly command: 'admin-tenant-list' }
  | {
      readonly command: 'admin-tenant-create';
      readonly slug: string;
      readonly name: string;
      readonly email: string;
      readonly edition: 'team' | 'enterprise';
      readonly seats?: number;
    }
  | {
      readonly command: 'admin-tenant-set-edition';
      readonly slug: string;
      /** Absent with `subscription`: back to the subscription's edition and seats. */
      readonly edition?: 'team' | 'enterprise';
      /** `null`: `--seats unlimited`. */
      readonly seats?: number | null;
      readonly subscription: boolean;
    }
  | { readonly command: 'admin-tenant-suspend'; readonly slug: string }
  | { readonly command: 'admin-tenant-resume'; readonly slug: string }
  | { readonly command: 'admin-tenant-rename'; readonly slug: string; readonly to: string }
  | { readonly command: 'admin-tenant-delete'; readonly slug: string; readonly cancel: boolean }
  | {
      readonly command: 'admin-tenant-settings';
      readonly slug: string;
      readonly action: 'get' | 'set' | 'clear';
      /** Every section for `get` when absent. */
      readonly section?: string;
      /** `set`'s JSON document. */
      readonly file?: string;
    };

export type ServerCommand =
  | { readonly command: 'serve' }
  | { readonly command: 'migrate'; readonly check: boolean }
  | { readonly command: 'config-check' }
  /**
   * `tenant` is the `--tenant` slug: required in hosted mode, refused in self-hosted mode (`identity/cli.ts`
   * checks it against the configuration, which the parser does not read).
   */
  | (TenantAdminCommand & { readonly tenant?: string })
  | AdminTenantCommand
  | { readonly command: 'admin-instances' }
  /** Every tenant's custom name (hosted edition spec §23.6): it works in no one tenant, so it takes no `--tenant`. */
  | { readonly command: 'admin-domains-list' }
  | { readonly command: 'admin-tenancy-role'; readonly printSql: boolean }
  | { readonly command: 'admin-tenancy-check' }
  | { readonly command: 'admin-tenancy-status' }
  | { readonly command: 'admin-tenancy-revert'; readonly acceptUnopened: boolean; readonly abort: boolean }
  | { readonly command: 'help' }
  | { readonly command: 'version' };

export class UsageError extends Error {
  readonly code = 'usage-error';
}

export const HELP_TEXT = `wirebench-server — Wirebench Server

Usage:
  wirebench-server [serve]          Start the server (default)
  wirebench-server migrate          Apply pending database migrations and exit
  wirebench-server migrate --check  Exit 1 when migrations are pending
  wirebench-server config check     Report each WIREBENCH_SERVER_* variable as set, defaulted or missing
  wirebench-server admin invite <email> [--no-admin]
                                    Create an invitation link (a server admin unless --no-admin)
  wirebench-server admin list-invitations
  wirebench-server admin revoke-invitation <id>
  wirebench-server admin license install <file>
                                    Install a license file (replaces any installed license)
  wirebench-server admin license show
  wirebench-server admin license remove
  wirebench-server admin scim-token create <name>
                                    Create a SCIM token for the identity provider (printed once)
  wirebench-server admin scim-token list
  wirebench-server admin scim-token revoke <id>
  wirebench-server admin scim-group list
  wirebench-server admin scim-group link <group> <team>
                                    Link a SCIM group (id or name) to a team (id or name)
  wirebench-server admin scim-group unlink <group>
  wirebench-server admin audit export [--from <iso>] [--to <iso>] [--action <name or group.>] [--workspace <id>]
                                    Write the audit log as NDJSON to stdout
  wirebench-server admin audit verify [--head <seq>:<hex>] [--json]
                                    Check the audit log's chain; exit 1 when a link is broken
  wirebench-server admin schedules list [--workspace <id>]
  wirebench-server admin schedules enable <id>
  wirebench-server admin schedules disable <id>
  wirebench-server admin schedules runs <id> [--limit <n>]
                                    A schedule's runs as NDJSON, newest first (default 50, at most 200)
  wirebench-server admin domains list
                                    Hosted: every team's custom domain, with its slug, state and last
                                    check (never its token)
  wirebench-server admin domains check --tenant <slug>
                                    Hosted: check a team's custom domain now
  wirebench-server admin domains remove --tenant <slug>
                                    Hosted: release a team's custom domain (abuse, a support case)
  wirebench-server admin instances  The server instances running on this database: holder, address,
                                    version, age and last renew
  wirebench-server admin tenancy role [--print-sql]
                                    As the owner (WIREBENCH_SERVER_MIGRATION_DATABASE_URL), create the
                                    app role of WIREBENCH_SERVER_DATABASE_URL if missing and grant it its
                                    privileges; --print-sql prints the statements instead, which
                                    hold a password verifier: handle them as a secret
  wirebench-server admin tenancy check
                                    Before an upgrade, read only: the PostgreSQL version, the app role,
                                    backups, the data directory's move and the migration's estimated time
  wirebench-server admin tenancy status
                                    Where the upgrade stands: its step, the data key and the re-wrap
  wirebench-server admin tenancy revert [--accept-unopened | --abort]
                                    With every server stopped, undo the upgrade to this version: the
                                    database back to schema 19 and the data directory to its old
                                    layout, so the previous version starts on them. Resumes if stopped;
                                    --accept-unopened goes on past values that open under neither key
                                    and links it does not follow; --abort, while it is still re-sealing,
                                    gives the upgrade back to the next start
  wirebench-server admin tenant list
                                    Hosted mode: every tenant's slug, status, edition, seats,
                                    subscription and deletion date
  wirebench-server admin tenant create --slug <slug> --name <name> --email <email> [--edition team|enterprise] [--seats <n>]
                                    Hosted mode: a tenant whose edition the operator sets, and a
                                    server-admin invitation for the email, mailed through the
                                    server's SMTP or printed without it
  wirebench-server admin tenant set-edition <slug> <team|enterprise> [--seats <n>|unlimited]
  wirebench-server admin tenant set-edition <slug> --subscription
                                    Hosted mode: the operator's edition and seats, or back to the
                                    subscription's
  wirebench-server admin tenant suspend <slug>
  wirebench-server admin tenant resume <slug>
  wirebench-server admin tenant rename <slug> <new-slug>
                                    Hosted mode: the old name redirects to the new one for 30 days,
                                    and is never used again
  wirebench-server admin tenant delete <slug> [--cancel]
                                    Hosted mode: the tenant and its data are deleted 14 days on;
                                    --cancel takes the request back until then
  wirebench-server admin tenant settings <slug> get [<section>]
  wirebench-server admin tenant settings <slug> set <section> --file <json>
  wirebench-server admin tenant settings <slug> clear <section>
                                    Hosted mode: a tenant's sign-in, forwarding, mail, retention and
                                    budget settings; secrets show only as set or not, and budgets
                                    are the operator's alone
  wirebench-server --version
  wirebench-server --help

Every admin command but admin instances, admin tenancy, admin tenant and admin domains list takes --tenant <slug>:
the tenant it works in. Hosted mode requires it; a self-hosted server has one tenant and refuses it. admin tenant names
its tenant as an argument.

Configuration is read from WIREBENCH_SERVER_* environment variables; see README.md.
`;

const TENANCY_USAGE =
  'usage: wirebench-server admin tenancy role [--print-sql] | check | status | revert [--accept-unopened | --abort]';

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  check: { type: 'boolean' },
  'no-admin': { type: 'boolean' },
  from: { type: 'string' },
  to: { type: 'string' },
  action: { type: 'string' },
  workspace: { type: 'string' },
  head: { type: 'string' },
  json: { type: 'boolean' },
  limit: { type: 'string' },
  'print-sql': { type: 'boolean' },
  'accept-unopened': { type: 'boolean' },
  abort: { type: 'boolean' },
  tenant: { type: 'string' },
  slug: { type: 'string' },
  name: { type: 'string' },
  email: { type: 'string' },
  edition: { type: 'string' },
  seats: { type: 'string' },
  subscription: { type: 'boolean' },
  cancel: { type: 'boolean' },
  file: { type: 'string' },
} as const;

const DOMAINS_USAGE = 'usage: wirebench-server admin domains list | check --tenant <slug> | remove --tenant <slug>';

const TENANT_USAGE =
  'usage: wirebench-server admin tenant list | create --slug <slug> --name <name> --email <email> [--edition team|enterprise] [--seats <n>]' +
  ' | set-edition <slug> <team|enterprise> [--seats <n>|unlimited] | set-edition <slug> --subscription | suspend <slug> | resume <slug>' +
  ' | rename <slug> <new-slug> | delete <slug> [--cancel]' +
  ' | settings <slug> get [<section>] | settings <slug> set <section> --file <json> | settings <slug> clear <section>';

/** `--edition`, or an edition argument: a hosted edition is Team or Enterprise (spec §22.4). */
function parseEdition(value: string): 'team' | 'enterprise' {
  if (value !== 'team' && value !== 'enterprise') throw new UsageError('the edition must be team or enterprise');
  return value;
}

/** `set-edition`'s `--seats`: a number, or `unlimited` for no limit. */
function parseSetSeats(value: string | undefined): number | null | undefined {
  return value === 'unlimited' ? null : parseSeats(value);
}

function parseSeats(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seats = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(seats) || seats < 1) {
    throw new UsageError('--seats must be a whole number from 1');
  }
  return seats;
}

const SCHEDULES_USAGE =
  'usage: wirebench-server admin schedules list [--workspace <id>] | enable <id> | disable <id> | runs <id> [--limit <n>]';

const AUDIT_USAGE =
  'usage: wirebench-server admin audit export [--from <iso>] [--to <iso>] [--action <name or group.>] [--workspace <id>]' +
  ' | verify [--head <seq>:<hex>] [--json]';

/** `<seq>:<hex>`, as the sealer logs a head: a sequence number from 1 and a 32-byte hash in hex. */
const HEAD = /^([1-9][0-9]{0,18}):([0-9a-fA-F]{64})$/;
const MAX_SEQ = 2n ** 63n - 1n;
/** A tenant's slug as `tenants.slug` holds it: one DNS label, lower-case. */
const TENANT_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

function parseHead(value: string): { seq: bigint; hash: string } {
  const match = HEAD.exec(value);
  if (match !== null) {
    const seq = BigInt(match[1]!);
    if (seq <= MAX_SEQ) return { seq, hash: match[2]!.toLowerCase() };
  }
  throw new UsageError('--head must be <seq>:<hex>, as in the "audit chain sealed to" log line');
}

export function parseServerArgs(argv: readonly string[]): ServerCommand {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: OPTIONS });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help) return { command: 'help' };
  if (parsed.values.version) return { command: 'version' };
  const [word, second, third, fourth, fifth] = parsed.positionals;
  if (parsed.values['no-admin'] && !(word === 'admin' && second === 'invite')) {
    throw new UsageError('--no-admin only applies to admin invite');
  }
  const isAuditExport = word === 'admin' && second === 'audit' && third === 'export';
  for (const key of ['from', 'to', 'action'] as const) {
    if (parsed.values[key] !== undefined && !isAuditExport) {
      throw new UsageError(`--${key} applies to admin audit export only`);
    }
  }
  const isSchedulesList = word === 'admin' && second === 'schedules' && third === 'list';
  if (parsed.values.workspace !== undefined && !isAuditExport && !isSchedulesList) {
    throw new UsageError('--workspace applies to admin audit export and admin schedules list only');
  }
  if (parsed.values.limit !== undefined && !(word === 'admin' && second === 'schedules' && third === 'runs')) {
    throw new UsageError('--limit applies to admin schedules runs only');
  }
  const isAuditVerify = word === 'admin' && second === 'audit' && third === 'verify';
  for (const key of ['head', 'json'] as const) {
    if (parsed.values[key] !== undefined && !isAuditVerify) {
      throw new UsageError(`--${key} applies to admin audit verify only`);
    }
  }
  if (parsed.values['print-sql'] !== undefined && !(word === 'admin' && second === 'tenancy' && third === 'role')) {
    throw new UsageError('--print-sql applies to admin tenancy role only');
  }
  if (
    parsed.values['accept-unopened'] !== undefined &&
    !(word === 'admin' && second === 'tenancy' && third === 'revert')
  ) {
    throw new UsageError('--accept-unopened applies to admin tenancy revert only');
  }
  if (parsed.values.abort !== undefined) {
    if (!(word === 'admin' && second === 'tenancy' && third === 'revert')) {
      throw new UsageError('--abort applies to admin tenancy revert only');
    }
    if (parsed.values['accept-unopened'] !== undefined) {
      throw new UsageError('--abort and --accept-unopened cannot be given together');
    }
  }
  const isTenantCommand = word === 'admin' && second === 'tenant';
  const isCreate = isTenantCommand && third === 'create';
  for (const key of ['slug', 'name', 'email', 'edition'] as const) {
    if (parsed.values[key] !== undefined && !isCreate)
      throw new UsageError(`--${key} applies to admin tenant create only`);
  }
  if (parsed.values.seats !== undefined && !(isCreate || (isTenantCommand && third === 'set-edition'))) {
    throw new UsageError('--seats applies to admin tenant create and set-edition only');
  }
  if (parsed.values.subscription !== undefined && !(isTenantCommand && third === 'set-edition')) {
    throw new UsageError('--subscription applies to admin tenant set-edition only');
  }
  if (parsed.values.file !== undefined && !(isTenantCommand && third === 'settings')) {
    throw new UsageError('--file applies to admin tenant settings set only');
  }
  if (parsed.values.cancel !== undefined && !(isTenantCommand && third === 'delete')) {
    throw new UsageError('--cancel applies to admin tenant delete only');
  }
  const tenant = parsed.values.tenant;
  if (tenant !== undefined) {
    if (
      word !== 'admin' ||
      second === 'tenancy' ||
      second === 'instances' ||
      second === 'tenant' ||
      (second === 'domains' && third === 'list')
    ) {
      throw new UsageError(
        '--tenant applies to the admin commands, not to admin tenancy, admin instances, admin domains list or admin tenant (which names its tenant as an argument)',
      );
    }
    if (!TENANT_SLUG.test(tenant))
      throw new UsageError('--tenant must be a tenant slug: lower-case letters, digits and -');
  }
  /** The admin command, in `--tenant`'s tenant when one was named. */
  const inTenant = (command: TenantAdminCommand): ServerCommand =>
    tenant === undefined ? command : { ...command, tenant };
  switch (word) {
    case undefined:
    case 'serve':
      if (parsed.values.check) throw new UsageError('--check only applies to migrate');
      return { command: 'serve' };
    case 'migrate':
      return { command: 'migrate', check: parsed.values.check === true };
    case 'config':
      if (second !== 'check') throw new UsageError('usage: wirebench-server config check');
      return { command: 'config-check' };
    case 'admin':
      switch (second) {
        case 'invite':
          if (third === undefined) throw new UsageError('usage: wirebench-server admin invite <email> [--no-admin]');
          return inTenant({ command: 'admin-invite', email: third, serverAdmin: parsed.values['no-admin'] !== true });
        case 'list-invitations':
          return inTenant({ command: 'admin-list-invitations' });
        case 'revoke-invitation':
          if (third === undefined) throw new UsageError('usage: wirebench-server admin revoke-invitation <id>');
          return inTenant({ command: 'admin-revoke-invitation', id: third });
        case 'audit': {
          if (third === 'verify') {
            return inTenant({
              command: 'admin-audit-verify',
              ...(parsed.values.head !== undefined ? { head: parseHead(parsed.values.head) } : {}),
              json: parsed.values.json === true,
            });
          }
          if (third !== 'export') throw new UsageError(AUDIT_USAGE);
          for (const key of ['from', 'to'] as const) {
            const value = parsed.values[key];
            if (value !== undefined && Number.isNaN(Date.parse(value))) {
              throw new UsageError(`--${key} must be an ISO 8601 date-time`);
            }
          }
          return inTenant({
            command: 'admin-audit-export',
            ...(parsed.values.from !== undefined ? { from: parsed.values.from } : {}),
            ...(parsed.values.to !== undefined ? { to: parsed.values.to } : {}),
            ...(parsed.values.action !== undefined ? { action: parsed.values.action } : {}),
            ...(parsed.values.workspace !== undefined ? { workspace: parsed.values.workspace } : {}),
          });
        }
        case 'schedules':
          switch (third) {
            case 'list':
              return inTenant({
                command: 'admin-schedules-list',
                ...(parsed.values.workspace !== undefined ? { workspace: parsed.values.workspace } : {}),
              });
            case 'enable':
            case 'disable':
              if (fourth === undefined) throw new UsageError(SCHEDULES_USAGE);
              return inTenant({
                command: third === 'enable' ? 'admin-schedules-enable' : 'admin-schedules-disable',
                id: fourth,
              });
            case 'runs': {
              if (fourth === undefined) throw new UsageError(SCHEDULES_USAGE);
              const limit = parsed.values.limit === undefined ? 50 : Number(parsed.values.limit);
              if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
                throw new UsageError('--limit must be a whole number from 1 to 200');
              }
              return inTenant({ command: 'admin-schedules-runs', id: fourth, limit });
            }
            default:
              throw new UsageError(SCHEDULES_USAGE);
          }
        case 'domains':
          if (fourth !== undefined) throw new UsageError(DOMAINS_USAGE);
          switch (third) {
            case 'list':
              return { command: 'admin-domains-list' };
            case 'check':
              return inTenant({ command: 'admin-domains-check' });
            case 'remove':
              return inTenant({ command: 'admin-domains-remove' });
            default:
              throw new UsageError(DOMAINS_USAGE);
          }
        case 'tenant':
          return parseTenantCommand(
            third,
            fourth,
            fifth,
            parsed.positionals.length,
            parsed.values,
            parsed.positionals[5],
          );
        case 'instances':
          if (third !== undefined) throw new UsageError('usage: wirebench-server admin instances');
          return { command: 'admin-instances' };
        case 'tenancy':
          if (fourth !== undefined) throw new UsageError(TENANCY_USAGE);
          switch (third) {
            case 'role':
              return { command: 'admin-tenancy-role', printSql: parsed.values['print-sql'] === true };
            case 'check':
              return { command: 'admin-tenancy-check' };
            case 'status':
              return { command: 'admin-tenancy-status' };
            case 'revert':
              return {
                command: 'admin-tenancy-revert',
                acceptUnopened: parsed.values['accept-unopened'] === true,
                abort: parsed.values.abort === true,
              };
            default:
              throw new UsageError(TENANCY_USAGE);
          }
        case 'license':
          switch (third) {
            case 'install':
              if (fourth === undefined) throw new UsageError('usage: wirebench-server admin license install <file>');
              return inTenant({ command: 'admin-license-install', file: fourth });
            case 'show':
              return inTenant({ command: 'admin-license-show' });
            case 'remove':
              return inTenant({ command: 'admin-license-remove' });
            default:
              throw new UsageError('usage: wirebench-server admin license install <file> | show | remove');
          }
        case 'scim-token':
          switch (third) {
            case 'create':
              if (fourth === undefined) throw new UsageError('usage: wirebench-server admin scim-token create <name>');
              return inTenant({ command: 'admin-scim-token-create', name: fourth });
            case 'list':
              return inTenant({ command: 'admin-scim-token-list' });
            case 'revoke':
              if (fourth === undefined) throw new UsageError('usage: wirebench-server admin scim-token revoke <id>');
              return inTenant({ command: 'admin-scim-token-revoke', id: fourth });
            default:
              throw new UsageError('usage: wirebench-server admin scim-token create <name> | list | revoke <id>');
          }
        case 'scim-group':
          switch (third) {
            case 'list':
              return inTenant({ command: 'admin-scim-group-list' });
            case 'link':
              if (fourth === undefined || fifth === undefined)
                throw new UsageError('usage: wirebench-server admin scim-group link <group> <team>');
              return inTenant({ command: 'admin-scim-group-link', group: fourth, team: fifth });
            case 'unlink':
              if (fourth === undefined) throw new UsageError('usage: wirebench-server admin scim-group unlink <group>');
              return inTenant({ command: 'admin-scim-group-unlink', group: fourth });
            default:
              throw new UsageError(
                'usage: wirebench-server admin scim-group list | link <group> <team> | unlink <group>',
              );
          }
        default:
          throw new UsageError(`unknown admin command "${second ?? ''}"; try --help`);
      }
    default:
      throw new UsageError(`unknown command "${word}"`);
  }
}

/** `admin tenant <verb> …` (spec §22.14); `count` is every positional, so an extra one is refused. */
function parseTenantCommand(
  verb: string | undefined,
  first: string | undefined,
  second: string | undefined,
  count: number,
  values: {
    readonly slug?: string;
    readonly name?: string;
    readonly email?: string;
    readonly edition?: string;
    readonly seats?: string;
    readonly subscription?: boolean;
    readonly cancel?: boolean;
    readonly file?: string;
  },
  third?: string,
): AdminTenantCommand {
  /** `admin tenant <verb>` and `args` positionals more, exactly. */
  const positionals = (args: number): void => {
    if (count !== 3 + args) throw new UsageError(TENANT_USAGE);
  };
  switch (verb) {
    case 'list':
      positionals(0);
      return { command: 'admin-tenant-list' };
    case 'create': {
      positionals(0);
      if (values.slug === undefined || values.name === undefined || values.email === undefined) {
        throw new UsageError('admin tenant create needs --slug, --name and --email');
      }
      const seats = parseSeats(values.seats);
      return {
        command: 'admin-tenant-create',
        slug: values.slug,
        name: values.name,
        email: values.email,
        edition: values.edition === undefined ? 'team' : parseEdition(values.edition),
        ...(seats !== undefined ? { seats } : {}),
      };
    }
    case 'set-edition': {
      if (values.subscription === true) {
        positionals(1);
        if (values.seats !== undefined)
          throw new UsageError("--subscription takes the subscription's seats; drop --seats");
        return { command: 'admin-tenant-set-edition', slug: first!, subscription: true };
      }
      positionals(2);
      const seats = parseSetSeats(values.seats);
      return {
        command: 'admin-tenant-set-edition',
        slug: first!,
        edition: parseEdition(second!),
        ...(seats !== undefined ? { seats } : {}),
        subscription: false,
      };
    }
    case 'suspend':
    case 'resume':
      positionals(1);
      return { command: verb === 'suspend' ? 'admin-tenant-suspend' : 'admin-tenant-resume', slug: first! };
    case 'rename':
      positionals(2);
      return { command: 'admin-tenant-rename', slug: first!, to: second! };
    case 'delete':
      positionals(1);
      return { command: 'admin-tenant-delete', slug: first!, cancel: values.cancel === true };
    case 'settings': {
      if (second === 'get') {
        if (count !== 5 && count !== 6) throw new UsageError(TENANT_USAGE);
        if (values.file !== undefined) throw new UsageError('--file applies to admin tenant settings set only');
        return {
          command: 'admin-tenant-settings',
          slug: first!,
          action: 'get',
          ...(third !== undefined ? { section: third } : {}),
        };
      }
      if (second !== 'set' && second !== 'clear') throw new UsageError(TENANT_USAGE);
      positionals(3);
      if (second === 'set' && values.file === undefined)
        throw new UsageError('admin tenant settings set needs --file <json>');
      if (second === 'clear' && values.file !== undefined)
        throw new UsageError('--file applies to admin tenant settings set only');
      return {
        command: 'admin-tenant-settings',
        slug: first!,
        action: second,
        section: third!,
        ...(values.file !== undefined ? { file: values.file } : {}),
      };
    }
    default:
      throw new UsageError(TENANT_USAGE);
  }
}
