import { create } from 'zustand';
import type { LintFindingWire } from '../../shared/kinds/rest/wire.js';
import type { ImportProblemWire, ValidationProblemWire } from '../../shared/kinds/soap/wire.js';

/**
 * Where a problem came from: importing a definition, expanding properties before a send, the
 * send itself failing at the transport level (a timeout, a refused connection, …), or
 * validating a message against its schema set (`validate.message`), checking a REST response
 * against its OpenAPI contract (`contract`, whose `location` is a JSON Pointer), a certificate
 * the workspace relies on nearing or past its expiry (`certificate`, whose `location` names the
 * endpoint or keystore; see `certificate-expiry.ts`), reading `hosts.yaml` (`hosts`, whose
 * `location` is the path of the offending key), reading `snippets.yaml` (`snippets`, likewise), a
 * mock stub the contract does not allow (`mock`, whose `location` says whether the status, a
 * header or the body is at fault), or linting a REST
 * API's cached definition (`lint`, whose `location` is a JSON Pointer into the document).
 */
export type ProblemSource =
  | 'import'
  | 'expansion'
  | 'send'
  | 'validation'
  | 'contract'
  | 'graphql'
  | 'certificate'
  | 'hosts'
  | 'snippets'
  | 'mock'
  | 'lint';

/** How badly a problem matters. Unresolved property references are warnings: the send still goes. */
export type ProblemSeverity = 'error' | 'warning';

/** The body of a problem — an {@link ImportProblemWire} is assignable to it. */
export interface ProblemDetail {
  readonly code: string;
  readonly message: string;
  /** The sub-source an import reported (`wsdl`, `schema`, …); absent for other sources. */
  readonly source?: string | undefined;
  readonly location?: string | undefined;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  readonly endLine?: number | undefined;
  readonly endColumn?: number | undefined;
}

/** Which half of an exchange a `validation` problem was found in; absent for every other source. */
export type ProblemDirection = 'request' | 'response';

/** One problem shown in the Problems view, tagged with where it came from. */
export interface Problem {
  /** A grouping key (e.g. the interface id) so a re-import replaces only its own entries. */
  readonly groupId: string;
  readonly source: ProblemSource;
  readonly severity: ProblemSeverity;
  /** Set for problems that belong to one request, so a send can clear just its own. */
  readonly requestId?: string;
  /** For a `validation` problem, which editor (request or response) its position belongs to. */
  readonly direction?: ProblemDirection;
  readonly problem: ProblemDetail;
}

/**
 * What the Problems view lists: every problem, one severity of them, or the lint findings alone.
 * Lint is its own list, never mixed in (#745): a definition's style findings are advice, and the
 * tab's badge and the status bar count problems without them.
 */
export type ProblemsFilter = 'all' | ProblemSeverity | 'lint';

/** The problems store: a flat list, grouped by `groupId` so a re-import replaces its own entries. */
export interface ProblemsStore {
  readonly items: Problem[];
  /** Which list the Problems view shows; not persisted. */
  readonly filter: ProblemsFilter;
  readonly setFilter: (filter: ProblemsFilter) => void;
  /** Replaces the `import` problems of one group (an interface id). */
  readonly set: (groupId: string, items: readonly ImportProblemWire[]) => void;
  /** Appends problems. Callers clear what they own first — see {@link ProblemsStore.clearSource}. */
  readonly add: (items: readonly Problem[]) => void;
  /**
   * Replaces the validation problems of one run. `groupId` is
   * `validation:<requestId>:<direction>`, so a request's two directions are validated (and
   * cleared) independently. `direction` is stamped on every entry so a click on the row knows
   * whether to reveal the position in the request or the response editor.
   */
  readonly setValidation: (
    groupId: string,
    requestId: string,
    direction: ProblemDirection,
    items: readonly ValidationProblemWire[],
  ) => void;
  /**
   * Replaces the lint findings of one REST API (group `lint:<apiId>`). An error stays an error;
   * warnings, infos and hints all show as warnings, the only other severity Problems has.
   */
  readonly setLint: (apiId: string, findings: readonly LintFindingWire[]) => void;
  /** Drops every problem of one group, whatever its source. */
  readonly clear: (groupId: string) => void;
  /** Drops every problem of one source, optionally narrowed to a single request. */
  readonly clearSource: (source: ProblemSource, requestId?: string) => void;
}

/** The Problems group a REST API's lint findings are filed under. */
export function lintGroupId(apiId: string): string {
  return `lint:${apiId}`;
}

export const useProblemsStore = create<ProblemsStore>((set, get) => ({
  items: [],
  filter: 'all',

  setFilter: (filter) => {
    set({ filter });
  },

  set: (groupId, items) => {
    const rest = get().items.filter((item) => item.groupId !== groupId);
    set({
      items: [
        ...rest,
        ...items.map((problem) => ({ groupId, source: 'import' as const, severity: 'error' as const, problem })),
      ],
    });
  },

  setValidation: (groupId, requestId, direction, items) => {
    const rest = get().items.filter((item) => item.groupId !== groupId);
    set({
      items: [
        ...rest,
        ...items.map((problem) => ({
          groupId,
          source: 'validation' as const,
          severity: problem.severity,
          requestId,
          direction,
          problem,
        })),
      ],
    });
  },

  setLint: (apiId, findings) => {
    const groupId = lintGroupId(apiId);
    const rest = get().items.filter((item) => item.groupId !== groupId);
    set({
      items: [
        ...rest,
        ...findings.map((finding) => ({
          groupId,
          source: 'lint' as const,
          severity: finding.severity === 'error' ? ('error' as const) : ('warning' as const),
          problem: {
            code: finding.rule,
            // The rule id is `code`, which Problems shows as secondary text beside the message.
            message: finding.message,
            source: 'lint',
            location: finding.path === '' ? '/' : finding.path,
            ...(finding.range !== undefined
              ? { line: finding.range.start.line, column: finding.range.start.column }
              : {}),
          },
        })),
      ],
    });
  },

  add: (items) => {
    set({ items: [...get().items, ...items] });
  },

  clear: (groupId) => {
    set({ items: get().items.filter((item) => item.groupId !== groupId) });
  },

  clearSource: (source, requestId) => {
    set({
      items: get().items.filter(
        (item) => item.source !== source || (requestId !== undefined && item.requestId !== requestId),
      ),
    });
  },
}));

/**
 * What the status bar counts. Lint findings are style advice on a definition, not something that
 * failed, so they are counted apart from the problems and never tint the Console or Problems
 * items; a failed SSH connect (grouped `ssh:<hostId>`) is not counted at all, since its
 * connection screen already says what failed.
 */
export interface ProblemCounts {
  /** Problems other than lint findings. */
  readonly problems: number;
  /** How many of {@link ProblemCounts.problems} are errors. */
  readonly errors: number;
  readonly lintErrors: number;
  readonly lintWarnings: number;
}

/** Whether a problem is a lint finding, which the Problems view lists apart and the counts leave out. */
export function isLintProblem(item: Problem): boolean {
  return item.source === 'lint';
}

/**
 * The problems the view lists under `filter`: lint findings alone, or everything else narrowed to
 * one severity. Failed SSH connects stay listed; only the counts leave them out.
 */
export function filterProblems(items: readonly Problem[], filter: ProblemsFilter): Problem[] {
  if (filter === 'lint') {
    return items.filter(isLintProblem);
  }
  return items.filter((item) => !isLintProblem(item) && (filter === 'all' || item.severity === filter));
}

export function countProblems(items: readonly Problem[]): ProblemCounts {
  let problems = 0;
  let errors = 0;
  let lintErrors = 0;
  let lintWarnings = 0;
  for (const item of items) {
    if (item.groupId.startsWith('ssh:')) continue;
    if (item.source === 'lint') {
      if (item.severity === 'error') lintErrors += 1;
      else lintWarnings += 1;
    } else {
      problems += 1;
      if (item.severity === 'error') errors += 1;
    }
  }
  return { problems, errors, lintErrors, lintWarnings };
}

/** `2 errors, 55 warnings`, leaving out a severity with none; empty when there are no findings. */
export function lintSummary(errors: number, warnings: number): string {
  const parts: string[] = [];
  if (errors > 0) parts.push(`${String(errors)} ${errors === 1 ? 'error' : 'errors'}`);
  if (warnings > 0) parts.push(`${String(warnings)} ${warnings === 1 ? 'warning' : 'warnings'}`);
  return parts.join(', ');
}
