/** What `HistoryService.recordWsSession` needs to build one WebSocket entry. */
export interface RecordWsSessionInput {
  readonly requestId: string;
  readonly requestName: string;
  /** The API the request belongs to, in the interface name's slot. */
  readonly apiName: string;
  readonly folderPath: string;
  readonly exchange: WsExchangeSummary;
  /**
   * Whether the live `handshake` event actually fired for this session — the one fact
   * `ipc/request.ts`'s `reportWsHandshakeFailure` is guarded by. `ok` is derived from it rather
   * than from `exchange.handshake.status === 101`: that status is optional on the engine's
   * handshake (e.g. absent through a proxy tunnel) and so cannot itself distinguish an opened
   * session from a refused one.
   */
  readonly handshakeOpened: boolean;
  /** Query parameters an API key travels in, masked in the URL whatever they are called. */
  readonly keyParams?: readonly string[];
  /** The run a sequence step's session belongs to, e.g. `sequence:<id>` and `run:<id>`. */
  readonly tags?: readonly string[];
}

/**
 * Builds one (already redacted) WebSocket `HistoryEntry` from a finished session — written on
 * close, whether the session closed cleanly or the handshake never got past `error`/a non-101
 * status — with the engine's builder, which the command line's `send` shares.
 *
 * `WsExchangeSummary` (the wire shape `openWsSession` resolves with) is already redacted for the
 * session's own show-secrets toggle; History redacts again unconditionally with `show: false`,
 * the same way `buildGrpcHistoryEntry` re-redacts its metadata regardless of what was shown live,
 * and masks every secret value main recorded this session.
 */
export function buildWsHistoryEntry(projectId: string, record: RecordWsSessionInput): HistoryEntry {
  // The wire shape (`WsExchangeSummary`, zod-inferred, every optional field typed `T | undefined`)
  // read as the engine's stricter `WsExchange` (plain `?:`, no explicit `undefined` under
  // `exactOptionalPropertyTypes`) — the same widen/narrow gap `toHistoryEntryWire`'s own JSON round
  // trip papers over elsewhere in this file. The shapes agree field for field; only
  // `exactOptionalPropertyTypes` disagrees, so the cast is safe.
  return buildEngineWsHistoryEntry(
    projectId,
    {
      requestId: record.requestId,
      requestName: record.requestName,
      apiName: record.apiName,
      folderPath: record.folderPath,
      exchange: record.exchange as unknown as WsExchange,
      handshakeOpened: record.handshakeOpened,
      ...(record.keyParams !== undefined ? { keyParams: record.keyParams } : {}),
      ...(record.tags !== undefined ? { tags: record.tags } : {}),
    },
    { text: redactSecretValues, base64: (base64) => redactSecretBytes(base64) },
  );
}

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

import { mkdirSync, watch } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  ProjectError,
  buildWsHistoryEntry as buildEngineWsHistoryEntry,
  detectLanguage,
  normalizeHistoryEntry,
  assertPathSegment,
  generateHistoryId,
  historyContractOf,
  historySseOf,
  openHistory,
} from '@wirebench/engine';
import type {
  HistoryEntry,
  HistorySse,
  HistoryFile,
  HistoryListQuery,
  RestContractResult,
  RestEventStreamLike,
  SseRow,
  WsExchange,
} from '@wirebench/engine';
import {
  redactHeaderPairs,
  redactHeaders,
  redactSecretBytes,
  redactSecretValues,
  redactStructuredBody,
  redactUrl,
  redactXml,
} from './redact.js';
import type {
  GrpcExchangeSummary,
  RestExchangeSummary,
  ExchangeSummary,
  HeaderEntryWire,
  HistoryEntryWire,
  ResolvedSendInputWire,
  WsExchangeSummary,
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

/** Starts watching one History file. `onChange` may fire more than once for one write. */
export type HistoryWatch = (file: string, onChange: () => void) => { close(): void };

/**
 * Watches the file's folder rather than the file: every write replaces the file (write a temp file,
 * rename it over), which a watch on the file itself would stop following. Temp and lock files in the
 * same folder are filtered out by name.
 */
export const watchHistoryFile: HistoryWatch = (file, onChange) => {
  const name = basename(file);
  mkdirSync(dirname(file), { recursive: true });
  const watcher = watch(dirname(file), (_event, changed) => {
    if (changed === null || changed === name) {
      onChange();
    }
  });
  watcher.on('error', (error) => {
    console.warn(`[history] the watch on "${file}" failed and was closed: ${error.message}`);
    watcher.close();
  });
  return { close: () => watcher.close() };
};

/** What a `HistoryService` does when another process writes one of its files (spec §3). */
export interface HistoryServiceOptions {
  /** Starts a watch per open file. Absent: no watching (tests, and anything that never shares). */
  readonly watch?: HistoryWatch;
  /** Called after a watched file changed on disk and was reloaded; main broadcasts `history.changed`. */
  readonly onChanged?: (projectId: string) => void;
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
  /**
   * The URL as sent. `toRestExchangeSummary` redacted it for the session's show-secrets toggle,
   * so it can still hold a key in the clear; History redacts it again with `show: false`.
   */
  readonly url: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  /** The request body as text; empty for a body with no text form. */
  readonly requestBody: string;
  readonly exchange?: RestExchangeSummary;
  readonly error?: { readonly code: string; readonly message: string };
  readonly durationMs: number;
  readonly tags?: readonly string[];
  /** Query parameters an API key travels in, masked in the URL whatever they are called. */
  readonly keyParams?: readonly string[];
  /** When the exchange happened, for one recorded elsewhere (an imported capture); absent means now. */
  readonly at?: string;
}

/** How much of a body a history line keeps. Beyond this it is truncated with a marker. */
const MAX_HISTORY_BODY_CHARS = 256 * 1024;

/**
 * A body as stored: itself when small, or its first characters with a marker naming what was cut —
 * either way with every secret value a send was handed masked, since History is written to disk.
 */
function storedBody(body: string): string {
  const text = redactSecretValues(body);
  if (text.length <= MAX_HISTORY_BODY_CHARS) {
    return text;
  }
  const kept = text.slice(0, MAX_HISTORY_BODY_CHARS);
  return `${kept}\n… truncated, ${String(text.length - MAX_HISTORY_BODY_CHARS)} more characters`;
}

/** The line {@link storedBody} ends a cut body with. */
const TRUNCATION_TAIL = /\n… truncated, \d+ more characters$/;

/**
 * True when `text` is History's truncated copy of a body: longer than the cap, and ending with the
 * line {@link storedBody} writes. Only the tail is tested, so a 256 KB body costs one short match.
 */
export function isTruncatedBody(text: string): boolean {
  return text.length > MAX_HISTORY_BODY_CHARS && TRUNCATION_TAIL.test(text.slice(-64));
}

/** An event-stream row as stored: its data or text masked, whatever the summary showed. */
function storedSseRow(row: SseRow): SseRow {
  if (row.kind === 'event') {
    return { ...row, data: redactSecretValues(row.data) };
  }
  return row.kind === 'comment' ? { ...row, text: redactSecretValues(row.text) } : row;
}

/**
 * The event stream as stored, capped by `historySseOf` and then masked, so only the rows kept are
 * scanned.
 */
function storedSse(stream: RestEventStreamLike): HistorySse {
  const sse = historySseOf(stream);
  return { ...sse, rows: sse.rows.map(storedSseRow) };
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
    at: record.at ?? new Date().toISOString(),
    projectId,
    requestId: record.requestId,
    requestName: record.requestName,
    interfaceName: record.apiName,
    operationName: record.folderPath,
    // Redacted again whatever the session showed: History is written to disk.
    endpoint: redactUrl(record.url, { show: false, extraParams: record.keyParams ?? [] }),
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
    // Cast for the same `exactOptionalPropertyTypes` gap `buildWsHistoryEntry` papers over above: the
    // wire's zod-inferred `id?: string | undefined` vs. the engine's plain `id?: string`. The shapes
    // agree field for field; only that strictness setting disagrees.
    ...(exchange?.stream !== undefined ? { sse: storedSse(exchange.stream as unknown as RestEventStreamLike) } : {}),
    // Cast for the same `exactOptionalPropertyTypes` gap as `sse` above; the shapes agree field for field.
    ...(exchange?.contract !== undefined
      ? { contract: historyContractOf(exchange.contract as RestContractResult) }
      : {}),
    sizeBytes:
      exchange === undefined
        ? Buffer.byteLength(record.requestBody, 'utf8')
        : Buffer.from(exchange.http.rawResponseBase64, 'base64').byteLength,
    ...(record.tags !== undefined ? { tags: record.tags } : {}),
  };
}

/** What `HistoryService.recordImportedRest` needs: one exchange a capture recorded, still raw. */
export interface RecordImportedRestInput {
  readonly requestId: string;
  readonly requestName: string;
  readonly apiName: string;
  /** When the capture says the exchange started, ISO 8601; the entry's `at`. */
  readonly at: string;
  readonly durationMs: number;
  readonly method: string;
  readonly url: string;
  readonly requestHeaders: readonly { readonly name: string; readonly value: string }[];
  readonly requestBody: string;
  readonly status: number;
  readonly statusText: string;
  readonly responseHeaders: readonly { readonly name: string; readonly value: string }[];
  readonly responseBody?: string;
  readonly tags: readonly string[];
}

/** Headers a recorded exchange keeps out of History altogether: the cookie jar's, not the request's. */
const IMPORT_DROPPED_HEADERS = new Set(['cookie', 'set-cookie']);

function withoutCookies(
  pairs: readonly { readonly name: string; readonly value: string }[],
): readonly { readonly name: string; readonly value: string }[] {
  return pairs.filter((pair) => !IMPORT_DROPPED_HEADERS.has(pair.name.toLowerCase()));
}

function contentTypeOf(pairs: readonly { readonly name: string; readonly value: string }[]): string | undefined {
  return pairs.find((pair) => pair.name.toLowerCase() === 'content-type')?.value;
}

/**
 * Builds one REST `HistoryEntry` from an exchange an imported capture recorded, through
 * {@link buildRestHistoryEntry} so the header and URL redaction is the one a live send gets.
 *
 * A live send's bodies come from a request whose credentials are references; a capture's are
 * whatever the browser saw, so secret-keyed JSON and form values are masked here first. The
 * exchange summary is synthesized from what the capture kept: no timings, TLS or raw bytes beyond
 * the response body, which sizes the entry.
 */
export function buildImportedRestHistoryEntry(projectId: string, record: RecordImportedRestInput): HistoryEntry {
  const requestHeaders = withoutCookies(record.requestHeaders);
  const responseHeaders = withoutCookies(record.responseHeaders);
  const responseType = contentTypeOf(responseHeaders);
  const requestBody = redactStructuredBody(record.requestBody, contentTypeOf(requestHeaders), { show: false });
  const responseText = redactStructuredBody(record.responseBody ?? '', responseType, { show: false });
  const responseBase64 = Buffer.from(responseText, 'utf8').toString('base64');
  const exchange: RestExchangeSummary = {
    sendId: `imported:${record.requestId}:${record.at}`,
    durationMs: record.durationMs,
    url: record.url,
    method: record.method,
    text: responseText,
    language: detectLanguage(responseType, Buffer.from(responseText, 'utf8')),
    cookies: [],
    methodChanged: false,
    problems: [],
    http: {
      status: record.status,
      statusText: record.statusText,
      headers: Object.fromEntries(responseHeaders.map((pair) => [pair.name.toLowerCase(), pair.value])),
      rawHeaders: responseHeaders.map((pair) => [pair.name, pair.value]),
      bodyBase64: responseBase64,
      rawBodyBase64: responseBase64,
      rawRequestBase64: '',
      rawResponseBase64: responseBase64,
      truncated: false,
      httpVersion: '1.1',
      timings: { startedAt: record.at, totalMs: record.durationMs },
      redirects: [],
      request: {
        url: record.url,
        method: record.method,
        headers: Object.fromEntries(requestHeaders.map((pair) => [pair.name, pair.value])),
      },
    },
  };
  return buildRestHistoryEntry(projectId, {
    requestId: record.requestId,
    requestName: record.requestName,
    apiName: record.apiName,
    // A HAR import places every request at its API's root.
    folderPath: '',
    method: record.method,
    url: record.url,
    requestHeaders: Object.fromEntries(requestHeaders.map((pair) => [pair.name, pair.value])),
    requestBody,
    exchange,
    durationMs: record.durationMs,
    tags: record.tags,
    at: record.at,
  });
}

/** What `HistoryService.recordGrpcSend` needs to build one gRPC entry. */
export interface RecordGrpcSendInput {
  readonly requestId: string;
  readonly requestName: string;
  /** The API the request belongs to, in the interface name's slot. */
  readonly apiName: string;
  readonly folderPath: string;
  /** The target as resolved, `host:port`. */
  readonly target: string;
  readonly service: string;
  readonly method: string;
  readonly methodKind: GrpcExchangeSummary['methodKind'];
  /** The request metadata as sent, redacted here. */
  readonly requestMetadata: Readonly<Record<string, string>>;
  /** The request message text as sent. */
  readonly requestMessage: string;
  readonly exchange?: GrpcExchangeSummary;
  readonly error?: { readonly code: string; readonly message: string };
  readonly durationMs: number;
  readonly tags?: readonly string[];
}

/**
 * Builds one (already redacted) gRPC `HistoryEntry`.
 *
 * The SOAP-shaped fields carry what they can, as a REST entry's do: the API's name as the
 * interface, the folder path as the operation, the target as the endpoint, the HTTP status as the
 * status. The call itself — method, gRPC status, every message on both sides — is in `grpc`, the
 * multi-message record ADR-0007 left room for; `ok` means the gRPC status was `OK`.
 */
export function buildGrpcHistoryEntry(projectId: string, record: RecordGrpcSendInput): HistoryEntry {
  const headers: HeaderEntryWire[] = Object.entries(redactHeaders(record.requestMetadata, { show: false })).map(
    ([name, value]) => ({ name, value }),
  );
  const exchange = record.exchange;
  return {
    id: generateHistoryId(),
    kind: 'grpc',
    at: new Date().toISOString(),
    projectId,
    requestId: record.requestId,
    requestName: record.requestName,
    interfaceName: record.apiName,
    operationName: record.folderPath,
    endpoint: record.target,
    soapVersion: 'none',
    ...(exchange !== undefined ? { status: exchange.http.status } : {}),
    durationMs: record.durationMs,
    ok: exchange !== undefined && exchange.status === 0,
    request: { envelopeXml: storedBody(record.requestMessage), headers },
    ...(exchange !== undefined
      ? {
          response: {
            envelopeXml: storedBody(
              exchange.responseMessages.map((message) => message.json ?? redactSecretBytes(message.base64)).join('\n'),
            ),
            rawHeaders: redactHeaderPairs(exchange.http.rawHeaders, { show: false }),
            status: exchange.http.status,
            statusText: exchange.statusName,
          },
        }
      : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    grpc: {
      service: record.service,
      method: record.method,
      methodKind: record.methodKind,
      ...(exchange !== undefined
        ? {
            status: exchange.status,
            statusName: exchange.statusName,
            ...(exchange.statusMessage !== undefined
              ? { statusMessage: redactSecretValues(exchange.statusMessage) }
              : {}),
          }
        : {}),
      requestMessages: exchange?.requestMessages.map(storedBody) ?? [storedBody(record.requestMessage)],
      // `storedBody` masks text; a message that did not decode is base64, masked as bytes first.
      responseMessages:
        exchange?.responseMessages.map((message) => storedBody(message.json ?? redactSecretBytes(message.base64))) ??
        [],
      trailers: Object.entries(redactHeaders(exchange?.trailers ?? {}, { show: false })).map(([name, value]) => ({
        name,
        value,
      })),
    },
    sizeBytes:
      exchange === undefined
        ? Buffer.byteLength(record.requestMessage, 'utf8')
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

  /** The watch on each open file, keyed by project id. */
  private readonly watchers = new Map<string, { close(): void }>();

  /** Reloads run one after another, so two change events never race one handle. */
  private reloads: Promise<void> = Promise.resolve();

  constructor(
    private readonly userDataDir: string,
    /**
     * How many entries to keep per project. A function rather than a number so a change to
     * `preferences.ui.historyCap` takes effect on the next append instead of at next launch.
     */
    private readonly cap?: () => number,
    private readonly options: HistoryServiceOptions = {},
  ) {}

  /** Opens (or reuses, if already open) the history file for `projectId`. */
  async open(projectId: string): Promise<void> {
    if (this.files.has(projectId)) {
      return;
    }
    const cap = this.cap?.();
    const path = historyFilePath(this.userDataDir, projectId);
    const file = await openHistory(path, {
      ...(cap !== undefined ? { cap } : {}),
    });
    // Re-check: a concurrent `open` for the same project may have won the race while we awaited.
    if (!this.files.has(projectId)) {
      this.files.set(projectId, file);
      const watch = this.options.watch;
      if (watch !== undefined) {
        try {
          this.watchers.set(
            projectId,
            watch(path, () => this.scheduleReload(projectId)),
          );
        } catch (error) {
          // The file is open and usable; without a watch another process's writes just show up late.
          console.warn(
            `[history] project "${projectId}": could not watch the History file, continuing unwatched: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }

  /** Detaches from one project's history. Safe to call when it is not open. */
  close(projectId: string): void {
    this.watchers.get(projectId)?.close();
    this.watchers.delete(projectId);
    this.files.delete(projectId);
  }

  /** Detaches from every open history file. */
  closeAll(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    this.files.clear();
  }

  /**
   * Reloads one project's file after its watch fired, and tells `onChanged` only when the file was
   * not the version this process last wrote — its own appends fire the watch too.
   */
  private scheduleReload(projectId: string): void {
    this.reloads = this.reloads
      .then(async () => {
        const file = this.files.get(projectId);
        if (file !== undefined && (await file.refresh())) {
          this.options.onChanged?.(projectId);
        }
      })
      .catch((error: unknown) => {
        console.warn(
          `[history] project "${projectId}": reloading the History file failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  /** Resolves once every reload scheduled so far has run. */
  whenReloaded(): Promise<void> {
    return this.reloads;
  }

  /**
   * Appends `entry`, or skips it when another writer holds the History lock: a busy file must not
   * turn a send that succeeded into a failed one. Any other error is the caller's.
   */
  private async appendOrSkip(projectId: string, file: HistoryFile, entry: HistoryEntry): Promise<boolean> {
    try {
      await file.append(entry);
      return true;
    } catch (error) {
      if (error instanceof ProjectError && error.code === 'history-busy') {
        console.warn(
          `[history] project "${projectId}": the History entry was skipped because the History file was busy`,
        );
        return false;
      }
      throw error;
    }
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
    return (await this.appendOrSkip(projectId, file, entry)) ? toHistoryEntryWire(entry) : undefined;
  }

  /** Appends one gRPC send's entry to its project's file, returning the wire shape it wrote. */
  async recordGrpcSend(projectId: string, record: RecordGrpcSendInput): Promise<HistoryEntryWire | undefined> {
    const file = this.files.get(projectId);
    if (file === undefined) {
      return undefined;
    }
    const entry = buildGrpcHistoryEntry(projectId, record);
    return (await this.appendOrSkip(projectId, file, entry)) ? toHistoryEntryWire(entry) : undefined;
  }

  /** Appends one WebSocket session's entry to its project's file, returning the wire shape it wrote. */
  async recordWsSession(projectId: string, record: RecordWsSessionInput): Promise<HistoryEntryWire | undefined> {
    const file = this.files.get(projectId);
    if (file === undefined) {
      return undefined;
    }
    const entry = buildWsHistoryEntry(projectId, record);
    return (await this.appendOrSkip(projectId, file, entry)) ? toHistoryEntryWire(entry) : undefined;
  }

  /** Appends one REST send's entry to its project's file, returning the wire shape it wrote. */
  async recordRestSend(projectId: string, record: RecordRestSendInput): Promise<HistoryEntryWire | undefined> {
    const file = this.files.get(projectId);
    if (file === undefined) {
      return undefined;
    }
    const entry = buildRestHistoryEntry(projectId, record);
    return (await this.appendOrSkip(projectId, file, entry)) ? toHistoryEntryWire(entry) : undefined;
  }

  /**
   * Appends one exchange an imported capture recorded, at the time it was recorded, returning the
   * wire shape it wrote; `undefined` when the project's file is not open or was busy.
   */
  async recordImportedRest(projectId: string, record: RecordImportedRestInput): Promise<HistoryEntryWire | undefined> {
    const file = this.files.get(projectId);
    if (file === undefined) {
      return undefined;
    }
    const entry = buildImportedRestHistoryEntry(projectId, record);
    return (await this.appendOrSkip(projectId, file, entry)) ? toHistoryEntryWire(entry) : undefined;
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

  /**
   * The newest REST entry of one request in its own project's file, or `undefined` when it was
   * never sent (or that file is not open). What a callback's URL is read from.
   */
  newestFor(projectId: string, requestId: string): HistoryEntryWire | undefined {
    const entry = this.files
      .get(projectId)
      ?.list({})
      .find((candidate) => candidate.requestId === requestId && candidate.kind === 'rest');
    return entry === undefined ? undefined : toHistoryEntryWire(entry);
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
