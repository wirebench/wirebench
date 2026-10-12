import { useEditorsStore } from '../../state/editors.js';
import { ipc } from '../../state/ipc-client.js';
import { useProblemsStore } from '../../state/problems.js';
import { findHost, useHostsStore } from './hosts-store.js';
import { isRetryableConnectError } from './reconnect.js';
import type { AttemptOutcome } from './reconnect.js';

interface Size {
  cols: number;
  rows: number;
}

/** A connect that ends here leaves no session: the problem says why, the terminal tab offers a retry. */
function recordProblem(hostId: string, code: string, message: string): void {
  useHostsStore.getState().noteConnectFailed(hostId);
  useProblemsStore
    .getState()
    .add([{ groupId: `ssh:${hostId}`, source: 'hosts', severity: 'error', problem: { code, message } }]);
}

function openTrustPrompt(hostId: string, size: Size, details: Readonly<Record<string, unknown>>): void {
  useHostsStore.getState().setTrustPrompt({
    hostId,
    size,
    host: String(details['host']),
    keyType: String(details['keyType']),
    fingerprint: String(details['fingerprint']),
    ...(typeof details['previous'] === 'string' ? { previous: details['previous'] } : {}),
  });
}

/** What one connect came to. */
type ConnectOutcome =
  | { readonly kind: 'open'; readonly sessionId: string }
  /** Another connect for the host is already running. */
  | { readonly kind: 'busy' }
  /** The host key is new or changed: the trust prompt is open. */
  | { readonly kind: 'trust' }
  /** Recorded in Problems. */
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

async function connectOutcome(hostId: string, size: Size): Promise<ConnectOutcome> {
  const store = useHostsStore.getState();
  const existing = store.sessions[hostId];
  if (existing?.state === 'connecting') return { kind: 'busy' };
  if (existing?.state === 'open' && existing.sessionId !== undefined) {
    return { kind: 'open', sessionId: existing.sessionId };
  }
  useProblemsStore.getState().clear(`ssh:${hostId}`);
  store.setSession(hostId, { state: 'connecting' });
  let result;
  try {
    result = await ipc().ssh.connect({ hostId, ...size });
  } catch (error) {
    store.setSession(hostId, undefined);
    const shaped = error as { code?: unknown; message?: unknown } | null;
    const code = typeof shaped?.code === 'string' ? shaped.code : 'ssh-connect-failed';
    const message = typeof shaped?.message === 'string' ? shaped.message : 'The connection could not be started';
    recordProblem(hostId, code, message);
    return { kind: 'failed', code, message };
  }
  if (result.ok) {
    store.setSession(hostId, { sessionId: result.value.sessionId, state: 'open' });
    return { kind: 'open', sessionId: result.value.sessionId };
  }
  store.setSession(hostId, undefined);
  const { code, message, details } = result.error;
  if ((code === 'ssh-host-key-new' || code === 'ssh-host-key-changed') && details) {
    openTrustPrompt(hostId, size, details);
    return { kind: 'trust' };
  }
  recordProblem(hostId, code, message);
  return { kind: 'failed', code, message };
}

/**
 * Opens a shell on a host. An unknown or changed host key is not an error: it opens the trust prompt and the
 * connect resumes from {@link confirmTrust}. Any other failure becomes a Problems entry.
 */
export async function connectToHost(hostId: string, size: Size): Promise<{ sessionId: string } | undefined> {
  const outcome = await connectOutcome(hostId, size);
  return outcome.kind === 'open' ? { sessionId: outcome.sessionId } : undefined;
}

/**
 * One reconnect attempt for a dropped session. Only a failure to reach the host is retried; a host key
 * (the trust prompt opens, as for any connect), a sign-in failure or anything else stops the loop with its
 * reason in Problems. A connect already running elsewhere stops it too: that connect's session lands in
 * the tab.
 */
export async function reconnectToHost(hostId: string, size: Size): Promise<AttemptOutcome> {
  const outcome = await connectOutcome(hostId, size);
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
  if (trusted.ok) return connectToHost(prompt.hostId, prompt.size);
  const { code, message, details } = trusted.error;
  // The key changed between the refusal and the click: show the user what it is now.
  if (code === 'ssh-host-key-changed' && details) {
    openTrustPrompt(prompt.hostId, prompt.size, details);
    return undefined;
  }
  // Main no longer holds the refusal (expired, or another window trusted the key): a fresh connect settles it.
  if (code === 'ssh-host-key-unexpected') return connectToHost(prompt.hostId, prompt.size);
  recordProblem(prompt.hostId, code, message);
  return undefined;
}

/** The editor-tab id of a host's terminal: one terminal tab per host. */
export function terminalTabId(hostId: string): string {
  return `ssh:${hostId}`;
}

/**
 * Opens (or brings forward) the host's terminal tab; the tab connects itself when it mounts. An open tab
 * with no live or pending session (and no trust prompt waiting) connects again, so Connect on a host
 * whose last attempt failed or ended retries.
 */
export function openTerminalFor(hostId: string): void {
  const hosts = useHostsStore.getState();
  const editors = useEditorsStore.getState();
  const id = terminalTabId(hostId);
  const state = hosts.sessions[hostId]?.state;
  const settled = state !== 'connecting' && state !== 'open' && hosts.trustPrompt?.hostId !== hostId;
  if (settled && editors.tabs.some((t) => t.id === id)) {
    hosts.bumpReconnect(hostId);
  }
  const title = hosts.resolved.find((h) => h.id === hostId)?.name ?? findHost(hosts.file, hostId)?.name ?? hostId;
  editors.open({ id, kind: 'ssh-terminal', title, hostId });
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
