/**
 * REST's answer to the HTTP Log's Resend (spec §5.4): `log.resend` hands a row to the kind it
 * was sent by.
 */
import { WirebenchError } from '@wirebench/engine';
import { previewRest, sendThroughEngine } from '../../send/exchange.js';
import type { KindLog } from '../kind-main.js';

export const restLog: KindLog = {
  async resend({ request, deps, sendDeps, sendId }) {
    // The row menu only offers Resend when the row itself was not an event stream; main holds
    // the same line, keyed on the *logged exchange* — never on the saved request's current
    // settings, which may have changed since this row was sent (in either direction: a plain row
    // whose request later grew an event-stream `Accept` must still resend, and a row that WAS one
    // must stay refused even if the request's `Accept` has since gone back to `*/*`). A row with
    // no cached exchange (an ad-hoc/failure row, which never streamed) falls back to the request's
    // current `Accept` header — the only signal there is when there is no logged exchange to ask.
    const cached = request.sendId !== undefined ? deps.service.exchanges.getRest(request.sendId) : undefined;
    const streaming =
      cached !== undefined
        ? cached.stream !== undefined
        : ((await previewRest(sendDeps, request.requestId, undefined))?.input.request.headers.some(
            (header) =>
              header.enabled &&
              header.name.toLowerCase() === 'accept' &&
              header.value.toLowerCase().includes('text/event-stream'),
          ) ?? false);
    if (streaming) {
      throw new WirebenchError('rest-resend-streaming', 'Event streams resend from the editor.', {
        details: { requestId: request.requestId },
      });
    }
    return {
      protocol: 'rest' as const,
      // No live hook: nothing on screen registered this send id, so it could not be stopped.
      // The saved request, not the row's headers, so a webhook item that signs is signed fresh.
      exchange: await sendThroughEngine(sendDeps, sendId, request.requestId, { draft: { kind: 'rest' } }),
    };
  },
};
