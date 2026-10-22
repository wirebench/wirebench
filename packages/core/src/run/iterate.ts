/**
 * Runs a data-driven run's iterations one after another and reports them as one run (#336, spec §5).
 *
 * Each iteration is a whole run of its own (`once`): its requests, or its sequences, with that
 * iteration's row as `${#Data#…}`. Values scripts set and sequence transfers start empty in every
 * iteration; the sender, and with it the cookie jar and OAuth2 tokens, is the run's.
 */
import type { RunContext } from './context.js';
import type { Iteration } from './iterations.js';
import type { RequestResult, RunResult } from './run.js';

export interface RunIterationsOptions {
  /** An iteration with a failed or errored request is the last one run. */
  readonly bail?: boolean;
  readonly signal?: AbortSignal;
}

/** True for a plain run: one iteration without data, which reports exactly as a run always has. */
const isPlain = (iteration: Iteration): boolean => iteration.count === 1 && iteration.row === undefined;

/** `context` for one iteration: its row as the Data scope, and its number for scripts. */
export function iterationContext(context: RunContext, iteration: Iteration): RunContext {
  if (isPlain(iteration)) return context;
  return {
    ...context,
    ...(iteration.row !== undefined ? { data: iteration.row.values } : {}),
    iteration: { index: iteration.index, count: iteration.count },
  };
}

/**
 * `request` tagged with the iteration that sent it; a plain run's is returned as it is. `runIterations`
 * tags its merged result; a host that shows each request as it ends tags it with this.
 */
export function tagIteration(request: RequestResult, iteration: Iteration): RequestResult {
  if (isPlain(iteration)) return request;
  return {
    ...request,
    iteration: {
      index: iteration.index,
      count: iteration.count,
      ...(iteration.row !== undefined ? { row: iteration.row.index } : {}),
    },
  };
}

/**
 * Calls `once` for each planned iteration, in order, and merges what they report. Under `bail`, and
 * after an abort, the iterations after the one that stopped are neither run nor reported.
 */
export async function runIterations(
  plan: readonly Iteration[],
  once: (iteration: Iteration) => Promise<RunResult>,
  options: RunIterationsOptions = {},
): Promise<RunResult> {
  const [first] = plan;
  if (first !== undefined && plan.length === 1 && isPlain(first)) return once(first);
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const runs: { result: RunResult; iteration: Iteration }[] = [];
  for (const iteration of plan) {
    if (options.signal?.aborted === true) break;
    const result = await once(iteration);
    runs.push({ result, iteration });
    if (options.bail === true && (result.summary.failed > 0 || result.summary.errored > 0)) break;
  }
  const sum = (key: 'total' | 'passed' | 'failed' | 'errored' | 'skipped'): number =>
    runs.reduce((total, { result }) => total + result.summary[key], 0);
  const environment = runs[0]?.result.environment;
  return {
    startedAt,
    ...(environment !== undefined ? { environment } : {}),
    summary: {
      total: sum('total'),
      passed: sum('passed'),
      failed: sum('failed'),
      errored: sum('errored'),
      skipped: sum('skipped'),
      durationMs: Math.round(performance.now() - started),
      iterations: { planned: plan.length, run: runs.length },
    },
    requests: runs.flatMap(({ result, iteration }) =>
      result.requests.map((request) => tagIteration(request, iteration)),
    ),
  };
}

/** Waits between a run's sends: nothing before the first, the delay before each later one. */
export interface Pacer {
  readonly wait: () => Promise<void>;
}

/** A pacer for one run, across its iterations. An abort ends a wait at once. */
export function createPacer(delayMs: number | undefined, signal?: AbortSignal): Pacer {
  let first = true;
  return {
    wait: async () => {
      if (first) {
        first = false;
        return;
      }
      if (delayMs === undefined || delayMs <= 0 || signal?.aborted === true) return;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, delayMs);
        signal?.addEventListener('abort', done, { once: true });
      });
    },
  };
}
