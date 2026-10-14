/**
 * Why a run ended the way it did (scheduled-runs spec §3.1, §3.2). The reason is stored on the run
 * as a short code and never carries a secret, a URL or a body.
 */
export const RUN_REASONS = [
  'snapshot-too-large',
  'snapshot-path-refused',
  'workspace-empty',
  'target-missing',
  'target-invalid',
  'environment-protected',
  'secret-key-missing',
  'scripts-refused',
  'timeout',
  'shutdown',
  'interrupted',
  'cancelled',
  'overlap',
  'run-failed',
] as const;
export type RunReason = (typeof RUN_REASONS)[number];

/** A run that cannot go on: it ends `errored` with this reason (or `cancelled` for a cancel). */
export class RunStopped extends Error {
  constructor(
    readonly reason: RunReason,
    message: string = reason,
  ) {
    super(message);
    this.name = 'RunStopped';
  }
}
