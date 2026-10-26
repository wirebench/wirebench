/**
 * WebSocket's steps of a desktop send (spec §5.5): the item with the editor's draft, its live events,
 * its summary, History and audit row. The session itself (its contract checks, its close) is
 * `exchange.ts`'s, which the shared kind's `interactive` flag keys.
 */
import { wsEffectiveAuth, wsItemFor } from '@wirebench/engine';
import type { SentRequest, WsExchange } from '@wirebench/engine';
import { toWsFrameWire, toWsHandshakeWire } from '../../engine-wire.js';
import { recordWs, reportWsHandshakeFailure, summariseWs } from '../../send/record.js';
import type { WsExchangeSummary } from '../../../shared/kinds/ws/wire.js';
import type { KindSend } from '../kind-main.js';
import { withWsPatch } from './mutations.js';
import { namedCredential } from '../key-masks.js';

export const wsSend: KindSend<'websocket'> = {
  selected(project, requestId, draft) {
    // Orphaned or not: the editor opens what it shows.
    const found = wsItemFor(project, requestId);
    return found === undefined || draft.draft === undefined
      ? found
      : { ...found, request: withWsPatch(found.request, draft.draft) };
  },

  liveEvent(redactor, sendId, event, show, keyParams) {
    switch (event.kind) {
      case 'handshake':
        return {
          kind: 'handshake',
          sendId,
          handshake: toWsHandshakeWire(redactor, event.handshake, {
            show,
            ...(keyParams !== undefined ? { keyParams } : {}),
          }),
        };
      case 'frame':
        return { kind: 'frame', sendId, frame: toWsFrameWire(redactor, event.frame, { show }) };
      case 'closed':
        return { kind: 'closed', sendId };
    }
  },

  summarise({ deps, sendId, sent, masks, show, checked }) {
    return {
      summary: summariseWs(deps.hostState.redactor, checked ?? wsSent(sent).ws, sendId, {
        show,
        ...(masks.keyParams !== undefined ? { keyParams: masks.keyParams } : {}),
      }),
    };
  },

  async record(deps, recorded, _sent, summary) {
    // As the app always has: the refused handshake's Log row, then History.
    const ws = summary as WsExchangeSummary;
    const opened = recorded.handshakeLogged === true;
    reportWsHandshakeFailure(deps, ws.sendId, recorded.item.request.id, ws, recorded.masks.keyParams, opened);
    await recordWs(deps, recorded.item, ws, recorded.masks.keyParams, opened, recorded.label);
  },

  async recordFailure(deps, recorded, failed, _error, summaryOf) {
    if (failed.input === undefined) return;
    // A session cancelled before it opened, or a run's cancelled after, settled with its transcript,
    // which History keeps as the app always has; one that failed as it was built (a bad option) has
    // none to record.
    if (failed.exchange === undefined) return;
    const { masks } = recorded;
    const summary = summariseWs(deps.hostState.redactor, failed.exchange as WsExchange, summaryOf.sendId, {
      show: summaryOf.show,
      ...(masks.keyParams !== undefined ? { keyParams: masks.keyParams } : {}),
    });
    await recordWs(deps, recorded.item, summary, masks.keyParams, recorded.handshakeLogged === true, recorded.label);
  },

  sentAudit(exchange, summary) {
    const { ws } = exchange;
    const opened = ws.handshake.error === undefined;
    return {
      method: null,
      url: ws.url,
      status: ws.handshake.status ?? null,
      outcome: opened ? 'ok' : 'failed',
      durationMs: summary.durationMs,
    };
  },

  failedAudit(_item, failed) {
    // A session that failed as it was built has no transcript, and never reached the wire.
    const exchange = failed.exchange as WsExchange | undefined;
    return exchange === undefined
      ? undefined
      : { status: null, outcome: 'failed', durationMs: failed.durationMs, method: null, url: exchange.url };
  },

  keyMasks(item) {
    // A WebSocket session masks its URL's key alone, as the app always has: its rows mask headers by name.
    const named = namedCredential(wsEffectiveAuth(item));
    return named?.in === 'query' ? { keyParams: [named.name] } : {};
  },
};

/** The WebSocket exchange a session settled with. */
export function wsSent(sent: SentRequest): Extract<NonNullable<SentRequest['exchange']>, { kind: 'websocket' }> {
  if (sent.exchange?.kind !== 'websocket') throw new Error('A WebSocket session came back without its exchange');
  return sent.exchange;
}
