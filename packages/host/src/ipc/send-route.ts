/**
 * The routing channels (hosted edition spec §18.4): `request.route`, `request.bundle`, `request.setRoutePin`,
 * `exchanges.recordAgentSend` and `exchanges.recordAgentFailure`. Every host registers them; only the server
 * host routes. On the desktop `request.route` always answers `server` (it sends from the person's machine
 * already) and the others refuse with `host-capability-missing`, so the desktop sends exactly as it did.
 */
import { WirebenchError } from '@wirebench/engine';
import { channels } from '@wirebench/wire/ipc';
import type { ExchangesRecordAgentFailureRequest, ExchangesRecordAgentSendRequest } from '@wirebench/wire/agent-route';
import type { FailedExchangeWire } from '@wirebench/wire/wire-base';
import type { HistoryEntryWire } from '@wirebench/wire/wire-types';
import { requestSentEvent } from '../audit/desktop-events.js';
import type { HistoryService } from '../history-service.js';
import { environmentNameOf, type AuditedSend } from '../send/exchange.js';
import { reportSendFailed } from '../send/host.js';
import { buildSendBundle, type SendBundleDeps } from '../send-bundle.js';
import { locateRouted, routeSend, type RoutableItem, type RoutePins, type SendRouteDeps } from '../send-route.js';
import { registerHandler, type HandlerTable } from './register.js';
import type { RequestChannelDeps } from './request.js';

/** What the server host lends the routing channels; absent on the desktop. */
export interface SendRoutingDeps
  extends Omit<SendRouteDeps, 'pins'>, Pick<SendBundleDeps, 'serverWorkspaceId' | 'teamSecretsDir' | 'limits'> {
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

type RecordingDeps = Pick<
  RequestChannelDeps,
  'project' | 'onHistoryAppended' | 'onSendFailed' | 'audit' | 'auditWorkspace' | 'hostState'
> & { readonly history?: HistoryService };

/** The item recorded for, checked to be the project's and of the kind named. */
function recordedItem(
  deps: Pick<RequestChannelDeps, 'project'>,
  request: { readonly projectId: string; readonly itemId: string; readonly kind: 'rest' | 'soap' },
): RoutableItem {
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
  return item;
}

/**
 * Tells the audit log of an agent send, as a send on this host is told of (desktop audit events spec §2.2):
 * the same `desktop.request_sent` event, under the environment the item is sent under. The event has no
 * field for where it went out from. Nothing here may fail the recording.
 */
function auditAgentSend(deps: RecordingDeps, item: RoutableItem, sent: AuditedSend): void {
  if (deps.audit === undefined || sent.url.length === 0) return;
  try {
    const located = deps.project.runContextFor?.(item.request.id);
    deps.audit(
      requestSentEvent(deps.hostState.redactor, {
        protocol: item.kind,
        ...sent,
        environment: located === undefined ? null : environmentNameOf(located),
        requestId: item.request.id,
        requestName: item.request.name,
        sentAt: new Date().toISOString(),
      }),
      deps.auditWorkspace?.(),
    );
  } catch (error) {
    console.warn(
      `[audit] an agent send could not be reported: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The SOAP version and action a request with these headers was sent with. */
function soapHeaderFacts(headers: Readonly<Record<string, string>>): {
  readonly soapVersion: '1.1' | '1.2';
  readonly soapAction?: string;
} {
  const contentType = headerOf(headers, 'content-type') ?? '';
  const soapAction = headerOf(headers, 'soapaction') ?? /action="([^"]*)"/i.exec(contentType)?.[1];
  return {
    soapVersion: contentType.toLowerCase().includes('application/soap+xml') ? '1.2' : '1.1',
    ...(soapAction !== undefined ? { soapAction: soapAction.replace(/^"|"$/g, '') } : {}),
  };
}

/**
 * Writes an agent send's exchange to History, through the same builders a send on this host uses, so it is
 * masked by this host's redactor as every entry is: the agent redacted it already, and History masks again.
 * The tab trimmed its bodies as History would before it uploaded them; `responseBytes` keeps the entry's
 * size the response's own. The send is told to the audit log as this host's sends are.
 */
async function recordAgentSend(
  deps: RecordingDeps,
  request: ExchangesRecordAgentSendRequest,
): Promise<{ entry?: HistoryEntryWire }> {
  const item = recordedItem(deps, request);
  const { result } = request;
  const requestHeaders = result.http.request.headers;
  const size = request.responseBytes !== undefined ? { sizeBytes: request.responseBytes } : {};
  let entry: HistoryEntryWire | undefined;
  if (request.kind === 'rest' && item.kind === 'rest') {
    const rest = request.result;
    auditAgentSend(deps, item, {
      method: rest.method,
      url: rest.url,
      status: rest.http.status,
      outcome: 'ok',
      durationMs: rest.durationMs,
    });
    const meta = deps.project.restMeta?.(request.itemId);
    entry = await deps.history?.recordRestSend(request.projectId, {
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
      ...size,
    });
  } else if (request.kind === 'soap' && item.kind === 'soap') {
    const soap = request.result;
    auditAgentSend(deps, item, {
      method: soap.http.request.method,
      url: soap.http.request.url,
      status: soap.http.status,
      outcome: 'ok',
      durationMs: soap.durationMs,
    });
    const meta = deps.project.requestMeta(request.itemId);
    entry = await deps.history?.recordSend(request.projectId, {
      requestId: request.itemId,
      requestName: meta?.requestName ?? item.request.name,
      interfaceName: meta?.interfaceName ?? item.iface.name,
      operationName: meta?.operationName ?? item.operation.name,
      input: {
        endpoint: soap.http.request.url,
        envelopeXml: rawRequestBody(soap.http.rawRequestBase64),
        ...soapHeaderFacts(requestHeaders),
        headers: { ...requestHeaders },
      },
      exchange: soap,
      durationMs: soap.durationMs,
      ...(meta?.tags !== undefined ? { tags: meta.tags } : {}),
      sentFrom: 'agent',
      ...size,
    });
  }
  if (entry !== undefined) deps.onHistoryAppended?.(entry);
  return entry === undefined ? {} : { entry };
}

/** A failure row from the agent, masked again by this host's redactor, as every row this host writes is. */
function remasked(deps: RecordingDeps, failure: FailedExchangeWire): FailedExchangeWire {
  const { redactor } = deps.hostState;
  return {
    ...failure,
    request: {
      ...failure.request,
      url: redactor.redactUrl(failure.request.url, { show: false }),
      headers: redactor.redactHeaders(failure.request.headers, { show: false }),
    },
    ...(failure.rawRequestBase64 !== undefined
      ? {
          rawRequestBase64: redactor.redactRawHttp(failure.rawRequestBase64, { show: false, encoding: 'base64' }),
        }
      : {}),
    error: { code: failure.error.code, message: redactor.redactSecretValues(failure.error.message) },
  };
}

/**
 * Writes what a failed agent send leaves, as a failed send on this host does (`sendThroughEngine`): a send
 * that failed on the wire gets its History entry, then the HTTP Log's row, and is told to the audit log; one
 * that failed while it was prepared gets the row alone.
 */
async function recordAgentFailure(
  deps: RecordingDeps,
  request: ExchangesRecordAgentFailureRequest,
): Promise<{ entry?: HistoryEntryWire }> {
  const item = recordedItem(deps, request);
  const failure = remasked(deps, request.failure);
  const error = failure.error;
  let entry: HistoryEntryWire | undefined;
  if (failure.stage !== 'prepare') {
    const body = failure.rawRequestBase64 === undefined ? '' : rawRequestBody(failure.rawRequestBase64);
    if (item.kind === 'rest') {
      const meta = deps.project.restMeta?.(request.itemId);
      entry = await deps.history?.recordRestSend(request.projectId, {
        requestId: request.itemId,
        requestName: meta?.requestName ?? item.request.name,
        apiName: meta?.apiName ?? item.api.name,
        folderPath: meta?.folderPath ?? '',
        method: failure.request.method,
        url: failure.request.url,
        requestHeaders: failure.request.headers,
        requestBody: body,
        error,
        durationMs: failure.durationMs,
        ...(meta?.tags !== undefined ? { tags: meta.tags } : {}),
        sentFrom: 'agent',
      });
    } else {
      const meta = deps.project.requestMeta(request.itemId);
      entry = await deps.history?.recordSend(request.projectId, {
        requestId: request.itemId,
        requestName: meta?.requestName ?? item.request.name,
        interfaceName: meta?.interfaceName ?? item.iface.name,
        operationName: meta?.operationName ?? item.operation.name,
        input: {
          endpoint: failure.request.url,
          envelopeXml: body,
          ...soapHeaderFacts(failure.request.headers),
          headers: { ...failure.request.headers },
        },
        error,
        durationMs: failure.durationMs,
        ...(meta?.tags !== undefined ? { tags: meta.tags } : {}),
        sentFrom: 'agent',
      });
    }
    if (entry !== undefined) deps.onHistoryAppended?.(entry);
    auditAgentSend(deps, item, {
      method: failure.request.method,
      url: failure.request.url,
      status: null,
      outcome: 'failed',
      durationMs: failure.durationMs,
    });
  }
  reportSendFailed(deps.onSendFailed, () => failure);
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
  registerHandler(table, channels.exchanges.recordAgentFailure, async (request) => {
    if (routing === undefined) throw notRouted();
    return await recordAgentFailure(deps, request);
  });
}
