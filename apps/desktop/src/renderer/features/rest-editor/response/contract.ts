/**
 * The renderer half of a REST response's contract check: the chip's wording, the Problems rows,
 * and the reveal a row asks for.
 *
 * The check itself ran in main (see `RestContractResultWire`); what arrives here is a status, the
 * operation and response key it used, and problems as JSON Pointers. A pointer is only turned into
 * a text range by the body view, against the text it is actually showing — the same response reads
 * differently pretty-printed and raw, so a range fixed here would be wrong in one of them.
 */
import { create } from 'zustand';
import type { RestContractResultWire } from '../../../../shared/wire-types.js';
import { useProblemsStore } from '../../../state/problems.js';
import { openRestRequestTab } from '../rest-actions.js';

/** How the chip reads: its tone picks the colour, and the text alone still says it all. */
export type ContractTone = 'success' | 'warning' | 'muted';

export interface ContractChipView {
  readonly label: string;
  readonly tone: ContractTone;
}

/** The chip for one result, or `undefined` when there was no contract to check against at all. */
export function contractChip(result: RestContractResultWire): ContractChipView | undefined {
  switch (result.status) {
    case 'ok':
      return { label: 'Contract ✓', tone: 'success' };
    case 'violation': {
      const count = result.problems.length;
      return { label: `Contract: ${String(count)} problem${count === 1 ? '' : 's'}`, tone: 'warning' };
    }
    case 'unmatched':
      return { label: 'Unexpected status', tone: 'warning' };
    case 'no-schema':
      return { label: 'No schema', tone: 'muted' };
    case 'not-checked':
      return { label: 'Not checked', tone: 'muted' };
    case 'skipped':
      return { label: 'Skipped', tone: 'muted' };
    case 'no-contract':
      return undefined;
  }
}

/** `GET /pets/{id} → 200 (application/json)`, then each note on a line of its own. */
export function contractTooltip(result: RestContractResultWire): string {
  const lines: string[] = [];
  if (result.operation !== undefined) {
    const target = result.responseKey === undefined ? '' : ` → ${result.responseKey}`;
    const media = result.mediaType === undefined ? '' : ` (${result.mediaType})`;
    lines.push(`${result.operation.method.toUpperCase()} ${result.operation.path}${target}${media}`);
  }
  lines.push(...result.notes);
  return lines.join('\n');
}

/** The Problems group one request's contract result owns; a new send replaces exactly it. */
export function contractGroupId(requestId: string): string {
  return `contract:${requestId}:response`;
}

/**
 * Files a result's problems under the request's group, replacing the last send's. A result with
 * no problems (or none at all) simply clears the group.
 */
export function recordContractProblems(requestId: string, result: RestContractResultWire | undefined): void {
  const groupId = contractGroupId(requestId);
  const store = useProblemsStore.getState();
  store.clear(groupId);
  const problems = result?.problems ?? [];
  if (problems.length === 0) {
    return;
  }
  store.add(
    problems.map((problem) => ({
      groupId,
      source: 'contract' as const,
      severity: 'warning' as const,
      requestId,
      direction: 'response' as const,
      problem: {
        code: problem.keyword,
        message: problem.message,
        source: 'openapi',
        // The pointer is the location: it is what the reveal maps onto the shown text.
        location: problem.path === '' ? '/' : problem.path,
      },
    })),
  );
}

/** A reveal waiting for the body view to pick it up. */
export interface PendingContractReveal {
  readonly requestId: string;
  readonly pointer: string;
  /** Distinguishes two reveals of the same pointer, so the second still moves the view. */
  readonly nonce: number;
}

interface ContractRevealStore {
  readonly pending: PendingContractReveal | undefined;
  readonly request: (requestId: string, pointer: string) => void;
  readonly settle: (nonce: number) => void;
}

let nextNonce = 1;

/**
 * The one reveal in flight. A store rather than a direct editor call: the tab may not be open,
 * the response pane may be on another tab and the body on another view, and each of those
 * switches only lands on a later render — so the body view takes the reveal once it is showing.
 */
export const useContractRevealStore = create<ContractRevealStore>((set, get) => ({
  pending: undefined,
  request: (requestId, pointer) => {
    set({ pending: { requestId, pointer, nonce: nextNonce++ } });
  },
  settle: (nonce) => {
    if (get().pending?.nonce === nonce) {
      set({ pending: undefined });
    }
  },
}));

/** Opens the request's tab and asks its body view to show where `pointer` points. */
export function revealContractProblem(requestId: string, pointer: string): void {
  openRestRequestTab(requestId);
  useContractRevealStore.getState().request(requestId, pointer === '/' ? '' : pointer);
}
