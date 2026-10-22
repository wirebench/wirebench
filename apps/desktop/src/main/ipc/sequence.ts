/**
 * Registers the `sequence.*` IPC channels: run a sequence end to end, and cancel a run. Editing a
 * sequence goes through `project.mutate` like every other entity.
 */

import { channels } from '../../shared/ipc.js';
import type { SequenceRunDeps, SequenceRunner } from '../sequence-runner.js';
import { registerHandler } from './register.js';

export function registerSequenceChannels(
  runner: SequenceRunner,
  deps: SequenceRunDeps,
  /** Refuses a run when `sequences` is off (phase 4 spec §7); editing is refused by `project.mutate`. */
  requireFeature: (feature: string) => void = () => undefined,
): void {
  registerHandler(channels.sequence.run, (request) => {
    requireFeature('sequences');
    return runner.run(request, deps);
  });
  registerHandler(channels.sequence.cancel, (request) => Promise.resolve(runner.cancel(request.runId)));
}
