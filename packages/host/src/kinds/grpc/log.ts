/**
 * gRPC's answer to the HTTP Log's Resend (spec §5.4): `log.resend` hands a row to the kind it
 * was sent by.
 */
import { grpcItemFor, WirebenchError } from '@wirebench/engine';
import { sendThroughEngine } from '../../send/exchange.js';
import type { KindLog } from '../kind-main.js';

export const grpcLog: KindLog = {
  async resend({ request, deps, sendDeps, sendId }) {
    // The row menu only offers Resend for unary calls; main holds the same line, since a
    // streaming call needs the live panel to talk into and cannot be replayed from a row.
    const located = deps.request.project.runContextFor?.(request.requestId);
    const methodKind =
      located === undefined ? undefined : grpcItemFor(located.project, request.requestId)?.request.methodKind;
    if (methodKind !== undefined && methodKind !== 'unary') {
      throw new WirebenchError('grpc-resend-streaming', 'Only a unary gRPC call can be resent from the log.', {
        details: { requestId: request.requestId, methodKind },
      });
    }
    return {
      protocol: 'grpc' as const,
      // No live hook either: nothing on screen holds this send id, so its events would be dropped.
      exchange: await sendThroughEngine(sendDeps, sendId, request.requestId, { draft: { kind: 'grpc' } }),
    };
  },
};
