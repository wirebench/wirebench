/**
 * Wraps `EngineService.send` so every completed (or failed) send is also recorded to the open
 * project's history — shared by `request.send` (`ipc/request.ts`) and `history.resend`
 * (`ipc/history.ts`), which both need the exact same "send, then append a redacted entry"
 * behaviour.
 */

import { isWirebenchError } from '@wirebench/engine';
import type { EngineService } from './engine-service.js';
import { failedExchangeOf } from './failed-exchange.js';
import type { HistoryService } from './history-service.js';
import type { ProjectRouter } from './project-router.js';
import type { PropertyScopes } from '@wirebench/engine';
import type {
  ExchangeSummary,
  FailedExchangeWire,
  HistoryEntryWire,
  ResolvedSendRequest,
} from '../shared/wire-types.js';

/** What an ad-hoc send with no `adHocScopes` expands against: nothing but the process env. */
const EMPTY_SCOPES: PropertyScopes = { project: {}, global: {}, system: process.env };

/** What `sendAndRecordHistory` needs from `ProjectRouter`, so tests can stub a minimal object. */
export type HistorySendProject = Pick<ProjectRouter, 'scopesFor' | 'authFor' | 'requestMeta' | 'projectId'> &
  // Optional so the many test stubs (and any ad-hoc caller with no project) stay valid: a send
  // without it simply carries no attachments, which is what an ad-hoc send should do anyway.
  // `wssFor` is optional for the same reason, and async besides: it resolves a password out of
  // the secret store, which is why it cannot live on the synchronous send input.
  // `proxyFor` is optional for the same reason, and async besides: resolving the proxy password
  // means a round trip to the OS keychain.
  Partial<Pick<ProjectRouter, 'sendAttachmentsFor' | 'wssFor' | 'proxyFor'>>;

/** Dependencies for {@link sendAndRecordHistory}. */
export interface SendWithHistoryDeps {
  readonly project: HistorySendProject;
  /**
   * The scopes an *ad-hoc* send expands against — one with no saved request behind it, and so
   * no project to resolve a chain from. Omitted in tests, which then expand against nothing.
   */
  readonly adHocScopes?: () => PropertyScopes;
  readonly showSecrets?: { get(): boolean };
  /** Omitted only in tests that don't care about history; the app always wires one in. */
  readonly history?: HistoryService;
  /** Called with the entry a successful record produced, so the caller can broadcast it. */
  readonly onHistoryAppended?: (entry: HistoryEntryWire) => void;
  /**
   * Called with the failure row of a send that threw, after History has recorded it, so the
   * caller can broadcast `exchange.failed`. Omitted in tests that don't care.
   */
  readonly onSendFailed?: (failure: FailedExchangeWire) => void;
}

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

const AD_HOC_NAME: HistoryNameFallback = { requestName: 'Ad-hoc request', interfaceName: '', operationName: '' };

function errorDetail(error: unknown): { code: string; message: string } {
  if (isWirebenchError(error)) {
    return { code: error.code, message: error.message };
  }
  return { code: 'internal-error', message: error instanceof Error ? error.message : String(error) };
}

/**
 * Sends `request` through `service.send`, then records a history entry for it (success, SOAP
 * fault, or transport error) against the project that owns the request — a no-op when no
 * project does (see {@link HistoryNameFallback.projectId}) or no `HistoryService` was supplied. Rethrows whatever `service.send` throws, after recording.
 */
export async function sendAndRecordHistory(
  service: EngineService,
  deps: SendWithHistoryDeps,
  request: ResolvedSendRequest,
  fallback: HistoryNameFallback = AD_HOC_NAME,
): Promise<ExchangeSummary> {
  // An ad-hoc send (a resend of an entry whose request is gone) names no entity, so there is
  // no project to route to: it carries no auth, no attachments, no WS-Security and no
  // project-scoped proxy rather than being routed to an arbitrary "current" project.
  const requestId = request.requestId;
  const owner = requestId === undefined ? undefined : deps.project.projectId(requestId);
  const auth = requestId !== undefined ? deps.project.authFor(requestId) : undefined;
  const attachments = requestId !== undefined ? deps.project.sendAttachmentsFor?.(requestId) : undefined;
  const wss = requestId !== undefined ? await deps.project.wssFor?.(requestId) : undefined;
  // Resolved per send rather than per session: the exclude list is evaluated against *this*
  // URL, and a system proxy can change under the app while it is running.
  const proxy = owner === undefined ? undefined : await deps.project.proxyFor?.(owner, request.input.endpoint);
  const startedAt = Date.now();
  try {
    const result = await service.send(request, {
      scopes: requestId === undefined ? (deps.adHocScopes?.() ?? EMPTY_SCOPES) : deps.project.scopesFor(requestId),
      showSecrets: deps.showSecrets?.get() ?? false,
      ...(auth !== undefined ? { auth } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
      ...(wss !== undefined ? { wss } : {}),
      ...(proxy !== undefined ? { proxy } : {}),
    });
    await record(service, deps, request, fallback, { durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    await record(service, deps, request, fallback, { durationMs, error: errorDetail(error) });
    // The failure row for the console's HTTP Log: the resolved headers the send went out with,
    // redacted for good inside `failedExchangeOf`. A SOAP send is always a POST.
    reportSendFailed(deps.onSendFailed, () =>
      failedExchangeOf({
        sendId: request.sendId,
        protocol: 'soap',
        requestId,
        url: request.input.endpoint,
        method: 'POST',
        headers: request.input.headers ?? {},
        startedAt,
        durationMs,
        error,
      }),
    );
    throw error;
  }
}

/**
 * Hands a failure row to `onSendFailed`, if one is wired. Anything the row builder or the listener
 * throws is swallowed: the send's own error is what the caller rethrows and the user must see.
 */
export function reportSendFailed(
  onSendFailed: ((failure: FailedExchangeWire) => void) | undefined,
  failure: () => FailedExchangeWire,
): void {
  if (onSendFailed === undefined) {
    return;
  }
  try {
    onSendFailed(failure());
  } catch {
    // Deliberately ignored — see above.
  }
}

async function record(
  service: EngineService,
  deps: SendWithHistoryDeps,
  request: ResolvedSendRequest,
  fallback: HistoryNameFallback,
  opts: { durationMs: number; error?: { code: string; message: string } },
): Promise<void> {
  if (deps.history === undefined) {
    return;
  }
  // The entry is keyed to the project the request came from. A send with no live request
  // belongs to no project, unless the caller named one (a resend of an orphaned entry goes
  // back into the history it came from); otherwise it is simply not recorded.
  const projectId =
    (request.requestId === undefined ? undefined : deps.project.projectId(request.requestId)) ?? fallback.projectId;
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
