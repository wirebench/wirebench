import type { IpcError, IpcResult } from '@shared/ipc.js';
import { useEditorsStore } from '../../../state/editors.js';
import { ipc } from '../../../state/ipc-client.js';
import { useUiStore } from '../../../state/ui.js';
import { openTrustPrompt } from '../connect.js';
import { useHostsStore } from '../hosts-store.js';
import { forwardKey, listenAddress } from './forward-format.js';
import { useForwardsStore } from './forwards-store.js';

/**
 * What a start may carry beyond the rule: a port for this run only, a confirmed network bind, and the
 * forwarding group whose Start group asked for it.
 */
export interface StartOptions {
  readonly port?: number;
  readonly confirmBind?: true;
  readonly group?: string;
}

function ruleOf(hostId: string, ruleId: string) {
  const host = useHostsStore.getState().resolved.find((h) => h.id === hostId);
  return { host, forward: host?.forwards.find((f) => f.rule.id === ruleId) };
}

/** `db-1 · pg`, as prompts and the palette name a forward. */
export function forwardLabel(hostId: string, ruleId: string): string {
  return `${ruleOf(hostId, ruleId).host?.name ?? hostId} · ${ruleId}`;
}

/** The answer of a call, with a call that threw (the channel went) as a refusal. */
async function answer<T>(call: () => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  try {
    return await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The forward could not be reached';
    const refusal: IpcError = { code: 'ssh-forward-failed', message };
    return { ok: false, error: refusal };
  }
}

/**
 * A prompt for a rule's start was dismissed: the rule is left stopped, not failed (main cleared too).
 */
export function cancelPromptedStart(hostId: string, ruleId: string): void {
  useForwardsStore.getState().setWaiting(forwardKey(hostId, ruleId), false);
  void stopForward(hostId, ruleId);
}

/**
 * Starts a rule. Every start in the UI goes through here, so the prompts are handled once: a network bind
 * not yet confirmed asks first and starts again with `confirmBind`; a host key not yet trusted opens the
 * trust dialog and starts again after trust. Prompts raised together (a group's start) queue and are asked
 * in turn; while its prompt waits the rule counts as waiting, not failed. Any other refusal is kept for the
 * rule's row.
 */
export async function startForward(hostId: string, ruleId: string, options: StartOptions = {}): Promise<void> {
  const store = useForwardsStore.getState();
  const key = forwardKey(hostId, ruleId);
  store.setStartError(key, undefined);
  const result = await answer(() => ipc().forward.start({ hostId, ruleId, ...options }));
  store.setWaiting(key, false);
  if (result.ok) return;
  const { code, message, details } = result.error;
  if (code === 'ssh-forward-bind-unconfirmed') {
    // `details.address` is the rule's bind; the prompt names the port it would run on too.
    const bind = typeof details?.['address'] === 'string' ? details['address'] : undefined;
    const port = options.port ?? ruleOf(hostId, ruleId).forward?.rule.port;
    const address = bind === undefined || port === undefined ? (bind ?? '') : listenAddress(bind, port);
    store.setWaiting(key, true);
    store.setBindPrompt({
      hostId,
      ruleId,
      label: forwardLabel(hostId, ruleId),
      address,
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.group === undefined ? {} : { group: options.group }),
    });
    return;
  }
  if ((code === 'ssh-host-key-new' || code === 'ssh-host-key-changed') && details) {
    store.setWaiting(key, true);
    openTrustPrompt(
      { paneId: `forward:${key}`, hostId },
      {
        retry: () => {
          void startForward(hostId, ruleId, options);
        },
        cancel: () => {
          cancelPromptedStart(hostId, ruleId);
        },
      },
      details,
    );
    return;
  }
  store.setStartError(key, { code, message });
}

/** Stops a forward (a failed one is cleared). One this window no longer has is simply gone from the store. */
export async function stopForward(hostId: string, ruleId: string): Promise<void> {
  const store = useForwardsStore.getState();
  const key = forwardKey(hostId, ruleId);
  store.setStartError(key, undefined);
  const result = await answer(() => ipc().forward.stop({ hostId, ruleId }));
  if (!result.ok && result.error.code !== 'ssh-forward-unknown') {
    store.setStartError(key, { code: result.error.code, message: result.error.message });
    return;
  }
  const state = useForwardsStore.getState().byKey[key];
  if (state !== undefined) useForwardsStore.getState().apply({ ...state, status: { state: 'stopped' } });
}

/** Stops every forward of this window. */
export async function stopAllForwards(): Promise<void> {
  await answer(() => ipc().forward.stopAll({}));
}

/** Stops a running forward and starts it with the rule as it now is (after `hosts.yaml` changed it). */
export async function restartForward(hostId: string, ruleId: string): Promise<void> {
  await stopForward(hostId, ruleId);
  await startForward(hostId, ruleId);
}

/** "Start on another port…": asks for a port, pre-filled with the first free one above the rule's. */
export async function askForPort(hostId: string, ruleId: string): Promise<void> {
  const rule = ruleOf(hostId, ruleId).forward?.rule;
  if (rule === undefined) return;
  const free = await answer(() => ipc().forward.freePort({ near: rule.port }));
  useForwardsStore.getState().setPortPrompt({
    hostId,
    ruleId,
    label: forwardLabel(hostId, ruleId),
    suggested: free.ok ? free.value.port : Math.min(rule.port + 1, 65535),
  });
}

/** Shows the Port forwarding view in the SSH area's fixed first tab. */
export function showForwarding(): void {
  const { sidebar, showSidebarView } = useUiStore.getState();
  if (!sidebar.visible || sidebar.view !== 'ssh') showSidebarView('ssh');
  useHostsStore.getState().setHomeView('forwarding');
  const editors = useEditorsStore.getState();
  editors.showSet('ssh');
  editors.showStart();
}
