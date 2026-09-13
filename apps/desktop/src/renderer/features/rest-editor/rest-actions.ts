/**
 * Opening and closing a REST request's editor tab. The editor itself arrives with the next task;
 * what is fixed here is the tab's id — `rest:<requestId>` — which the explorer, the commands, the
 * persisted-tab restore and the store's cleanup all address it by.
 */
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';

/** The editor-tab id for one REST request. */
export function restTabId(requestId: string): string {
  return `rest:${requestId}`;
}

/** Opens (or focuses) the REST request's tab. A request the mirror does not hold is ignored. */
export function openRestRequestTab(requestId: string, fallbackTitle?: string): void {
  const title = useProjectStore.getState().restRequests[requestId]?.name ?? fallbackTitle;
  if (title === undefined) {
    return;
  }
  useEditorsStore.getState().open({ id: restTabId(requestId), kind: 'rest-request', title, restRequestId: requestId });
}
