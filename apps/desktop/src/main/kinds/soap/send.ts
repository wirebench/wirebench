/**
 * SOAP's steps of a desktop send (spec §5.5): the item with the editor's override, its summary,
 * History and audit row. A SOAP send reports no live events.
 */
import { soapEffectiveAuth, soapItemFor } from '@wirebench/engine';
import type { SentRequest, SoapSendInput } from '@wirebench/engine';
import type { HistoryNameFallback } from '../../send/record.js';
import { recordSoap, summariseSoap } from '../../send/record.js';
import type { Recorded } from '../../send/exchange.js';
import type { KindSend } from '../kind-main.js';
import { apiKeyMasks } from '../key-masks.js';

export const soapSend: KindSend<'soap'> = {
  selected(project, requestId, draft) {
    // Orphaned or not: the editor sends what it shows.
    const found = soapItemFor(project, requestId);
    return found === undefined || draft.override === undefined ? found : { ...found, override: draft.override };
  },

  summarise({ deps, sendId, sent, masks, show, requestId }) {
    const exchange = soapSent(sent);
    const { summary, full } = summariseSoap(deps.hostState.redactor, deps.service, sendId, exchange.soap, {
      ...(requestId !== undefined ? { requestId } : {}),
      requestEnvelopeXml: exchange.input.envelopeXml,
      ...masks,
      show,
    });
    return { summary, unredacted: full };
  },

  async record(deps, recorded, sent, _summary, unredacted) {
    const exchange = soapSent(sent);
    await recordSoap(deps, {
      ...soapRequestId(recorded),
      names: soapNames(recorded),
      input: exchange.input,
      ...(unredacted !== undefined ? { exchange: unredacted } : {}),
      // The exchange's own time on the wire: History has never counted resolving and connecting.
      durationMs: exchange.soap.durationMs,
      ...(recorded.label !== undefined ? { label: recorded.label } : {}),
    });
  },

  async recordFailure(deps, recorded, failed, error) {
    if (failed.input === undefined) return;
    await recordSoap(deps, {
      ...soapRequestId(recorded),
      names: soapNames(recorded),
      input: failed.input as SoapSendInput,
      error,
      durationMs: failed.durationMs,
      ...(recorded.label !== undefined ? { label: recorded.label } : {}),
    });
  },

  sentAudit(exchange, summary) {
    const { request, status } = exchange.soap.http;
    return { method: request.method, url: request.url, status, outcome: 'ok', durationMs: summary.durationMs };
  },

  failedAudit(_item, failed) {
    const input = failed.input as SoapSendInput | undefined;
    return input === undefined
      ? undefined
      : { status: null, outcome: 'failed', durationMs: failed.durationMs, method: 'POST', url: input.endpoint };
  },

  keyMasks(item) {
    const auth = soapEffectiveAuth(item);
    return auth === undefined ? {} : apiKeyMasks(auth);
  },
};

function soapSent(sent: SentRequest): Extract<NonNullable<SentRequest['exchange']>, { kind: 'soap' }> {
  if (sent.exchange?.kind !== 'soap') throw new Error('A SOAP send came back without its exchange');
  return sent.exchange;
}

/** The request a SOAP entry is keyed to: the saved one, or the one an ad-hoc resend came from. */
function soapRequestId(recorded: Recorded): { readonly requestId?: string } {
  if (recorded.adHoc === undefined) return { requestId: recorded.item.request.id };
  return recorded.adHocRequestId !== undefined ? { requestId: recorded.adHocRequestId } : {};
}

/** What History names a SOAP item by when the project has no meta for it: an ad-hoc send's own names. */
function soapNames(recorded: Recorded): HistoryNameFallback {
  if (recorded.adHoc !== undefined) return recorded.adHoc;
  const { item } = recorded;
  return item.kind === 'soap'
    ? { requestName: item.request.name, interfaceName: item.iface.name, operationName: item.operation.name }
    : { requestName: item.request.name, interfaceName: '', operationName: '' };
}
