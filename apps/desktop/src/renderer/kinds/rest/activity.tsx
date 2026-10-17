import { lazy } from 'react';
import type { HistoryEntryWire } from '../../../shared/wire-types.js';
import { isSseExchange } from '../../features/console/log-row-actions.js';
import { MethodBadge } from '../../features/rest-api/method-badge.js';
import { requestDisplayName } from '../../features/rest-api/request-display-name.js';
import { openRestRequestTab } from '../../features/rest-editor/rest-actions.js';
import { ContractChip } from '../../features/rest-editor/response/contract-chip.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { ipc } from '../../state/ipc-client.js';
import type { KindHistory, KindLog, KindRequests, KindSearch } from '../renderer-kind.js';

// Split out with the History entry tab it is drawn in.
const SseHistoryBody = lazy(async () => {
  const module = await import('./history-body.js');
  return { default: module.SseHistoryBody };
});

export const restRequests: KindRequests = {
  open: openRestRequestTab,
  exists: (requestId, project) => project.restRequests[requestId] !== undefined,
  // A webhook item is a REST request in the project's webhook collection, which is not an API.
  quickOpen: (project) =>
    Object.values(project.restRequests).map((request) => ({
      id: request.id,
      tag: request.body.kind === 'graphql' ? 'GQL' : request.method,
      name: request.name,
      apiId: request.apiId,
      apiName: project.apis[request.apiId]?.name ?? 'Webhooks',
      ...(request.folderId !== undefined ? { folderId: request.folderId } : {}),
      match: request.url,
    })),
};

function RestHistoryBadge({ entry, place }: { readonly entry: HistoryEntryWire; readonly place: 'row' | 'header' }) {
  if (entry.method === undefined) {
    return <span className={place === 'row' ? 'w-12 shrink-0 text-fg-faint' : 'text-xs text-fg-faint'}>REST</span>;
  }
  return place === 'row' ? (
    <MethodBadge
      method={entry.method}
      title={`${entry.method} ${requestDisplayName(entry.requestName, entry.method)}`}
      className="w-12 text-left"
    />
  ) : (
    <MethodBadge method={entry.method} className="w-auto" />
  );
}

function RestHistoryChip({ entry }: { readonly entry: HistoryEntryWire }) {
  return <ContractChip result={entry.contract} />;
}

export const restHistory: KindHistory = {
  Badge: RestHistoryBadge,
  Chip: RestHistoryChip,
  Body: SseHistoryBody,
  hasBody: (entry) => entry.sse !== undefined,
  // An event stream has no live pane to run in (the HTTP Log draws the same line).
  canResend: (entry) => entry.sse === undefined,
  resend: (id) => ipc().history.resendRest({ id }),
  // From its own exchange map: the SOAP map never holds a REST response.
  current: (requestId) => {
    const current = useExchangesStore.getState().restByRequest[requestId]?.exchange;
    return current === undefined ? undefined : { label: 'Current', restExchange: current };
  },
};

export const restSearch: KindSearch = { badge: 'REST' };

export const restLog: KindLog = {
  resendRefusal: (entry) => (isSseExchange(entry) ? 'Event streams resend from the editor' : undefined),
};
