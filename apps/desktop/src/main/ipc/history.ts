/**
 * Registers the `history.*` IPC channels: list/search, read one entry, clear, and re-send.
 * `history.resend` goes through the same `sendAndRecordHistory` path as `request.send`, so a
 * re-send is itself recorded as a new history entry. `history.resendGrpc` calls a gRPC entry's
 * saved request through `request.sendGrpc`'s path, with the messages the entry recorded.
 */

import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { WirebenchError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type {
  FailedExchangeWire,
  GrpcExchangeSummary,
  GrpcRequestPatchWire,
  HeaderEntryWire,
  HistoryEntryWire,
  RequestSendGrpcRequest,
} from '../../shared/wire-types.js';
import type { EngineService } from '../engine-service.js';
import type { HistoryService } from '../history-service.js';
import { containsRedaction } from '../redact.js';
import type { ProjectRouter } from '../project-router.js';
import type { GetSecret, PropertyScopes } from '@wirebench/engine';
import type { HistorySendProject, SendWithHistoryDeps } from '../send-with-history.js';
import { sendAndRecordHistory } from '../send-with-history.js';
import { registerHandler } from './register.js';

/** What `history.resend` needs beyond `EngineService`/`HistoryService`. */
export interface HistoryChannelDeps {
  readonly project: HistorySendProject &
    Pick<ProjectRouter, 'buildLiveSendInput'> &
    Partial<Pick<ProjectRouter, 'grpcSend'>>;
  /**
   * The scopes an *ad-hoc* send expands against — one with no saved request behind it, and so
   * no project to resolve a chain from. Omitted in tests, which then expand against nothing.
   */
  readonly adHocScopes?: () => PropertyScopes;
  readonly showSecrets?: { get(): boolean };
  /** Called with the new entry a re-send produced, so main can broadcast `history.appended`. */
  readonly onHistoryAppended?: (entry: HistoryEntryWire) => void;
  /** Called with the failure row of a resend that threw, so main can broadcast `exchange.failed`. */
  readonly onSendFailed?: (failure: FailedExchangeWire) => void;
  /** The getter a resend's `${secret:name}` tokens resolve through; see `SendWithHistoryDeps`. */
  readonly secretsFor?: (projectId: string | undefined) => GetSecret;
  /** The OAuth2 token service and keychain reader, for a resend whose owner uses OAuth2. */
  readonly oauth2?: SendWithHistoryDeps['oauth2'];
  readonly getSecret?: SendWithHistoryDeps['getSecret'];
  /** Sends a gRPC call the way `request.sendGrpc` does; `history.resendGrpc` is refused without it. */
  readonly grpc?: {
    send(request: RequestSendGrpcRequest, sender: WebContents): Promise<GrpcExchangeSummary>;
  };
}

/**
 * The draft a gRPC entry resends with: its method and the messages it recorded. A streaming
 * client's messages go back as one JSON array, which is what the editor's message field holds
 * for such a call; a unary or server-streaming call sent exactly one. An entry with no messages
 * (the send failed before any went out) falls back to the request text it recorded.
 */
export function grpcResendDraft(
  entry: HistoryEntryWire & { grpc: NonNullable<HistoryEntryWire['grpc']> },
): GrpcRequestPatchWire {
  const { service, method, methodKind, requestMessages } = entry.grpc;
  const streamsIn = methodKind === 'client-streaming' || methodKind === 'bidi-streaming';
  const message =
    requestMessages.length === 0
      ? entry.request.envelopeXml
      : streamsIn
        ? JSON.stringify(
            requestMessages.map((text) => JSON.parse(text) as unknown),
            null,
            2,
          )
        : requestMessages[0]!;
  return { service, method, methodKind, message };
}

/** Drops headers the history store redacted (`<redacted>`) before resending — never resent verbatim. */
function liveHeaders(headers: readonly HeaderEntryWire[]): Record<string, string> {
  return Object.fromEntries(headers.filter((header) => header.value !== '<redacted>').map((h) => [h.name, h.value]));
}

/**
 * True when an orphaned entry (its original request no longer exists) carries a redacted
 * secret anywhere a resend would replay: the request envelope, a request header value, or the
 * SOAP fault reason. Such an entry must never be resent — the redaction marker itself would go
 * out as the literal credential.
 */
function isRedacted(entry: HistoryEntryWire): boolean {
  return (
    containsRedaction(entry.request.envelopeXml) ||
    entry.request.headers.some((header) => containsRedaction(header.value)) ||
    (entry.fault?.reason !== undefined && containsRedaction(entry.fault.reason))
  );
}

export function registerHistoryChannels(
  service: EngineService,
  history: HistoryService,
  deps: HistoryChannelDeps,
): void {
  registerHandler(channels.history.list, (request) =>
    Promise.resolve(
      history.list({
        ...(request.query !== undefined ? { query: request.query } : {}),
        limit: request.limit ?? 200,
        ...(request.before !== undefined ? { before: request.before } : {}),
        ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
      }),
    ),
  );

  registerHandler(channels.history.get, (request) => Promise.resolve({ entry: history.get(request.id) }));

  registerHandler(channels.history.clear, async () => ({ cleared: await history.clear() }));

  registerHandler(channels.history.resend, (request) => {
    const entry = history.get(request.id);
    if (entry === undefined) {
      throw new WirebenchError('unknown-history-entry', `No history entry with id "${request.id}"`, {
        details: { id: request.id },
      });
    }

    // Only a SOAP send can be replayed here: both paths below build a SOAP send input, so a REST,
    // gRPC or WebSocket entry would go out as a POST of its body wrapped as an envelope — a
    // different request from the one recorded. Refuse it, typed, rather than misfire. (An entry
    // without a kind predates the other protocols and is SOAP.)
    const kind = entry.kind ?? 'soap';
    if (kind !== 'soap') {
      throw new WirebenchError(
        'history-resend-unsupported',
        `A ${kind === 'websocket' ? 'WebSocket session' : `${kind === 'grpc' ? 'gRPC' : 'REST'} call`} is resent from its request, not from History`,
        { details: { id: request.id, kind } },
      );
    }

    // Path 1: the original request still exists — replay the LIVE request (current envelope,
    // headers and effective endpoint), exactly like a normal `request.send`. The stored entry
    // was redacted before being written to disk, so it must never be the source of a resend
    // while a live copy is available.
    const liveInput = entry.requestId !== undefined ? deps.project.buildLiveSendInput(entry.requestId) : undefined;
    if (liveInput === undefined) {
      // Path 2: the original request is gone. An entry that carries a redacted secret can never
      // be resent — the marker itself would go out as the literal credential — so refuse it.
      if (isRedacted(entry)) {
        throw new WirebenchError(
          'history-resend-redacted',
          'This entry contains redacted secrets and its original request no longer exists',
          { details: { id: request.id } },
        );
      }
    }

    const input = liveInput ?? {
      endpoint: entry.endpoint,
      envelopeXml: entry.request.envelopeXml,
      soapVersion: entry.soapVersion === 'none' ? '1.1' : entry.soapVersion,
      ...(entry.soapAction !== undefined ? { soapAction: entry.soapAction } : {}),
      headers: liveHeaders(entry.request.headers),
    };

    return sendAndRecordHistory(
      service,
      {
        project: deps.project,
        ...(deps.adHocScopes !== undefined ? { adHocScopes: deps.adHocScopes } : {}),
        ...(deps.showSecrets !== undefined ? { showSecrets: deps.showSecrets } : {}),
        history,
        ...(deps.onHistoryAppended !== undefined ? { onHistoryAppended: deps.onHistoryAppended } : {}),
        ...(deps.onSendFailed !== undefined ? { onSendFailed: deps.onSendFailed } : {}),
        ...(deps.secretsFor !== undefined ? { secretsFor: deps.secretsFor } : {}),
        ...(deps.oauth2 !== undefined ? { oauth2: deps.oauth2 } : {}),
        ...(deps.getSecret !== undefined ? { getSecret: deps.getSecret } : {}),
      },
      {
        sendId: crypto.randomUUID(),
        ...(entry.requestId !== undefined ? { requestId: entry.requestId } : {}),
        input,
      },
      {
        requestName: entry.requestName,
        interfaceName: entry.interfaceName,
        operationName: entry.operationName,
        projectId: entry.projectId,
      },
    );
  });

  registerHandler(channels.history.resendGrpc, (request, sender) => {
    const entry = history.get(request.id);
    if (entry === undefined) {
      throw new WirebenchError('unknown-history-entry', `No history entry with id "${request.id}"`, {
        details: { id: request.id },
      });
    }
    const { grpc } = entry;
    if (entry.kind !== 'grpc' || grpc === undefined || deps.grpc === undefined) {
      throw new WirebenchError('history-resend-unsupported', 'Only a gRPC call is resent through this channel', {
        details: { id: request.id, kind: entry.kind ?? 'soap' },
      });
    }
    // The call goes out through the saved request (its endpoint, metadata, auth and TLS), so an
    // entry whose request is gone has nothing to resend through.
    const { requestId } = entry;
    if (requestId === undefined || deps.project.grpcSend?.(requestId) === undefined) {
      throw new WirebenchError('history-resend-orphan', 'The request this call was sent from no longer exists', {
        details: { id: request.id },
      });
    }
    return deps.grpc.send({ sendId: randomUUID(), requestId, draft: grpcResendDraft({ ...entry, grpc }) }, sender);
  });
}
