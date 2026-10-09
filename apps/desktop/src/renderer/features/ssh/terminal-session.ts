import { useHostsStore } from './hosts-store.js';

/** What a terminal tab hands over to receive one session's output and its end. */
export interface TerminalHandlers {
  write(data: Uint8Array): void;
  exit(code: number | null): void;
}

interface Pending {
  chunks: Uint8Array[];
  bytes: number;
  exit?: number | null;
}

/** Output kept for a session no tab has attached to yet; beyond this the oldest chunks go. */
const PENDING_LIMIT = 1024 * 1024;

/** Detached sessions remembered so their late events are dropped instead of buffered; oldest go first. */
const ENDED_LIMIT = 256;

const attached = new Map<string, TerminalHandlers>();
const pending = new Map<string, Pending>();
const ended = new Set<string>();

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

function onExit(sessionId: string, code: number | null): void {
  if (ended.has(sessionId)) return;
  const handlers = attached.get(sessionId);
  if (handlers) {
    handlers.exit(code);
    return;
  }
  pendingFor(sessionId).exit = code;
}

/** Routes a session's output to a terminal, first replaying what arrived before it attached. */
export function attachTerminal(sessionId: string, handlers: TerminalHandlers): void {
  ended.delete(sessionId);
  attached.set(sessionId, handlers);
  const entry = pending.get(sessionId);
  if (entry === undefined) return;
  pending.delete(sessionId);
  for (const chunk of entry.chunks) handlers.write(chunk);
  if (entry.exit !== undefined) handlers.exit(entry.exit);
}

/**
 * Stops routing a session's output and forgets anything buffered for it. Events main had already sent
 * are dropped from then on, rather than buffered for a terminal that will never attach.
 */
export function detachTerminal(sessionId: string): void {
  attached.delete(sessionId);
  pending.delete(sessionId);
  ended.add(sessionId);
  if (ended.size > ENDED_LIMIT) {
    const oldest = ended.values().next().value;
    if (oldest !== undefined) ended.delete(oldest);
  }
}

/** Feeds an event as main would send it; tests only. */
export function __dispatchForTest(name: 'ssh.data' | 'ssh.exit', payload: unknown): void {
  const event = payload as { sessionId: string; data?: string; code?: number | null };
  if (name === 'ssh.data') onData(event.sessionId, base64ToBytes(event.data ?? ''));
  else onExit(event.sessionId, event.code ?? null);
}

type Listener = (payload: unknown) => void;
interface DataEvent {
  sessionId: string;
  data: string;
}
interface ExitEvent {
  sessionId: string;
  code: number | null;
}
interface StateEvent {
  sessionId: string;
  state: 'open' | 'closed';
}

/** Listens for every session's output, end and state; called once from the shell. */
export function subscribeToSshEvents(): () => void {
  // `defineEvent` types every event's `name` as `string`, so the event map cannot narrow a payload
  // by channel; the casts are the ones the other mirrors use.
  const offs = [
    window.wirebench.on('ssh.data', ((event: DataEvent) => {
      onData(event.sessionId, base64ToBytes(event.data));
    }) as Listener),
    window.wirebench.on('ssh.exit', ((event: ExitEvent) => {
      onExit(event.sessionId, event.code);
    }) as Listener),
    window.wirebench.on('ssh.state', ((event: StateEvent) => {
      useHostsStore.getState().noteSessionState(event.sessionId, event.state);
    }) as Listener),
  ];
  return () => {
    for (const off of offs) off();
  };
}
