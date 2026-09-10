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
import type { HistorySendProject } from '../send-with-history.js';
import { sendAndRecordHistory } from '../send-with-history.js';
import { registerHandler } from './register.js';

/** What `history.resend` needs beyond `EngineService`/`HistoryService`. */
export interface HistoryChannelDeps {
  readonly project: HistorySendProject;
  readonly showSecrets?: { get(): boolean };
  /** Called with the new entry a re-send produced, so main can broadcast `history.appended`. */
  readonly onHistoryAppended?: (entry: HistoryEntryWire) => void;
}

/** Drops headers the history store redacted (`<redacted>`) before resending — never resent verbatim. */
function liveHeaders(headers: readonly HeaderEntryWire[]): Record<string, string> {
  return Object.fromEntries(headers.filter((header) => header.value !== '<redacted>').map((h) => [h.name, h.value]));
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
    return sendAndRecordHistory(
      service,
      {
        project: deps.project,
        ...(deps.showSecrets !== undefined ? { showSecrets: deps.showSecrets } : {}),
        history,
        ...(deps.onHistoryAppended !== undefined ? { onHistoryAppended: deps.onHistoryAppended } : {}),
      },
      {
        sendId: crypto.randomUUID(),
        ...(entry.requestId !== undefined ? { requestId: entry.requestId } : {}),
        input: {
          endpoint: entry.endpoint,
          envelopeXml: entry.request.envelopeXml,
          soapVersion: entry.soapVersion === 'none' ? '1.1' : entry.soapVersion,
          ...(entry.soapAction !== undefined ? { soapAction: entry.soapAction } : {}),
          headers: liveHeaders(entry.request.headers),
        },
      },
      { requestName: entry.requestName, interfaceName: entry.interfaceName, operationName: entry.operationName },
    );
  });
}
