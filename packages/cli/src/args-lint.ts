/**
 * `wirebench lint <definition>` (#342 spec §6): an OpenAPI document checked against the built-in
 * and project rule sets, the findings printed and written, and the exit code a CI gate reads.
 */
import { refuseForeign } from './args-ops.js';
import type { OptionValues } from './args-ops.js';
import { UsageError } from './usage-error.js';

export type FailSeverity = 'error' | 'warning' | 'info' | 'hint' | 'none';

export interface LintReporter {
  readonly kind: 'json' | 'sarif';
  readonly file: string;
}

export interface LintArgs {
  readonly command: 'lint';
  /** A file path, an http(s) URL, or `project:<name>`. */
  readonly definition: string;
  readonly failSeverity: FailSeverity;
  /** `--ruleset` files, applied after the project's `lint/` folder, in the order given. */
  readonly rulesets: readonly string[];
  readonly reporters: readonly LintReporter[];
  /** `--project <dir>`; absent means the current directory, when it is a project. */
  readonly project?: string;
  readonly allowRemoteRefs: boolean;
  readonly quiet: boolean;
}

/** The options only `lint` takes; the verbs that parse leniently refuse them. */
export const LINT_OPTIONS = {
  'fail-severity': { type: 'string' },
  ruleset: { type: 'string', multiple: true },
  'allow-remote-refs': { type: 'boolean' },
} as const;

const LINT_ONLY_FLAGS: readonly string[] = Object.keys(LINT_OPTIONS);

export const LINT_USAGE =
  'wirebench lint <definition> [--fail-severity <level>] [--ruleset <file>]… [--reporter json=<file>|sarif=<file>]… [--project <dir>] [--allow-remote-refs] [-q]';

export const LINT_HELP = `${LINT_USAGE}

Checks an OpenAPI 2.0, 3.0, 3.1 or 3.2 document against the built-in hygiene and OWASP rule sets
and the project's own rule sets, and prints one line per finding.

<definition>           A file, an http(s) URL, or project:<name> — the cached definition of the
                       project's REST API of that name or slug (no network access).
--fail-severity <lvl>  error (default) | warning | info | hint: exit 1 when a finding is at that
                       severity or worse. none: exit 0 whatever is found.
--ruleset <file>       A rule-set YAML file, applied after the project's lint/ folder. Repeatable.
--reporter <spec>      json=<file> | sarif=<file>. Repeatable.
--project <dir>        The project whose lint/ folder applies and that project:<name> reads
                       (default: the current directory, when it holds wirebench.yaml).
--allow-remote-refs    Follow $refs from a local document to http(s) URLs (never followed otherwise).
-q, --quiet            Print the counts only.
Exit 0 when the gate passes; 1 when it fails; 2 for a usage error, an unreadable file, a rule set
that is not valid or a document that is not OpenAPI 2.0-3.2; 3 when the document cannot be fetched
or parsed.`;

const FLAGS: readonly string[] = [...LINT_ONLY_FLAGS, 'reporter', 'project', 'quiet'];
const FAIL_SEVERITIES: readonly FailSeverity[] = ['error', 'warning', 'info', 'hint', 'none'];
const REPORTER_KINDS: readonly LintReporter['kind'][] = ['json', 'sarif'];

/** `run`, `secrets list` and `mock`: a lint-only option is a usage error. */
export function refuseLintOnly(values: OptionValues, verb: string): void {
  for (const key of LINT_ONLY_FLAGS) {
    if (values[key] !== undefined) {
      throw new UsageError(`--${key} does not apply to ${verb}`);
    }
  }
}

function parseReporter(spec: string): LintReporter {
  const eq = spec.indexOf('=');
  const kind = REPORTER_KINDS.find((candidate) => candidate === spec.slice(0, eq));
  const file = spec.slice(eq + 1);
  if (eq === -1 || kind === undefined || file.length === 0) {
    throw new UsageError(`--reporter must be json=<file> or sarif=<file>, got "${spec}"`);
  }
  return { kind, file };
}

export function parseLint(rest: readonly string[], values: OptionValues): LintArgs {
  refuseForeign(values, FLAGS, 'wirebench lint');
  const [definition, ...extra] = rest;
  if (definition === undefined || extra.length > 0) {
    throw new UsageError(`usage: ${LINT_USAGE}`);
  }
  const raw = values['fail-severity'];
  const failSeverity = raw === undefined ? 'error' : FAIL_SEVERITIES.find((candidate) => candidate === raw);
  if (failSeverity === undefined) {
    throw new UsageError(`--fail-severity must be error, warning, info, hint or none, got "${String(raw)}"`);
  }
  const rulesets = values['ruleset'];
  const reporters = values['reporter'];
  const project = values['project'];
  return {
    command: 'lint',
    definition,
    failSeverity,
    rulesets: Array.isArray(rulesets) ? (rulesets as readonly string[]) : [],
    reporters: Array.isArray(reporters) ? (reporters as readonly string[]).map(parseReporter) : [],
    ...(typeof project === 'string' ? { project } : {}),
    allowRemoteRefs: values['allow-remote-refs'] === true,
    quiet: values['quiet'] === true,
  };
}
