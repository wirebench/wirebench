/**
 * Opening a WebSocket request's editor tab. What is fixed here is the tab's id — `ws:<requestId>`
 * — which the explorer, the commands, the persisted-tab restore and the store's cleanup all
 * address it by.
 */
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';

/** The editor-tab id for one WebSocket request. */
export function wsTabId(requestId: string): string {
  return `ws:${requestId}`;
}

/** Opens (or focuses) the WebSocket request's tab. A request the mirror does not hold is ignored. */
export function openWsRequestTab(requestId: string, fallbackTitle?: string): void {
  const title = useProjectStore.getState().wsRequests[requestId]?.name ?? fallbackTitle;
  if (title === undefined) {
    return;
  }
  useEditorsStore.getState().open({ id: wsTabId(requestId), kind: 'ws-request', title, wsRequestId: requestId });
}
