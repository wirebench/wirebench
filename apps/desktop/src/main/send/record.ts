/**
 * What a desktop send leaves behind once the engine has sent it: the summary the renderer is
 * handed (and the exchange cache keeps unredacted), and the History entry.
 */
import { isWirebenchError, WirebenchError } from '@wirebench/engine';
import type {
  GrpcCallResult,
  GrpcResolvedInput,
  GrpcSelected,
  RestContractResult,
  RestExchange,
  RestSelected,
  RestSendInput,
  SoapExchange,
  SoapSendInput,
  WsExchange,
  WsSelected,
} from '@wirebench/engine';
import type { EngineService } from '../engine-service.js';
import {
  redactExchangeSummary,
  toExchangeSummary,
  toGrpcExchangeSummary,
  toRestContractWire,
  toRestExchangeSummary,
  toWsExchangeSummary,
} from '../engine-wire.js';
import { failedExchangeOf } from '../failed-exchange.js';
import { redactSecretValues } from '../redact.js';
import type { SendThroughEngineDeps } from './exchange.js';
import { reportSendFailed } from './host.js';
import type {
  ExchangeSummary,
  FailedExchangeWire,
  GrpcExchangeSummary,
  ResolvedSendInputWire,
  RestExchangeSummary,
  WsExchangeSummary,
} from '../../shared/wire-types.js';

export type RecordDeps = Pick<SendThroughEngineDeps, 'project' | 'history' | 'onHistoryAppended'>;

/** The label used when the send's `requestId` is unknown or no longer exists. */
export interface HistoryNameFallback {
  readonly requestName: string;
  readonly interfaceName: string;
  readonly operationName: string;
  /**
   * The project an entry for a send with no live request is keyed to. Only a resend supplies
   * one — the project whose history the resent entry came from; with none, such a send is
   * simply not recorded, since no project owns it.
   */
  readonly projectId?: string;
}

/**
 * What a send's History entry adds to its request's own names: a sequence run's tags, or the
 * environment a multi-environment send went to. Laid over the project's meta for the request, so a
 * request the project has no meta for is named as it always is.
 */
export interface HistoryLabel {
  /** Replaces the meta's tags: the run a sequence step belongs to. */
  readonly tags?: readonly string[];
  /** Appended to the request's name: the environment a multi-environment send went to. */
  readonly environmentName?: string;
}

/** `meta` with `label` laid over it; undefined when the project has no meta for the request. */
function labelled<T extends { readonly requestName: string }>(
  meta: T | undefined,
  label: HistoryLabel | undefined,
): (T & { readonly tags?: readonly string[] }) | undefined {
  if (meta === undefined || label === undefined) return meta;
  return {
    ...meta,
    ...(label.environmentName !== undefined ? { requestName: `${meta.requestName} · ${label.environmentName}` } : {}),
    ...(label.tags !== undefined ? { tags: label.tags } : {}),
  };
}

export const AD_HOC_NAME: HistoryNameFallback = {
  requestName: 'Ad-hoc request',
  interfaceName: '',
  operationName: '',
};

/** One SOAP send as History records it: the request it came from, if any, and its names. */
export interface SoapRecord {
  /** Absent for an ad-hoc send. */
  readonly requestId?: string;
  /** What names the entry when the project has no meta for the request. */
  readonly names: HistoryNameFallback;
  /** The request as resolved, references unexpanded. */
  readonly input: SoapSendInput;
  /** The unredacted summary, when the send completed (a SOAP fault included). */
  readonly exchange?: ExchangeSummary;
  readonly error?: unknown;
  readonly durationMs: number;
  readonly label?: HistoryLabel;
}

/**
 * Appends one SOAP send's History entry, successful or not, to the project owning the request — or,
 * for a send with none, to the project `names` names. A no-op without a history service or a project.
 */
export async function recordSoap(deps: RecordDeps, record: SoapRecord): Promise<void> {
  if (deps.history === undefined) {
    return;
  }
  const { requestId } = record;
  const projectId = (requestId === undefined ? undefined : deps.project.projectId(requestId)) ?? record.names.projectId;
  if (projectId === undefined) {
    return;
  }
  const meta = requestId !== undefined ? labelled(deps.project.requestMeta(requestId), record.label) : undefined;
  const name = meta ?? record.names;
  const entry = await deps.history.recordSend(projectId, {
    ...(requestId !== undefined ? { requestId } : {}),
    requestName: name.requestName,
    interfaceName: name.interfaceName,
    operationName: name.operationName,
    input: soapInputWire(record.input),
    ...(record.exchange !== undefined ? { exchange: record.exchange } : {}),
    ...(record.error !== undefined ? { error: restErrorDetail(record.error) } : {}),
    durationMs: record.durationMs,
    ...(meta?.tags !== undefined ? { tags: meta.tags } : {}),
  });
  if (entry !== undefined) {
    deps.onHistoryAppended?.(entry);
  }
}

/** The parts of a resolved SOAP input History reads, in the wire shape it records. */
function soapInputWire(input: SoapSendInput): ResolvedSendInputWire {
  return {
    endpoint: input.endpoint,
    envelopeXml: input.envelopeXml,
    soapVersion: input.soapVersion,
    ...(input.soapAction !== undefined ? { soapAction: input.soapAction } : {}),
    ...(input.headers !== undefined ? { headers: { ...input.headers } } : {}),
  };
}

/**
 * A SOAP exchange as `request.send` answers it, redacted for `show`. The exchange cache keeps the
 * unredacted summary, the response attachments' bytes and the engine exchange, and re-renders it
 * when the show-secrets flag changes. Returns the unredacted summary too, which History records.
 */
export function summariseSoap(
  service: EngineService,
  sendId: string,
  exchange: SoapExchange,
  options: {
    readonly requestId?: string;
    /** The request envelope as resolved: `SoapExchange` keeps the request only as raw bytes. */
    readonly requestEnvelopeXml: string;
    readonly keyParams?: readonly string[];
    readonly keyHeaders?: readonly string[];
    readonly show: boolean;
  },
): { readonly summary: ExchangeSummary; readonly full: ExchangeSummary } {
  const keys = {
    ...(options.keyParams !== undefined ? { keyParams: options.keyParams } : {}),
    ...(options.keyHeaders !== undefined ? { keyHeaders: options.keyHeaders } : {}),
  };
  const full = toExchangeSummary(exchange, sendId, { show: true });
  service.exchanges.put(sendId, full, exchange.response?.attachments, {
    exchange,
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    requestEnvelopeXml: options.requestEnvelopeXml,
    ...keys,
  });
  return { summary: redactExchangeSummary(full, { show: options.show, ...keys }), full };
}

/**
 * Appends one REST send's History entry, successful or not. A no-op without a history service.
 * `item` names the request and its API when the project has no meta for it.
 */
export async function recordRest(
  deps: RecordDeps,
  item: RestSelected,
  input: RestSendInput,
  summary: RestExchangeSummary | undefined,
  durationMs: number,
  keyParams: readonly string[] | undefined,
  error?: unknown,
  label?: HistoryLabel,
): Promise<void> {
  const requestId = item.request.id;
  const projectId = deps.project.projectId(requestId);
  if (deps.history === undefined || projectId === undefined) {
    return;
  }
  const meta = labelled(deps.project.restMeta?.(requestId), label);
  const body = input.request.body;
  const entry = await deps.history.recordRestSend(projectId, {
    requestId,
    requestName: meta?.requestName ?? item.request.name,
    apiName: meta?.apiName ?? item.api.name,
    folderPath: meta?.folderPath ?? '',
    method: input.request.method,
    url: summary?.url ?? input.baseUrl,
    requestHeaders: Object.fromEntries(
      input.request.headers.filter((header) => header.enabled).map((header) => [header.name, header.value]),
    ),
    requestBody: body.kind === 'raw' ? body.text : '',
    ...(summary !== undefined ? { exchange: summary } : {}),
    ...(error !== undefined ? { error: restErrorDetail(error) } : {}),
    durationMs,
    ...(keyParams !== undefined ? { keyParams } : {}),
    ...(meta?.tags !== undefined ? { tags: meta.tags } : {}),
  });
  if (entry !== undefined) {
    deps.onHistoryAppended?.(entry);
  }
}

/** One failure, as a history line records it. */
export function restErrorDetail(error: unknown): { code: string; message: string } {
  // History is always redacted: a message quoting what the request carried keeps no secret value.
  if (isWirebenchError(error)) {
    return { code: error.code, message: redactSecretValues(error.message) };
  }
  return {
    code: 'internal-error',
    message: redactSecretValues(error instanceof Error ? error.message : String(error)),
  };
}

/**
 * A REST exchange as `request.sendRest` answers it, redacted for `show`. The exchange cache keeps
 * the unredacted summary and the body, and re-renders it when the show-secrets flag changes.
 */
export function summariseRest(
  service: EngineService,
  sendId: string,
  exchange: RestExchange,
  contract: RestContractResult | undefined,
  options: {
    readonly method: string;
    readonly keyParams?: readonly string[];
    readonly keyHeaders?: readonly string[];
    readonly show: boolean;
  },
): RestExchangeSummary {
  const context = {
    method: options.method,
    ...(options.keyParams !== undefined ? { keyParams: options.keyParams } : {}),
    ...(options.keyHeaders !== undefined ? { keyHeaders: options.keyHeaders } : {}),
  };
  const summaryOf = (show: boolean): RestExchangeSummary => {
    const summary = toRestExchangeSummary(exchange, sendId, { ...context, show });
    return contract === undefined ? summary : { ...summary, contract: toRestContractWire(contract) };
  };
  service.exchanges.putRest(sendId, summaryOf(true), exchange.body, summaryOf);
  return summaryOf(options.show);
}

/** What a gRPC call sent, as History records it: the call as resolved and its message text. */
export interface GrpcSent {
  readonly input: GrpcResolvedInput;
  readonly messageText: string;
}

/**
 * Appends one gRPC send's History entry, successful or not. A no-op without a history service.
 * `item` names the request, its API and its method when the project has no meta for it.
 */
export async function recordGrpc(
  deps: RecordDeps,
  item: GrpcSelected,
  sent: GrpcSent,
  summary: GrpcExchangeSummary | undefined,
  durationMs: number,
  error?: unknown,
  label?: HistoryLabel,
): Promise<void> {
  const requestId = item.request.id;
  const projectId = deps.project.projectId(requestId);
  if (deps.history === undefined || projectId === undefined) {
    return;
  }
  const meta = labelled(deps.project.grpcMeta?.(requestId), label);
  const entry = await deps.history.recordGrpcSend(projectId, {
    requestId,
    requestName: meta?.requestName ?? item.request.name,
    apiName: meta?.apiName ?? item.api.name,
    folderPath: meta?.folderPath ?? '',
    target: summary?.target ?? sent.input.target,
    service: item.request.service,
    method: item.request.method,
    methodKind: item.request.methodKind,
    requestMetadata: Object.fromEntries(
      sent.input.metadata.filter((row) => row.enabled).map((row) => [row.name, row.value]),
    ),
    requestMessage: sent.messageText,
    ...(summary !== undefined ? { exchange: summary } : {}),
    ...(error !== undefined ? { error: restErrorDetail(error) } : {}),
    durationMs,
    ...(meta?.tags !== undefined ? { tags: meta.tags } : {}),
  });
  if (entry !== undefined) {
    deps.onHistoryAppended?.(entry);
  }
}

/** A gRPC call as `request.sendGrpc` answers it, redacted for `show`. History records the same. */
export function summariseGrpc(result: GrpcCallResult, sendId: string, show: boolean): GrpcExchangeSummary {
  return toGrpcExchangeSummary(result, sendId, { show });
}

/** A WebSocket session as `request.openWs` answers it, redacted for `show`. History records the same. */
export function summariseWs(
  exchange: WsExchange,
  sendId: string,
  options: { readonly show: boolean; readonly keyParams?: readonly string[] },
): WsExchangeSummary {
  return toWsExchangeSummary(exchange, sendId, options);
}

/**
 * Appends one WebSocket session's History entry, on close — successful or not. A no-op without a
 * history service. `item` names the request and its API when the project has no meta for it.
 * `handshakeOpened` is the same fact {@link reportWsHandshakeFailure} is guarded by (the handshake's
 * Log row was written), so History's `ok` follows it rather than re-deriving from
 * `summary.handshake.status`, which is optional and so cannot distinguish a refusal from a session
 * that opened but happens to carry no status (e.g. through a proxy tunnel).
 */
export async function recordWs(
  deps: RecordDeps,
  item: Pick<WsSelected, 'request' | 'api'>,
  summary: WsExchangeSummary,
  keyParams: readonly string[] | undefined,
  handshakeOpened: boolean,
  label?: HistoryLabel,
): Promise<void> {
  const requestId = item.request.id;
  const projectId = deps.project.projectId(requestId);
  if (deps.history === undefined || projectId === undefined) {
    return;
  }
  const meta = labelled(deps.project.wsMeta?.(requestId), label);
  const entry = await deps.history.recordWsSession(projectId, {
    requestId,
    requestName: meta?.requestName ?? item.request.name,
    apiName: meta?.apiName ?? item.api.name,
    folderPath: meta?.folderPath ?? '',
    exchange: summary,
    handshakeOpened,
    ...(keyParams !== undefined ? { keyParams } : {}),
    ...(meta?.tags !== undefined ? { tags: meta.tags } : {}),
  });
  if (entry !== undefined) {
    deps.onHistoryAppended?.(entry);
  }
}

/**
 * The HTTP Log's row for a handshake that never opened: a refusal (e.g. 401) or a transport
 * failure before any response. Checked against the *settled* `summary` rather than a live event:
 * the session settles with such a handshake rather than failing, and the host is told only of a
 * handshake that opened, so this is the one place such a failure can be seen and reported, exactly
 * like a prepare/send-stage failure. {@link recordWs} still writes History for it afterwards
 * (`closedBy: 'error'`).
 *
 * Guarded by `handshakeLogged` (the opened handshake's row was written) rather than by
 * `summary.handshake.status !== 101`: `status` is *optional* on the engine's handshake (e.g. absent
 * through a proxy tunnel, which never populates it even for a session that opened fine), so testing
 * it here could report a failure row for a session that already got a success row. The two rows
 * must stay provably exclusive.
 */
export function reportWsHandshakeFailure(
  deps: { readonly onSendFailed?: ((failure: FailedExchangeWire) => void) | undefined },
  sendId: string,
  requestId: string,
  summary: WsExchangeSummary,
  keyParams: readonly string[] | undefined,
  handshakeLogged: boolean,
): void {
  if (handshakeLogged) {
    return;
  }
  const { handshake } = summary;
  reportSendFailed(deps.onSendFailed, () =>
    failedExchangeOf({
      sendId,
      protocol: 'websocket',
      requestId,
      url: handshake.url,
      method: 'GET',
      headers: handshake.requestHeaders,
      startedAt: new Date(handshake.startedAt).getTime(),
      durationMs: handshake.durationMs,
      error:
        handshake.error !== undefined
          ? new WirebenchError('ws-handshake-failed', handshake.error)
          : new WirebenchError('ws-handshake-refused', 'The server refused the WebSocket handshake.'),
      keyParams,
    }),
  );
}
