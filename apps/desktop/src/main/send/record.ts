/**
 * What a desktop send leaves behind once the engine has sent it: the summary the renderer is
 * handed (and the exchange cache keeps unredacted), and the History entry.
 */
import { isWirebenchError } from '@wirebench/engine';
import type { RestContractResult, RestExchange, RestSelected, RestSendInput } from '@wirebench/engine';
import type { EngineService } from '../engine-service.js';
import { toRestContractWire, toRestExchangeSummary } from '../engine-wire.js';
import type { SendThroughEngineDeps } from './exchange.js';
import type { RestExchangeSummary } from '../../shared/wire-types.js';

export type RecordDeps = Pick<SendThroughEngineDeps, 'project' | 'history' | 'onHistoryAppended'>;

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
