/**
 * The op verbs (spec §5): `import`, `operations`, `generate`, `send`, `validate`, `query` and
 * `history list|diff`. Each becomes an {@link OpArgs}: the op's name and its input, which the op's
 * own zod schema checks when it runs, so the flags here only carry values.
 */
import { UsageError } from './usage-error.js';

export type OpName =
  'import' | 'operations' | 'generate' | 'send' | 'validate' | 'query' | 'history_list' | 'history_diff';

export interface OpArgs {
  readonly command: 'op';
  readonly op: OpName;
  /** `--project`, as typed; `.` when absent. */
  readonly project: string;
  readonly historyDir?: string;
  readonly json: boolean;
  readonly input: Readonly<Record<string, unknown>>;
  /** `validate`/`query`: a History id or a file, told apart when run (an existing file wins). */
  readonly source?: string;
  /** `send --body-file`, read when run. */
  readonly bodyFile?: string;
}

/** The options the verbs add to the shared `parseArgs` call. */
export const OP_OPTIONS = {
  project: { type: 'string' },
  json: { type: 'boolean' },
  name: { type: 'string' },
  optional: { type: 'string' },
  body: { type: 'string' },
  'body-file': { type: 'string' },
  operation: { type: 'string' },
  direction: { type: 'string' },
  status: { type: 'string' },
  namespace: { type: 'string', multiple: true },
  item: { type: 'string' },
  limit: { type: 'string' },
  ignore: { type: 'string', multiple: true },
  'history-dir': { type: 'string' },
} as const;

export type OptionValues = Readonly<Record<string, string | boolean | readonly string[] | undefined>>;

const USAGE: Readonly<Record<OpName, string>> = {
  import: 'wirebench import <source> [--name <name>]',
  operations: 'wirebench operations [<interface-or-api>]',
  generate: 'wirebench generate <operation> [--optional all|required]',
  send: 'wirebench send <item> [-e <env>] [--body <text> | --body-file <file>]',
  validate: 'wirebench validate <history-id|file> [--operation <ref>] [--direction request|response] [--status <n>]',
  query: 'wirebench query <expression> <history-id|file> [--namespace <prefix>=<uri>]… [--direction request|response]',
  history_list: 'wirebench history list [--item <text>] [--limit <n>]',
  history_diff: 'wirebench history diff <from-id> <to-id> [--ignore <path>]…',
};

/**
 * The options only the op verbs take. `run` and `secrets list` refuse exactly these: every other
 * registered option (`--no-color`, `-q`, `--bail`, …) they accepted before the verbs existed, and
 * still accept and ignore.
 */
const OP_ONLY_FLAGS: readonly string[] = Object.keys(OP_OPTIONS);

const COMMON = ['project', 'json'] as const;

const VERB_FLAGS: Readonly<Record<OpName, readonly string[]>> = {
  import: [...COMMON, 'name'],
  operations: COMMON,
  generate: [...COMMON, 'optional'],
  send: [...COMMON, 'env', 'body', 'body-file', 'history-dir'],
  validate: [...COMMON, 'operation', 'direction', 'status', 'history-dir'],
  query: [...COMMON, 'namespace', 'direction', 'history-dir'],
  history_list: [...COMMON, 'item', 'limit', 'history-dir'],
  history_diff: [...COMMON, 'ignore', 'history-dir'],
};

export const OPS_HELP_TEXT = `wirebench import <source> [--name <name>] [--project <dir>]
                       Adds a WSDL or OpenAPI document (a file or an http(s) URL) to the project.
wirebench operations [<interface-or-api>] [--project <dir>]
                       Lists SOAP operations and REST endpoints, with the references generate and
                       validate take and the saved requests send takes.
wirebench generate <operation> [--optional all|required] [--project <dir>]
                       Prints a sample request: a SOAP envelope, or a REST method, path and JSON body.
wirebench send <item> [-e <env>] [--body <text> | --body-file <file>] [--project <dir>]
                       Sends a saved SOAP or REST request as run does, prints the response and the
                       assertion results, and records it in the desktop's History.
wirebench validate <history-id|file> [--operation <ref>] [--direction request|response] [--status <n>]
                       Validates a message against the WSDL schema or the OpenAPI response schema. The
                       source is a file when one exists at that path, else a History id.
wirebench query <expression> <history-id|file> [--namespace <prefix>=<uri>]… [--direction …]
                       XPath 3.1 on XML, JSONPath on JSON; prints each result on its own line. The
                       source is a file when one exists at that path, else a History id.
wirebench history list [--item <text>] [--limit <n>] | history diff <from-id> <to-id> [--ignore <path>]…
                       The desktop's History for the project: recent sends, or a semantic diff of two
                       responses.
                       Every verb: --project <dir> (default: the current directory), --json (the result
                       exactly), --history-dir <dir> (default: the desktop's History folder).
                       Exit 0; 1 for a failed assertion or an invalid message; 2 for a refused call;
                       3 for a run error.`;

/** `wirebench <verb> --help`. */
export const VERB_HELP: Readonly<Record<string, string>> = {
  import: `${USAGE.import} [--project <dir>] [--json]

Adds a WSDL or an OpenAPI document to the project, as the desktop's import does: its definition is
cached when the project caches definitions, and each operation gets a Request 1.`,
  operations: `${USAGE.operations} [--project <dir>] [--json]

Lists the project's SOAP operations (interface, binding, operation, SOAP action) and REST endpoints
(API, method, path, operationId), each with its reference and its saved requests.`,
  generate: `${USAGE.generate} [--project <dir>] [--json]

<operation>            Interface/Operation, API/operationId, API/METHOD /path, or a saved request path.
--optional             all: include optional elements and properties. required (default): only
                       required ones.`,
  send: `${USAGE.send} [--project <dir>] [--history-dir <dir>] [--json]

<item>                 A saved request path as operations lists it, or its name when only one has it.
-e, --env <name>       The environment; required when the project defines any.
--body, --body-file    Send this envelope or body instead of the saved one. Nothing is saved.
Secrets come from WIREBENCH_SECRET_<NAME> variables, as for run. Exit 1 when an assertion failed.`,
  validate: `${USAGE.validate} [--project <dir>] [--history-dir <dir>] [--json]

<history-id|file>      A file when one exists at that path, else a History id.
--operation <ref>      Required unless the History entry is a send of a saved request.
--status <n>           REST: the status whose response schema applies (default: the entry's, or 200).
Exit 1 when the message is invalid.`,
  query: `${USAGE.query} [--project <dir>] [--history-dir <dir>] [--json]

<history-id|file>      A file when one exists at that path, else a History id.
XML gets XPath 3.1, with the document's own prefixes; JSON gets JSONPath.`,
  history: `${USAGE.history_list} [--project <dir>] [--history-dir <dir>] [--json]
${USAGE.history_diff} [--project <dir>] [--history-dir <dir>] [--json]

list                   Newest first; --item filters on the item path, --limit is 1 to 200 (default 20).
diff                   The semantic XML or JSON diff of two responses; --ignore leaves a path out.`,
};

const VERBS: ReadonlySet<string> = new Set([
  'import',
  'operations',
  'generate',
  'send',
  'validate',
  'query',
  'history',
]);

export function isOpVerb(word: string): boolean {
  return VERBS.has(word);
}

/** Every option given that `allowed` does not list is a usage error, not a silent no-op. */
export function refuseForeign(values: OptionValues, allowed: readonly string[], verb: string): void {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && key !== 'help' && key !== 'version' && !allowed.includes(key)) {
      throw new UsageError(`--${key} does not apply to ${verb}`);
    }
  }
}

/** `run` and `secrets list`: an op-only option is a usage error; the rest parse as they always did. */
export function refuseOpOnly(values: OptionValues, verb: string): void {
  for (const key of OP_ONLY_FLAGS) {
    if (values[key] !== undefined) {
      throw new UsageError(`--${key} does not apply to ${verb}`);
    }
  }
}

function str(values: OptionValues, key: string): string | undefined {
  const value = values[key];
  return typeof value === 'string' ? value : undefined;
}

function strings(values: OptionValues, key: string): readonly string[] {
  const value = values[key];
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

function opt(key: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}

function integer(values: OptionValues, key: string): number | undefined {
  const raw = str(values, key);
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new UsageError(`--${key} must be an integer, got "${raw}"`);
  }
  return n;
}

function namespaces(specs: readonly string[]): Record<string, string> | undefined {
  if (specs.length === 0) {
    return undefined;
  }
  const map: Record<string, string> = {};
  for (const spec of specs) {
    const eq = spec.indexOf('=');
    if (eq <= 0) {
      throw new UsageError(`--namespace must be "<prefix>=<uri>", got "${spec}"`);
    }
    map[spec.slice(0, eq)] = spec.slice(eq + 1);
  }
  return map;
}

function usage(op: OpName): UsageError {
  return new UsageError(`usage: ${USAGE[op]}`);
}

function one(op: OpName, args: readonly string[]): string {
  const [first] = args;
  if (first === undefined || args.length !== 1) {
    throw usage(op);
  }
  return first;
}

function two(op: OpName, args: readonly string[]): readonly [string, string] {
  const [first, second] = args;
  if (first === undefined || second === undefined || args.length !== 2) {
    throw usage(op);
  }
  return [first, second];
}

function opOf(word: string, rest: readonly string[]): { readonly op: OpName; readonly args: readonly string[] } {
  if (word !== 'history') {
    return { op: word as OpName, args: rest };
  }
  const [sub, ...args] = rest;
  if (sub === 'list') {
    return { op: 'history_list', args };
  }
  if (sub === 'diff') {
    return { op: 'history_diff', args };
  }
  throw new UsageError(`wirebench history list | diff: unknown subcommand "${sub ?? ''}"`);
}

/** @throws UsageError */
export function parseOpVerb(word: string, rest: readonly string[], values: OptionValues): OpArgs {
  const { op, args } = opOf(word, rest);
  refuseForeign(
    values,
    VERB_FLAGS[op],
    word === 'history' ? `wirebench history ${rest[0] ?? ''}` : `wirebench ${word}`,
  );
  const historyDir = str(values, 'history-dir');
  const common = {
    command: 'op' as const,
    op,
    project: str(values, 'project') ?? '.',
    ...(historyDir !== undefined ? { historyDir } : {}),
    json: values['json'] === true,
  };
  const direction = opt('direction', str(values, 'direction'));
  switch (op) {
    case 'import':
      return { ...common, input: { source: one(op, args), ...opt('name', str(values, 'name')) } };
    case 'operations': {
      if (args.length > 1) {
        throw usage(op);
      }
      return { ...common, input: opt('container', args[0]) };
    }
    case 'generate':
      return { ...common, input: { operation: one(op, args), ...opt('optional', str(values, 'optional')) } };
    case 'send': {
      const body = str(values, 'body');
      const bodyFile = str(values, 'body-file');
      if (body !== undefined && bodyFile !== undefined) {
        throw new UsageError('--body and --body-file cannot be combined');
      }
      return {
        ...common,
        input: { item: one(op, args), ...opt('environment', str(values, 'env')), ...opt('body', body) },
        ...(bodyFile !== undefined ? { bodyFile } : {}),
      };
    }
    case 'validate':
      return {
        ...common,
        source: one(op, args),
        input: {
          ...opt('operation', str(values, 'operation')),
          ...direction,
          ...opt('status', integer(values, 'status')),
        },
      };
    case 'query': {
      const [expression, source] = two(op, args);
      return {
        ...common,
        source,
        input: { expression, ...opt('namespaces', namespaces(strings(values, 'namespace'))), ...direction },
      };
    }
    case 'history_list': {
      if (args.length > 0) {
        throw usage(op);
      }
      return { ...common, input: { ...opt('item', str(values, 'item')), ...opt('limit', integer(values, 'limit')) } };
    }
    case 'history_diff': {
      const [from, to] = two(op, args);
      const ignore = strings(values, 'ignore');
      return { ...common, input: { from, to, ...(ignore.length > 0 ? { ignore } : {}) } };
    }
  }
}
