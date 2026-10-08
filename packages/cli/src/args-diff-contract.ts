/**
 * `wirebench diff-contract <old> <new>` (#56 spec §6): two versions of a WSDL or an OpenAPI document
 * compared, the report printed and written, and the exit code a CI gate reads.
 */
import { refuseForeign } from './args-ops.js';
import type { OptionValues } from './args-ops.js';
import { UsageError } from './usage-error.js';

export type FailOn = 'breaking' | 'any' | 'none';

export interface DiffContractReporter {
  readonly kind: 'markdown' | 'html' | 'json';
  readonly file: string;
}

export interface DiffContractArgs {
  readonly command: 'diff-contract';
  /** A file path, an http(s) URL, or `project:<name>`. */
  readonly old: string;
  readonly new: string;
  readonly failOn: FailOn;
  readonly reporters: readonly DiffContractReporter[];
  /** Where `project:<name>` sources are read from; `.` when absent. */
  readonly project: string;
  readonly quiet: boolean;
}

export const DIFF_CONTRACT_USAGE =
  'wirebench diff-contract <old> <new> [--fail-on breaking|any|none] [--reporter <kind>=<file>]… [--project <dir>] [-q]';

export const DIFF_CONTRACT_HELP = `${DIFF_CONTRACT_USAGE}

Compares two versions of a WSDL or of an OpenAPI document operation by operation, and classifies each
change breaking or compatible for an existing client.

<old>, <new>           A file, an http(s) URL, or project:<name> — the cached definition of the
                       project's interface or REST API of that name or slug (no network access).
--fail-on <when>       breaking (default): exit 1 when any change is breaking. any: exit 1 on any
                       change. none: exit 0 whatever changed.
--reporter <spec>      markdown=<file> | html=<file> | json=<file>. Repeatable.
--project <dir>        The project project:<name> reads (default: the current directory).
-q, --quiet            Print the counts only.
Exit 0 when the gate passes; 1 when it fails; 2 for a usage error, an unreadable file, a missing cache
or two different formats; 3 when a document cannot be fetched or parsed.`;

const FLAGS: readonly string[] = ['fail-on', 'reporter', 'project', 'quiet'];
const FAIL_ON: readonly FailOn[] = ['breaking', 'any', 'none'];
const REPORTER_KINDS: readonly DiffContractReporter['kind'][] = ['markdown', 'html', 'json'];

function parseReporter(spec: string): DiffContractReporter {
  const eq = spec.indexOf('=');
  const kind = spec.slice(0, eq);
  const file = spec.slice(eq + 1);
  const known = REPORTER_KINDS.find((candidate) => candidate === kind);
  if (eq === -1 || known === undefined || file.length === 0) {
    throw new UsageError(`--reporter must be markdown=<file>, html=<file> or json=<file>, got "${spec}"`);
  }
  return { kind: known, file };
}

export function parseDiffContract(rest: readonly string[], values: OptionValues): DiffContractArgs {
  refuseForeign(values, FLAGS, 'wirebench diff-contract');
  const [oldSource, newSource, ...extra] = rest;
  if (oldSource === undefined || newSource === undefined || extra.length > 0) {
    throw new UsageError(`usage: ${DIFF_CONTRACT_USAGE}`);
  }
  const rawFailOn = values['fail-on'];
  const failOn = rawFailOn === undefined ? 'breaking' : FAIL_ON.find((candidate) => candidate === rawFailOn);
  if (failOn === undefined) {
    throw new UsageError(`--fail-on must be breaking, any or none, got "${String(rawFailOn)}"`);
  }
  const reporterSpecs = values['reporter'];
  const project = values['project'];
  return {
    command: 'diff-contract',
    old: oldSource,
    new: newSource,
    failOn,
    reporters: Array.isArray(reporterSpecs) ? (reporterSpecs as readonly string[]).map(parseReporter) : [],
    project: typeof project === 'string' ? project : '.',
    quiet: values['quiet'] === true,
  };
}
