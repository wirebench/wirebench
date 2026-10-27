/**
 * The Runner's constants (#336), free of zod so renderer code may import them eagerly (the renderer
 * CSP trap: `test/renderer-eager-imports.test.ts`). The wire shapes are in `runner-wire.ts`.
 */

/** What a run does when it has more iterations than data rows. */
export const RUNNER_OVERRUNS = ['stop', 'wrap', 'repeat-last'] as const;
export type RunnerOverrun = (typeof RUNNER_OVERRUNS)[number];

/** The settings a target starts with: a fresh object each time. */
export function defaultRunnerSettings(): {
  delayMs: number;
  overrun: RunnerOverrun;
  bail: boolean;
  order: string[];
  excluded: string[];
} {
  return { delayMs: 0, overrun: 'stop', bail: false, order: [], excluded: [] };
}

/** How many past runs of each target the history keeps. */
export const RUNNER_HISTORY_LIMIT = 20;
