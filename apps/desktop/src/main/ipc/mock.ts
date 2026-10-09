/**
 * Registers the `mock.*` IPC channels (#59): start, stop and reset a mock served from this machine.
 * Editing a mock goes through `project.mutate` like every other entity. A started mock's events go to
 * the window that started it.
 */

import type { WebContents } from 'electron';
import type { MockExchangeEvent, Project } from '@wirebench/engine';
import { channels, events } from '../../shared/ipc.js';
import type { MockRunner, MockSink } from '../mock-runner.js';
import { emitEvent } from './events.js';
import { registerHandler } from './register.js';

export interface MockChannelDeps {
  /** The project holding `mockId`, its model as it is now and its folder; throws when no open project has it. */
  readonly locate: (mockId: string) => { readonly projectId: string; readonly project: Project; readonly dir: string };
  /** The host a mock listens on: loopback, unless the preference says every interface. */
  readonly host: () => string;
  /** Whether `mockId` belongs to a project open in the calling window. */
  readonly owns: (mockId: string) => boolean;
}

function sinkFor(sender: WebContents): MockSink {
  return {
    state: (event) => {
      emitEvent(sender, events.mock.state, event);
    },
    exchange: (mockId, event) => {
      const message = (side: MockExchangeEvent['request']) => ({
        headers: side.headers.map(([name, value]): [string, string] => [name, value]),
        body: side.body,
        truncated: side.truncated,
      });
      emitEvent(sender, events.mock.exchange, {
        mockId,
        seq: event.seq,
        at: event.at,
        method: event.method,
        url: event.url,
        ...(event.operation !== undefined ? { operation: event.operation } : {}),
        ...(event.responseId !== undefined ? { responseId: event.responseId } : {}),
        ...(event.responseName !== undefined ? { responseName: event.responseName } : {}),
        status: event.status,
        durationMs: event.durationMs,
        problems: event.problems.map((problem) => ({ ...problem })),
        ...(event.error !== undefined ? { error: { ...event.error } } : {}),
        ...(event.log !== undefined ? { log: [...event.log] } : {}),
        request: message(event.request),
        response: message(event.response),
      });
    },
  };
}

export function registerMockChannels(runner: MockRunner, deps: MockChannelDeps): void {
  registerHandler(channels.mock.start, (request, sender) =>
    runner.startMock(request.mockId, {
      ...deps.locate(request.mockId),
      owner: sender.id,
      host: deps.host(),
      sink: sinkFor(sender),
    }),
  );
  registerHandler(channels.mock.stop, async (request) => ({ stopped: await runner.stopMock(request.mockId) }));
  registerHandler(channels.mock.reset, (request) => Promise.resolve({ reset: runner.reset(request.mockId) }));
  registerHandler(channels.mock.states, () =>
    Promise.resolve({
      states: runner
        .runningIds()
        .filter(deps.owns)
        .map((mockId) => runner.stateOf(mockId)),
    }),
  );
}
