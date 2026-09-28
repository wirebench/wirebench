/**
 * Opening a catch URL's tab. The id — `catch-url:<hookId>` — is fixed here because the explorer,
 * the tab itself and the store's cleanup all use it. Also `webhooksActions`: what the Webhooks
 * node's and a catch URL's context menus run (webhook-capture §4.2).
 */
import { showToast } from '../../components/toast.js';
import { useEditorsStore } from '../../state/editors.js';
import { ipc } from '../../state/ipc-client.js';
import { forgetSeen } from '../../state/webhooks-seen.js';
import { useWebhooksStore } from '../../state/webhooks.js';
import { useWebhooksDialogs, type WebhooksConfirm } from './webhooks-dialogs-state.js';

export function catchUrlTabId(hookId: string): string {
  return `catch-url:${hookId}`;
}

/** Opens (or focuses) the catch URL's tab. One the store does not list is ignored. */
export function openCatchUrlTab(hookId: string): void {
  const hook = useWebhooksStore.getState().hooks.find((candidate) => candidate.id === hookId);
  if (hook === undefined) return;
  useEditorsStore.getState().open({ id: catchUrlTabId(hookId), kind: 'catch-url', title: hook.name, hookId });
}

const VERBS: Readonly<Record<WebhooksConfirm['action'], string>> = {
  rotate: 'rotate the URL',
  clear: 'clear the captures',
  delete: 'delete the catch URL',
};

/** What the Webhooks node's and a catch URL's menus run. */
export const webhooksActions = {
  newCatchUrl(): void {
    useWebhooksDialogs.getState().openSettings(undefined);
  },

  openSettings(hookId: string): void {
    useWebhooksDialogs.getState().openSettings(hookId);
  },

  async copyUrl(hookId: string): Promise<void> {
    const hook = useWebhooksStore.getState().hooks.find((candidate) => candidate.id === hookId);
    if (hook === undefined) return;
    await navigator.clipboard?.writeText(hook.url);
    showToast('Catch URL copied');
  },

  confirm(action: WebhooksConfirm['action'], hookId: string): void {
    useWebhooksDialogs.getState().askConfirm({ action, hookId });
  },

  /** Runs a confirmed change, then re-lists at once: the `hooks` nudge does not reach a device offline. */
  async run(action: WebhooksConfirm['action'], hookId: string): Promise<void> {
    const store = useWebhooksStore.getState();
    const server = store.server;
    if (server === undefined) return;
    const ref = { url: server.url, workspaceId: server.workspaceId, hookId };
    const result =
      action === 'rotate'
        ? await ipc().hooks.rotate(ref)
        : action === 'clear'
          ? await ipc().hooks.clear(ref)
          : await ipc().hooks.remove(ref);
    if (!result.ok) {
      showToast(`Could not ${VERBS[action]}: ${result.error.message}`);
      return;
    }
    if (action === 'clear') store.markSeen(hookId, null);
    if (action === 'delete') useEditorsStore.getState().close(catchUrlTabId(hookId));
    await useWebhooksStore.getState().refresh();
    // After the re-list, not before: a re-list that still lists this catch URL (main has not
    // caught up yet) would otherwise treat the forgotten marker as a first sight and rewrite it.
    if (action === 'delete') forgetSeen(server.url, hookId);
  },
};
