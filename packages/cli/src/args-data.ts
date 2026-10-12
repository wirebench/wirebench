/**
 * `wirebench run`'s data-driven flags (#336): `--data`, `--iterations`, `--delay`, `--data-overrun`.
 */
import { DATA_OVERRUNS, MAX_ITERATIONS } from '@wirebench/engine';
import type { DataOverrun } from '@wirebench/engine';
import { UsageError } from './usage-error.js';

export const DATA_OPTIONS = {
  data: { type: 'string' },
  iterations: { type: 'string' },
  delay: { type: 'string' },
  'data-overrun': { type: 'string' },
} as const;

const DATA_FLAGS = Object.keys(DATA_OPTIONS) as readonly (keyof typeof DATA_OPTIONS)[];

type DataValues = { readonly [K in keyof typeof DATA_OPTIONS]?: string | undefined };

/** What a run reads of the four flags; a flag not given adds nothing. */
export interface RunDataArgs {
  /** The data file, relative to the working directory. */
  readonly data?: string;
  readonly iterations?: number;
  readonly delayMs?: number;
  readonly dataOverrun?: DataOverrun;
}

/** The four flags belong to `run` alone. */
export function refuseRunDataOnly(values: DataValues, verb: string): void {
  for (const flag of DATA_FLAGS) {
    if (values[flag] !== undefined) throw new UsageError(`--${flag} does not apply to ${verb}`);
  }
}

/**
 * Reads the flags of a `run`.
 *
 * @throws UsageError a bad count, delay or mode; `--data-overrun` without `--data`; data or
 *   iterations with a baseline flag (a golden is per request, not per row)
 */
export function parseRunData(values: DataValues, baselines: boolean): RunDataArgs {
  const { data, iterations, delay } = values;
  const overrun = values['data-overrun'];
  if (overrun !== undefined && data === undefined) throw new UsageError('--data-overrun needs --data');
  if (overrun !== undefined && !(DATA_OVERRUNS as readonly string[]).includes(overrun)) {
    throw new UsageError(`--data-overrun must be one of ${DATA_OVERRUNS.join(', ')}, got "${overrun}"`);
  }
  if (baselines && (data !== undefined || iterations !== undefined)) {
    throw new UsageError('--data and --iterations cannot be combined with --baseline or --update-baseline');
  }
  return {
    ...(data !== undefined ? { data } : {}),
    ...(iterations !== undefined ? { iterations: wholeNumber(iterations, 'iterations', 1, MAX_ITERATIONS) } : {}),
    ...(delay !== undefined ? { delayMs: wholeNumber(delay, 'delay', 0, 3_600_000) } : {}),
    ...(overrun !== undefined ? { dataOverrun: overrun as DataOverrun } : {}),
  };
}

function wholeNumber(raw: string, flag: string, min: number, max: number): number {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`--${flag} must be a whole number from ${min} to ${max}, got "${raw}"`);
  }
  return n;
}
