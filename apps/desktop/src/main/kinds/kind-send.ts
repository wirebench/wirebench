/**
 * Each kind's send steps (spec §5.5), by kind: the same objects `MAIN_KINDS` carries as `send`.
 *
 * Kept apart from `kind-main.ts` so the send path does not import the kinds' IPC modules, which
 * import the send path: `send/exchange.ts` and `send/live.ts` look a kind up here.
 */
import type { KindId } from '../../shared/kinds/kind-module.js';
import { grpcSend } from './grpc/send.js';
import type { KindSend, SendKind } from './kind-main.js';
import { mcpSend } from './mcp/send.js';
import { restSend } from './rest/send.js';
import { soapSend } from './soap/send.js';
import { wsSend } from './ws/send.js';

/** Every kind's send steps, by kind. */
export const KIND_SENDS: { readonly [K in KindId]: KindSend<K> } = {
  soap: soapSend,
  rest: restSend,
  grpc: grpcSend,
  websocket: wsSend,
  mcp: mcpSend,
};

/**
 * The send steps of `kind`, typed for any kind: the caller holds an item, live event or exchange of
 * that same kind, which TypeScript cannot correlate through the lookup.
 */
export function kindSend(kind: SendKind): KindSend<SendKind> {
  return KIND_SENDS[kind] as unknown as KindSend<SendKind>;
}
