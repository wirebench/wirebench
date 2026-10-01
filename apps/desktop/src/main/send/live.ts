/**
 * An engine live event as the renderer receives it: tagged with its send, and redacted for the
 * session's show-secrets flag exactly as `EngineService` redacted its own live events.
 */
import type { LiveEvent } from '@wirebench/engine';
import { toSseRowWire } from '../engine-wire.js';
import { redactHeaders } from '../redact.js';
import type { RestLiveEvent } from '../../shared/wire-types.js';

/** One live event on the wire. Tasks 11 and 13 add the gRPC and WebSocket arms. */
export function toWireEvent(sendId: string, event: LiveEvent, show: boolean): RestLiveEvent {
  switch (event.protocol) {
    case 'rest':
      return event.kind === 'open'
        ? { kind: 'open', sendId, status: event.status, headers: redactHeaders(event.headers, { show }) }
        : { kind: 'row', sendId, row: toSseRowWire(event.row, { show }) };
    case 'grpc':
      // Unreachable until Task 11: the app still makes its gRPC calls through EngineService.
      throw new Error('A gRPC live event has no wire form yet');
  }
}
