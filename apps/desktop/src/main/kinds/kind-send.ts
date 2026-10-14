/**
 * Each kind's send steps (spec §5.5), by kind: the same objects `MAIN_KINDS` carries as `send`.
 *
 * Kept apart from `kind-main.ts` so the send path does not import the kinds' IPC modules, which
 * import the send path: `send/exchange.ts` and `send/live.ts` look a kind up here.
 */
import type { MainKindId } from './enabled-kinds.js';
import { grpcSend } from './grpc/send.js';
import type { KindSend, SendKind } from './kind-main.js';
import { restSend } from './rest/send.js';
import { soapSend } from './soap/send.js';
import { wsSend } from './ws/send.js';

/** Every kind's send steps, by kind. */
export const KIND_SENDS: { readonly [K in MainKindId]: KindSend<K> } = {
  soap: soapSend,
  rest: restSend,
  grpc: grpcSend,
  websocket: wsSend,
};

/**
 * The send steps of `kind`, typed for any kind: the caller holds an item, live event or exchange of
 * that same kind, which TypeScript cannot correlate through the lookup.
 *
 * @throws Error for a kind the engine sends and the app does not have yet
 */
export function kindSend(kind: SendKind): KindSend<SendKind> {
  const send = (KIND_SENDS as Partial<Record<SendKind, KindSend<MainKindId>>>)[kind];
  if (send === undefined) throw new Error(`The app cannot send ${kind} requests yet`);
  return send as unknown as KindSend<SendKind>;
}
