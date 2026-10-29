/**
 * The tab's second socket, to the local agent paired with this user (hosted edition spec §18.2, §18.3).
 *
 * - The user's pairings are read from the server (`GET /api/v1/agent/pairings`) once after the server's
 *   hello, and again whenever *This machine* pairs or unpairs, or the agent closes for a reason that says the
 *   pairing may be gone (`4401`, `4403`). With no pairing there is no socket: the connection is idle.
 * - For the first pairing it opens `ws://127.0.0.1:<port>/host`. Each attempt first mints a nonce
 *   (`POST /api/v1/agent/nonces`, one per attempt) and sends `{ type: 'auth', pairingId, nonce }` as the
 *   socket's first frame. An agent that is not running leaves the status at `connecting`, retried on the
 *   transport's backoff (up to 30 s).
 * - Its status shows in Settings → *This machine*; it has no reconnect bar of its own. A call made without a
 *   connected agent answers `host-disconnected`, as the server socket's calls do.
 *
 * Kept free of zod and React, like the transport: it runs before the renderer loads.
 */
import type { Invoke } from '../preload/build-api.js';
import type { AgentEnv, AgentPairingView, AgentStatus } from '../preload/build-api.js';
import { createSocketTransport, type SocketLike, type SocketTransport } from './socket-transport.js';

export const AGENT_PAIRINGS_PATH = '/api/v1/agent/pairings';
export const AGENT_NONCES_PATH = '/api/v1/agent/nonces';
export const AGENT_PAIRING_CODES_PATH = '/api/v1/agent/pairing-codes';

/** The agent's close codes that say the pairing itself may have changed (unpaired, or another origin). */
const PAIRING_CLOSES: ReadonlySet<number> = new Set([4401, 4403]);

/** What a call answers while no agent is connected. */
export const AGENT_DISCONNECTED = {
  ok: false,
  error: {
    code: 'host-disconnected',
    message: 'This machine’s Wirebench agent is not connected; start it, or pair this machine, and try again',
  },
} as const;

/** A `fetch` answer, as much of it as the connection reads. */
export interface FetchAnswer {
  readonly status: number;
  json(): Promise<unknown>;
}

export interface AgentConnectionDeps {
  readonly fetch: (url: string, init: RequestInit) => Promise<FetchAnswer>;
  /** The page's origin: what `wirebench agent pair --server` is told. */
  readonly serverOrigin: string;
  readonly createSocket?: (url: string) => SocketLike;
  /** Something went wrong outside any call (a pairings read, say); the console by default. */
  readonly log?: (message: string, error: unknown) => void;
}

export interface AgentConnection {
  readonly env: AgentEnv;
  /** Sends an `agent.*` call to the agent, or answers {@link AGENT_DISCONNECTED} without one. */
  readonly invoke: Invoke;
  /** Reads the pairings again and opens, moves or closes the socket to match. */
  refresh(): Promise<void>;
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The server's message in a refusal body, or a plain one naming the status. */
async function refusal(answer: FetchAnswer, what: string): Promise<Error> {
  let message = `${what} failed (HTTP ${String(answer.status)})`;
  try {
    const body = await answer.json();
    const error = isRecord(body) && isRecord(body['error']) ? body['error'] : body;
    if (isRecord(error) && typeof error['message'] === 'string' && error['message'] !== '') message = error['message'];
  } catch {
    // No body to read: the status says enough.
  }
  return new Error(message);
}

function pairingOf(value: unknown): AgentPairingView | undefined {
  if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['port'] !== 'number') return undefined;
  return {
    id: value['id'],
    port: value['port'],
    sshOptIn: value['sshOptIn'] === true,
    createdAt: typeof value['createdAt'] === 'string' ? value['createdAt'] : '',
    lastSeenAt: typeof value['lastSeenAt'] === 'string' ? value['lastSeenAt'] : '',
  };
}

const JSON_POST = (body: unknown): RequestInit => ({
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export function createAgentConnection(deps: AgentConnectionDeps): AgentConnection {
  const log = deps.log ?? ((message, error) => console.error(message, error));
  const listeners = new Set<(status: AgentStatus) => void>();
  let status: AgentStatus = 'none';
  let version: string | undefined;
  let current: { readonly id: string; readonly port: number; readonly transport: SocketTransport } | undefined;
  let closed = false;
  /** One pairings read at a time; a refresh asked meanwhile runs once more after it. */
  let reading: Promise<void> | undefined;
  let again = false;

  const setStatus = (next: AgentStatus): void => {
    if (next !== 'connected') version = undefined;
    if (next === status) return;
    status = next;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch (error) {
        log('an agent status listener failed:', error);
      }
    }
  };

  const pairings = async (): Promise<readonly AgentPairingView[]> => {
    const answer = await deps.fetch(AGENT_PAIRINGS_PATH, { credentials: 'same-origin' });
    if (answer.status !== 200) throw await refusal(answer, 'Reading the paired machines');
    const body = await answer.json();
    const rows = isRecord(body) && Array.isArray(body['pairings']) ? body['pairings'] : [];
    return rows.map(pairingOf).filter((one): one is AgentPairingView => one !== undefined);
  };

  /** A fresh nonce for one attempt, as the auth frame the agent wants first. */
  const authFrame = (pairingId: string) => async (): Promise<unknown> => {
    const answer = await deps.fetch(AGENT_NONCES_PATH, JSON_POST({ pairingId }));
    if (answer.status !== 200 && answer.status !== 201) throw await refusal(answer, 'Minting a nonce for the agent');
    const body = await answer.json();
    if (!isRecord(body) || typeof body['nonce'] !== 'string') throw new Error('The server sent no nonce');
    return { type: 'auth', pairingId, nonce: body['nonce'] };
  };

  const drop = (): void => {
    const previous = current;
    current = undefined;
    previous?.transport.close();
  };

  const open = (pairing: AgentPairingView): void => {
    const transport: SocketTransport = createSocketTransport(`ws://127.0.0.1:${String(pairing.port)}/host`, {
      ...(deps.createSocket === undefined ? {} : { createSocket: deps.createSocket }),
      firstFrame: authFrame(pairing.id),
      disconnected: AGENT_DISCONNECTED,
      onHello() {
        if (current?.transport !== transport) return;
        setStatus('connected');
        // The version is for Settings only; a hello without one still connects.
        void transport.invoke('agent.hello', undefined).then((result) => {
          if (current?.transport !== transport || !isRecord(result) || result['ok'] !== true) return;
          const value = result['value'];
          if (isRecord(value) && typeof value['version'] === 'string') {
            version = value['version'];
            // Listeners read the version through `env.version()`: tell them it is there.
            for (const listener of [...listeners]) listener(status);
          }
        });
      },
      onOpenFailed() {
        if (current?.transport === transport) setStatus('connecting');
      },
      onClosed(code) {
        if (current?.transport !== transport) return;
        setStatus('connecting');
        if (PAIRING_CLOSES.has(code)) void refresh();
      },
    });
    current = { id: pairing.id, port: pairing.port, transport };
    setStatus('connecting');
  };

  const readOnce = async (): Promise<void> => {
    let list: readonly AgentPairingView[];
    try {
      list = await pairings();
    } catch (error) {
      // The socket, if any, keeps what it had: a failed read says nothing about the pairing.
      log('the paired machines could not be read:', error);
      return;
    }
    if (closed) return;
    const first = list.find((one) => one.port > 0);
    if (first === undefined) {
      drop();
      setStatus('none');
      return;
    }
    if (current?.id === first.id && current.port === first.port) return;
    drop();
    open(first);
  };

  const refresh = async (): Promise<void> => {
    if (closed) return;
    if (reading !== undefined) {
      again = true;
      await reading;
      return;
    }
    reading = (async () => {
      do {
        again = false;
        await readOnce();
      } while (again && !closed);
    })().finally(() => {
      reading = undefined;
    });
    await reading;
  };

  const invoke: Invoke = (channel, request) =>
    current === undefined ? Promise.resolve(AGENT_DISCONNECTED) : current.transport.invoke(channel, request);

  const env: AgentEnv = {
    serverOrigin: deps.serverOrigin,
    status: () => status,
    version: () => version,
    onStatus(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    pairings,
    async createPairingCode() {
      const answer = await deps.fetch(AGENT_PAIRING_CODES_PATH, JSON_POST({}));
      if (answer.status !== 200 && answer.status !== 201) throw await refusal(answer, 'Making a pairing code');
      const body = await answer.json();
      if (!isRecord(body) || typeof body['code'] !== 'string') throw new Error('The server sent no pairing code');
      return { code: body['code'], expiresAt: typeof body['expiresAt'] === 'string' ? body['expiresAt'] : '' };
    },
    async unpair(id) {
      const answer = await deps.fetch(`${AGENT_PAIRINGS_PATH}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (answer.status !== 200 && answer.status !== 204 && answer.status !== 404) {
        throw await refusal(answer, 'Unpairing the machine');
      }
      await refresh();
    },
    refresh,
  };

  return {
    env,
    invoke,
    refresh,
    close() {
      closed = true;
      drop();
      setStatus('none');
    },
  };
}
