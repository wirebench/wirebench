/**
 * The routing channels (hosted edition spec §18.4): `request.route`, `request.bundle`, `request.setRoutePin`
 * and `exchanges.recordAgentSend`. Every host registers them; only the server host routes. On the desktop
 * `request.route` always answers `server` (it sends from the person's machine already) and the other three
 * refuse with `host-capability-missing`, so the desktop sends exactly as it did.
 */
import { WirebenchError } from '@wirebench/engine';
import { channels } from '@wirebench/wire/ipc';
import type { ExchangesRecordAgentSendRequest } from '@wirebench/wire/agent-route';
import type { HistoryEntryWire } from '@wirebench/wire/wire-types';
import type { HistoryService } from '../history-service.js';
import { buildSendBundle, type SendBundleDeps } from '../send-bundle.js';
import { locateRouted, routeSend, type RoutePins, type SendRouteDeps } from '../send-route.js';
import { registerHandler, type HandlerTable } from './register.js';
import type { RequestChannelDeps } from './request.js';

/** What the server host lends the routing channels; absent on the desktop. */
export interface SendRoutingDeps
  extends Omit<SendRouteDeps, 'pins'>, Pick<SendBundleDeps, 'serverWorkspaceId' | 'limits'> {
  readonly pins: RoutePins;
}

function notRouted(): WirebenchError {
  return new WirebenchError('host-capability-missing', 'This host does not route sends to an agent', {
    details: { capability: 'agent-routing' },
  });
}

/** The body of a raw HTTP request (after its head), as text; empty when it has none. */
function rawRequestBody(rawRequestBase64: string): string {
  const raw = Buffer.from(rawRequestBase64, 'base64');
  const end = raw.indexOf('\r\n\r\n');
  return end === -1 ? '' : raw.subarray(end + 4).toString('utf8');
}

/** A header's value, by name in any case. */
function headerOf(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1];
}

/**
 * Writes an agent send's exchange to History, through the same builders a send on this host uses, so it is
 * masked by this host's redactor as every entry is: the agent redacted it already, and History masks again.
 */
async function recordAgentSend(
  deps: Pick<RequestChannelDeps, 'project' | 'onHistoryAppended'> & { readonly history?: HistoryService },
  request: ExchangesRecordAgentSendRequest,
): Promise<{ entry?: HistoryEntryWire }> {
  const { item } = locateRouted(deps, request);
  if (item?.kind !== request.kind) {
    throw new WirebenchError(
      'agent-kind-mismatch',
      `The request "${request.itemId}" is not a ${request.kind} request`,
      {
        details: { itemId: request.itemId, kind: request.kind },
      },
    );
  }
  if (deps.history === undefined) return {};
  const { result } = request;
  const requestHeaders = result.http.request.headers;
  let entry: HistoryEntryWire | undefined;
  if (request.kind === 'rest' && item.kind === 'rest') {
    const rest = request.result;
    const meta = deps.project.restMeta?.(request.itemId);
    entry = await deps.history.recordRestSend(request.projectId, {
      requestId: request.itemId,
      requestName: meta?.requestName ?? item.request.name,
      apiName: meta?.apiName ?? item.api.name,
      folderPath: meta?.folderPath ?? '',
      method: rest.method,
      url: rest.url,
      requestHeaders,
      requestBody: rawRequestBody(rest.http.rawRequestBase64),
      exchange: rest,
      durationMs: rest.durationMs,
      ...(meta?.tags !== undefined ? { tags: meta.tags } : {}),
      ...(rest.http.keyNames !== undefined ? { keyParams: rest.http.keyNames.params } : {}),
      sentFrom: 'agent',
    });
  } else if (request.kind === 'soap' && item.kind === 'soap') {
    const soap = request.result;
    const meta = deps.project.requestMeta(request.itemId);
    const contentType = headerOf(requestHeaders, 'content-type') ?? '';
    const soapAction = headerOf(requestHeaders, 'soapaction') ?? /action="([^"]*)"/i.exec(contentType)?.[1];
    entry = await deps.history.recordSend(request.projectId, {
      requestId: request.itemId,
      requestName: meta?.requestName ?? item.request.name,
      interfaceName: meta?.interfaceName ?? item.iface.name,
      operationName: meta?.operationName ?? item.operation.name,
      input: {
        endpoint: soap.http.request.url,
        envelopeXml: rawRequestBody(soap.http.rawRequestBase64),
        soapVersion: contentType.toLowerCase().includes('application/soap+xml') ? '1.2' : '1.1',
        ...(soapAction !== undefined ? { soapAction: soapAction.replace(/^"|"$/g, '') } : {}),
        headers: { ...requestHeaders },
      },
      exchange: soap,
      durationMs: soap.durationMs,
      ...(meta?.tags !== undefined ? { tags: meta.tags } : {}),
      sentFrom: 'agent',
    });
  }
  if (entry !== undefined) deps.onHistoryAppended?.(entry);
  return entry === undefined ? {} : { entry };
}

/** Registers the routing channels; `routing` is the server host's, absent on the desktop. */
export function registerSendRouteChannels(
  table: HandlerTable,
  deps: RequestChannelDeps,
  routing: SendRoutingDeps | undefined,
): void {
  registerHandler(table, channels.request.route, async (request) => {
    if (routing === undefined) return { route: 'server' as const };
    await routing.pins.load();
    return await routeSend(routing, request);
  });
  registerHandler(table, channels.request.bundle, async (request) => {
    if (routing === undefined) throw notRouted();
    return await buildSendBundle(routing, request);
  });
  registerHandler(table, channels.request.setRoutePin, async (request) => {
    if (routing === undefined) throw notRouted();
    return { pin: await routing.pins.set(request.scope, request.id, request.pin) };
  });
  registerHandler(table, channels.exchanges.recordAgentSend, async (request) => {
    if (routing === undefined) throw notRouted();
    return await recordAgentSend(deps, request);
  });
}
