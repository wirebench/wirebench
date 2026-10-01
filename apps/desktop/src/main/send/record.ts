/**
 * What a desktop send leaves behind once the engine has sent it: the summary the renderer is
 * handed (and the exchange cache keeps unredacted), and the History entry.
 */
import { isWirebenchError } from '@wirebench/engine';
import type {
  RestContractResult,
  RestExchange,
  RestSelected,
  RestSendInput,
  SoapExchange,
  SoapSendInput,
} from '@wirebench/engine';
import type { EngineService } from '../engine-service.js';
import { redactExchangeSummary, toExchangeSummary, toRestContractWire, toRestExchangeSummary } from '../engine-wire.js';
import type { SendThroughEngineDeps } from './exchange.js';
import type { ExchangeSummary, ResolvedSendInputWire, RestExchangeSummary } from '../../shared/wire-types.js';

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
  const meta = requestId !== undefined ? deps.project.requestMeta(requestId) : undefined;
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
): Promise<void> {
  const requestId = item.request.id;
  const projectId = deps.project.projectId(requestId);
  if (deps.history === undefined || projectId === undefined) {
    return;
  }
  const meta = deps.project.restMeta?.(requestId);
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
  if (isWirebenchError(error)) {
    return { code: error.code, message: error.message };
  }
  return { code: 'internal-error', message: error instanceof Error ? error.message : String(error) };
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
