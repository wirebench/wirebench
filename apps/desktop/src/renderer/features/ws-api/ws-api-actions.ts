/**
 * Opening a WebSocket API's tab. The id — `ws-api:<apiId>` — is fixed here because the explorer,
 * the persisted-tab restore and the store's cleanup all use it.
 */
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';

/** The editor-tab id for one WebSocket API. */
export function wsApiTabId(apiId: string): string {
  return `ws-api:${apiId}`;
}

/** Opens (or focuses) the WebSocket API's tab. An API the mirror does not hold is ignored. */
export function openWsApiTab(apiId: string, fallbackTitle?: string): void {
  const title = useProjectStore.getState().wsApis[apiId]?.name ?? fallbackTitle;
  if (title === undefined) {
    return;
  }
  useEditorsStore.getState().open({ id: wsApiTabId(apiId), kind: 'ws-api', title, wsApiId: apiId });
}
