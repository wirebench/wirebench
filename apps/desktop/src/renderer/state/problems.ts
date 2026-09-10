import { create } from 'zustand';
import type { ImportProblemWire } from '../../shared/wire-types.js';

/**
 * Where a problem came from: importing a definition, expanding properties before a send, or
 * the send itself failing at the transport level (a timeout, a refused connection, …).
 */
export type ProblemSource = 'import' | 'expansion' | 'send';

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
}

/** One problem shown in the (minimal, pre-Task-42) Problems view, tagged with where it came from. */
export interface Problem {
  /** A grouping key (e.g. the interface id) so a re-import replaces only its own entries. */
  readonly groupId: string;
  readonly source: ProblemSource;
  readonly severity: ProblemSeverity;
  /** Set for problems that belong to one request, so a send can clear just its own. */
  readonly requestId?: string;
  readonly problem: ProblemDetail;
}

/** The problems store: a flat list, grouped by `groupId` so a re-import replaces its own entries. */
export interface ProblemsStore {
  readonly items: Problem[];
  /** Replaces the `import` problems of one group (an interface id). */
  readonly set: (groupId: string, items: readonly ImportProblemWire[]) => void;
  /** Appends problems. Callers clear what they own first — see {@link ProblemsStore.clearSource}. */
  readonly add: (items: readonly Problem[]) => void;
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
