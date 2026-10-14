/**
 * REST's steps of a desktop send (spec §5.5): the item with the editor's draft, its live events, its
 * summary, History and audit row.
 */
import { applyAuth, composeUrl, restEffectiveAuth, restItemFor } from '@wirebench/engine';
import type { RestContractResult, RestSendInput, SentRequest } from '@wirebench/engine';
import { toSseRowWire } from '../../engine-wire.js';
import { redactHeaders } from '../../redact.js';
import { withRestDraft } from '../../send/draft.js';
import { recordRest, summariseRest } from '../../send/record.js';
import { withSentSigningHeaders } from '../../webhook-send.js';
import type { RestExchangeSummary } from '../../../shared/kinds/rest/wire.js';
import type { KindSend } from '../kind-main.js';
import { apiKeyMasks } from '../key-masks.js';

export const restSend: KindSend<'rest'> = {
  selected(project, requestId, draft) {
    // An API request or a webhook item, orphaned or not.
    const found = restItemFor(project, requestId);
    return found === undefined ? undefined : withRestDraft(project, found, draft.draft);
  },

  liveEvent(sendId, event, show) {
    return event.kind === 'open'
      ? { kind: 'open', sendId, status: event.status, headers: redactHeaders(event.headers, { show }) }
      : { kind: 'row', sendId, row: toSseRowWire(event.row, { show }) };
  },

  summarise({ deps, sendId, sent, masks, show }) {
    const exchange = restSent(sent);
    return {
      summary: summariseRest(deps.service, sendId, exchange.rest, exchange.contract as RestContractResult | undefined, {
        ...(exchange.graphql !== undefined ? { graphql: exchange.graphql } : {}),
        method: exchange.input.request.method,
        ...masks,
        show,
      }),
    };
  },

  async record(deps, recorded, sent, summary) {
    const { input, rest: exchange } = restSent(sent);
    // History keeps the signing headers as they went out, so its resend replays them (R1).
    const rest = summary as RestExchangeSummary;
    const sentInput =
      input.sign === undefined ? input : withSentSigningHeaders(input, input.sign.scheme, rest.http.request.headers);
    // The exchange's own time on the wire, as for every protocol: never the prepare stage's.
    await recordRest(
      deps,
      recorded.item,
      sentInput,
      rest,
      exchange.durationMs,
      recorded.masks.keyParams,
      undefined,
      recorded.label,
    );
  },

  async recordFailure(deps, recorded, failed, error) {
    if (failed.input === undefined) return;
    await recordRest(
      deps,
      recorded.item,
      failed.input as RestSendInput,
      undefined,
      failed.durationMs,
      recorded.masks.keyParams,
      error,
      recorded.label,
    );
  },

  sentAudit(exchange, summary) {
    const { request, status } = exchange.rest;
    return { method: request.method, url: request.url, status, outcome: 'ok', durationMs: summary.durationMs };
  },

  failedAudit(_item, failed) {
    const input = failed.input as RestSendInput | undefined;
    if (input === undefined) return undefined;
    const { request, settings } = input;
    // Built as a successful send's URL is: the auth the input already carries (resolved values;
    // nothing is fetched here) adds its query rows, and the audit event masks the key's value.
    const { url } = composeUrl(
      input.baseUrl,
      request.url,
      request.pathParams,
      [...request.query, ...applyAuth(input.auth).query],
      { ...(settings.encodeUrl !== undefined ? { encode: settings.encodeUrl } : {}) },
    );
    return { status: null, outcome: 'failed', durationMs: failed.durationMs, method: request.method, url };
  },

  keyMasks(item) {
    return apiKeyMasks(restEffectiveAuth(item));
  },
};

function restSent(sent: SentRequest): Extract<NonNullable<SentRequest['exchange']>, { kind: 'rest' }> {
  if (sent.exchange?.kind !== 'rest') throw new Error('A REST send came back without its exchange');
  return sent.exchange;
}
