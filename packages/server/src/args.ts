import { parseArgs } from 'node:util';

export type ServerCommand =
  | { readonly command: 'serve' }
  | { readonly command: 'migrate'; readonly check: boolean }
  | { readonly command: 'config-check' }
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
  wirebench-server --version
  wirebench-server --help

Configuration is read from WIREBENCH_SERVER_* environment variables; see README.md.
`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  check: { type: 'boolean' },
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
  const [word, second] = parsed.positionals;
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
    default:
      throw new UsageError(`unknown command "${word}"`);
  }
}
