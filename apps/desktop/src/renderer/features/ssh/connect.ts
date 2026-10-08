import { useEditorsStore } from '../../state/editors.js';
import { ipc } from '../../state/ipc-client.js';
import { useProblemsStore } from '../../state/problems.js';
import { findHost, useHostsStore } from './hosts-store.js';

interface Size {
  cols: number;
  rows: number;
}

function recordProblem(hostId: string, code: string, message: string): void {
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

/**
 * Opens a shell on a host. An unknown or changed host key is not an error: it opens the trust prompt and the
 * connect resumes from {@link confirmTrust}. Any other failure becomes a Problems entry.
 */
export async function connectToHost(hostId: string, size: Size): Promise<{ sessionId: string } | undefined> {
  const store = useHostsStore.getState();
  const existing = store.sessions[hostId];
  if (existing?.state === 'connecting') return undefined;
  if (existing?.state === 'open' && existing.sessionId !== undefined) return { sessionId: existing.sessionId };
  useProblemsStore.getState().clear(`ssh:${hostId}`);
  store.setSession(hostId, { state: 'connecting' });
  let result;
  try {
    result = await ipc().ssh.connect({ hostId, ...size });
  } catch (error) {
    store.setSession(hostId, undefined);
    const shaped = error as { code?: unknown; message?: unknown } | null;
    recordProblem(
      hostId,
      typeof shaped?.code === 'string' ? shaped.code : 'ssh-connect-failed',
      typeof shaped?.message === 'string' ? shaped.message : 'The connection could not be started',
    );
    return undefined;
  }
  if (result.ok) {
    store.setSession(hostId, { sessionId: result.value.sessionId, state: 'open' });
    return result.value;
  }
  store.setSession(hostId, undefined);
  const { code, message, details } = result.error;
  if ((code === 'ssh-host-key-new' || code === 'ssh-host-key-changed') && details) {
    openTrustPrompt(hostId, size, details);
    return undefined;
  }
  recordProblem(hostId, code, message);
  return undefined;
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

/** Opens (or brings forward) the host's terminal tab; the tab connects itself when it mounts. */
export function openTerminalFor(hostId: string): void {
  const { resolved, file } = useHostsStore.getState();
  const title = resolved.find((h) => h.id === hostId)?.name ?? findHost(file, hostId)?.name ?? hostId;
  useEditorsStore.getState().open({ id: terminalTabId(hostId), kind: 'ssh-terminal', title, hostId });
}
