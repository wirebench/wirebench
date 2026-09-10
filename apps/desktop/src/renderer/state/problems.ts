import { create } from 'zustand';
import type { ImportProblemWire } from '../../shared/wire-types.js';

/** One problem shown in the (minimal, pre-Task-42) Problems view, tagged with where it came from. */
export interface Problem {
  /** A grouping key (e.g. the interface id) so a re-import replaces only its own entries. */
  readonly groupId: string;
  readonly problem: ImportProblemWire;
}

/** The problems store: a flat list, grouped by `groupId` so a re-import replaces its own entries. */
export interface ProblemsStore {
  readonly items: Problem[];
  readonly set: (groupId: string, items: readonly ImportProblemWire[]) => void;
  readonly clear: (groupId: string) => void;
}

export const useProblemsStore = create<ProblemsStore>((set, get) => ({
  items: [],

  set: (groupId, items) => {
    const rest = get().items.filter((item) => item.groupId !== groupId);
    set({ items: [...rest, ...items.map((problem) => ({ groupId, problem }))] });
  },

  clear: (groupId) => {
    set({ items: get().items.filter((item) => item.groupId !== groupId) });
  },
}));
