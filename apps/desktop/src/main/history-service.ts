/**
 * Owns each open project's persistent request history: one jsonl file per project under
 * Electron's `userData` (never inside the project folder — the brief for Task 24 is explicit
 * that history must survive even when the project folder is deleted or never saved), always
 * redacted at write.
 *
 * Wraps `@wirebench/engine`'s `openHistory`/`HistoryFile`; the only desktop-specific piece is
 * where the file lives (`historyFilePath`) and how one send becomes a `HistoryEntry`
 * (`buildHistoryEntry`), which reuses the same `redact.ts` helpers as the HTTP log.
 */

import { join } from 'node:path';
import { normalizeHistoryEntry, assertPathSegment, generateHistoryId, openHistory } from '@wirebench/engine';
import type { HistoryEntry, HistoryFile, HistoryListQuery } from '@wirebench/engine';
import { redactHeaderPairs, redactHeaders, redactXml } from './redact.js';
import type {
  RestExchangeSummary,
  ExchangeSummary,
  HeaderEntryWire,
  HistoryEntryWire,
  ResolvedSendInputWire,
} from '../shared/wire-types.js';

/**
 * Converts the engine's `HistoryEntry` (all `readonly` fields/arrays) to the plain, mutable
 * `HistoryEntryWire` zod infers, via a JSON round trip — both shapes are already JSON-plain, so
 * this only strips the `readonly` modifiers `wrapHandler`'s response validation needs gone.
 */
export function toHistoryEntryWire(entry: HistoryEntry): HistoryEntryWire {
  // Normalised first: a line written before the REST client carries no `kind`, and the wire shape
  // says every entry has one. `normalizeHistoryEntry` is what decides such a line is SOAP.
  return JSON.parse(JSON.stringify(normalizeHistoryEntry(entry))) as HistoryEntryWire;
}

/**
 * Where one project's history file lives: `<userData>/history/<projectId>.jsonl`.
 *
 * The id is a single path segment and nothing else. A *linked* project keeps the id its own
 * `wirebench.yaml` declares, and that file may have been authored anywhere ("a colleague sent
 * me a project"), so an id such as `../../tmp/x` would otherwise make `writeFileAtomic` mkdir
 * and write outside `userData`. `WorkspaceService` refuses such a project before it ever gets
 * this far; this is the second lock on the same door, using the engine's own segment rule
 * rather than a second copy of it.
 *
 * @throws WorkspaceError `workspace-path-invalid` when `projectId` is not a safe path segment.
 */
export function historyFilePath(userDataDir: string, projectId: string): string {
  assertPathSegment(projectId);
  return join(userDataDir, 'history', `${projectId}.jsonl`);
}

/** What `HistoryService.recordSend` needs to build one entry, beyond the wire input it sent. */
export interface RecordSendInput {
  /** The saved request this send came from, if any. */
  readonly requestId?: string;
  readonly requestName: string;
  readonly interfaceName: string;
  readonly operationName: string;
  /** The input actually sent (post-expansion endpoint, as-authored envelope/headers). */
  readonly input: ResolvedSendInputWire;
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
function sizeOf(exchange: ExchangeSummary | undefined, input: ResolvedSendInputWire): number {
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
    kind: 'soap',
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

/** What `HistoryService.recordRestSend` needs to build one REST entry. */
export interface RecordRestSendInput {
  readonly requestId: string;
  readonly requestName: string;
  /** The API the request belongs to, which takes the place of a SOAP interface's name. */
  readonly apiName: string;
  /** The folder path inside the API, as `Pets / Admin`; empty at the API's root. */
  readonly folderPath: string;
  readonly method: string;
  /** The URL as sent, already redacted by `toRestExchangeSummary`. */
  readonly url: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  /** The request body as text; empty for a body with no text form. */
  readonly requestBody: string;
  readonly exchange?: RestExchangeSummary;
  readonly error?: { readonly code: string; readonly message: string };
  readonly durationMs: number;
  readonly tags?: readonly string[];
}

/** How much of a body a history line keeps. Beyond this it is truncated with a marker. */
const MAX_HISTORY_BODY_CHARS = 256 * 1024;

/** A body as stored: itself when small, or its first characters with a marker naming what was cut. */
function storedBody(text: string): string {
  if (text.length <= MAX_HISTORY_BODY_CHARS) {
    return text;
  }
  const kept = text.slice(0, MAX_HISTORY_BODY_CHARS);
  return `${kept}\n… truncated, ${String(text.length - MAX_HISTORY_BODY_CHARS)} more characters`;
}

/**
 * Builds one (already redacted) REST `HistoryEntry`.
 *
 * The shape is the SOAP entry's, reused deliberately: `interfaceName` carries the API's name and
 * `operationName` the folder path, so History's search, list and diff need no per-protocol
 * branching beyond the badge. `kind` says which protocol it was, and `method` the verb a SOAP entry
 * has no need of.
 */
export function buildRestHistoryEntry(projectId: string, record: RecordRestSendInput): HistoryEntry {
  const headers: HeaderEntryWire[] = Object.entries(redactHeaders(record.requestHeaders, { show: false })).map(
    ([name, value]) => ({ name, value }),
  );
  const exchange = record.exchange;
  const status = exchange?.http.status;
  return {
    id: generateHistoryId(),
    kind: 'rest',
    at: new Date().toISOString(),
    projectId,
    requestId: record.requestId,
    requestName: record.requestName,
    interfaceName: record.apiName,
    operationName: record.folderPath,
    endpoint: record.url,
    method: record.method,
    // A REST send speaks no SOAP version; the field is the shared entry's, so it says so.
    soapVersion: 'none',
    ...(status !== undefined ? { status } : {}),
    durationMs: record.durationMs,
    // A 3xx that was not followed is a perfectly good answer, so "ok" is anything but 4xx/5xx.
    ok: status !== undefined && status >= 200 && status < 400,
    request: { envelopeXml: storedBody(record.requestBody), headers },
    ...(exchange !== undefined
      ? {
          response: {
            envelopeXml: storedBody(exchange.text),
            rawHeaders: redactHeaderPairs(exchange.http.rawHeaders, { show: false }),
            status: exchange.http.status,
            statusText: exchange.http.statusText,
          },
        }
      : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    sizeBytes:
      exchange === undefined
        ? Buffer.byteLength(record.requestBody, 'utf8')
        : Buffer.from(exchange.http.rawResponseBase64, 'base64').byteLength,
    ...(record.tags !== undefined ? { tags: record.tags } : {}),
  };
}

/**
 * Owns one history file per open project, keyed by project id. Opening a second project does not
 * evict the first: every `list`/`get`/`clear` spans the open files unless a `projectId` narrows
 * it, and `recordSend` routes one entry to its own project's file.
 */
export class HistoryService {
  /** Open history files, in the order their projects were opened. */
  private readonly files = new Map<string, HistoryFile>();

  constructor(
    private readonly userDataDir: string,
    /**
     * How many entries to keep per project. A function rather than a number so a change to
     * `preferences.ui.historyCap` takes effect on the next append instead of at next launch.
     */
    private readonly cap?: () => number,
  ) {}

  /** Opens (or reuses, if already open) the history file for `projectId`. */
  async open(projectId: string): Promise<void> {
    if (this.files.has(projectId)) {
      return;
    }
    const cap = this.cap?.();
    const file = await openHistory(historyFilePath(this.userDataDir, projectId), {
      ...(cap !== undefined ? { cap } : {}),
    });
    // Re-check: a concurrent `open` for the same project may have won the race while we awaited.
    if (!this.files.has(projectId)) {
      this.files.set(projectId, file);
    }
  }

  /** Detaches from one project's history. Safe to call when it is not open. */
  close(projectId: string): void {
    this.files.delete(projectId);
  }

  /** Detaches from every open history file. */
  closeAll(): void {
    this.files.clear();
  }

  /** The ids of the projects whose history is currently open, in open order. */
  openProjectIds(): readonly string[] {
    return [...this.files.keys()];
  }

  /** The open files a query addresses: one project's, or all of them. */
  private filesFor(projectId: string | undefined): readonly HistoryFile[] {
    if (projectId === undefined) {
      return [...this.files.values()];
    }
    const file = this.files.get(projectId);
    return file !== undefined ? [file] : [];
  }

  /**
   * Builds and appends one entry for a completed/failed send, or `undefined` when that project's
   * history file is not open.
   */
  async recordSend(projectId: string, record: RecordSendInput): Promise<HistoryEntryWire | undefined> {
    const file = this.files.get(projectId);
    if (file === undefined) {
      return undefined;
    }
    const entry = buildHistoryEntry(projectId, record);
    await file.append(entry);
    return toHistoryEntryWire(entry);
  }

  /** Appends one REST send's entry to its project's file, returning the wire shape it wrote. */
  async recordRestSend(projectId: string, record: RecordRestSendInput): Promise<HistoryEntryWire | undefined> {
    const file = this.files.get(projectId);
    if (file === undefined) {
      return undefined;
    }
    const entry = buildRestHistoryEntry(projectId, record);
    await file.append(entry);
    return toHistoryEntryWire(entry);
  }

  /**
   * Newest-first entries across every open history file (or just `projectId`'s). Entries sharing
   * a timestamp keep their insertion order — the sort is stable over each file's own newest-first
   * list. `total` is the number of matching entries before `limit` (and ignoring `before`), which
   * is what the renderer shows as the result count.
   */
  list(query?: HistoryListQuery & { readonly projectId?: string }): { entries: HistoryEntryWire[]; total: number } {
    const files = this.filesFor(query?.projectId);
    const page: HistoryListQuery = {
      ...(query?.query !== undefined ? { query: query.query } : {}),
      ...(query?.before !== undefined ? { before: query.before } : {}),
    };
    const merged: HistoryEntry[] = [];
    let total = 0;
    for (const file of files) {
      merged.push(...file.list(page));
      total += query?.query !== undefined ? file.list({ query: query.query }).length : file.count();
    }
    // Stable, so entries with the same `at` keep each file's newest-first insertion order.
    merged.sort((left, right) => (left.at === right.at ? 0 : left.at < right.at ? 1 : -1));
    const limited = query?.limit !== undefined ? merged.slice(0, query.limit) : merged;
    return { entries: limited.map(toHistoryEntryWire), total };
  }

  /** The entry with this id, from whichever open file holds it. */
  get(id: string): HistoryEntryWire | undefined {
    for (const file of this.files.values()) {
      const entry = file.get(id);
      if (entry !== undefined) {
        return toHistoryEntryWire(entry);
      }
    }
    return undefined;
  }

  /** Empties one project's history, or every open project's. Returns the entries cleared. */
  async clear(projectId?: string): Promise<number> {
    let cleared = 0;
    for (const file of this.filesFor(projectId)) {
      cleared += await file.clear();
    }
    return cleared;
  }
}
