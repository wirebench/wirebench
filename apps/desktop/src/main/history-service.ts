/**
 * Owns the open project's persistent request history: a jsonl file under Electron's `userData`
 * (never inside the project folder — the brief for Task 24 is explicit that history must
 * survive even when the project folder is deleted or never saved), always redacted at write.
 *
 * Wraps `@wirebench/engine`'s `openHistory`/`HistoryFile`; the only desktop-specific piece is
 * where the file lives (`historyFilePath`) and how one send becomes a `HistoryEntry`
 * (`buildHistoryEntry`), which reuses the same `redact.ts` helpers as the HTTP log.
 */

import { join } from 'node:path';
import { generateHistoryId, openHistory } from '@wirebench/engine';
import type { HistoryEntry, HistoryFile, HistoryListQuery } from '@wirebench/engine';
import { redactHeaderPairs, redactHeaders, redactXml } from './redact.js';
import type { ExchangeSummary, HeaderEntryWire, HistoryEntryWire, SoapSendInputWire } from '../shared/wire-types.js';

/**
 * Converts the engine's `HistoryEntry` (all `readonly` fields/arrays) to the plain, mutable
 * `HistoryEntryWire` zod infers, via a JSON round trip — both shapes are already JSON-plain, so
 * this only strips the `readonly` modifiers `wrapHandler`'s response validation needs gone.
 */
export function toHistoryEntryWire(entry: HistoryEntry): HistoryEntryWire {
  return JSON.parse(JSON.stringify(entry)) as HistoryEntryWire;
}

/** Where one project's history file lives: `<userData>/history/<projectId>.jsonl`. */
export function historyFilePath(userDataDir: string, projectId: string): string {
  return join(userDataDir, 'history', `${projectId}.jsonl`);
}

/** What `HistoryService.recordSend` needs to build one entry, beyond the wire input it sent. */
export interface RecordSendInput {
  /** The saved request this send came from, if any. */
  readonly requestId?: string;
  readonly requestName: string;
  readonly interfaceName: string;
  readonly operationName: string;
  /** The `SoapSendInputWire` actually sent (post-expansion endpoint, as-authored envelope/headers). */
  readonly input: SoapSendInputWire;
  /** The UNREDACTED exchange summary, when the send completed (even as a SOAP fault). */
  readonly exchange?: ExchangeSummary;
  /** Set instead of `exchange` when the send never got a response (network error, abort, ...). */
  readonly error?: { readonly code: string; readonly message: string };
  readonly durationMs: number;
  readonly tags?: readonly string[];
}

/** True for a 2xx HTTP response carrying no SOAP fault. */
function isOk(exchange: ExchangeSummary | undefined): boolean {
  if (exchange === undefined) {
    return false;
  }
  const status = exchange.http.status;
  return status >= 200 && status < 300 && exchange.response?.fault === undefined;
}

/** Approximate on-the-wire size of a completed exchange, from its base64 response bytes. */
function sizeOf(exchange: ExchangeSummary | undefined, input: SoapSendInputWire): number {
  if (exchange === undefined) {
    return Buffer.byteLength(input.envelopeXml, 'utf8');
  }
  return Buffer.from(exchange.http.rawResponseBase64, 'base64').byteLength;
}

/**
 * Builds one (already redacted) `HistoryEntry` from a completed or failed send. Redaction is
 * unconditional here — history on disk is always redacted, regardless of the session's
 * show-secrets toggle (which only affects what the *live* HTTP log renders).
 */
export function buildHistoryEntry(projectId: string, record: RecordSendInput): HistoryEntry {
  const headers: HeaderEntryWire[] = Object.entries(redactHeaders(record.input.headers ?? {}, { show: false })).map(
    ([name, value]) => ({ name, value }),
  );
  const exchange = record.exchange;
  const fault = exchange?.response?.fault;
  return {
    id: generateHistoryId(),
    at: new Date().toISOString(),
    projectId,
    ...(record.requestId !== undefined ? { requestId: record.requestId } : {}),
    requestName: record.requestName,
    interfaceName: record.interfaceName,
    operationName: record.operationName,
    endpoint: record.input.endpoint,
    soapVersion: record.input.soapVersion,
    ...(record.input.soapAction !== undefined ? { soapAction: record.input.soapAction } : {}),
    ...(exchange !== undefined ? { status: exchange.http.status } : {}),
    durationMs: record.durationMs,
    ok: isOk(exchange),
    ...(fault !== undefined ? { fault: { code: fault.code, reason: fault.reason } } : {}),
    request: { envelopeXml: redactXml(record.input.envelopeXml, { show: false }), headers },
    ...(exchange !== undefined
      ? {
          response: {
            ...(exchange.response?.envelopeXml !== undefined
              ? { envelopeXml: redactXml(exchange.response.envelopeXml, { show: false }) }
              : {}),
            rawHeaders: redactHeaderPairs(exchange.http.rawHeaders, { show: false }),
            status: exchange.http.status,
            statusText: exchange.http.statusText,
          },
        }
      : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    sizeBytes: sizeOf(exchange, record.input),
    ...(record.tags !== undefined ? { tags: record.tags } : {}),
  };
}

/** Owns the currently open project's history file, opening/closing it as the project changes. */
export class HistoryService {
  private current: HistoryFile | undefined;
  private currentProjectId: string | undefined;

  constructor(
    private readonly userDataDir: string,
    /**
     * How many entries to keep per project. A function rather than a number so a change to
     * `preferences.ui.historyCap` takes effect on the next append instead of at next launch.
     */
    private readonly cap?: () => number,
  ) {}

  /** Opens (or reuses, if already open for this project) the history file for `projectId`. */
  async open(projectId: string): Promise<void> {
    if (this.currentProjectId === projectId && this.current !== undefined) {
      return;
    }
    const cap = this.cap?.();
    this.current = await openHistory(historyFilePath(this.userDataDir, projectId), {
      ...(cap !== undefined ? { cap } : {}),
    });
    this.currentProjectId = projectId;
  }

  /** Detaches from whatever project's history is open. Safe to call when none is. */
  close(): void {
    this.current = undefined;
    this.currentProjectId = undefined;
  }

  /** The id of the project whose history is currently open, if any. */
  get projectId(): string | undefined {
    return this.currentProjectId;
  }

  /** Builds and appends one entry for a completed/failed send, or `undefined` if no project is open. */
  async recordSend(projectId: string, record: RecordSendInput): Promise<HistoryEntryWire | undefined> {
    if (this.current === undefined || this.currentProjectId !== projectId) {
      return undefined;
    }
    const entry = buildHistoryEntry(projectId, record);
    await this.current.append(entry);
    return toHistoryEntryWire(entry);
  }

  list(query?: HistoryListQuery): { entries: HistoryEntryWire[]; total: number } {
    if (this.current === undefined) {
      return { entries: [], total: 0 };
    }
    const entries = this.current.list(query).map(toHistoryEntryWire);
    const total = query?.query !== undefined ? this.current.list({ query: query.query }).length : this.current.count();
    return { entries, total };
  }

  get(id: string): HistoryEntryWire | undefined {
    const entry = this.current?.get(id);
    return entry !== undefined ? toHistoryEntryWire(entry) : undefined;
  }

  async clear(): Promise<number> {
    return (await this.current?.clear()) ?? 0;
  }
}
