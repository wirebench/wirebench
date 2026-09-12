/**
 * Registers the `history.*` IPC channels: list/search, read one entry, clear, and re-send.
 * `history.resend` goes through the same `sendAndRecordHistory` path as `request.send`, so a
 * re-send is itself recorded as a new history entry.
 */

import { WirebenchError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { HeaderEntryWire, HistoryEntryWire } from '../../shared/wire-types.js';
import type { EngineService } from '../engine-service.js';
import type { HistoryService } from '../history-service.js';
import { containsRedaction } from '../redact.js';
import type { ProjectRouter } from '../project-router.js';
import type { PropertyScopes } from '@wirebench/engine';
import type { HistorySendProject } from '../send-with-history.js';
import { sendAndRecordHistory } from '../send-with-history.js';
import { registerHandler } from './register.js';

/** What `history.resend` needs beyond `EngineService`/`HistoryService`. */
export interface HistoryChannelDeps {
  readonly project: HistorySendProject & Pick<ProjectRouter, 'buildLiveSendInput'>;
  /**
   * The scopes an *ad-hoc* send expands against — one with no saved request behind it, and so
   * no project to resolve a chain from. Omitted in tests, which then expand against nothing.
   */
  readonly adHocScopes?: () => PropertyScopes;
  readonly showSecrets?: { get(): boolean };
  /** Called with the new entry a re-send produced, so main can broadcast `history.appended`. */
  readonly onHistoryAppended?: (entry: HistoryEntryWire) => void;
}

/** Drops headers the history store redacted (`<redacted>`) before resending — never resent verbatim. */
function liveHeaders(headers: readonly HeaderEntryWire[]): Record<string, string> {
  return Object.fromEntries(headers.filter((header) => header.value !== '<redacted>').map((h) => [h.name, h.value]));
}

/**
 * True when an orphaned entry (its original request no longer exists) carries a redacted
 * secret anywhere a resend would replay: the request envelope, a request header value, or the
 * SOAP fault reason. Such an entry must never be resent — the redaction marker itself would go
 * out as the literal credential.
 */
function isRedacted(entry: HistoryEntryWire): boolean {
  return (
    containsRedaction(entry.request.envelopeXml) ||
    entry.request.headers.some((header) => containsRedaction(header.value)) ||
    (entry.fault?.reason !== undefined && containsRedaction(entry.fault.reason))
  );
}

export function registerHistoryChannels(
  service: EngineService,
  history: HistoryService,
  deps: HistoryChannelDeps,
): void {
  registerHandler(channels.history.list, (request) =>
    Promise.resolve(
      history.list({
        ...(request.query !== undefined ? { query: request.query } : {}),
        limit: request.limit ?? 200,
        ...(request.before !== undefined ? { before: request.before } : {}),
        ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
      }),
    ),
  );

  registerHandler(channels.history.get, (request) => Promise.resolve({ entry: history.get(request.id) }));

  registerHandler(channels.history.clear, async () => ({ cleared: await history.clear() }));

  registerHandler(channels.history.resend, (request) => {
    const entry = history.get(request.id);
    if (entry === undefined) {
      throw new WirebenchError('unknown-history-entry', `No history entry with id "${request.id}"`, {
        details: { id: request.id },
      });
    }

    // Path 1: the original request still exists — replay the LIVE request (current envelope,
    // headers and effective endpoint), exactly like a normal `request.send`. The stored entry
    // was redacted before being written to disk, so it must never be the source of a resend
    // while a live copy is available.
    const liveInput = entry.requestId !== undefined ? deps.project.buildLiveSendInput(entry.requestId) : undefined;
    if (liveInput === undefined) {
      // Path 2: the original request is gone. An entry that carries a redacted secret can never
      // be resent — the marker itself would go out as the literal credential — so refuse it.
      if (isRedacted(entry)) {
        throw new WirebenchError(
          'history-resend-redacted',
          'This entry contains redacted secrets and its original request no longer exists',
          { details: { id: request.id } },
        );
      }
    }

    const input = liveInput ?? {
      endpoint: entry.endpoint,
      envelopeXml: entry.request.envelopeXml,
      soapVersion: entry.soapVersion === 'none' ? '1.1' : entry.soapVersion,
      ...(entry.soapAction !== undefined ? { soapAction: entry.soapAction } : {}),
      headers: liveHeaders(entry.request.headers),
    };

    return sendAndRecordHistory(
      service,
      {
        project: deps.project,
        ...(deps.adHocScopes !== undefined ? { adHocScopes: deps.adHocScopes } : {}),
        ...(deps.showSecrets !== undefined ? { showSecrets: deps.showSecrets } : {}),
        history,
        ...(deps.onHistoryAppended !== undefined ? { onHistoryAppended: deps.onHistoryAppended } : {}),
      },
      {
        sendId: crypto.randomUUID(),
        ...(entry.requestId !== undefined ? { requestId: entry.requestId } : {}),
        input,
      },
      {
        requestName: entry.requestName,
        interfaceName: entry.interfaceName,
        operationName: entry.operationName,
        projectId: entry.projectId,
      },
    );
  });
}
