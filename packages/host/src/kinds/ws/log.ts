/**
 * WebSocket's answer to the HTTP Log's Resend (spec §5.4): `log.resend` hands a row to the kind it
 * was sent by.
 */
import { WirebenchError } from '@wirebench/engine';
import type { KindLog } from '../kind-main.js';

export const wsLog: KindLog = {
  resend({ request }) {
    // A WebSocket row is a whole session's handshake, not one request/response pair; like a
    // streaming gRPC call, it needs the live panel to drive it and cannot be replayed from a row.
    throw new WirebenchError(
      'ws-resend-streaming',
      'A WebSocket session cannot be resent from the log. Open the connection from the request.',
      { details: { requestId: request.requestId } },
    );
  },
};
