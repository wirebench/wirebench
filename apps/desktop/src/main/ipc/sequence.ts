/**
 * Registers the `sequence.*` IPC channels: run a sequence end to end, and cancel a run. Editing a
 * sequence goes through `project.mutate` like every other entity.
 */

import { channels } from '../../shared/ipc.js';
import type { EngineService } from '../engine-service.js';
import type { SequenceRunDeps, SequenceRunner } from '../sequence-runner.js';
import { registerHandler } from './register.js';

export function registerSequenceChannels(runner: SequenceRunner, service: EngineService, deps: SequenceRunDeps): void {
  registerHandler(channels.sequence.run, (request, sender) => runner.run(request, deps, sender));
  registerHandler(channels.sequence.cancel, (request) => Promise.resolve(runner.cancel(request.runId, service)));
}
