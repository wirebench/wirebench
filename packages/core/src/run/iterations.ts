/**
 * Which iterations a data-driven run makes, and which data row each one reads (#336, spec §2).
 */
import { WirebenchError } from '../errors.js';

/** What a run does when it is asked for more iterations than the data file has rows. */
export type DataOverrun = 'stop' | 'wrap' | 'repeat-last';

export const DATA_OVERRUNS: readonly DataOverrun[] = ['stop', 'wrap', 'repeat-last'];

/** The most iterations one run makes. */
export const MAX_ITERATIONS = 10_000;

/** One iteration of a run: its 0-based index, how many the run plans, and the data row it reads. */
export interface Iteration {
  readonly index: number;
  readonly count: number;
  readonly row?: { readonly index: number; readonly values: Readonly<Record<string, string>> };
}

export interface IterationPlanInput {
  /** The data file's rows; absent for a run without one. */
  readonly rows?: readonly Readonly<Record<string, string>>[];
  /** Iterations asked for; absent: one per row, or one without data. */
  readonly iterations?: number;
  readonly overrun?: DataOverrun;
}

/**
 * The iterations a run makes, in order.
 *
 * @throws WirebenchError `iterations-invalid` for a count outside 1–{@link MAX_ITERATIONS}
 */
export function planIterations(input: IterationPlanInput): Iteration[] {
  const { rows, iterations } = input;
  if (iterations !== undefined && (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS)) {
    throw new WirebenchError('iterations-invalid', `Iterations must be a whole number from 1 to ${MAX_ITERATIONS}`);
  }
  if (rows === undefined || rows.length === 0) {
    const count = iterations ?? 1;
    return Array.from({ length: count }, (_, index) => ({ index, count }));
  }
  const asked = Math.min(iterations ?? rows.length, MAX_ITERATIONS);
  const overrun = input.overrun ?? 'stop';
  const count = overrun === 'stop' ? Math.min(asked, rows.length) : asked;
  return Array.from({ length: count }, (_, index) => {
    const rowIndex = overrun === 'wrap' ? index % rows.length : Math.min(index, rows.length - 1);
    return { index, count, row: { index: rowIndex, values: rows[rowIndex]! } };
  });
}
