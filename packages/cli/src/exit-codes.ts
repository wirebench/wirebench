import type { RunSummary } from '@wirebench/engine';

/** The process exit codes, fixed by the spec (§3.5). A pipeline branches on these. */
export const ExitCode = { Ok: 0, AssertionFailed: 1, Usage: 2, RunError: 3, Interrupted: 130 } as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Maps a finished run to the process exit code. An errored request outranks a failed assertion:
 * a pipeline that could not reach the service has learned nothing about the service.
 */
export function exitCodeFor(summary: Pick<RunSummary, 'failed' | 'errored'>): ExitCode {
  if (summary.errored > 0) {
    return ExitCode.RunError;
  }
  return summary.failed > 0 ? ExitCode.AssertionFailed : ExitCode.Ok;
}
