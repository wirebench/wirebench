import { lazy } from 'react';
import { openWsRequestTab } from '../../features/ws-editor/ws-actions.js';
import type { KindHistory, KindLog, KindRequests, KindSearch } from '../renderer-kind.js';

// Split out with the History entry tab it is drawn in.
const WsHistoryBody = lazy(async () => {
  const module = await import('./history-body.js');
  return { default: module.WsHistoryBody };
});

export const wsRequests: KindRequests = {
  open: openWsRequestTab,
  exists: (requestId, project) => project.wsRequests[requestId] !== undefined,
  quickOpen: (project) =>
    Object.values(project.wsRequests).map((request) => ({
      id: request.id,
      tag: 'WS',
      name: request.name,
      apiId: request.apiId,
      apiName: project.wsApis[request.apiId]?.name ?? 'WebSocket API',
      ...(request.folderId !== undefined ? { folderId: request.folderId } : {}),
      match: request.url,
    })),
};

function WsHistoryBadge({ place }: { readonly place: 'row' | 'header' }) {
  return place === 'row' ? (
    <span data-testid="history-ws-badge" className="w-12 shrink-0 text-fg-faint">
      WS
    </span>
  ) : (
    <span className="text-xs text-fg-faint">WS</span>
  );
}

export const wsHistory: KindHistory = {
  Badge: WsHistoryBadge,
  Body: WsHistoryBody,
  hasBody: (entry) => entry.ws !== undefined,
  // A session resends from its request.
  canResend: () => false,
};

export const wsSearch: KindSearch = { badge: 'WS' };

export const wsLog: KindLog = {
  noResend: 'A WebSocket session reconnects from the request',
  noBody: 'A handshake has no body',
};
