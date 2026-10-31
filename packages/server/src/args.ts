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
  | { readonly command: 'admin-schedules-runs'; readonly id: string; readonly limit: number };

export type ServerCommand =
  | { readonly command: 'serve' }
  | { readonly command: 'migrate'; readonly check: boolean }
  | { readonly command: 'config-check' }
  /**
   * `tenant` is the `--tenant` slug: required in hosted mode, refused in self-hosted mode (`identity/cli.ts`
   * checks it against the configuration, which the parser does not read).
   */
  | (TenantAdminCommand & { readonly tenant?: string })
  | { readonly command: 'admin-tenancy-role'; readonly printSql: boolean }
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
  wirebench-server admin tenancy role [--print-sql]
                                    As the owner (WIREBENCH_SERVER_MIGRATION_DATABASE_URL), create the
                                    app role of WIREBENCH_SERVER_DATABASE_URL if missing and grant it its
                                    privileges; --print-sql prints the statements instead, which
                                    hold a password verifier: handle them as a secret
  wirebench-server --version
  wirebench-server --help

Every admin command but tenancy role takes --tenant <slug>: the tenant it works in. Hosted mode requires it;
a self-hosted server has one tenant and refuses it.

Configuration is read from WIREBENCH_SERVER_* environment variables; see README.md.
`;

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
  tenant: { type: 'string' },
} as const;

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
  const tenant = parsed.values.tenant;
  if (tenant !== undefined) {
    if (word !== 'admin' || second === 'tenancy') {
      throw new UsageError('--tenant applies to the admin commands, not to admin tenancy');
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
        case 'tenancy':
          if (third !== 'role') throw new UsageError('usage: wirebench-server admin tenancy role [--print-sql]');
          return { command: 'admin-tenancy-role', printSql: parsed.values['print-sql'] === true };
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
