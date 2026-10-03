import { parseArgs } from 'node:util';
import {
  isOpVerb,
  OP_OPTIONS,
  OPS_HELP_TEXT,
  parseCall,
  parseMcp,
  parseOpVerb,
  refuseOpOnly,
  VERB_HELP,
} from './args-ops.js';
import type { CallArgs, McpArgs, OpArgs } from './args-ops.js';
import { UsageError } from './usage-error.js';

export { UsageError };
export type { CallArgs, McpArgs, OpArgs, OpName } from './args-ops.js';

/** Spec §3.1: `wirebench run <path> [selector…] [options]`. */
export const HELP_TEXT = `wirebench run <path> [selector…] [options]

<path>                 One project directory (wirebench.yaml). A workspace directory is exit 2, with a
                       message listing its projects. When the project sits inside a workspace, the
                       workspace's environments and properties still apply (found by walking up to
                       workspace.yaml).
[selector…]            Paths below <path>: a request file, an operation, an interface, an API.
                       None = every request in the project.
    --sequence <name>  Run a sequence (by name, or sequences/<slug>.sequence.yaml) instead of
                       requests: its steps in order, with their transfers and assertions.
                       Repeatable; cannot be combined with selectors.

-e, --env <name>       Environment by name or slug. Required when the target defines any.
    --var <k=v>        Override an environment property for this run. Repeatable.
    --reporter <spec>  cli | junit=<file> | json=<file> | html=<file>. Repeatable. Default: cli.
    --bail             Stop at the first failed or errored request; the rest are skipped.
    --timeout <ms>     Per-request timeout override.
    --sla <ms>         Default response-time ceiling for requests that declare none.
    --require-assertions  A request without assertions is an error.
    --baseline         Compare each response with its committed golden (<slug>.golden.yaml).
    --require-baseline With --baseline: a request without a golden is an error.
    --insecure         Skip TLS verification (as the desktop's per-environment switch).
    --no-color
-q, --quiet | -v, --verbose

wirebench secrets list <path> [selector… | --sequence <name>…] [-e <name>] [--var <k=v>…]
                       Prints every secret the selection needs: variable name, where it is used,
                       whether it is set. Exit 0 when all are set, 3 when one is missing. Never
                       prints a value. --var as for run, so a token only a --var holds is listed.

${OPS_HELP_TEXT}

wirebench --version | --help
wirebench <verb> --help`;

export type ReporterSpec =
  { readonly kind: 'cli' } | { readonly kind: 'junit' | 'json' | 'html'; readonly file: string };

export interface RunArgs {
  readonly command: 'run';
  readonly path: string;
  readonly selectors: readonly string[];
  /** `--sequence` names; when any are given the run is of those sequences, not of requests. */
  readonly sequences: readonly string[];
  readonly env?: string;
  readonly vars: Readonly<Record<string, string>>;
  readonly reporters: readonly ReporterSpec[];
  readonly bail: boolean;
  readonly timeoutMs?: number;
  readonly slaMs?: number;
  readonly requireAssertions: boolean;
  readonly baseline: boolean;
  readonly requireBaseline: boolean;
  readonly insecure: boolean;
  readonly color: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
}

export interface SecretsListArgs {
  readonly command: 'secrets-list';
  readonly path: string;
  readonly selectors: readonly string[];
  /** `--sequence` names, as `run` takes them: the secrets their steps need are listed. */
  readonly sequences: readonly string[];
  readonly env?: string;
  /** `--var` overrides, as `run` takes them: a token only one of them holds is listed too. */
  readonly vars: Readonly<Record<string, string>>;
}

export type ParsedArgs =
  | RunArgs
  | SecretsListArgs
  | OpArgs
  | McpArgs
  | CallArgs
  | { readonly command: 'help'; readonly topic?: string }
  | { readonly command: 'version' };

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

/** Every `--var <key>=<value>`, later ones winning. */
function parseVars(specs: readonly string[] | undefined): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const spec of specs ?? []) {
    const [key, value] = parseVar(spec);
    vars[key] = value;
  }
  return vars;
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
        sequence: { type: 'string', multiple: true },
        var: { type: 'string', multiple: true },
        reporter: { type: 'string', multiple: true },
        bail: { type: 'boolean' },
        timeout: { type: 'string' },
        sla: { type: 'string' },
        'require-assertions': { type: 'boolean' },
        baseline: { type: 'boolean' },
        'require-baseline': { type: 'boolean' },
        insecure: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        verbose: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
        ...OP_OPTIONS,
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
    const [topic] = positionals;
    return topic !== undefined && Object.hasOwn(VERB_HELP, topic) ? { command: 'help', topic } : { command: 'help' };
  }
  if (values.version) {
    return { command: 'version' };
  }

  const [word, ...rest] = positionals;
  const sequences = values.sequence ?? [];
  /** A run is of requests or of sequences, never both: which report entry is which would be a guess. */
  const refuseMixed = (selectors: readonly string[]): void => {
    if (sequences.length > 0 && selectors.length > 0) {
      throw new UsageError('--sequence cannot be combined with request selectors');
    }
  };

  if (word === undefined) {
    return { command: 'help' };
  }

  if (word === 'run') {
    refuseOpOnly(values, 'wirebench run');
    const [path, ...selectors] = rest;
    if (path === undefined) {
      throw new UsageError('wirebench run <path> [selector…] [options]: <path> is required');
    }
    refuseMixed(selectors);
    const baseline = values.baseline ?? false;
    const requireBaseline = values['require-baseline'] ?? false;
    if (requireBaseline && !baseline) {
      throw new UsageError('--require-baseline needs --baseline');
    }
    if (baseline && sequences.length > 0) {
      throw new UsageError('--baseline cannot be combined with --sequence: sequence steps are not compared');
    }
    const vars = parseVars(values.var);
    const reporterSpecs = values.reporter ?? [];
    const reporters: readonly ReporterSpec[] =
      reporterSpecs.length > 0 ? reporterSpecs.map(parseReporter) : [{ kind: 'cli' }];
    return {
      command: 'run',
      path,
      selectors,
      sequences,
      ...(values.env !== undefined ? { env: values.env } : {}),
      vars,
      reporters,
      bail: values.bail ?? false,
      ...(values.timeout !== undefined ? { timeoutMs: parsePositiveInt(values.timeout, 'timeout') } : {}),
      ...(values.sla !== undefined ? { slaMs: parsePositiveInt(values.sla, 'sla') } : {}),
      requireAssertions: values['require-assertions'] ?? false,
      baseline,
      requireBaseline,
      insecure: values.insecure ?? false,
      color: !values['no-color'],
      quiet: values.quiet ?? false,
      verbose: values.verbose ?? false,
    };
  }

  if (word === 'secrets') {
    refuseOpOnly(values, 'wirebench secrets list');
    const [sub, path, ...selectors] = rest;
    if (sub !== 'list') {
      throw new UsageError(`wirebench secrets list <path> [selector…] [-e <name>]: unknown subcommand "${sub ?? ''}"`);
    }
    if (path === undefined) {
      throw new UsageError('wirebench secrets list <path> [selector…] [-e <name>]: <path> is required');
    }
    refuseMixed(selectors);
    return {
      command: 'secrets-list',
      path,
      selectors,
      sequences,
      ...(values.env !== undefined ? { env: values.env } : {}),
      vars: parseVars(values.var),
    };
  }

  if (word === 'call') {
    return parseCall(rest, values);
  }

  if (word === 'mcp') {
    return parseMcp(rest, values);
  }

  if (isOpVerb(word)) {
    return parseOpVerb(word, rest, values);
  }

  throw new UsageError(`unknown command "${word}"`);
}
