import type { SshConnectProgressEvent } from '../../../shared/ssh-wire.js';
import { noteProgress } from './connect-store.js';
import { useHostsStore } from './hosts-store.js';
import { reconnectNow } from './reconnect.js';
import type { SessionEndReason } from './reconnect.js';

/** What a terminal tab hands over to receive one session's output and its end. */
export interface TerminalHandlers {
  write(data: Uint8Array): void;
  exit(code: number | null, reason: SessionEndReason): void;
}

interface Pending {
  chunks: Uint8Array[];
  bytes: number;
  exit?: { code: number | null; reason: SessionEndReason };
}

/** Output kept for a session no tab has attached to yet; beyond this the oldest chunks go. */
const PENDING_LIMIT = 1024 * 1024;

/** Detached sessions remembered so their late events are dropped instead of buffered; oldest go first. */
const ENDED_LIMIT = 256;

const attached = new Map<string, TerminalHandlers>();
const pending = new Map<string, Pending>();
const ended = new Set<string>();
/** Listeners told that a session printed something, whether or not a terminal shows it yet. */
const outputWatchers = new Map<string, Set<() => void>>();
/** When each session last printed (ms since the epoch), so a watcher that comes late still knows. */
const lastOutput = new Map<string, number>();

/** When the session last printed, if it has. */
export function lastOutputAt(sessionId: string): number | undefined {
  return lastOutput.get(sessionId);
}

/** Calls `listener` each time the session prints; returns the unsubscribe. */
export function watchOutput(sessionId: string, listener: () => void): () => void {
  let set = outputWatchers.get(sessionId);
  if (set === undefined) {
    set = new Set();
    outputWatchers.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) outputWatchers.delete(sessionId);
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function pendingFor(sessionId: string): Pending {
  let entry = pending.get(sessionId);
  if (entry === undefined) {
    entry = { chunks: [], bytes: 0 };
    pending.set(sessionId, entry);
  }
  return entry;
}

function onData(sessionId: string, data: Uint8Array): void {
  if (ended.has(sessionId)) return;
  lastOutput.set(sessionId, Date.now());
  for (const listener of [...(outputWatchers.get(sessionId) ?? [])]) listener();
  const handlers = attached.get(sessionId);
  if (handlers) {
    handlers.write(data);
    return;
  }
  const entry = pendingFor(sessionId);
  entry.chunks.push(data);
  entry.bytes += data.length;
  while (entry.bytes > PENDING_LIMIT) {
    const dropped = entry.chunks.shift();
    if (dropped === undefined) break;
    entry.bytes -= dropped.length;
  }
}

function onExit(sessionId: string, code: number | null, reason: SessionEndReason): void {
  if (ended.has(sessionId)) return;
  const handlers = attached.get(sessionId);
  if (handlers) {
    handlers.exit(code, reason);
    return;
  }
  pendingFor(sessionId).exit = { code, reason };
}

/** Routes a session's output to a terminal, first replaying what arrived before it attached. */
export function attachTerminal(sessionId: string, handlers: TerminalHandlers): void {
  ended.delete(sessionId);
  attached.set(sessionId, handlers);
  const entry = pending.get(sessionId);
  if (entry === undefined) return;
  pending.delete(sessionId);
  for (const chunk of entry.chunks) handlers.write(chunk);
  if (entry.exit !== undefined) handlers.exit(entry.exit.code, entry.exit.reason);
}

/**
 * Stops routing a session's output and forgets anything buffered for it. Events main had already sent
 * are dropped from then on, rather than buffered for a terminal that will never attach.
 */
export function detachTerminal(sessionId: string): void {
  attached.delete(sessionId);
  pending.delete(sessionId);
  lastOutput.delete(sessionId);
  ended.add(sessionId);
  if (ended.size > ENDED_LIMIT) {
    const oldest = ended.values().next().value;
    if (oldest !== undefined) ended.delete(oldest);
  }
}

/** Feeds an event as main would send it; tests only. */
export function __dispatchForTest(
  name: 'ssh.data' | 'ssh.exit' | 'localTerminal.data' | 'localTerminal.exit',
  payload: unknown,
): void {
  const event = payload as { sessionId: string; data?: string; code?: number | null; reason?: SessionEndReason };
  if (name === 'ssh.data' || name === 'localTerminal.data') onData(event.sessionId, base64ToBytes(event.data ?? ''));
  else onExit(event.sessionId, event.code ?? null, event.reason ?? 'exit');
}

type Listener = (payload: unknown) => void;
interface DataEvent {
  sessionId: string;
  data: string;
}
interface ExitEvent {
  sessionId: string;
  code: number | null;
  reason: SessionEndReason;
}
interface StateEvent {
  sessionId: string;
  state: 'open' | 'closed';
}

/** Listens for every session's output, end and state, and for the moments to reconnect at once; called once from the shell. */
export function subscribeToSshEvents(): () => void {
  // `defineEvent` types every event's `name` as `string`, so the event map cannot narrow a payload
  // by channel; the casts are the ones the other mirrors use.
  const offs = [
    window.wirebench.on('ssh.data', ((event: DataEvent) => {
      onData(event.sessionId, base64ToBytes(event.data));
    }) as Listener),
    window.wirebench.on('ssh.exit', ((event: ExitEvent) => {
      onExit(event.sessionId, event.code, event.reason);
    }) as Listener),
    // A local terminal's shell (#410) prints and ends the same way; its ids never clash with an SSH session's.
    window.wirebench.on('localTerminal.data', ((event: DataEvent) => {
      onData(event.sessionId, base64ToBytes(event.data));
    }) as Listener),
    window.wirebench.on('localTerminal.exit', ((event: { sessionId: string; code: number | null }) => {
      onExit(event.sessionId, event.code, 'exit');
    }) as Listener),
    window.wirebench.on('ssh.resumed', reconnectNow),
    window.wirebench.on('ssh.state', ((event: StateEvent) => {
      useHostsStore.getState().noteSessionState(event.sessionId, event.state);
    }) as Listener),
    window.wirebench.on('ssh.connectProgress', ((event: SshConnectProgressEvent) => {
      noteProgress(event.attemptId, event.event);
    }) as Listener),
  ];
  window.addEventListener('online', reconnectNow);
  return () => {
    for (const off of offs) off();
    window.removeEventListener('online', reconnectNow);
  };
}
