/**
 * gRPC's steps of a desktop send (spec §5.5): the item with the editor's draft, its live events, its
 * summary, History and audit row.
 */
import { grpcItemFor } from '@wirebench/engine';
import type { GrpcFailedInput, SentRequest } from '@wirebench/engine';
import { toGrpcResponseMessageWire } from '../../engine-wire.js';
import { recordGrpc, summariseGrpc } from '../../send/record.js';
import type { GrpcExchangeSummary } from '../../../shared/kinds/grpc/wire.js';
import type { KindSend } from '../kind-main.js';
import { withGrpcPatch } from './mutations.js';

export const grpcSend: KindSend<'grpc'> = {
  selected(project, requestId, draft) {
    // Any method kind, orphaned or not: a run skips streams, a person sends them.
    const found = grpcItemFor(project, requestId);
    return found === undefined || draft.draft === undefined
      ? found
      : { ...found, request: withGrpcPatch(found.request, draft.draft) };
  },

  liveEvent(redactor, sendId, event, show) {
    switch (event.kind) {
      case 'open':
        return { kind: 'open', sendId };
      case 'headers':
        // Redacted as the summary's `headers` are, so metadata looks the same live or after.
        return {
          kind: 'headers',
          sendId,
          httpStatus: event.httpStatus,
          headers: redactor.redactHeaders(event.headers, { show }),
        };
      case 'message':
        return {
          kind: 'message',
          sendId,
          index: event.index,
          message: toGrpcResponseMessageWire(redactor, event.message, { show }),
        };
      case 'closed':
        return { kind: 'closed', sendId };
    }
  },

  summarise({ deps, sendId, sent, show }) {
    return { summary: summariseGrpc(deps.hostState.redactor, grpcSent(sent).grpc, sendId, show) };
  },

  async record(deps, recorded, sent, summary) {
    const exchange = grpcSent(sent);
    await recordGrpc(
      deps,
      recorded.item,
      exchange,
      summary as GrpcExchangeSummary,
      exchange.grpc.exchange.durationMs,
      undefined,
      recorded.label,
    );
  },

  async recordFailure(deps, recorded, failed, error) {
    if (failed.input === undefined) return;
    // The call as connected, with the message it was to send: a send-stage failure has both.
    const { messageText, ...input } = failed.input as GrpcFailedInput;
    if (messageText === undefined) return;
    await recordGrpc(deps, recorded.item, { input, messageText }, undefined, failed.durationMs, error, recorded.label);
  },

  sentAudit(exchange, summary) {
    const { input } = exchange;
    const status = 'statusName' in summary ? summary.status : null;
    return {
      method: `${input.service}/${input.method}`,
      url: input.target,
      status,
      outcome: 'ok',
      durationMs: summary.durationMs,
    };
  },

  failedAudit(_item, failed) {
    const input = failed.input as GrpcFailedInput | undefined;
    return input === undefined
      ? undefined
      : {
          status: null,
          outcome: 'failed',
          durationMs: failed.durationMs,
          method: `${input.service}/${input.method}`,
          url: input.target,
        };
  },
};

function grpcSent(sent: SentRequest): Extract<NonNullable<SentRequest['exchange']>, { kind: 'grpc' }> {
  if (sent.exchange?.kind !== 'grpc') throw new Error('A gRPC send came back without its exchange');
  return sent.exchange;
}
