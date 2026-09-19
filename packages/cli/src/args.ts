import { parseArgs } from 'node:util';

/** Spec §3.1: `wirebench run <path> [selector…] [options]`. */
export const HELP_TEXT = `wirebench run <path> [selector…] [options]

<path>                 One project directory (wirebench.yaml). A workspace directory is exit 2, with a
                       message listing its projects. When the project sits inside a workspace, the
                       workspace's environments and properties still apply (found by walking up to
                       workspace.yaml).
[selector…]            Paths below <path>: a request file, an operation, an interface, an API.
                       None = every request in the project.

-e, --env <name>       Environment by name or slug. Required when the target defines any.
    --var <k=v>        Override an environment property for this run. Repeatable.
    --reporter <spec>  cli | junit=<file> | json=<file> | html=<file>. Repeatable. Default: cli.
    --bail             Stop at the first failed or errored request; the rest are skipped.
    --timeout <ms>     Per-request timeout override.
    --sla <ms>         Default response-time ceiling for requests that declare none.
    --require-assertions  A request without assertions is an error.
    --insecure         Skip TLS verification (as the desktop's per-environment switch).
    --no-color
-q, --quiet | -v, --verbose

wirebench secrets list <path> [selector…] [-e <name>]
                       Prints every secret the selection needs: variable name, where it is used,
                       whether it is set. Exit 0 when all are set, 3 when one is missing. Never
                       prints a value.

wirebench --version | --help`;

/** Thrown for any command-line mistake; `main` turns it into exit code 2. */
export class UsageError extends Error {
  readonly code = 'usage-error';
}

export type ReporterSpec =
  { readonly kind: 'cli' } | { readonly kind: 'junit' | 'json' | 'html'; readonly file: string };

export interface RunArgs {
  readonly command: 'run';
  readonly path: string;
  readonly selectors: readonly string[];
  readonly env?: string;
  readonly vars: Readonly<Record<string, string>>;
  readonly reporters: readonly ReporterSpec[];
  readonly bail: boolean;
  readonly timeoutMs?: number;
  readonly slaMs?: number;
  readonly requireAssertions: boolean;
  readonly insecure: boolean;
  readonly color: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
}

export interface SecretsListArgs {
  readonly command: 'secrets-list';
  readonly path: string;
  readonly selectors: readonly string[];
  readonly env?: string;
}

export type ParsedArgs = RunArgs | SecretsListArgs | { readonly command: 'help' } | { readonly command: 'version' };

const REPORTER_KINDS = new Set(['junit', 'json', 'html']);

/** Parses `--reporter <spec>`, one of `cli` or `<kind>=<file>`. */
function parseReporter(spec: string): ReporterSpec {
  if (spec === 'cli') {
    return { kind: 'cli' };
  }
  const eq = spec.indexOf('=');
  if (eq === -1) {
    throw new UsageError(`--reporter must be "cli" or "<kind>=<file>", got "${spec}"`);
  }
  const kind = spec.slice(0, eq);
  const file = spec.slice(eq + 1);
  if (!REPORTER_KINDS.has(kind) || file.length === 0) {
    throw new UsageError(`--reporter must be "cli" or "<kind>=<file>", got "${spec}"`);
  }
  return { kind: kind as 'junit' | 'json' | 'html', file };
}

/** Parses `--var <k=v>`, splitting on the first `=` so a value may itself contain `=`. */
function parseVar(spec: string): readonly [string, string] {
  const eq = spec.indexOf('=');
  if (eq === -1) {
    throw new UsageError(`--var must be "<key>=<value>", got "${spec}"`);
  }
  return [spec.slice(0, eq), spec.slice(eq + 1)];
}

/** Parses a positive-integer millisecond flag, naming the flag in any error. */
function parsePositiveInt(raw: string, flagName: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`--${flagName} must be a positive integer, got "${raw}"`);
  }
  return n;
}

/** Parses `process.argv.slice(2)` into a {@link ParsedArgs}, or throws {@link UsageError}. */
export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        env: { type: 'string', short: 'e' },
        var: { type: 'string', multiple: true },
        reporter: { type: 'string', multiple: true },
        bail: { type: 'boolean' },
        timeout: { type: 'string' },
        sla: { type: 'string' },
        'require-assertions': { type: 'boolean' },
        insecure: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        verbose: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
      },
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new UsageError(error.message);
    }
    throw error;
  }

  const { values, positionals } = parsed;

  if (values.help) {
    return { command: 'help' };
  }
  if (values.version) {
    return { command: 'version' };
  }

  const [word, ...rest] = positionals;

  if (word === undefined) {
    return { command: 'help' };
  }

  if (word === 'run') {
    const [path, ...selectors] = rest;
    if (path === undefined) {
      throw new UsageError('wirebench run <path> [selector…] [options]: <path> is required');
    }
    const vars: Record<string, string> = {};
    for (const spec of values.var ?? []) {
      const [key, value] = parseVar(spec);
      vars[key] = value;
    }
    const reporterSpecs = values.reporter ?? [];
    const reporters: readonly ReporterSpec[] =
      reporterSpecs.length > 0 ? reporterSpecs.map(parseReporter) : [{ kind: 'cli' }];
    return {
      command: 'run',
      path,
      selectors,
      ...(values.env !== undefined ? { env: values.env } : {}),
      vars,
      reporters,
      bail: values.bail ?? false,
      ...(values.timeout !== undefined ? { timeoutMs: parsePositiveInt(values.timeout, 'timeout') } : {}),
      ...(values.sla !== undefined ? { slaMs: parsePositiveInt(values.sla, 'sla') } : {}),
      requireAssertions: values['require-assertions'] ?? false,
      insecure: values.insecure ?? false,
      color: !values['no-color'],
      quiet: values.quiet ?? false,
      verbose: values.verbose ?? false,
    };
  }

  if (word === 'secrets') {
    const [sub, path, ...selectors] = rest;
    if (sub !== 'list') {
      throw new UsageError(`wirebench secrets list <path> [selector…] [-e <name>]: unknown subcommand "${sub ?? ''}"`);
    }
    if (path === undefined) {
      throw new UsageError('wirebench secrets list <path> [selector…] [-e <name>]: <path> is required');
    }
    return {
      command: 'secrets-list',
      path,
      selectors,
      ...(values.env !== undefined ? { env: values.env } : {}),
    };
  }

  throw new UsageError(`unknown command "${word}"`);
}
