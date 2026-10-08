import { ipc } from '../../state/ipc-client.js';
import { useProblemsStore } from '../../state/problems.js';
import { useHostsStore } from './hosts-store.js';

interface Size {
  cols: number;
  rows: number;
}

/** What a connect asks for before a terminal exists to measure; the terminal resizes the session on mount. */
export const DEFAULT_TERMINAL_SIZE: Size = { cols: 80, rows: 24 };

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
  store.setSession(hostId, { state: 'connecting' });
  const result = await ipc().ssh.connect({ hostId, ...size });
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
