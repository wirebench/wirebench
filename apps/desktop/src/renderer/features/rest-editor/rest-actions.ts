/**
 * Opening and closing a REST request's editor tab. The editor itself arrives with the next task;
 * what is fixed here is the tab's id — `rest:<requestId>` — which the explorer, the commands, the
 * persisted-tab restore and the store's cleanup all address it by.
 */
import { showToast } from '../../components/toast.js';
import { useEditorsStore } from '../../state/editors.js';
import { ipc } from '../../state/ipc-client.js';
import { folderChainOf, useProjectStore } from '../../state/project.js';

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

/**
 * The owner whose OAuth2 configuration a request actually authenticates with: itself if it
 * configures one, else the nearest folder up its chain, else its API.
 *
 * The same walk `rest/auth.ts` does on the send path — first non-`inherit` wins — but answering
 * "whose token is this?" rather than "what credentials go on the wire?". Returns `undefined` when
 * nothing in the chain uses OAuth2, which is what makes *Get OAuth2 Token* a no-op rather than an
 * error on a request that does not need one.
 */
export function oauth2OwnerOf(requestId: string): string | undefined {
  const state = useProjectStore.getState();
  const request = state.restRequests[requestId];
  if (request === undefined) {
    return undefined;
  }
  if (request.auth.type !== 'inherit') {
    return request.auth.type === 'oauth2' ? requestId : undefined;
  }
  for (const folder of [...folderChainOf(state.folders, request.folderId)].reverse()) {
    if (folder.auth !== undefined && folder.auth.type !== 'inherit') {
      return folder.auth.type === 'oauth2' ? folder.id : undefined;
    }
  }
  const api = state.apis[request.apiId];
  return api?.auth?.type === 'oauth2' ? api.id : undefined;
}

/**
 * Obtains a token for one request's OAuth2 owner, reporting what happened.
 *
 * The palette's counterpart to the inspector's *Get token* button: the same channel and the same
 * owner resolution, so a shortcut and a click cannot end up meaning different things. Takes the
 * request rather than reading the active tab, so this module stays independent of the commands.
 */
export async function getOAuth2Token(requestId: string | undefined): Promise<void> {
  const ownerId = requestId === undefined ? undefined : oauth2OwnerOf(requestId);
  if (ownerId === undefined) {
    showToast('This request does not use OAuth2.');
    return;
  }
  const result = await ipc().oauth2.fetchToken({ ownerId });
  showToast(result.ok ? 'Got an access token.' : result.error.message);
}
