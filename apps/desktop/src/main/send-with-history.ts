/**
 * Wraps `EngineService.send` so every completed (or failed) send is also recorded to the open
 * project's history — shared by `request.send` (`ipc/request.ts`) and `history.resend`
 * (`ipc/history.ts`), which both need the exact same "send, then append a redacted entry"
 * behaviour.
 */

import { isWirebenchError } from '@wirebench/engine';
import type { EngineService } from './engine-service.js';
import type { HistoryService } from './history-service.js';
import type { ProjectService } from './project-service.js';
import type { ExchangeSummary, HistoryEntryWire, RequestSendRequest } from '../shared/wire-types.js';

/** What `sendAndRecordHistory` needs from `ProjectService`, so tests can stub a minimal object. */
export type HistorySendProject = Pick<ProjectService, 'scopesFor' | 'authFor' | 'requestMeta' | 'projectId'>;

/** Dependencies for {@link sendAndRecordHistory}. */
export interface SendWithHistoryDeps {
  readonly project: HistorySendProject;
  readonly showSecrets?: { get(): boolean };
  /** Omitted only in tests that don't care about history; the app always wires one in. */
  readonly history?: HistoryService;
  /** Called with the entry a successful record produced, so the caller can broadcast it. */
  readonly onHistoryAppended?: (entry: HistoryEntryWire) => void;
}

/** The label used when the send's `requestId` is unknown or no longer exists. */
export interface HistoryNameFallback {
  readonly requestName: string;
  readonly interfaceName: string;
  readonly operationName: string;
}

const AD_HOC_NAME: HistoryNameFallback = { requestName: 'Ad-hoc request', interfaceName: '', operationName: '' };

function errorDetail(error: unknown): { code: string; message: string } {
  if (isWirebenchError(error)) {
    return { code: error.code, message: error.message };
  }
  return { code: 'internal-error', message: error instanceof Error ? error.message : String(error) };
}

/**
 * Sends `request` through `service.send`, then records a history entry for it (success, SOAP
 * fault, or transport error) against the open project — a no-op when no project is open or no
 * `HistoryService` was supplied. Rethrows whatever `service.send` throws, after recording.
 */
export async function sendAndRecordHistory(
  service: EngineService,
  deps: SendWithHistoryDeps,
  request: RequestSendRequest,
  fallback: HistoryNameFallback = AD_HOC_NAME,
): Promise<ExchangeSummary> {
  const auth = request.requestId !== undefined ? deps.project.authFor(request.requestId) : undefined;
  const startedAt = Date.now();
  try {
    const result = await service.send(request, {
      scopes: deps.project.scopesFor(),
      showSecrets: deps.showSecrets?.get() ?? false,
      ...(auth !== undefined ? { auth } : {}),
    });
    await record(service, deps, request, fallback, { durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    await record(service, deps, request, fallback, {
      durationMs: Date.now() - startedAt,
      error: errorDetail(error),
    });
    throw error;
  }
}

async function record(
  service: EngineService,
  deps: SendWithHistoryDeps,
  request: RequestSendRequest,
  fallback: HistoryNameFallback,
  opts: { durationMs: number; error?: { code: string; message: string } },
): Promise<void> {
  if (deps.history === undefined) {
    return;
  }
  const projectId = deps.project.projectId();
  if (projectId === undefined) {
    return;
  }
  const meta = request.requestId !== undefined ? deps.project.requestMeta(request.requestId) : undefined;
  const name = meta ?? fallback;
  const exchange = opts.error === undefined ? service.exchanges.get(request.sendId) : undefined;
  const entry = await deps.history.recordSend(projectId, {
    ...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
    requestName: name.requestName,
    interfaceName: name.interfaceName,
    operationName: name.operationName,
    input: request.input,
    ...(exchange !== undefined ? { exchange } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {}),
    durationMs: opts.durationMs,
  });
  if (entry !== undefined) {
    deps.onHistoryAppended?.(entry);
  }
}
