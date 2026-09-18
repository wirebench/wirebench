import { randomUUID } from 'node:crypto';
import { ProjectError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { EngineService } from '../engine-service.js';
import { curlForLogEntry } from '../log-curl.js';
import { sendAndRecordHistory } from '../send-with-history.js';
import { registerHandler } from './register.js';
import { sendGrpcRequest, sendRestRequest, type RequestChannelDeps } from './request.js';

/** What the HTTP Log's channels need from main. */
export interface LogChannelDeps {
  readonly showSecrets: { get(): boolean };
  readonly service: EngineService;
  /** The same deps `request.*` sends with, so a resend writes History and failure rows alike. */
  readonly request: RequestChannelDeps;
}

/** Registers `log.*`: everything the HTTP Log asks main to do with a row it already holds. */
export function registerLogChannels(deps: LogChannelDeps): void {
  registerHandler(channels.log.curl, (request) =>
    Promise.resolve(curlForLogEntry(request.entry, { shell: request.shell, show: deps.showSecrets.get() })),
  );

  // Replays the saved request behind a row as it is now — never the row's own (redacted) copy.
  registerHandler(channels.log.resend, async (request, sender) => {
    const sendId = randomUUID();
    if (request.protocol === 'rest') {
      return {
        protocol: 'rest' as const,
        exchange: await sendRestRequest(deps.service, deps.request, { sendId, requestId: request.requestId }),
      };
    }
    if (request.protocol === 'grpc') {
      return {
        protocol: 'grpc' as const,
        exchange: await sendGrpcRequest(deps.service, deps.request, { sendId, requestId: request.requestId }, sender),
      };
    }
    // History's resend Path 1: the live request, never a redacted copy.
    const input = deps.request.project.buildLiveSendInput(request.requestId);
    if (input === undefined) {
      throw new ProjectError('unknown-entity', `No request with id "${request.requestId}"`, {
        details: { requestId: request.requestId },
      });
    }
    return {
      protocol: 'soap' as const,
      exchange: await sendAndRecordHistory(deps.service, deps.request, {
        sendId,
        requestId: request.requestId,
        input,
      }),
    };
  });
}
