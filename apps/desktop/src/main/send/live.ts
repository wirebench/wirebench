/**
 * An engine live event as the renderer receives it: tagged with its send, and redacted for the
 * session's show-secrets flag exactly as `EngineService` redacted its own live events.
 */
import type { LiveEvent } from '@wirebench/engine';
import { toGrpcResponseMessageWire, toSseRowWire, toWsFrameWire, toWsHandshakeWire } from '../engine-wire.js';
import { redactHeaders } from '../redact.js';
import type { GrpcLiveEvent, RestLiveEvent, WsLiveEvent } from '../../shared/wire-types.js';

/** A live event as the renderer receives it, of any protocol. */
export type LiveEventWire = RestLiveEvent | GrpcLiveEvent | WsLiveEvent;

/**
 * One live event on the wire. `keyParams` names the query parameters an API key travels in, which a
 * WebSocket handshake's URL masks whatever they are called.
 */
export function toWireEvent(
  sendId: string,
  event: LiveEvent,
  show: boolean,
  keyParams?: readonly string[],
): LiveEventWire {
  switch (event.protocol) {
    case 'rest':
      return event.kind === 'open'
        ? { kind: 'open', sendId, status: event.status, headers: redactHeaders(event.headers, { show }) }
        : { kind: 'row', sendId, row: toSseRowWire(event.row, { show }) };
    case 'grpc':
      switch (event.kind) {
        case 'open':
          return { kind: 'open', sendId };
        case 'headers':
          // Redacted as the summary's `headers` are, so metadata looks the same live or after.
          return {
            kind: 'headers',
            sendId,
            httpStatus: event.httpStatus,
            headers: redactHeaders(event.headers, { show }),
          };
        case 'message':
          return {
            kind: 'message',
            sendId,
            index: event.index,
            message: toGrpcResponseMessageWire(event.message, { show }),
          };
        case 'closed':
          return { kind: 'closed', sendId };
      }
    case 'websocket':
      switch (event.kind) {
        case 'handshake':
          return {
            kind: 'handshake',
            sendId,
            handshake: toWsHandshakeWire(event.handshake, {
              show,
              ...(keyParams !== undefined ? { keyParams } : {}),
            }),
          };
        case 'frame':
          return { kind: 'frame', sendId, frame: toWsFrameWire(event.frame, { show }) };
        case 'closed':
          return { kind: 'closed', sendId };
      }
  }
}
