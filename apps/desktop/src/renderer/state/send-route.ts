/**
 * Where a send goes from a browser tab (hosted edition spec §18.4): the server host, as today, or the paired
 * local agent on the person's machine.
 *
 * - Only the browser has `env.agent`. Without it (the desktop) nothing here runs: no `request.route`
 *   call, no chip, and every send goes exactly as before.
 * - Before a REST or SOAP send the tab asks `request.route`, when it routes at all ({@link routingActive}):
 *   once the user has a pairing. A tab with no pairing sends everything from the server, exactly as before
 *   the agent existed (the server's hello never lists `send:private`, so that capability cannot be the test). `agent` with a connected agent sends
 *   `request.bundle` (server) → `agent.send` (agent) → `exchanges.recordAgentSend` (server), so History stays
 *   one list; `agent` without one fails with `send-needs-agent`, naming the needs.
 * - `agent-cookies` is the one need only the tab can see: the cookie domains its agent's jar holds for this
 *   pairing (`agent.cookies.domains`), read when the agent connects and after each agent send. A target whose
 *   host matches one goes to the agent even when the server says `server`, so it carries those cookies.
 * - The chip beside the send button reads the cached route per request, refreshed on edit (debounced) and
 *   after a pin changes.
 *
 * Types only from the wire: the renderer's eager chain must not build a zod schema (CSP).
 */
import { create } from 'zustand';
import type { IpcError, IpcResult } from '@shared/ipc.js';
import type { RequestRouteInfo, RequestRouteResponse, SendNeed } from '@shared/agent-route.js';
import type { RestExchangeSummary } from '@shared/kinds/rest/wire.js';
import type { ExchangeSummary } from '@shared/kinds/soap/wire.js';
import type { AgentEnv, AgentStatus } from '../../preload/build-api.js';
import { ipc } from './ipc-client.js';
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

/**
 * Whether this tab routes sends (spec §18.4): it has an agent transport, that is a pairing, connected or not.
 * Never on the desktop, and never in a tab whose user has paired no machine.
 */
export function routingActive(): boolean {
  const agent = agentEnv();
  return agent !== undefined && agent.status() !== 'none';
}

/**
 * Sends on their way to the agent, by send id, from the bundle request on: a cancel of one goes to the agent,
 * and a cancel before the agent has it stops it there (`cancelled`).
 */
const agentSends = new Map<string, { cancelled: boolean }>();

export function isAgentSend(sendId: string): boolean {
  return agentSends.has(sendId);
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
  return { route: needs.length > 0 ? 'agent' : 'server', needs, ...(info !== undefined ? { info } : {}) };
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

/** The error a send that needs the agent answers when none is connected. */
export function sendNeedsAgentError(needs: readonly SendNeed[]): IpcError {
  const named = needs.map((need) => SEND_NEED_LABELS[need]).join(', ');
  return {
    code: 'send-needs-agent',
    message: `This request must be sent from your machine (it needs ${named}), and no Wirebench agent is connected. Pair this machine, or start the paired agent, and send again.`,
    details: { needs: [...needs] },
  };
}

type AgentSendResult<K extends 'rest' | 'soap'> = K extends 'rest' ? RestExchangeSummary : ExchangeSummary;

/**
 * Sends one saved request through the agent: the server builds the bundle, the agent sends it, the server
 * records the redacted exchange in History. Answers the agent's result as an ordinary send's.
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
  const entry = { cancelled: false };
  agentSends.set(sendId, entry);
  let sent: Awaited<ReturnType<NonNullable<typeof api.agent>['send']>>;
  try {
    const bundle = await api.request.bundle({ projectId, itemId: requestId });
    if (!bundle.ok) return bundle;
    if (entry.cancelled) return { ok: false, error: { code: 'aborted', message: 'The request was aborted.' } };
    sent = await api.agent.send({ sendId, bundle: bundle.value });
  } finally {
    agentSends.delete(sendId);
  }
  if (!sent.ok) return sent;
  // The jar may hold a new domain now.
  void refreshCookieDomains().catch(() => undefined);
  const record =
    kind === 'rest'
      ? await api.exchanges.recordAgentSend({
          projectId,
          itemId: requestId,
          kind: 'rest',
          result: sent.value as RestExchangeSummary & { sentFrom: 'agent' },
        })
      : await api.exchanges.recordAgentSend({
          projectId,
          itemId: requestId,
          kind: 'soap',
          result: sent.value,
        });
  if (!record.ok) {
    // The send happened; History missing it is worth saying, but the response is still the person's to see.
    console.error('the agent send could not be recorded in History:', record.error);
  }
  return { ok: true, value: sent.value as AgentSendResult<K> };
}

/** Cancels a send the agent is running. */
export async function cancelAgentSend(sendId: string): Promise<void> {
  const entry = agentSends.get(sendId);
  if (entry !== undefined) entry.cancelled = true;
  await ipc().agent?.cancel({ sendId });
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
