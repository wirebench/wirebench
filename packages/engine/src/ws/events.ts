/**
 * What a WebSocket session reports while it runs (spec §3.2): the handshake once the server has
 * switched protocols, each frame sent or received, and the session closed.
 */
import type { WsFrame, WsHandshake } from './model.js';

export type WsLiveEvent =
  | { readonly protocol: 'websocket'; readonly kind: 'handshake'; readonly handshake: WsHandshake }
  | { readonly protocol: 'websocket'; readonly kind: 'frame'; readonly frame: WsFrame }
  | { readonly protocol: 'websocket'; readonly kind: 'closed' };

/** This protocol's member of the unions over every composed protocol (package split spec §3.4). */
declare module '../protocol/unions.js' {
  interface LiveEvents {
    websocket: WsLiveEvent;
  }
}
