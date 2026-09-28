/**
 * Opening a catch URL's tab. The id — `catch-url:<hookId>` — is fixed here because the explorer,
 * the tab itself and the store's cleanup all use it.
 */
import { useEditorsStore } from '../../state/editors.js';
import { useWebhooksStore } from '../../state/webhooks.js';

export function catchUrlTabId(hookId: string): string {
  return `catch-url:${hookId}`;
}

/** Opens (or focuses) the catch URL's tab. One the store does not list is ignored. */
export function openCatchUrlTab(hookId: string): void {
  const hook = useWebhooksStore.getState().hooks.find((candidate) => candidate.id === hookId);
  if (hook === undefined) return;
  useEditorsStore.getState().open({ id: catchUrlTabId(hookId), kind: 'catch-url', title: hook.name, hookId });
}
