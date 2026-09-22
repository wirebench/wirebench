import { randomUUID } from 'node:crypto';
import { nodeFs, ProjectError, WirebenchError, writeFileAtomic } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { RecordsWritePicks } from '../dialog-picks.js';
import type { EngineService } from '../engine-service.js';
import { harFileName, harOf } from '../har.js';
import { curlForLogEntry } from '../log-curl.js';
import { pickSaveFile } from '../native-dialogs.js';
import { sendAndRecordHistory } from '../send-with-history.js';
import { registerHandler } from './register.js';
import { sendGrpcRequest, sendRestRequest, type RequestChannelDeps } from './request.js';

/** What the HTTP Log's channels need from main. */
export interface LogChannelDeps {
  readonly showSecrets: { get(): boolean };
  readonly service: EngineService;
  /** The same deps `request.*` sends with, so a resend writes History and failure rows alike. */
  readonly request: RequestChannelDeps;
  /** Records the HAR path the save dialog returned, as every other write pick is. */
  readonly picks: RecordsWritePicks;
  /** The `creator.version` a HAR file carries. */
  readonly appVersion: string;
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
      // The row menu only offers Resend when the row itself was not an event stream; main holds
      // the same line, keyed on the *logged exchange* — never on the saved request's current
      // settings, which may have changed since this row was sent (in either direction: a plain row
      // whose request later grew an event-stream `Accept` must still resend, and a row that WAS one
      // must stay refused even if the request's `Accept` has since gone back to `*/*`). A row with
      // no cached exchange (an ad-hoc/failure row, which never streamed) falls back to the request's
      // current `Accept` header — the only signal there is when there is no logged exchange to ask.
      const cached = request.sendId !== undefined ? deps.service.exchanges.getRest(request.sendId) : undefined;
      const streaming =
        cached !== undefined
          ? cached.stream !== undefined
          : (deps.request.project
              .restSend?.(request.requestId)
              ?.input.request.headers.some(
                (header) =>
                  header.enabled &&
                  header.name.toLowerCase() === 'accept' &&
                  header.value.toLowerCase().includes('text/event-stream'),
              ) ?? false);
      if (streaming) {
        throw new WirebenchError('rest-resend-streaming', 'Event streams resend from the editor.', {
          details: { requestId: request.requestId },
        });
      }
      return {
        protocol: 'rest' as const,
        exchange: await sendRestRequest(deps.service, deps.request, { sendId, requestId: request.requestId }, sender),
      };
    }
    if (request.protocol === 'grpc') {
      // The row menu only offers Resend for unary calls; main holds the same line, since a
      // streaming call needs the live panel to talk into and cannot be replayed from a row.
      const methodKind = deps.request.project.grpcSend?.(request.requestId)?.request.methodKind;
      if (methodKind !== undefined && methodKind !== 'unary') {
        throw new WirebenchError('grpc-resend-streaming', 'Only a unary gRPC call can be resent from the log.', {
          details: { requestId: request.requestId, methodKind },
        });
      }
      return {
        protocol: 'grpc' as const,
        exchange: await sendGrpcRequest(deps.service, deps.request, { sendId, requestId: request.requestId }, sender),
      };
    }
    if (request.protocol === 'websocket') {
      // A WebSocket row is a whole session's handshake, not one request/response pair; like a
      // streaming gRPC call, it needs the live panel to drive it and cannot be replayed from a row.
      throw new WirebenchError(
        'ws-resend-streaming',
        'A WebSocket session cannot be resent from the log. Open the connection from the request.',
        { details: { requestId: request.requestId } },
      );
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

  registerHandler(channels.log.exportHar, async (request, sender) => {
    // Always show:false, whatever the toggle says: a HAR file is made to be shared.
    const har = harOf(request.entries, { name: 'Wirebench', version: deps.appVersion });
    // The path is never the renderer's to choose: it comes from the native dialog or the e2e override.
    const path = await pickSaveFile(sender, deps.picks, {
      title: 'Export HAR',
      filters: [{ name: 'HAR', extensions: ['har'] }],
      defaultPath: harFileName(new Date()),
    });
    if (path === undefined) {
      return { saved: false };
    }
    await writeFileAtomic(nodeFs, path, Buffer.from(JSON.stringify(har, null, 2), 'utf8'));
    return { saved: true, path };
  });
}
