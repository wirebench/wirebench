import { useEditorsStore } from '../../state/editors.js';
import { ipc } from '../../state/ipc-client.js';
import { useProblemsStore } from '../../state/problems.js';
import { findHost, useHostsStore } from './hosts-store.js';
import { hasHost, leaves, onePane } from './panes/pane-tree.js';
import type { PaneLeaf } from './panes/pane-tree.js';
import { isRetryableConnectError } from './reconnect.js';
import type { AttemptOutcome } from './reconnect.js';

export interface Size {
  cols: number;
  rows: number;
}

/** A connect that ends here leaves no session: the problem says why, the pane offers a retry. */
function recordProblem({ paneId, hostId }: PaneLeaf, code: string, message: string): void {
  useHostsStore.getState().noteConnectFailed(paneId);
  useProblemsStore
    .getState()
    .add([{ groupId: `ssh:${hostId}`, source: 'hosts', severity: 'error', problem: { code, message } }]);
}

/** How a trust prompt resumes: a terminal pane's connect at its size, or another caller's own retry. */
export type TrustResume = { readonly size: Size } | { readonly retry: () => void; readonly cancel: () => void };

/** Shows the trust prompt for a refused host key (`details` from `ssh-host-key-new` / `-changed`). */
export function openTrustPrompt(
  { paneId, hostId }: PaneLeaf,
  resume: TrustResume,
  details: Readonly<Record<string, unknown>>,
): void {
  useHostsStore.getState().setTrustPrompt({
    paneId,
    hostId,
    ...resume,
    host: String(details['host']),
    keyType: String(details['keyType']),
    fingerprint: String(details['fingerprint']),
    ...(typeof details['previous'] === 'string' ? { previous: details['previous'] } : {}),
  });
}

/** What one connect came to. */
type ConnectOutcome =
  | { readonly kind: 'open'; readonly sessionId: string }
  /** Another connect for the pane is already running. */
  | { readonly kind: 'busy' }
  /** The host key is new or changed: the trust prompt is open. */
  | { readonly kind: 'trust' }
  /** Recorded in Problems. */
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

async function connectOutcome(pane: PaneLeaf, size: Size): Promise<ConnectOutcome> {
  const { paneId, hostId } = pane;
  const store = useHostsStore.getState();
  const existing = store.panes[paneId];
  if (existing?.state === 'connecting') return { kind: 'busy' };
  if (existing?.state === 'open' && existing.sessionId !== undefined) {
    return { kind: 'open', sessionId: existing.sessionId };
  }
  useProblemsStore.getState().clear(`ssh:${hostId}`);
  store.setPane(paneId, { hostId, state: 'connecting' });
  let result;
  try {
    result = await ipc().ssh.connect({ hostId, ...size });
  } catch (error) {
    store.setPane(paneId, undefined);
    const shaped = error as { code?: unknown; message?: unknown } | null;
    const code = typeof shaped?.code === 'string' ? shaped.code : 'ssh-connect-failed';
    const message = typeof shaped?.message === 'string' ? shaped.message : 'The connection could not be started';
    recordProblem(pane, code, message);
    return { kind: 'failed', code, message };
  }
  if (result.ok) {
    store.setPane(paneId, { hostId, sessionId: result.value.sessionId, state: 'open' });
    return { kind: 'open', sessionId: result.value.sessionId };
  }
  store.setPane(paneId, undefined);
  const { code, message, details } = result.error;
  if ((code === 'ssh-host-key-new' || code === 'ssh-host-key-changed') && details) {
    openTrustPrompt(pane, { size }, details);
    return { kind: 'trust' };
  }
  recordProblem(pane, code, message);
  return { kind: 'failed', code, message };
}

/**
 * Opens a shell on a pane's host. An unknown or changed host key is not an error: it opens the trust prompt and the
 * connect resumes from {@link confirmTrust}. Any other failure becomes a Problems entry.
 */
export async function connectToHost(pane: PaneLeaf, size: Size): Promise<{ sessionId: string } | undefined> {
  const outcome = await connectOutcome(pane, size);
  return outcome.kind === 'open' ? { sessionId: outcome.sessionId } : undefined;
}

/**
 * One reconnect attempt for a dropped session. Only a failure to reach the host is retried; a host key
 * (the trust prompt opens, as for any connect), a sign-in failure or anything else stops the loop with its
 * reason in Problems. A connect already running for the pane stops it too: that connect's session lands
 * in the pane.
 */
export async function reconnectToHost(pane: PaneLeaf, size: Size): Promise<AttemptOutcome> {
  const outcome = await connectOutcome(pane, size);
  if (outcome.kind === 'open') return { kind: 'open' };
  if (outcome.kind === 'failed' && isRetryableConnectError(outcome.code)) {
    return { kind: 'retry', message: outcome.message };
  }
  return { kind: 'stop' };
}

/** Records the key the prompt showed (after the user's click), then connects again. */
export async function confirmTrust(replace: boolean): Promise<{ sessionId: string } | undefined> {
  const prompt = useHostsStore.getState().trustPrompt;
  if (!prompt) return undefined;
  useHostsStore.getState().setTrustPrompt(null);
  const trusted = await ipc().ssh.trustHostKey({
    host: prompt.host,
    keyType: prompt.keyType,
    fingerprint: prompt.fingerprint,
    replace,
  });
  const pane = { paneId: prompt.paneId, hostId: prompt.hostId };
  const { retry, cancel, size } = prompt;
  const resume: TrustResume | undefined =
    retry !== undefined && cancel !== undefined ? { retry, cancel } : size !== undefined ? { size } : undefined;
  if (resume === undefined) return undefined;
  const again = async (): Promise<{ sessionId: string } | undefined> => {
    if ('retry' in resume) {
      resume.retry();
      return undefined;
    }
    return connectToHost(pane, resume.size);
  };
  if (trusted.ok) return again();
  const { code, message, details } = trusted.error;
  // The key changed between the refusal and the click: show the user what it is now.
  if (code === 'ssh-host-key-changed' && details) {
    openTrustPrompt(pane, resume, details);
    return undefined;
  }
  // Main no longer holds the refusal (expired, or another window trusted the key): a fresh connect settles it.
  if (code === 'ssh-host-key-unexpected') return again();
  if ('cancel' in resume) {
    resume.cancel();
    useProblemsStore
      .getState()
      .add([{ groupId: `ssh:${prompt.hostId}`, source: 'hosts', severity: 'error', problem: { code, message } }]);
    return undefined;
  }
  recordProblem(pane, code, message);
  return undefined;
}

/** Whether an open terminal tab still holds the pane: a connect that ends after its pane went must not linger. */
export function paneIsOpen(paneId: string): boolean {
  return useEditorsStore
    .getState()
    .tabs.some((tab) => tab.panes !== undefined && leaves(tab.panes).some((leaf) => leaf.paneId === paneId));
}

/**
 * Brings forward the terminal tab used most recently that has a pane on the host, or opens a new one-pane
 * tab (`ssh-terminal:<uuid>`), which connects itself when it mounts. A pane on the host with no live or
 * pending session (and no trust prompt waiting) connects again, so Connect on a host whose last attempt
 * failed or ended retries.
 */
export function openTerminalFor(hostId: string): void {
  const hosts = useHostsStore.getState();
  const editors = useEditorsStore.getState();
  const use = (id: string): number => hosts.terminalTabUse[id] ?? 0;
  const tab = editors.tabs
    .filter((t) => t.kind === 'ssh-terminal' && t.panes !== undefined && hasHost(t.panes, hostId))
    .reduce<(typeof editors.tabs)[number] | undefined>(
      (best, t) => (best === undefined || use(t.id) > use(best.id) ? t : best),
      undefined,
    );
  if (tab?.panes !== undefined) {
    for (const { paneId } of leaves(tab.panes).filter((leaf) => leaf.hostId === hostId)) {
      const state = hosts.panes[paneId]?.state;
      if (state !== 'connecting' && state !== 'open' && hosts.trustPrompt?.paneId !== paneId) {
        hosts.bumpReconnect(paneId);
      }
    }
    editors.activate(tab.id);
    return;
  }
  const title = hosts.resolved.find((h) => h.id === hostId)?.name ?? findHost(hosts.file, hostId)?.name ?? hostId;
  editors.open({ id: `ssh-terminal:${crypto.randomUUID()}`, kind: 'ssh-terminal', title, panes: onePane(hostId) });
}

/**
 * Opens the host's settings for editing in the details panel, bringing the Hosts tab to the front and
 * picking the host first: the panel only shows there.
 */
export function editHost(hostId: string): void {
  const editors = useEditorsStore.getState();
  editors.showSet('ssh');
  editors.showStart();
  const hosts = useHostsStore.getState();
  hosts.setHomeView('hosts');
  hosts.selectHost(hostId);
  hosts.openDialog({ mode: 'edit-host', id: hostId });
}
