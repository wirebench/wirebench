import type { RequestResult, RunResult } from '@wirebench/engine';

/**
 * One output of a run. `onRequestDone` streams as requests finish, so a long run shows progress;
 * `onRunDone` sees the whole result, which is all a file report needs.
 */
export interface Reporter {
  onRequestDone?(result: RequestResult): void;
  onRunDone(result: RunResult): Promise<void> | void;
}
