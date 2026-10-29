/**
 * The agent's calls to a Wirebench Server's pairing routes (hosted edition spec §18.2): trading a code
 * for a pairing, unpairing, telling the server its port, and redeeming a tab's nonce. Every call after
 * the pairing itself is signed with the agent's key. `fetch` is injected, so the embedder decides how the
 * agent reaches the server (and a test can stand one up on loopback).
 *
 * A signed call the server answers with its definitive "no such pairing" (`404 agent-pairing-unknown`:
 * unpaired from the browser's side) removes the pairing here too, so the agent stops letting anyone in for
 * it, and an embedder that listens only while paired stops listening with the last one. Anything else (no
 * answer, a `5xx`, a refused signature, a bare `404` from a proxy) keeps it: only the server's own answer
 * says the pairing is gone. A forged answer of that kind costs a pairing, as `unpair --local` does.
 */
import {
  AGENT_EMPTY_BODY_SHA256,
  agentPairResponseSchema,
  agentRedeemMessage,
  agentRedeemResponseSchema,
  agentRequestMessage,
  type AgentPairRequest,
  type AgentRedeemResponse,
} from '@wirebench/engine';
import { bodySha256, signedHeaders } from './keys.js';
import type { Pairing, PairingStore } from './pairings.js';

/** The part of `fetch` the agent uses. */
export type AgentFetch = (url: string, init: RequestInit) => Promise<Response>;

/** How long one call to the server may take. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Why a call to the server did not do what it was for; the message is safe to show. */
export class AgentServerError extends Error {
  constructor(
    readonly code: 'unreachable' | 'refused' | 'rate-limited' | 'bad-answer' | 'unpaired',
    message: string,
    /** The HTTP status, when the server answered. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AgentServerError';
  }
}

/** Whether `hostname` (as `URL` gives it) is this machine's loopback: `localhost`, `127.0.0.0/8` or `::1`. */
function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * `serverUrl` as the origin the agent pairs with: `https://host[:port]`, with any path, query or fragment
 * the user typed dropped (the pairing routes are at the server's root). `http://` only for a server on this
 * machine's loopback, since the code and every signed request would otherwise cross the network in the
 * clear. Throws when it is none of these.
 */
export function normaliseServerUrl(serverUrl: string): string {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new AgentServerError('unreachable', 'The server address is not a URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AgentServerError('unreachable', 'The server address must start with https://');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new AgentServerError(
      'unreachable',
      'The server address must start with https:// (http:// is for this machine only)',
    );
  }
  return url.origin;
}

/** The URL of `route` (starting `/api/…`) on the server, and its path as the server signs it. */
function routeOf(serverUrl: string, route: string): { readonly url: string; readonly path: string } {
  const url = new URL(`${serverUrl}${route}`);
  return { url: url.href, path: url.pathname };
}

async function call(fetch: AgentFetch, url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      redirect: 'error',
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
    });
  } catch {
    throw new AgentServerError('unreachable', 'The server could not be reached');
  }
}

function refusal(response: Response, what: string): AgentServerError {
  return response.status === 429
    ? new AgentServerError('rate-limited', `The server refused ${what}: too many attempts, try again later`, 429)
    : new AgentServerError('refused', `The server refused ${what} (HTTP ${String(response.status)})`, response.status);
}

/** The server's code for a pairing it does not hold (`packages/server/src/agent/errors.ts`). */
export const PAIRING_UNKNOWN_CODE = 'agent-pairing-unknown';

/** Whether `response` is the server's own "no such pairing": `404` with {@link PAIRING_UNKNOWN_CODE}. */
async function saysPairingUnknown(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  try {
    const body: unknown = await response.clone().json();
    return typeof body === 'object' && body !== null && (body as { code?: unknown }).code === PAIRING_UNKNOWN_CODE;
  } catch {
    return false;
  }
}

/**
 * Removes `pairing` here when the server answered that it no longer holds it, and throws what to say;
 * returns quietly for any other answer.
 */
async function forgetIfUnpaired(response: Response, pairing: Pairing, store: PairingStore): Promise<void> {
  if (!(await saysPairingUnknown(response))) return;
  await store.remove(pairing.pairingId);
  throw new AgentServerError(
    'unpaired',
    `${pairing.origin} no longer holds this machine's pairing (it was unpaired there), so it was removed here`,
    404,
  );
}

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AgentServerError('bad-answer', 'The server answered with something that is not JSON');
  }
}

/** A canonical `scheme://host[:port]`, or `undefined` when `origin` is not exactly one. */
function canonicalOrigin(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.origin === origin.replace(/\/+$/, '') ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export interface PairOptions {
  /** As the user typed it. */
  readonly code: string;
  readonly serverUrl: string;
  /**
   * Kept on the wire for the version that serves SSH; both agents send `false` in slice 3, and that version
   * asks again rather than trust it (spec §18.1).
   */
  readonly sshOptIn: boolean;
  readonly store: PairingStore;
  readonly fetch: AgentFetch;
  /**
   * The running agent's port (`RunningAgent.port`). With no agent running, the port it will listen on
   * (the CLI's pair step passes `AGENT_FIRST_PORT`, 47615); if it lands on another, `startAgent` tells the
   * server with a signed `PATCH`.
   */
  readonly port: number;
}

/** What the caller shows: "paired as <email>". */
export interface PairResult {
  readonly pairingId: string;
  readonly origin: string;
  readonly email: string;
}

/**
 * Trades `code` for a pairing at `serverUrl` and keeps it. Makes the agent's key first if this is its
 * first pairing. The code is sent once and kept nowhere.
 */
export async function pair(options: PairOptions): Promise<PairResult> {
  const serverUrl = normaliseServerUrl(options.serverUrl);
  const { agentId, key } = await options.store.identity();
  const { port } = options;
  const body: AgentPairRequest = {
    code: options.code,
    agentId,
    publicKey: key.publicKey,
    port,
    sshOptIn: options.sshOptIn,
  };
  const { url } = routeOf(serverUrl, '/api/v1/agent/pairings');
  const response = await call(options.fetch, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw refusal(response, 'the pairing code');
  const answer = agentPairResponseSchema.safeParse(await jsonOf(response));
  const origin = answer.success ? canonicalOrigin(answer.data.origin) : undefined;
  if (!answer.success || origin === undefined) {
    throw new AgentServerError('bad-answer', 'The server answered the pairing with something unexpected');
  }
  // The origin tabs may connect from is the server's own: a server must not name another's origin, or its
  // pairing would accept the other server's tabs.
  if (origin !== serverUrl) {
    throw new AgentServerError(
      'bad-answer',
      `The server answered that its address is ${origin}, not ${serverUrl}; pair with the server's own address`,
    );
  }
  await options.store.add({
    pairingId: answer.data.pairingId,
    serverUrl,
    origin,
    email: answer.data.email,
    sshOptIn: options.sshOptIn,
    createdAt: new Date().toISOString(),
    port,
  });
  return { pairingId: answer.data.pairingId, origin, email: answer.data.email };
}

export interface UnpairOptions {
  readonly pairingId: string;
  readonly store: PairingStore;
  readonly fetch: AgentFetch;
}

/**
 * Unpairs at the server, signed, and forgets the pairing here. A server that no longer knows it (`404`,
 * unpaired from the browser's side already) counts as done. Any other refusal, or no answer, keeps the
 * pairing and throws, so the user is not told it is gone while the server still holds it.
 */
export async function unpair(options: UnpairOptions): Promise<void> {
  const pairing = options.store.get(options.pairingId);
  if (pairing === undefined) return;
  const { key } = await options.store.identity();
  const { url, path } = routeOf(pairing.serverUrl, `/api/v1/agent/pairings/${encodeURIComponent(pairing.pairingId)}`);
  const response = await call(options.fetch, url, {
    method: 'DELETE',
    headers: signedHeaders(key, pairing.pairingId, (timestamp) =>
      agentRequestMessage('DELETE', path, pairing.pairingId, timestamp, AGENT_EMPTY_BODY_SHA256),
    ),
  });
  if (!response.ok && response.status !== 404) throw refusal(response, 'the unpairing');
  await options.store.remove(pairing.pairingId);
}

/**
 * Tells the pairing's server the agent listens on `port`, signed, and records it. `startAgent` does this for
 * every pairing at each start, which is also when it learns of a pairing unpaired from the browser's side.
 */
export async function reportPort(
  pairing: Pairing,
  port: number,
  store: PairingStore,
  fetch: AgentFetch,
): Promise<void> {
  const { key } = await store.identity();
  const body = JSON.stringify({ port });
  const { url, path } = routeOf(pairing.serverUrl, `/api/v1/agent/pairings/${encodeURIComponent(pairing.pairingId)}`);
  const response = await call(fetch, url, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...signedHeaders(key, pairing.pairingId, (timestamp) =>
        agentRequestMessage('PATCH', path, pairing.pairingId, timestamp, bodySha256(body)),
      ),
    },
    body,
  });
  await forgetIfUnpaired(response, pairing, store);
  if (!response.ok) throw refusal(response, 'the port change');
  await store.setPort(pairing.pairingId, port);
}

/**
 * Redeems a tab's `nonce` at the pairing's server, signed. The answer says whose tab it is; a refusal
 * (replayed, expired) throws, and a pairing the server no longer holds is removed here as well. The nonce
 * is sent once and kept nowhere.
 */
export async function redeemNonce(
  pairing: Pairing,
  nonce: string,
  store: PairingStore,
  fetch: AgentFetch,
  signal?: AbortSignal,
): Promise<AgentRedeemResponse> {
  const { key } = await store.identity();
  const { url } = routeOf(pairing.serverUrl, '/api/v1/agent/nonces/redeem');
  const response = await call(
    fetch,
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...signedHeaders(key, pairing.pairingId, (timestamp) =>
          agentRedeemMessage(nonce, pairing.pairingId, timestamp),
        ),
      },
      body: JSON.stringify({ nonce }),
    },
    signal,
  );
  await forgetIfUnpaired(response, pairing, store);
  if (!response.ok) throw refusal(response, 'the tab');
  const answer = agentRedeemResponseSchema.safeParse(await jsonOf(response));
  if (!answer.success)
    throw new AgentServerError('bad-answer', 'The server answered the tab with something unexpected');
  return answer.data;
}
