import type { CallbackWaiting, RequestResult, RunResult } from '@wirebench/engine';

/**
 * One output of a run. `onRequestDone` streams as requests finish, so a long run shows progress;
 * `onRunDone` sees the whole result, which is all a file report needs.
 */
export interface Reporter {
  onRequestDone?(result: RequestResult): void;
  /** A request or step has sent and now waits for its callbacks (callback-assertion §4). */
  onCallbackWaiting?(path: string, waiting: readonly CallbackWaiting[]): void;
  onRunDone(result: RunResult): Promise<void> | void;
}
