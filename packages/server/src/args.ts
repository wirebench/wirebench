import { parseArgs } from 'node:util';

export type ServerCommand =
  | { readonly command: 'serve' }
  | { readonly command: 'migrate'; readonly check: boolean }
  | { readonly command: 'config-check' }
  | { readonly command: 'admin-invite'; readonly email: string; readonly serverAdmin: boolean }
  | { readonly command: 'admin-list-invitations' }
  | { readonly command: 'admin-revoke-invitation'; readonly id: string }
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
  wirebench-server --version
  wirebench-server --help

Configuration is read from WIREBENCH_SERVER_* environment variables; see README.md.
`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  check: { type: 'boolean' },
  'no-admin': { type: 'boolean' },
} as const;

export function parseServerArgs(argv: readonly string[]): ServerCommand {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: OPTIONS });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help) return { command: 'help' };
  if (parsed.values.version) return { command: 'version' };
  const [word, second, third] = parsed.positionals;
  if (parsed.values['no-admin'] && !(word === 'admin' && second === 'invite')) {
    throw new UsageError('--no-admin only applies to admin invite');
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
        default:
          throw new UsageError(`unknown admin command "${second ?? ''}"; try --help`);
      }
    default:
      throw new UsageError(`unknown command "${word}"`);
  }
}
