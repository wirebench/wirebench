import { parseArgs } from 'node:util';
import {
  isOpVerb,
  OP_OPTIONS,
  OPS_HELP_TEXT,
  parseCall,
  parseMcp,
  parseExport,
  parseOpVerb,
  refuseOpOnly,
  VERB_HELP,
} from './args-ops.js';
import type { CallArgs, ExportArgs, McpArgs, OpArgs } from './args-ops.js';
import { DATA_OPTIONS, parseRunData, refuseRunDataOnly } from './args-data.js';
import type { RunDataArgs } from './args-data.js';
import { DIFF_CONTRACT_HELP, DIFF_CONTRACT_USAGE, parseDiffContract } from './args-diff-contract.js';
import type { DiffContractArgs } from './args-diff-contract.js';
import { LINT_HELP, LINT_OPTIONS, LINT_USAGE, parseLint, refuseLintOnly } from './args-lint.js';
import type { LintArgs } from './args-lint.js';
import { MOCK_CHECK_HELP, MOCK_HELP, parseMockCheck, parseMockServe } from './args-mock.js';
import type { MockArgs, MockCheckArgs } from './args-mock.js';
import { MOCK_RECORD_HELP, MOCK_RECORD_OPTIONS, parseMock, refuseMockRecordOnly } from './args-mock-record.js';
import type { MockRecordArgs } from './args-mock-record.js';
import { parseScripts, refuseScriptsOnly, SCRIPTS_HELP, SCRIPTS_OPTIONS, SCRIPTS_USAGE } from './args-scripts.js';
import type { ScriptsConvertArgs } from './args-scripts.js';
import { parseSsh, SSH_HELP } from './args-ssh.js';
import type { SshForwardArgs } from './args-ssh.js';
import type { FeatureArgs } from './features.js';
import { secretSourcesOptionsFrom, type CliSecretSourcesOptions } from './source-secrets.js';
import { UsageError } from './usage-error.js';

export { UsageError };
export type { CallArgs, ExportArgs, McpArgs, OpArgs, OpName } from './args-ops.js';
export type { DiffContractArgs } from './args-diff-contract.js';
export type { LintArgs } from './args-lint.js';
export type { MockArgs, MockCheckArgs } from './args-mock.js';
export type { MockRecordArgs } from './args-mock-record.js';
export type { ScriptsConvertArgs } from './args-scripts.js';
export type { SshForwardArgs } from './args-ssh.js';
export type { FeatureArgs } from './features.js';

/** `wirebench <verb> --help` for every verb that has its own help. */
export const HELP_TOPICS: Readonly<Record<string, string>> = {
  ...VERB_HELP,
  'diff-contract': DIFF_CONTRACT_HELP,
  lint: LINT_HELP,
  mock: `${MOCK_HELP}\n\n${MOCK_CHECK_HELP}\n\n${MOCK_RECORD_HELP}`,
  scripts: SCRIPTS_HELP,
  ssh: SSH_HELP,
};

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
    --data <file>      CSV (header row) or JSON (array of objects): one iteration per row, each
                       column read as \${#Data#column}. Relative to the working directory.
    --iterations <n>   Iterations to run (1-10000). Default: the data file's rows, else 1.
    --data-overrun <mode>
                       stop | wrap | repeat-last: when --iterations exceeds the rows. Default: stop.
    --delay <ms>       Wait between requests (and sequence steps), across iterations.

-e, --env <name>       Environment by name or slug. Required when the target defines any.
    --refuse-protected Exit 2 before sending when the environment is protected; without it a
                       protected environment is only warned about.
    --var <k=v>        Override an environment property for this run. Repeatable.
    --reporter <spec>  cli | junit=<file> | json=<file> | html=<file>. Repeatable. Default: cli.
    --bail             Stop at the first failed or errored request; the rest are skipped, and so
                       are every later iteration.
    --timeout <ms>     Per-request timeout override.
    --sla <ms>         Default response-time ceiling for requests that declare none.
    --require-assertions  A request without assertions is an error.
    --baseline         Compare each response with its committed golden (<slug>.golden.yaml).
    --require-baseline With --baseline: a request without a golden is an error.
    --update-baseline  Save each changed response as its golden, keeping its ignore rules.
                       The only flag that writes to the project.
    --insecure         Skip TLS verification (as the desktop's per-environment switch).
    --allow-commands   Let MCP servers run their local (stdio) commands; without it each one is
                       refused. Sequence steps included.
    --no-secret-sources   Read secrets from WIREBENCH_SECRET_<NAME> only; skip the workspace's
                          secret sources.
    --trust-secret-sources
                          Use the workspace's shared secret sources as they are.
    --trust-secret-sources-hash <hash>
                          Use them only if the mapping's hash is <hash> (secrets list prints it).
    --no-color
-q, --quiet | -v, --verbose

Every verb: --features <id=on|off,…>
                       Switch features off (or back on) for this process: soap, rest, grpc, websocket,
                       mcp, graphql, scripts, sequences, webhooks, server-sync, team-secrets,
                       mcp-server. Laid over WIREBENCH_FEATURES, which takes the same list. A request
                       of a kind that is off errors with feature-disabled; a verb that needs an off
                       feature exits 2.

wirebench secrets list <path> [selector… | --sequence <name>…] [-e <name>] [--var <k=v>…]
                       Prints every secret the selection needs: variable name, where it is used,
                       whether it is set. Exit 0 when all are set, 3 when one is missing. Never
                       prints a value. --var as for run, so a token only a --var holds is listed.
                       Also shows where each secret comes from, and prints the
                       secret-sources hash.

${OPS_HELP_TEXT}

${DIFF_CONTRACT_USAGE}
                       Compares two versions of a WSDL or an OpenAPI document (files, URLs or
                       project:<name>) and classifies each change breaking or compatible. Exit 1
                       when the --fail-on gate fails (default: any breaking change).

${LINT_USAGE}
                       Checks an OpenAPI 2.0-3.2 document against the built-in hygiene and OWASP
                       rule sets and the project's lint/ rule sets. Exit 1 when a finding is at the
                       --fail-severity level or worse (default: error).

wirebench mock <path> [mock…] [--port <n>] [--host <addr>] [--json] [-q]
                       Serves the project's mocks until stopped (see wirebench mock --help).

wirebench mock check <path> [mock…] [--json]
                       Checks the mocks' stubs against the contract. Exit 1 when one does not conform.

${MOCK_RECORD_HELP}

${SCRIPTS_USAGE}
                       Rewrites the project's imported scripts to the typed API: prints a diff per
                       level, or with --write backs the originals up and saves (see
                       wirebench scripts --help).

wirebench ssh forward <host> [rule…] | --group <id> [--port <rule>=<n>]… [--host-key SHA256:<b64>]…
                       [--json] [-q]
                       Opens a host's port forwarding rules, or a forwarding group's, from hosts.yaml
                       until stopped (see wirebench ssh --help).

wirebench --version | --help
wirebench <verb> --help`;

/** `cli`, or a registered reporter's id and the file it writes (phase 7 spec §3.2). */
export type ReporterSpec =
  { readonly kind: 'cli' } | { readonly kind: 'file'; readonly reporter: string; readonly file: string };

export interface RunArgs extends RunDataArgs {
  readonly command: 'run';
  readonly path: string;
  readonly selectors: readonly string[];
  /** `--sequence` names; when any are given the run is of those sequences, not of requests. */
  readonly sequences: readonly string[];
  readonly env?: string;
  /** `--refuse-protected`: a protected environment is a usage error, not a warning. */
  readonly refuseProtected: boolean;
  readonly vars: Readonly<Record<string, string>>;
  readonly reporters: readonly ReporterSpec[];
  readonly bail: boolean;
  readonly timeoutMs?: number;
  readonly slaMs?: number;
  readonly requireAssertions: boolean;
  readonly baseline: boolean;
  readonly requireBaseline: boolean;
  readonly updateBaseline: boolean;
  readonly insecure: boolean;
  /** `--allow-commands`: MCP stdio servers may start their commands (#79). */
  readonly allowCommands: boolean;
  readonly secretSources: CliSecretSourcesOptions;
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
  readonly secretSources: CliSecretSourcesOptions;
}

/** What `parseCliArgs` returns: one verb's arguments, plus the options every verb takes. */
export type ParsedArgs = VerbArgs & FeatureArgs;

type VerbArgs =
  | RunArgs
  | SecretsListArgs
  | OpArgs
  | McpArgs
  | CallArgs
  | ExportArgs
  | DiffContractArgs
  | LintArgs
  | MockArgs
  | MockCheckArgs
  | MockRecordArgs
  | SshForwardArgs
  | ScriptsConvertArgs
  | { readonly command: 'help'; readonly topic?: string }
  | { readonly command: 'version' };

/** A reporter id as the registry spells one: `junit`, or a plugin's `<plugin>/<reporter>`. */
const REPORTER_ID = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?$/;

/** The verbs `--allow-commands` applies to: those that send saved MCP requests (#79). */
const COMMAND_VERBS: ReadonlySet<string> = new Set(['run', 'send', 'mcp']);

/** Parses `--reporter <spec>`, one of `cli` or `<kind>=<file>`. */
function parseReporter(spec: string): ReporterSpec {
  if (spec === 'cli') {
    return { kind: 'cli' };
  }
  const eq = spec.indexOf('=');
  if (eq === -1) {
    throw new UsageError(`--reporter must be "cli" or "<kind>=<file>", got "${spec}"`);
  }
  const reporter = spec.slice(0, eq);
  const file = spec.slice(eq + 1);
  if (!REPORTER_ID.test(reporter) || file.length === 0) {
    throw new UsageError(`--reporter must be "cli" or "<kind>=<file>", got "${spec}"`);
  }
  // Whether the id names a reporter is the registry's to say, once the verb has built it.
  return { kind: 'file', reporter, file };
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

/** `--fail-on` belongs to `diff-contract` alone. */
function refuseDiffOnly(values: { readonly 'fail-on'?: string | undefined }, verb: string): void {
  if (values['fail-on'] !== undefined) {
    throw new UsageError(`--fail-on does not apply to ${verb}`);
  }
}

/** Parses `process.argv.slice(2)` into a {@link ParsedArgs}, or throws {@link UsageError}. */
export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  if (argv[0] === 'ssh') {
    return parseSsh(argv.slice(1));
  }
  const { values, positionals } = parseShared(argv);
  const verb = parseVerb(values, positionals);
  // Added only when given, so a verb's arguments read exactly as they did without the flag.
  return typeof values.features === 'string' ? { ...verb, features: values.features } : verb;
}

/** `--features`, on every verb (feature switches spec §5.1). */
const FEATURE_OPTIONS = { features: { type: 'string' } } as const;

/** The options every verb but `ssh` parses with; each verb refuses the ones that are not its own. */
const SHARED_OPTIONS = {
  env: { type: 'string', short: 'e' },
  'refuse-protected': { type: 'boolean' },
  sequence: { type: 'string', multiple: true },
  var: { type: 'string', multiple: true },
  reporter: { type: 'string', multiple: true },
  bail: { type: 'boolean' },
  timeout: { type: 'string' },
  sla: { type: 'string' },
  'require-assertions': { type: 'boolean' },
  baseline: { type: 'boolean' },
  'require-baseline': { type: 'boolean' },
  'update-baseline': { type: 'boolean' },
  insecure: { type: 'boolean' },
  'allow-commands': { type: 'boolean' },
  'no-secret-sources': { type: 'boolean' },
  'trust-secret-sources': { type: 'boolean' },
  'trust-secret-sources-hash': { type: 'string' },
  'no-color': { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  verbose: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  'fail-on': { type: 'string' },
  ...DATA_OPTIONS,
  ...OP_OPTIONS,
  ...MOCK_RECORD_OPTIONS,
  ...LINT_OPTIONS,
  ...SCRIPTS_OPTIONS,
  ...FEATURE_OPTIONS,
} as const;

type SharedParse = ReturnType<
  typeof parseArgs<{ args: string[]; allowPositionals: true; strict: true; options: typeof SHARED_OPTIONS }>
>;

/** The one `parseArgs` call every verb but `ssh` shares. */
function parseShared(argv: readonly string[]): SharedParse {
  try {
    return parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: SHARED_OPTIONS });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new UsageError(error.message);
    }
    throw error;
  }
}

/** One verb from the shared parse; `UsageError` for anything that is not a verb's call. */
function parseVerb(values: SharedParse['values'], positionals: readonly string[]): VerbArgs {
  if (values.help) {
    const [topic] = positionals;
    return topic !== undefined && Object.hasOwn(HELP_TOPICS, topic) ? { command: 'help', topic } : { command: 'help' };
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

  /** How a refusal names the verb: the subcommand too, for the verbs that have one. */
  const verb = `wirebench ${word === 'secrets' ? 'secrets list' : word === 'scripts' ? 'scripts convert' : word}`;

  if (word !== 'run') {
    refuseRunDataOnly(values, verb);
  }

  // Only what sends MCP requests takes it; every other verb refuses it rather than ignore it.
  if (values['allow-commands'] !== undefined && !COMMAND_VERBS.has(word)) {
    throw new UsageError(`--allow-commands does not apply to ${verb}`);
  }

  if (word !== 'lint') {
    refuseLintOnly(values, verb);
  }

  if (word !== 'scripts') {
    refuseScriptsOnly(values, verb);
  }

  if (word === 'mock') {
    refuseDiffOnly(values, 'wirebench mock');
    // `mock record …` records (#60), `mock check …` checks stubs (#325); any other `mock <path> …` serves (#61).
    if (rest[0] === 'check') return parseMockCheck(rest, values);
    return rest[0] === 'record' ? parseMock(rest, values) : parseMockServe(rest, values);
  }
  refuseMockRecordOnly(values, `wirebench ${word}`);

  if (word === 'run') {
    refuseOpOnly(values, 'wirebench run');
    refuseDiffOnly(values, 'wirebench run');
    const [path, ...selectors] = rest;
    if (path === undefined) {
      throw new UsageError('wirebench run <path> [selector…] [options]: <path> is required');
    }
    refuseMixed(selectors);
    const baseline = values.baseline ?? false;
    const requireBaseline = values['require-baseline'] ?? false;
    const updateBaseline = values['update-baseline'] ?? false;
    if (updateBaseline && (baseline || requireBaseline)) {
      throw new UsageError('--update-baseline cannot be combined with --baseline or --require-baseline');
    }
    if (updateBaseline && sequences.length > 0) {
      throw new UsageError('--update-baseline cannot be combined with --sequence: sequence steps have no golden');
    }
    if (requireBaseline && !baseline) {
      throw new UsageError('--require-baseline needs --baseline');
    }
    if (baseline && sequences.length > 0) {
      throw new UsageError('--baseline cannot be combined with --sequence: sequence steps are not compared');
    }
    const data = parseRunData(values, baseline || updateBaseline);
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
      refuseProtected: values['refuse-protected'] ?? false,
      vars,
      reporters,
      bail: values.bail ?? false,
      ...(values.timeout !== undefined ? { timeoutMs: parsePositiveInt(values.timeout, 'timeout') } : {}),
      ...(values.sla !== undefined ? { slaMs: parsePositiveInt(values.sla, 'sla') } : {}),
      requireAssertions: values['require-assertions'] ?? false,
      baseline,
      requireBaseline,
      updateBaseline,
      insecure: values.insecure ?? false,
      allowCommands: values['allow-commands'] ?? false,
      secretSources: secretSourcesOptionsFrom(values),
      color: !values['no-color'],
      quiet: values.quiet ?? false,
      verbose: values.verbose ?? false,
      ...data,
    };
  }

  if (word === 'secrets') {
    refuseOpOnly(values, 'wirebench secrets list');
    refuseDiffOnly(values, 'wirebench secrets list');
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
      secretSources: secretSourcesOptionsFrom(values),
    };
  }

  if (word === 'scripts') {
    return parseScripts(rest, values);
  }

  if (word === 'call') {
    return parseCall(rest, values);
  }

  if (word === 'diff-contract') {
    return parseDiffContract(rest, values);
  }

  if (word === 'lint') {
    return parseLint(rest, values);
  }

  if (word === 'mcp') {
    return parseMcp(rest, values);
  }

  if (word === 'export') {
    return parseExport(rest, values);
  }

  if (isOpVerb(word)) {
    return parseOpVerb(word, rest, values);
  }

  throw new UsageError(`unknown command "${word}"`);
}
