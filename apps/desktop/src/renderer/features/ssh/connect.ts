import { useEditorsStore } from '../../state/editors.js';
import { ipc } from '../../state/ipc-client.js';
import { useProblemsStore } from '../../state/problems.js';
import { findHost, useHostsStore, type HostPrefill } from './hosts-store.js';
import { hasHost, leaves, onePane } from './panes/pane-tree.js';
import type { PaneLeaf } from './panes/pane-tree.js';
import {
  beginAttempt,
  failWaitingAttempt,
  noteConnected,
  noteFailed,
  noteTrust,
  signInUserOf,
} from './connect-store.js';
import type { ConnectError } from './connect-errors.js';
import { isQuickHostId, quickHostName, quickTargetOf, useQuickHostsStore } from './quick-hosts.js';
import type { SshQuickTarget } from '../../../shared/ssh-wire.js';
import { useRecentStore } from './recent-connections.js';
import { isRetryableConnectError } from './reconnect.js';
import type { AttemptOutcome } from './reconnect.js';

export interface Size {
  cols: number;
  rows: number;
}

/**
 * A connect that ends here leaves no session: the problem says why, the pane offers a retry, and the recent
 * connections note the failure.
 */
function recordProblem({ paneId, hostId }: PaneLeaf, code: string, message: string): void {
  useHostsStore.getState().noteConnectFailed(paneId);
  // A one-off server is no host of the recent list: it is gone with the window.
  if (!isQuickHostId(hostId)) useRecentStore.getState().record(hostId, 'failed');
  useProblemsStore
    .getState()
    .add([{ groupId: `ssh:${hostId}`, source: 'hosts', severity: 'error', problem: { code, message } }]);
}

/**
 * The host has no user and none was typed on the pane's screen: nothing connects, and the screen asks for
 * one (#532). Main would refuse the same way, but only after the screen showed a step running.
 */
export function missingUser(key: string, hostId: string): ConnectError | undefined {
  const host = useHostsStore.getState().resolved.find((h) => h.id === hostId);
  if (host?.incomplete?.field !== 'user' || signInUserOf(key) !== undefined) return undefined;
  return {
    code: 'ssh-host-incomplete',
    message: `${host.name} has no user; set it on the host or one of its groups`,
    details: { hostId, field: 'user' },
  };
}

/** The user typed on the pane's screen, as the connect request carries it. */
export function signInRequest(key: string): { user?: string } {
  const user = signInUserOf(key);
  return user === undefined ? {} : { user };
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

/**
 * A security key PIN typed on a pane's connection screen (#420), waiting for that pane's next connect. It
 * is taken once and lives only here, in memory: never stored, never sent with a later connect.
 */
const pendingPins = new Map<string, string>();

/** Hands `pin` to the pane's next connect (the screen then retries it). */
export function connectWithPin(paneId: string, pin: string): void {
  pendingPins.set(paneId, pin);
}

/**
 * A password typed on a pane's connection screen for this connect only (#721, #722): none is stored, or the
 * agent could not sign in. Like a PIN it is taken once, kept only in memory, and never stored.
 */
const pendingPasswords = new Map<string, string>();

/** Hands `password` to the pane's next connect (the screen then retries it). */
export function connectWithPassword(paneId: string, password: string): void {
  pendingPasswords.set(paneId, password);
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
  // The pane's connection screen follows this attempt: main reports its stages under the id.
  const attemptId = beginAttempt(paneId, 'terminal');
  const unset = missingUser(paneId, hostId);
  if (unset !== undefined) {
    store.setPane(paneId, undefined);
    noteFailed(paneId, attemptId, unset);
    recordProblem(pane, unset.code, unset.message);
    return { kind: 'failed', code: unset.code, message: unset.message };
  }
  const skPin = pendingPins.get(paneId);
  pendingPins.delete(paneId);
  const password = pendingPasswords.get(paneId);
  pendingPasswords.delete(paneId);
  const quick = quickTargetOf(hostId);
  let result;
  try {
    result = await ipc().ssh.connect({
      hostId,
      ...size,
      attemptId,
      ...signInRequest(paneId),
      ...(skPin === undefined ? {} : { skPin }),
      ...(password === undefined ? {} : { password }),
      ...(quick === undefined ? {} : { quick }),
    });
  } catch (error) {
    store.setPane(paneId, undefined);
    const shaped = error as { code?: unknown; message?: unknown } | null;
    const code = typeof shaped?.code === 'string' ? shaped.code : 'ssh-connect-failed';
    const message = typeof shaped?.message === 'string' ? shaped.message : 'The connection could not be started';
    noteFailed(paneId, attemptId, { code, message });
    recordProblem(pane, code, message);
    return { kind: 'failed', code, message };
  }
  if (result.ok) {
    const { agentForwarding, recording } = result.value;
    store.setPane(paneId, {
      hostId,
      sessionId: result.value.sessionId,
      state: 'open',
      ...(agentForwarding === undefined ? {} : { agentForwarding }),
      ...(recording === true ? { recording } : {}),
    });
    if (quick === undefined) useRecentStore.getState().record(hostId, 'connected');
    noteConnected(paneId, attemptId);
    return { kind: 'open', sessionId: result.value.sessionId };
  }
  store.setPane(paneId, undefined);
  const { code, message, details } = result.error;
  if ((code === 'ssh-host-key-new' || code === 'ssh-host-key-changed') && details) {
    // Trusting the key resumes this connect: a password typed for it goes with the resumed one.
    if (password !== undefined) pendingPasswords.set(paneId, password);
    noteTrust(paneId, attemptId, code === 'ssh-host-key-changed');
    openTrustPrompt(pane, { size }, details);
    return { kind: 'trust' };
  }
  noteFailed(paneId, attemptId, result.error);
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
  // The screen waiting on the prompt says why the connect stopped.
  failWaitingAttempt(prompt.paneId, trusted.error);
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
export function openTerminalFor(hostId: string): string {
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
    return tab.id;
  }
  return openInNewTab(hostId);
}

/** Opens another one-pane terminal tab on the host, whatever tabs it already has; returns its id. */
export function openInNewTab(hostId: string): string {
  const hosts = useHostsStore.getState();
  const title =
    hosts.resolved.find((h) => h.id === hostId)?.name ??
    findHost(hosts.file, hostId)?.name ??
    quickHostName(hostId) ??
    hostId;
  const id = `ssh-terminal:${crypto.randomUUID()}`;
  useEditorsStore.getState().open({ id, kind: 'ssh-terminal', title, panes: onePane(hostId) });
  return id;
}

/**
 * Opens the host's settings for editing in the details panel, bringing the Hosts tab to the front and
 * picking the host first: the panel only shows there. A host form with changes already open asks first.
 */
export function editHost(hostId: string): void {
  const hosts = useHostsStore.getState();
  const dialog = hosts.dialog;
  if (dialog?.mode === 'edit-host' && dialog.id === hostId) {
    showHostsTab();
    hosts.setDetailsOpen(true);
    return;
  }
  hosts.leaveForm(() => {
    showHostsTab();
    const after = useHostsStore.getState();
    after.selectHost(hostId);
    // The form lives in the details panel, so Edit opens it even when it was put away.
    after.setDetailsOpen(true);
    after.openDialog({ mode: 'edit-host', id: hostId });
  });
}

/**
 * Opens New host in the details panel on the Hosts tab, its draft card in the group it will be saved to.
 * A host form with changes already open asks first. `from` says where it starts: a group, a one-off
 * server's address, or a host to duplicate.
 */
export function newHost(from: { parent?: string; prefill?: HostPrefill; copyOf?: string } = {}): void {
  useHostsStore.getState().leaveForm(() => {
    showHostsTab();
    useHostsStore.getState().openDialog({ mode: 'new-host', ...from });
  });
}

/** Brings the SSH area's fixed tab to the front on its Hosts view, where the details panel shows. */
function showHostsTab(): void {
  const editors = useEditorsStore.getState();
  editors.showSet('ssh');
  editors.showStart();
  useHostsStore.getState().setHomeView('hosts');
}

/**
 * Connects to a server that is not saved (#537), with the agent: brings forward its terminal when it has one
 * in this window, or opens one; `newTab` always opens another. Returns the tab's id.
 */
export function connectQuick(target: SshQuickTarget, newTab = false): string {
  const hostId = useQuickHostsStore.getState().add(target);
  return newTab ? openInNewTab(hostId) : openTerminalFor(hostId);
}

/** Opens New host on the Hosts tab, filled in from a one-off server: Save then keeps it in hosts.yaml. */
export function saveQuickAsHost(target: SshQuickTarget): void {
  newHost({
    prefill: {
      name: target.address,
      address: target.address,
      port: target.port,
      ...(target.user === undefined ? {} : { user: target.user }),
    },
  });
}
