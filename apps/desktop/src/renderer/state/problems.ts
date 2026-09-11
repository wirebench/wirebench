import { create } from 'zustand';
import type { ImportProblemWire, ValidationProblemWire } from '../../shared/wire-types.js';

/**
 * Where a problem came from: importing a definition, expanding properties before a send, the
 * send itself failing at the transport level (a timeout, a refused connection, …), or
 * validating a message against its schema set (`validate.message`).
 */
export type ProblemSource = 'import' | 'expansion' | 'send' | 'validation';

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

/** The problems store: a flat list, grouped by `groupId` so a re-import replaces its own entries. */
export interface ProblemsStore {
  readonly items: Problem[];
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
  /** Drops every problem of one group, whatever its source. */
  readonly clear: (groupId: string) => void;
  /** Drops every problem of one source, optionally narrowed to a single request. */
  readonly clearSource: (source: ProblemSource, requestId?: string) => void;
}

export const useProblemsStore = create<ProblemsStore>((set, get) => ({
  items: [],

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
