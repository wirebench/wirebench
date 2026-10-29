/**
 * The tab's second socket, to the local agent paired with this user (hosted edition spec §18.2, §18.3).
 *
 * - The user's pairings are read from the server (`GET /api/v1/agent/pairings`) once after the server's
 *   hello, and again whenever *This machine* pairs or unpairs, or the agent closes for a reason that says the
 *   pairing may be gone (`4401`, `4403`). With no pairing there is no socket: the connection is idle.
 * - It tries the pairings in turn, the one that last connected from this browser first (`localStorage`, read
 *   and written inside try/catch: it may be blocked). A pairing whose port is not an integer in the agent's
 *   range (47615–47634) is skipped. For a pairing it opens `ws://127.0.0.1:<port>/host`. Each attempt first
 *   mints a nonce (`POST /api/v1/agent/nonces`, one per attempt) and sends `{ type: 'auth', pairingId, nonce }`
 *   as the socket's first frame. An agent that is not running leaves the status at `connecting`, retried on
 *   the transport's backoff (up to 30 s); every third open in a row that gets no hello reads the pairings
 *   again, so an agent that moved to another port (it took the next free one) is found there.
 * - An agent that refuses a pairing (`4401`, `4403`: this machine's agent holds another pairing, or it was
 *   unpaired there) moves the tab on to the next pairing, after 1 s, then 2 s, for a pairing refused before.
 *   A pairing refused three times in a row is `refused` (all of them refused is the status `refused`), and is
 *   tried again only every five minutes. A hello clears its count.
 * - With more than one pairing, a send may need what only one of the agents has: the desktop app's
 *   agent resolves team secrets, `wirebench agent` does not. {@link AgentEnv.selectFor} keeps the agent
 *   connected when its hello covers the capabilities asked for, and otherwise tries the other pairings in
 *   order (the hellos already seen first ruling out an agent), staying on the first that covers them. When
 *   none does, it goes back to the one it had. The two agents of one machine keep separate pairings, so a
 *   person may well have both paired.
 * - Its status shows in Settings → *This machine*; it has no reconnect bar of its own. A call made without a
 *   connected agent answers `host-disconnected`, as the server socket's calls do.
 *
 * Kept free of zod and React, like the transport: it runs before the renderer loads.
 */
import type { Invoke } from '../preload/build-api.js';
import type { AgentEnv, AgentPairingView, AgentSelection, AgentStatus } from '../preload/build-api.js';
import { createSocketTransport, type SocketLike, type SocketTransport } from './socket-transport.js';

export const AGENT_PAIRINGS_PATH = '/api/v1/agent/pairings';
export const AGENT_NONCES_PATH = '/api/v1/agent/nonces';
export const AGENT_PAIRING_CODES_PATH = '/api/v1/agent/pairing-codes';

/** The agent's close codes that say the pairing itself may have changed (unpaired, or another origin). */
const PAIRING_CLOSES: ReadonlySet<number> = new Set([4401, 4403]);

/** The agent's ports (`packages/agent/src/ports.ts`), the only ones the page's CSP lets it connect to. */
export const AGENT_PORT_RANGE = { first: 47_615, last: 47_634 } as const;

/** Where the pairing that last connected from this browser is remembered. */
export const PREFERRED_PAIRING_KEY = 'wirebench.agent.pairing';

/** Refusals in a row after which a pairing counts as refused, and how long it then waits between tries. */
export const REFUSED_AFTER = 3;
export const REFUSED_RETRY_MS = 5 * 60_000;

/** Failed opens in a row of one pairing after which the pairings are read again, for a port that moved. */
export const REREAD_AFTER_FAILURES = 3;

/** How long {@link AgentEnv.selectFor} waits for another pairing's agent to say hello. */
export const SELECT_TIMEOUT_MS = 10_000;

/** The delay before trying a pairing refused `refusals` times in a row: none, 1 s, 2 s, then five minutes. */
function refusalDelay(refusals: number): number {
  if (refusals <= 0) return 0;
  return refusals >= REFUSED_AFTER ? REFUSED_RETRY_MS : 1_000 * 2 ** (refusals - 1);
}

function isAgentPort(port: unknown): port is number {
  return (
    typeof port === 'number' &&
    Number.isInteger(port) &&
    port >= AGENT_PORT_RANGE.first &&
    port <= AGENT_PORT_RANGE.last
  );
}

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
  /** The page's `localStorage`, when it has one; every read and write is guarded. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
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
  if (!isRecord(value) || typeof value['id'] !== 'string' || !isAgentPort(value['port'])) return undefined;
  return {
    id: value['id'],
    port: value['port'],
    agentId: typeof value['agentId'] === 'string' ? value['agentId'] : '',
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
  /** The pairing tried now: its socket once open, or the timer that opens it. */
  let current:
    | {
        readonly id: string;
        readonly port: number;
        transport?: SocketTransport;
        timer?: ReturnType<typeof setTimeout>;
        /** Hears how this attempt went, for {@link AgentEnv.selectFor}: a hello, or a close or failure. */
        settle?: ((outcome: 'hello' | 'failed') => void) | undefined;
      }
    | undefined;
  /** The capabilities each pairing's agent named in its last hello, by pairing id. */
  const helloCapabilities = new Map<string, ReadonlySet<string>>();
  /** Set while {@link AgentEnv.selectFor} moves between pairings: a refusal then does not move on by itself. */
  let selecting = false;
  /** The usable pairings, in the order they are tried. */
  let candidates: readonly AgentPairingView[] = [];
  /** Refusals in a row, by pairing id. */
  const refusals = new Map<string, number>();
  let closed = false;
  /** One pairings read at a time; a refresh asked meanwhile runs once more after it. */
  let reading: Promise<void> | undefined;
  let again = false;
  /** Set by a refusal: the next read moves on past this pairing. */
  let advanceFrom: string | undefined;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener(status);
      } catch (error) {
        log('an agent status listener failed:', error);
      }
    }
  };

  const setStatus = (next: AgentStatus): void => {
    if (next !== 'connected') version = undefined;
    if (next === status) return;
    status = next;
    notify();
  };

  const preferred = (): string | undefined => {
    try {
      return deps.storage?.getItem(PREFERRED_PAIRING_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  };

  const remember = (id: string): void => {
    try {
      deps.storage?.setItem(PREFERRED_PAIRING_KEY, id);
    } catch {
      // Blocked storage: the order is simply the server's next time.
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

  const isRefused = (id: string): boolean => (refusals.get(id) ?? 0) >= REFUSED_AFTER;

  const drop = (): void => {
    const previous = current;
    current = undefined;
    if (previous?.timer !== undefined) clearTimeout(previous.timer);
    previous?.transport?.close();
  };

  const open = (pairing: AgentPairingView): void => {
    const slot: NonNullable<typeof current> = { id: pairing.id, port: pairing.port };
    /** Opens in a row that got no hello: nothing may listen on this port any more. */
    let failures = 0;
    /** Every few failed opens, the pairings are read again: the agent may have moved to another port. */
    const failedOpen = (): void => {
      failures += 1;
      if (failures % REREAD_AFTER_FAILURES === 0 && !selecting) void refresh();
    };
    const transport: SocketTransport = createSocketTransport(`ws://127.0.0.1:${String(pairing.port)}/host`, {
      ...(deps.createSocket === undefined ? {} : { createSocket: deps.createSocket }),
      firstFrame: authFrame(pairing.id),
      disconnected: AGENT_DISCONNECTED,
      onHello(hello) {
        if (current !== slot) return;
        failures = 0;
        helloCapabilities.set(pairing.id, new Set(hello.capabilities));
        slot.settle?.('hello');
        refusals.delete(pairing.id);
        remember(pairing.id);
        setStatus('connected');
        // The version is for Settings only; a hello without one still connects.
        void transport.invoke('agent.hello', undefined).then((result) => {
          if (current !== slot || !isRecord(result) || result['ok'] !== true) return;
          const value = result['value'];
          if (isRecord(value) && typeof value['version'] === 'string') {
            version = value['version'];
            // Listeners read the version through `env.version()`: tell them it is there.
            notify();
          }
        });
      },
      onOpenFailed() {
        if (current !== slot) return;
        slot.settle?.('failed');
        if (status !== 'refused') setStatus('connecting');
        failedOpen();
      },
      onClosed(code, helloSeen) {
        if (current !== slot) return;
        slot.settle?.('failed');
        if (!PAIRING_CLOSES.has(code)) {
          setStatus('connecting');
          if (!helloSeen) failedOpen();
          return;
        }
        // Refused: this pairing is not this machine's (or no longer is). The next one is tried.
        refusals.set(pairing.id, (refusals.get(pairing.id) ?? 0) + 1);
        drop();
        // While a send picks its agent, it moves on itself.
        if (selecting) return;
        advanceFrom = pairing.id;
        void refresh();
      },
    });
    slot.transport = transport;
    current = slot;
  };

  /** Tries `pairing`, after the wait its refusals call for. */
  const tryPairing = (pairing: AgentPairingView): void => {
    drop();
    setStatus(candidates.every((one) => isRefused(one.id)) ? 'refused' : 'connecting');
    const delay = refusalDelay(refusals.get(pairing.id) ?? 0);
    if (delay === 0) {
      open(pairing);
      return;
    }
    const slot: NonNullable<typeof current> = { id: pairing.id, port: pairing.port };
    slot.timer = setTimeout(() => {
      if (current === slot) {
        current = undefined;
        open(pairing);
      }
    }, delay);
    current = slot;
  };

  /** The pairing after `id` in the order, wrapping round; the first when `id` is no longer there. */
  const after = (id: string): AgentPairingView | undefined =>
    candidates[(candidates.findIndex((one) => one.id === id) + 1) % candidates.length];

  const readOnce = async (): Promise<void> => {
    const from = advanceFrom;
    advanceFrom = undefined;
    let list: readonly AgentPairingView[] | undefined;
    try {
      list = await pairings();
    } catch (error) {
      // A failed read says nothing about the pairings: the socket keeps what it had, and a refusal still
      // moves on through the pairings last read.
      log('the paired machines could not be read:', error);
    }
    if (closed) return;
    if (list !== undefined) {
      const first = preferred();
      candidates = [...list.filter((one) => one.id === first), ...list.filter((one) => one.id !== first)];
      for (const id of [...refusals.keys()]) {
        if (!candidates.some((one) => one.id === id)) refusals.delete(id);
      }
    }
    if (candidates.length === 0) {
      drop();
      setStatus('none');
      return;
    }
    if (from !== undefined) {
      const next = after(from);
      if (next !== undefined) tryPairing(next);
      return;
    }
    if (list === undefined) return;
    const kept = candidates.some((one) => one.id === current?.id && one.port === current.port);
    const next = candidates[0];
    if (!kept && next !== undefined) tryPairing(next);
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

  /** Whether `pairingId`'s agent named every one of `needed` in its last hello; `undefined` before one. */
  const covers = (pairingId: string, needed: readonly string[]): boolean | undefined => {
    const named = helloCapabilities.get(pairingId);
    return named === undefined ? undefined : needed.every((capability) => named.has(capability));
  };

  /** Opens `pairing` now, without a refusal's wait, and resolves on its hello or its first failure. */
  const attempt = (pairing: AgentPairingView): Promise<'hello' | 'failed'> =>
    new Promise((resolve) => {
      drop();
      setStatus('connecting');
      open(pairing);
      const slot = current;
      if (slot === undefined) {
        resolve('failed');
        return;
      }
      const timer = setTimeout(() => {
        slot.settle?.('failed');
      }, SELECT_TIMEOUT_MS);
      slot.settle = (outcome) => {
        clearTimeout(timer);
        slot.settle = undefined;
        resolve(outcome);
      };
    });

  const selectFor = async (needed: readonly string[]): Promise<AgentSelection> => {
    const connected = (): AgentSelection => {
      if (status !== 'connected' || current === undefined) return { connected: false, missing: [] };
      const named = helloCapabilities.get(current.id) ?? new Set<string>();
      return { connected: true, missing: needed.filter((capability) => !named.has(capability)) };
    };
    if (closed || needed.length === 0 || selecting) return connected();
    if (status === 'connected' && current !== undefined && covers(current.id, needed) === true) return connected();
    const had = candidates.find((one) => one.id === current?.id);
    /** The agent connected now, which does not cover the needs. */
    const before = status === 'connected' ? had : undefined;
    // The others in order, skipping a refused one and one whose agent is known not to cover the needs.
    const others = candidates.filter(
      (one) => one.id !== before?.id && !isRefused(one.id) && covers(one.id, needed) !== false,
    );
    if (others.length === 0) return connected();
    selecting = true;
    try {
      for (const pairing of others) {
        if (closed) break;
        if ((await attempt(pairing)) === 'hello' && covers(pairing.id, needed) === true) return connected();
      }
      // None covers them: back to the agent it had, which answers for what it lacks; or, if none was
      // connected and none answered now, back to the pairing it was trying.
      if (!closed && before !== undefined) {
        if (current?.id !== before.id) await attempt(before);
      } else if (!closed && status !== 'connected' && had !== undefined && current?.id !== had.id) {
        tryPairing(had);
      }
      return connected();
    } finally {
      selecting = false;
    }
  };

  const invoke: Invoke = (channel, request) =>
    current?.transport === undefined ? Promise.resolve(AGENT_DISCONNECTED) : current.transport.invoke(channel, request);

  const env: AgentEnv = {
    serverOrigin: deps.serverOrigin,
    status: () => status,
    version: () => version,
    refused: isRefused,
    selectFor,
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
