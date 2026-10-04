import { parseArgs } from 'node:util';

export type ServerCommand =
  | { readonly command: 'serve' }
  | { readonly command: 'migrate'; readonly check: boolean }
  | { readonly command: 'config-check' }
  | { readonly command: 'admin-invite'; readonly email: string; readonly serverAdmin: boolean }
  | { readonly command: 'admin-list-invitations' }
  | { readonly command: 'admin-revoke-invitation'; readonly id: string }
  | { readonly command: 'admin-license-install'; readonly file: string }
  | { readonly command: 'admin-license-show' }
  | { readonly command: 'admin-license-remove' }
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
  wirebench-server admin audit export [--from <iso>] [--to <iso>] [--action <name or group.>] [--workspace <id>]
                                    Write the audit log as NDJSON to stdout
  wirebench-server admin audit verify [--head <seq>:<hex>] [--json]
                                    Check the audit log's chain; exit 1 when a link is broken
  wirebench-server --version
  wirebench-server --help

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
} as const;

const AUDIT_USAGE =
  'usage: wirebench-server admin audit export [--from <iso>] [--to <iso>] [--action <name or group.>] [--workspace <id>]' +
  ' | verify [--head <seq>:<hex>] [--json]';

/** `<seq>:<hex>`, as the sealer logs a head: a sequence number from 1 and a 32-byte hash in hex. */
const HEAD = /^([1-9][0-9]{0,18}):([0-9a-fA-F]{64})$/;
const MAX_SEQ = 2n ** 63n - 1n;

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
  const [word, second, third, fourth] = parsed.positionals;
  if (parsed.values['no-admin'] && !(word === 'admin' && second === 'invite')) {
    throw new UsageError('--no-admin only applies to admin invite');
  }
  const isAuditExport = word === 'admin' && second === 'audit' && third === 'export';
  for (const key of ['from', 'to', 'action', 'workspace'] as const) {
    if (parsed.values[key] !== undefined && !isAuditExport) {
      throw new UsageError(`--${key} applies to admin audit export only`);
    }
  }
  const isAuditVerify = word === 'admin' && second === 'audit' && third === 'verify';
  for (const key of ['head', 'json'] as const) {
    if (parsed.values[key] !== undefined && !isAuditVerify) {
      throw new UsageError(`--${key} applies to admin audit verify only`);
    }
  }
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
          return { command: 'admin-invite', email: third, serverAdmin: parsed.values['no-admin'] !== true };
        case 'list-invitations':
          return { command: 'admin-list-invitations' };
        case 'revoke-invitation':
          if (third === undefined) throw new UsageError('usage: wirebench-server admin revoke-invitation <id>');
          return { command: 'admin-revoke-invitation', id: third };
        case 'audit': {
          if (third === 'verify') {
            return {
              command: 'admin-audit-verify',
              ...(parsed.values.head !== undefined ? { head: parseHead(parsed.values.head) } : {}),
              json: parsed.values.json === true,
            };
          }
          if (third !== 'export') throw new UsageError(AUDIT_USAGE);
          for (const key of ['from', 'to'] as const) {
            const value = parsed.values[key];
            if (value !== undefined && Number.isNaN(Date.parse(value))) {
              throw new UsageError(`--${key} must be an ISO 8601 date-time`);
            }
          }
          return {
            command: 'admin-audit-export',
            ...(parsed.values.from !== undefined ? { from: parsed.values.from } : {}),
            ...(parsed.values.to !== undefined ? { to: parsed.values.to } : {}),
            ...(parsed.values.action !== undefined ? { action: parsed.values.action } : {}),
            ...(parsed.values.workspace !== undefined ? { workspace: parsed.values.workspace } : {}),
          };
        }
        case 'license':
          switch (third) {
            case 'install':
              if (fourth === undefined) throw new UsageError('usage: wirebench-server admin license install <file>');
              return { command: 'admin-license-install', file: fourth };
            case 'show':
              return { command: 'admin-license-show' };
            case 'remove':
              return { command: 'admin-license-remove' };
            default:
              throw new UsageError('usage: wirebench-server admin license install <file> | show | remove');
          }
        default:
          throw new UsageError(`unknown admin command "${second ?? ''}"; try --help`);
      }
    default:
      throw new UsageError(`unknown command "${word}"`);
  }
}
