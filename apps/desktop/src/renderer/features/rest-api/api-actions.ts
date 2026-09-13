/**
 * Opening an API's tab. Its contents arrive with the API tab task; the id — `api:<apiId>` — is
 * fixed here because the explorer, the persisted-tab restore and the store's cleanup all use it.
 */
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';

/** The editor-tab id for one API. */
export function apiTabId(apiId: string): string {
  return `api:${apiId}`;
}

/** Opens (or focuses) the API's tab. An API the mirror does not hold is ignored. */
export function openApiTab(apiId: string, fallbackTitle?: string): void {
  const title = useProjectStore.getState().apis[apiId]?.name ?? fallbackTitle;
  if (title === undefined) {
    return;
  }
  useEditorsStore.getState().open({ id: apiTabId(apiId), kind: 'api', title, apiId });
}
