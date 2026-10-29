/**
 * Where a send goes from a browser tab (hosted edition spec §18.4): the server host, as today, or the paired
 * local agent on the person's machine.
 *
 * - Only the browser has `env.agent`. Without it (the desktop) nothing here runs: no `request.route`
 *   call, no chip, and every send goes exactly as before.
 * - Before every REST or SOAP send the tab asks `request.route`, paired or not. `agent` with a connected
 *   agent sends `request.bundle` (server) → `agent.send` (agent) → `exchanges.recordAgentSend` (server), so
 *   History stays one list; `agent` without one (none paired, or not answering) fails with
 *   `send-needs-agent`, naming the needs. A private target the server's egress rule lets it reach is
 *   `server`, so an unpaired tab sends as before to everything but what only a person's machine can mean.
 * - `agent-cookies` is the one need only the tab can see: the cookie domains its agent's jar holds for this
 *   pairing (`agent.cookies.domains`), read when the agent connects and after each agent send. A target whose
 *   host matches one goes to the agent even when the server says `server`, so it carries those cookies.
 * - The chip beside the send button reads the cached route per request, refreshed on edit (debounced) and
 *   after a pin changes.
 * - Under a protected environment the server answers the bundle with `needs-confirmation`; the tab asks, and
 *   asks for the bundle again with `confirmed`. The agent never asks.
 *
 * Types only from the wire: the renderer's eager chain must not build a zod schema (CSP).
 */
import { create } from 'zustand';
import type { IpcError, IpcResult } from '@shared/ipc.js';
import type { RequestRouteInfo, RequestRouteResponse, SendNeed } from '@shared/agent-route.js';
import type { RestExchangeSummary } from '@shared/kinds/rest/wire.js';
import type { ExchangeSummary } from '@shared/kinds/soap/wire.js';
import type { FailedExchangeWire } from '@shared/wire-base.js';
import { historyBody, HISTORY_BODY_MAX_CHARS } from '@shared/history-body.js';
import type { AgentEnv, AgentStatus } from '../../preload/build-api.js';
import { ipc } from './ipc-client.js';
import { askProtectedSend } from './protected-send.js';
import { useProjectStore } from './project.js';

/** The plain words for each need, as the error and the chip's tooltip name them. */
export const SEND_NEED_LABELS: Readonly<Record<SendNeed, string>> = {
  'private-target': 'an address on your network',
  'loopback-target': 'an address on your machine (localhost)',
  'system-values': 'values from your machine’s environment',
  'secret-source': 'a secret source on your machine',
  'team-secret': 'a team secret your machine holds',
  keystore: 'a keystore on your machine',
  kerberos: 'your Kerberos sign-in',
  'ntlm-machine': 'your Windows sign-in (NTLM)',
  'agent-cookies': 'cookies your machine holds for this host',
  pinned: 'a pin to this machine',
};

/** How long an edit waits before the chip asks for the route again. */
export const ROUTE_REFRESH_MS = 400;

/** A route as the tab holds it: the server's answer, with `agent-cookies` folded in. */
export interface RouteView {
  readonly route: 'server' | 'agent';
  readonly needs: readonly SendNeed[];
  readonly info?: RequestRouteInfo;
  /** The target's host does not resolve from the server: a name only the person's network may know. */
  readonly unresolved?: true;
}

interface CookieDomain {
  readonly domain: string;
  readonly hostOnly: boolean;
}

interface SendRouteState {
  /** The last route known per request id; absent until asked. */
  readonly byRequest: Readonly<Record<string, RouteView>>;
  readonly agentStatus: AgentStatus;
  readonly agentVersion: string | undefined;
  readonly cookieDomains: readonly CookieDomain[];
}

export const useSendRouteStore = create<SendRouteState>(() => ({
  byRequest: {},
  agentStatus: 'none',
  agentVersion: undefined,
  cookieDomains: [],
}));

/** The tab's agent, or `undefined` on the desktop. */
export function agentEnv(): AgentEnv | undefined {
  return (globalThis as { wirebench?: { env?: { agent?: AgentEnv } } }).wirebench?.env?.agent;
}

/** Whether this window routes sends (spec §18.4): every browser tab, paired or not; never the desktop. */
export function routingActive(): boolean {
  return agentEnv() !== undefined;
}

/**
 * A routed send between its click and the host that runs it: while the draft is committed, the route asked
 * and the bundle built, a cancel only marks it (`cancelled`), and the next step stops it before anything is
 * sent. Once the agent has it (`atAgent`) a cancel goes to the agent. A send the route gives to the server is
 * let go first, so its cancel reaches the server as before.
 */
interface RoutedSend {
  cancelled: boolean;
  atAgent: boolean;
}
const routedSends = new Map<string, RoutedSend>();

/** The answer of a send cancelled before any host had it. */
export const ABORTED: IpcError = { code: 'aborted', message: 'The request was aborted.' };

/** Starts tracking a routed send, before its first awaited step. */
export function trackRoutedSend(sendId: string): void {
  routedSends.set(sendId, { cancelled: false, atAgent: false });
}

/** Whether a cancel arrived for a tracked send. */
export function routedSendCancelled(sendId: string): boolean {
  return routedSends.get(sendId)?.cancelled === true;
}

/** Stops tracking: the send is the server's now, or done. */
export function releaseRoutedSend(sendId: string): void {
  routedSends.delete(sendId);
}

/**
 * Cancels a send the routing still holds: marks it at once, and tells the agent when it already has it.
 * `undefined` when the routing holds no such send (it is the server's to cancel); checked synchronously, so
 * a server send's cancel goes out without waiting a tick.
 */
export function cancelRoutedSend(sendId: string): Promise<void> | undefined {
  const entry = routedSends.get(sendId);
  if (entry === undefined) return undefined;
  entry.cancelled = true;
  return entry.atAgent
    ? ipc()
        .agent?.cancel({ sendId })
        .then(() => undefined)
    : Promise.resolve();
}

/** Whether `host` falls under a cookie domain the agent holds (RFC 6265 domain match). */
export function heldByAgent(host: string | undefined, domains: readonly CookieDomain[]): boolean {
  if (host === undefined) return false;
  const target = host.toLowerCase();
  return domains.some(({ domain, hostOnly }) =>
    hostOnly ? target === domain : target === domain || target.endsWith(`.${domain}`),
  );
}

/** The server's answer, with `agent-cookies` added when the target's host is one the agent holds cookies for. */
function viewOf(answer: RequestRouteResponse): RouteView {
  const info = answer.info;
  const needs: SendNeed[] = answer.route === 'agent' ? [...answer.needs] : [];
  if (heldByAgent(info?.targetHost, useSendRouteStore.getState().cookieDomains) && !needs.includes('agent-cookies')) {
    needs.push('agent-cookies');
  }
  const unresolved = answer.route === 'agent' && answer.detail?.reason === 'unresolved';
  return {
    route: needs.length > 0 ? 'agent' : 'server',
    needs,
    ...(info !== undefined ? { info } : {}),
    ...(unresolved ? { unresolved: true as const } : {}),
  };
}

/** Reads the agent's cookie domains again; an agent not connected holds none this tab can use. */
export async function refreshCookieDomains(): Promise<void> {
  const agent = ipc().agent;
  if (agentEnv()?.status() !== 'connected' || agent === undefined) {
    useSendRouteStore.setState({ cookieDomains: [] });
    return;
  }
  const result = await agent.cookies.domains(undefined);
  useSendRouteStore.setState({ cookieDomains: result.ok ? result.value.domains : [] });
}

/**
 * Asks where a send of `requestId` goes now, and caches it for the chip. `undefined` on the desktop, for a
 * request whose project is not known, and when the server refuses (the send then reports why).
 */
export async function routeOf(requestId: string): Promise<IpcResult<RouteView> | undefined> {
  if (!routingActive()) return undefined;
  const projectId = useProjectStore.getState().projectOf[requestId];
  if (projectId === undefined) return undefined;
  const result = await ipc().request.route({ projectId, itemId: requestId });
  if (!result.ok) return result;
  const view = viewOf(result.value);
  useSendRouteStore.setState((state) => ({ byRequest: { ...state.byRequest, [requestId]: view } }));
  return { ok: true, value: view };
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Refreshes the chip's route after an edit, once the edits pause. Nothing on the desktop. */
export function scheduleRouteRefresh(requestId: string): void {
  if (!routingActive()) return;
  const pending = timers.get(requestId);
  if (pending !== undefined) clearTimeout(pending);
  timers.set(
    requestId,
    setTimeout(() => {
      timers.delete(requestId);
      void routeOf(requestId).catch(() => undefined);
    }, ROUTE_REFRESH_MS),
  );
}

/** Pins or unpins a request, or the request's workspace, to the agent, then asks for the route again. */
export async function setRoutePin(
  requestId: string,
  scope: 'request' | 'workspace',
  pin: 'agent' | null,
): Promise<IpcResult<unknown>> {
  const id = scope === 'request' ? requestId : useSendRouteStore.getState().byRequest[requestId]?.info?.workspaceId;
  if (id === undefined) {
    return { ok: false, error: { code: 'unknown-entity', message: 'This request is not in a server workspace' } };
  }
  const result = await ipc().request.setRoutePin({ scope, id, pin });
  await routeOf(requestId);
  return result;
}

/**
 * The error a send that needs the agent answers when none is connected. `unresolved` says the target's host
 * does not resolve from the server, so it may be a name only the person's network knows.
 */
export function sendNeedsAgentError(needs: readonly SendNeed[], unresolved = false): IpcError {
  const named = needs.map((need) => SEND_NEED_LABELS[need]).join(', ');
  const why = unresolved
    ? 'The host this request goes to does not resolve from the server: it may be a name only your network knows, which only your machine can send to. No Wirebench agent is connected. Pair this machine, or start the paired agent, and send again.'
    : `This request must be sent from your machine (it needs ${named}), and no Wirebench agent is connected. Pair this machine, or start the paired agent, and send again.`;
  return {
    code: 'send-needs-agent',
    message: why,
    details: { needs: [...needs], ...(unresolved ? { reason: 'unresolved' } : {}) },
  };
}

/** A body cut as History cuts it, in base64: the raw HTTP's head kept whole, its body cut. */
function trimmedRaw(rawBase64: string): string {
  if (rawBase64.length <= HISTORY_BODY_MAX_CHARS) return rawBase64;
  const raw = atobBytes(rawBase64);
  const end = indexOfHeadEnd(raw);
  if (end === -1) return '';
  const head = raw.subarray(0, end + 4);
  const body = new TextDecoder().decode(raw.subarray(end + 4));
  const cut = new TextEncoder().encode(historyBody(body));
  const joined = new Uint8Array(head.length + cut.length);
  joined.set(head);
  joined.set(cut, head.length);
  return bytesToBase64(joined);
}

function atobBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** Where a raw HTTP message's head ends (the `\r\n\r\n`), or -1. */
function indexOfHeadEnd(raw: Uint8Array): number {
  for (let index = 0; index + 3 < raw.length; index += 1) {
    if (raw[index] === 13 && raw[index + 1] === 10 && raw[index + 2] === 13 && raw[index + 3] === 10) return index;
  }
  return -1;
}

/** The bytes a base64 string decodes to, without decoding it. */
function base64Bytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, (base64.length / 4) * 3 - padding);
}

/**
 * An agent's exchange as it is uploaded for History: every body cut as History cuts it, the bodies History
 * never reads left out, so a large response does not have to cross the server socket (capped at 32 MiB) whole.
 * The response's own size goes with it. What the tab shows is the whole exchange.
 */
export function forHistory<T extends RestExchangeSummary | ExchangeSummary>(
  result: T,
): { readonly result: T; readonly responseBytes: number } {
  const { http } = result;
  const trimmedHttp = {
    ...http,
    bodyBase64: '',
    rawBodyBase64: '',
    rawRequestBase64: trimmedRaw(http.rawRequestBase64),
    rawResponseBase64: trimmedRaw(http.rawResponseBase64),
  };
  const trimmed =
    'text' in result
      ? { ...result, http: trimmedHttp, text: historyBody(result.text) }
      : {
          ...result,
          http: trimmedHttp,
          ...(result.response !== undefined
            ? { response: { ...result.response, envelopeXml: historyBody(result.response.envelopeXml) } }
            : {}),
        };
  return { result: trimmed, responseBytes: base64Bytes(http.rawResponseBase64) };
}

type AgentSendResult<K extends 'rest' | 'soap'> = K extends 'rest' ? RestExchangeSummary : ExchangeSummary;

/** The bundle of `requestId`, asking first when its environment is protected; a "no" sends nothing. */
async function bundleFor(
  api: ReturnType<typeof ipc>,
  projectId: string,
  requestId: string,
): Promise<Awaited<ReturnType<ReturnType<typeof ipc>['request']['bundle']>>> {
  const first = await api.request.bundle({ projectId, itemId: requestId });
  if (first.ok || first.error.code !== 'needs-confirmation') return first;
  const environment = (first.error.details as { environment?: unknown } | undefined)?.environment;
  const name = typeof environment === 'string' ? environment : 'This environment';
  if (!(await askProtectedSend(name))) {
    return {
      ok: false,
      error: {
        code: 'send-declined',
        message: `Not sent: "${name}" is protected and the send was not confirmed`,
        details: { environments: [name] },
      },
    };
  }
  return await api.request.bundle({ projectId, itemId: requestId, confirmed: true });
}

/** The HTTP Log's row the agent built for a failed send, from its error; `undefined` when it sent none. */
function failureOf(error: IpcError, sendId: string): FailedExchangeWire | undefined {
  const failure = (error.details as { failure?: unknown } | undefined)?.failure;
  if (typeof failure !== 'object' || failure === null) return undefined;
  // The tab's id, so the row matches the send it shows.
  return { ...(failure as FailedExchangeWire), sendId };
}

/**
 * Sends one saved request through the agent: the server builds the bundle (after the person confirms a
 * protected environment), the agent sends it, the server records the redacted exchange in History, trimmed
 * as History trims it. A send that failed on the agent leaves the same History entry and HTTP Log row on the
 * server a failed server send leaves. Answers the agent's result as an ordinary send's.
 */
export async function sendThroughAgent<K extends 'rest' | 'soap'>(
  kind: K,
  requestId: string,
  sendId: string,
): Promise<IpcResult<AgentSendResult<K>>> {
  const api = ipc();
  const projectId = useProjectStore.getState().projectOf[requestId];
  if (projectId === undefined || api.agent === undefined) {
    return { ok: false, error: { code: 'unknown-request', message: `No request with id "${requestId}"` } };
  }
  const entry = routedSends.get(sendId) ?? { cancelled: false, atAgent: false };
  routedSends.set(sendId, entry);
  let sent: Awaited<ReturnType<NonNullable<typeof api.agent>['send']>>;
  try {
    if (entry.cancelled) return { ok: false, error: ABORTED };
    const bundle = await bundleFor(api, projectId, requestId);
    if (!bundle.ok) return bundle;
    if (entry.cancelled) return { ok: false, error: ABORTED };
    entry.atAgent = true;
    sent = await api.agent.send({ sendId, bundle: bundle.value });
  } finally {
    routedSends.delete(sendId);
  }
  if (!sent.ok) {
    const failure = failureOf(sent.error, sendId);
    if (failure !== undefined) {
      const recorded = await api.exchanges.recordAgentFailure({ projectId, itemId: requestId, kind, failure });
      if (!recorded.ok) console.error('the failed agent send could not be recorded:', recorded.error);
    }
    return sent;
  }
  // The jar may hold a new domain now.
  void refreshCookieDomains().catch(() => undefined);
  const record =
    kind === 'rest'
      ? await api.exchanges.recordAgentSend({
          projectId,
          itemId: requestId,
          kind: 'rest',
          ...forHistory(sent.value as RestExchangeSummary & { sentFrom: 'agent' }),
        })
      : await api.exchanges.recordAgentSend({
          projectId,
          itemId: requestId,
          kind: 'soap',
          ...forHistory(sent.value as ExchangeSummary & { sentFrom: 'agent' }),
        });
  if (!record.ok) {
    // The send happened; History missing it is worth saying, but the response is still the person's to see.
    console.error('the agent send could not be recorded in History:', record.error);
  }
  return { ok: true, value: sent.value as AgentSendResult<K> };
}

/** Follows the agent's status into the store, and reads its cookie domains whenever it connects. */
export function watchAgent(): () => void {
  const agent = agentEnv();
  if (agent === undefined) return () => undefined;
  const sync = (status: AgentStatus): void => {
    const was = useSendRouteStore.getState().agentStatus;
    useSendRouteStore.setState({ agentStatus: status, agentVersion: agent.version() });
    if (status === 'connected' && was !== 'connected') void refreshCookieDomains().catch(() => undefined);
    if (status !== 'connected') useSendRouteStore.setState({ cookieDomains: [] });
  };
  sync(agent.status());
  return agent.onStatus(sync);
}
