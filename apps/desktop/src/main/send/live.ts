/**
 * An engine live event as the renderer receives it: tagged with its send, and redacted for the
 * session's show-secrets flag exactly as `EngineService` redacted its own live events.
 */
import type { Redactor } from '../host/redactor.js';
import type { LiveEvent } from '@wirebench/engine';
import { kindSend } from '../kinds/kind-send.js';
import type { GrpcLiveEvent } from '../../shared/kinds/grpc/wire.js';
import type { McpLiveEvent } from '../../shared/kinds/mcp/wire.js';
import type { RestLiveEvent } from '../../shared/kinds/rest/wire.js';
import type { WsLiveEvent } from '../../shared/kinds/ws/wire.js';

/** A live event as the renderer receives it, of any protocol. */
export type LiveEventWire = RestLiveEvent | GrpcLiveEvent | WsLiveEvent | McpLiveEvent;

/**
 * One live event on the wire, as its kind turns it. `keyParams` names the query parameters an API key
 * travels in, which a WebSocket handshake's URL masks whatever they are called.
 *
 * @throws Error for a kind that reports no live events
 */
export function toWireEvent(
  redactor: Redactor,
  sendId: string,
  event: LiveEvent,
  show: boolean,
  keyParams?: readonly string[],
): LiveEventWire {
  const send = kindSend(event.protocol);
  if (send.liveEvent === undefined) throw new Error(`${event.protocol} sends report no live events`);
  return send.liveEvent(redactor, sendId, event, show, keyParams);
}
