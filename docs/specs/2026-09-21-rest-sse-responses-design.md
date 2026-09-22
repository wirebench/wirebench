# Spec: Server-Sent Events responses

- Status: **built** 2026-09-21
- Date: 2026-09-21
- Issue: #97.
- Builds on: the REST client design (`docs/specs/2026-09-13-wirebench-rest-client-design.md`), the gRPC live
  streaming design (`docs/specs/2026-09-18-grpc-live-streaming-design.md`), the WebSocket request kind
  (`docs/specs/2026-09-19-websocket-request-kind-design.md`).

## Assumptions and decisions

The owner asked for this to proceed without check-ins; each is decided here, with its reason.

1. **An SSE response is a REST response, not a request kind.** No `kind`, no container, no format change. A
   REST request whose response says `Content-Type: text/event-stream` is shown as a stream; nothing is saved
   differently. `formatVersion` stays 3.
2. **Detection is the final response's media type**, `text/event-stream`, case-insensitive, parameters
   ignored, on any status. Redirect hops are drained as today. The `Accept` header is not consulted: a server
   that streams without being asked is exactly the case the issue describes.
3. **Opt-in at the transport; every other response is unchanged.** `sendHttp` streams only when the caller
   passes a `stream` hook *and* the response is an event stream. Without the hook (SOAP, the CLI runner,
   OAuth2 token fetches, `log.resend`) or for any other media type, the buffered path runs exactly as before —
   same body, same `maxSizeBytes` truncation, same timings. Only the desktop REST send passes the hook.
4. **The parser is in-house** (`packages/engine/src/rest/sse.ts`), browser-safe, no dependency. It follows the
   WHATWG event-stream rules: UTF-8 decode with a streaming decoder; one leading BOM stripped; lines end at
   CRLF, LF or CR (a CR at a chunk's end waits for the next chunk before it decides); a line starting `:` is a
   comment; `field: value` with one leading space stripped, a line with no colon is a field with an empty
   value; `data` appends value + LF; `event` sets the type; `id` sets the last event id unless it contains NUL;
   `retry` is kept only when all ASCII digits; unknown fields are ignored; a blank line dispatches — with an
   empty data buffer nothing is dispatched and the type resets; one trailing LF is removed from data; the type
   defaults to `message`. An unterminated event at end of stream is discarded, as the standard says.
5. **Comments and `retry:` are rows, not dropped** (issue AC). They sit in the same ordered list as events,
   the way WebSocket control frames sit among messages, and a toggle hides them (shown by default).
6. **Caps, reusing the WebSocket numbers.**
   - *Main memory:* at most `SSE_MEMORY_ROWS = 10 000` rows and `SSE_MEMORY_BYTES = 32 MB` of data. Past
     either, the first 400 rows stay and the oldest after them go (`droppedRows` counts them) — the head
     shows what the stream opened with, the tail is what a person is watching.
   - *Renderer live half:* `WS_LIVE_FRAME_LIMIT` (5 000), oldest first, `droppedRows` — the same rule and the
     same constant as `pushLiveFrame`.
   - *Final summary over IPC:* head 400 + tail 4 600 (5 000), so the pane does not lose rows when the live
     half is replaced.
   - *History and the HTTP Log's HAR:* the WebSocket History cap — first 400 + last 100 rows, 1 MB of data,
     an oversized row keeps its place and loses its data (`payloadTruncated`). `capFrames` is generalised to
     `capByEnds` so both kinds share one implementation and one set of constants.
7. **Stop aborts and records; it is never an error.** Stop is the existing `request.cancel` by `sendId`
   (the `sends` registry). Once the stream has begun, an abort resolves the send with the exchange so far and
   `stream.endedBy: 'client'`. A socket error mid-stream also resolves, with `endedBy: 'error'` and the
   message; the rows received are the result. An abort *before* the headers arrive stays today's `aborted`
   failure.
8. **Timeouts.** The request's timeout governs until the response headers arrive, as today. Once an event
   stream is accepted, the deadline timer is cleared and no idle timeout applies: keep-alive comments every
   15–60 s are normal. What ends a stream is the server, Stop, or the network. To make that possible the
   transport passes undici `bodyTimeout: 0` when a `stream` hook is present; a buffered response is still
   bounded by the overall deadline, which was always the tighter limit, so its outcome is unchanged.
9. **`maxSizeBytes` does not apply to a stream**; decision 6 bounds it instead. **Compression** is decoded
   incrementally (`gzip`, `deflate`, `br`) through `node:zlib` streams.
10. **Body, Raw.** A stream's `text` is empty and its Body tab is replaced by **Events**. Raw shows the request
    as today and the response status line and headers, then one line saying the body is an event stream of N
    rows, shown under Events. The raw body is not kept.
11. **Query view.** It runs over a JSON document built from the kept events:
    `[{ "event", "id", "data", "at" }]`, `data` parsed when it parses as JSON, else the string. Comments and
    retry rows are not in it. JSONPath and XPath both work on it, unchanged.
12. **Last-Event-ID.** Carried on the exchange (`lastEventId`) and shown in the status line and History.
    Reconnecting with it, honouring `retry`, and auto-reconnect are **out of scope**; a person who wants to
    resume adds the header by hand.
13. **HAR.** An SSE row exports as an ordinary entry whose `response.content` is
    `{ mimeType: 'text/event-stream', text }`, `text` re-serialised from the kept rows in event-stream format
    (comments as `: …`, retry as `retry: n`), plus `_sseTruncated`/`_sseOmittedRows` when capped.
14. **cURL and copy.** *Copy as cURL* adds `-N` (no buffering) when the request's `Accept` includes
    `text/event-stream`. The Events tab has *Copy events as JSON* (the Query document).
15. **`log.resend` refuses an SSE row** with `rest-resend-streaming`, "Event streams resend from the editor",
    the gRPC streaming rule: a resend has no live pane and no Stop.
16. **The CLI runner is out of scope.** It does not pass the hook, so it buffers until the server closes or
    the timeout fires, exactly as today.
17. **UI copy and docs never name other tools.**

---

## 1. Objective

**What.** A REST response of type `text/event-stream` renders event by event while the connection is open,
can be stopped, and lands in History and the HTTP Log as a multi-message exchange.

**Why.** Token-streaming APIs and the streamable-HTTP transport of agent tool protocols answer with
`text/event-stream`; today such a response shows nothing until the connection closes.

**Acceptance criteria** (the issue's, made testable):

- AC1. A `text/event-stream` response lists each event while the connection is open: event name, id, data,
  arrival time (ms since the headers arrived).
- AC2. Stop closes the connection; the exchange is recorded with the events received so far, `endedBy:
  'client'`, not as a failure.
- AC3. A JSON `data:` payload pretty-prints in the event detail, and the Query view evaluates over the
  events document (decision 11).
- AC4. History and the HTTP Log record the exchange as multi-message, the way a gRPC stream is: History keeps
  the capped rows; the log row names the event count; HAR carries the stream text.
- AC5. A comment line and a `retry:` field appear as rows.
- AC6. Every non-event-stream response, and every send without the hook, behaves exactly as before.

## 2. Tech stack

TypeScript, Node 24, undici 8 (`request` body as an async iterable), `node:zlib` streams, zod, React. No new
dependency. Tests: vitest; the existing `test-rest-server.ts` gains `/sse/*` routes; Playwright e2e in CI.

## 3. Engine

```ts
// packages/engine/src/rest/sse.ts — browser-safe
export type SseRow =
  | { readonly kind: 'event'; readonly index: number; readonly at: number; readonly size: number;
      readonly event: string; readonly data: string; readonly id?: string; readonly lastEventId: string;
      readonly payloadTruncated?: true }
  | { readonly kind: 'comment'; readonly index: number; readonly at: number; readonly size: number;
      readonly text: string }
  | { readonly kind: 'retry'; readonly index: number; readonly at: number; readonly size: number;
      readonly ms: number };
export interface SseParser { push(chunk: Uint8Array, at: number): void; end(): void }
export function createSseParser(onRow: (row: SseRow) => void): SseParser;
export function eventStreamDocument(rows: readonly SseRow[]): string;   // decision 11
export function serializeEventStream(rows: readonly SseRow[]): string;  // decision 13
export function isEventStream(contentType: string | undefined): boolean; // decision 2

// packages/engine/src/rest/send.ts
export interface RestEventStream {
  readonly rows: readonly SseRow[];
  readonly counts: { readonly events: number; readonly comments: number; readonly retries: number;
                     readonly bytes: number };
  readonly lastEventId: string;
  readonly retryMs?: number;
  readonly endedBy: 'server' | 'client' | 'error';
  readonly error?: string;
  readonly droppedRows: number;
}
// RestExchange.stream?: RestEventStream
// RestSendInput.onStream?: { onOpen?(status: number, headers: Record<string, string>): void;
//                            onRow?(row: SseRow): void }
```

- **Transport seam** (`http/types.ts`, `http/client.ts`): `HttpRequest.stream?: HttpStreamHook` with
  `accept(status, headers): HttpStreamSink | undefined` and `HttpStreamSink.onChunk(bytes)`. When `accept`
  returns a sink, the deadline is cleared, chunks are decompressed and handed over as they come, an abort or
  socket error ends the read with `HttpExchange.streamEnd: { by: 'server' | 'client' | 'error', error? }`
  instead of a throw, and `body`/`rawBody` are empty. `sendRest` accepts only when `isEventStream` holds and
  `onStream` was given.
- The row `index` is contiguous; `at` is ms since the headers; `size` is the UTF-8 bytes of the row's lines.
- **Caps.** `ws/transcript.ts` gains `capByEnds<T>(items, { head, tail, maxBytes, sizeOf, strip })`;
  `capFrames` becomes a call to it with unchanged results; `rest/sse-transcript.ts` adds `capSseRows(rows,
  limits)` and the memory ring `createSseRowStore()` (decision 6).
- **Reuse.** `ws/pretty.ts` `prettyFrameText` for the detail; `WS_HISTORY_HEAD/TAIL/MAX_BYTES` for History.

## 4. IPC and main

Same pattern as `grpc.live` and `ws.live`:

- `request.sendRest` still resolves with the whole exchange; while it runs, a `rest.live` event
  (`open` with status and redacted headers, then one `row` per row) is emitted, correlated by `sendId`.
- `EngineService.sendRestRequest` gains `onLive`; the `sends` map it already registers is what Stop aborts.
- `RestExchangeSummary.stream?`: rows (head 400 + tail 4 600), counts, `lastEventId`, `retryMs`, `endedBy`,
  `error`, `droppedRows`, `truncated`, `omittedRows`.
- History: `HistoryEntry.kind` stays `'rest'`; it gains `sse?: HistorySse` — the capped rows, counts,
  `lastEventId`, `endedBy`, `error`, `truncated`, `omittedRows`; `ok` is the 2xx rule as for any REST send.
- HTTP Log: one row per exchange, written when it ends, as a gRPC stream's is; the name column adds
  `· N events`; HAR per decision 13; resend per decision 15; cURL per decision 14.

## 5. Renderer

- `RestExchangeState.live?: RestLiveState { status?, headers?, rows, droppedRows?, counts }`;
  `applyRestLive` applies the `applyGrpcLive` sendId guard; `live` is dropped when the exchange arrives;
  `subscribeToRestLive` beside `subscribeToWsLive` in the app shell.
- The send button reads **Stop** while a stream is open (it is `cancelRest`).
- **Events** tab (first tab when `stream` or `live` is present, Body otherwise): rows of arrival time
  `mm:ss.mmm`, event-name chip, id, one-line data preview; comment and retry rows muted, one toggle hides
  them; free-text filter; keyed by `index`; follows the bottom only while pinned and windows past
  `WS_TIMELINE_WINDOW` — both by importing `useFollowBottom` and the constant from the WebSocket timeline.
  Selecting a row shows `prettyFrameText(data)` in the read-only viewer with a *Raw* toggle. A banner says
  how many rows were let go. Status line adds `· N events · last id 42 · stopped`.
- Query tab over `eventStreamDocument`, `documentKind: 'json'`. History entry view: the same Events list,
  read-only, with the capped-transcript banner the WebSocket view uses.

## 6. Testing

- **Unit** (`packages/engine/test/unit/rest/sse.test.ts`, `sse-transcript.test.ts`,
  `ws/transcript.test.ts` unchanged and green): every parser rule in decision 4, chunk boundaries anywhere
  (byte-by-byte split of a fixture equals the whole), multi-byte UTF-8 split across chunks, the document and
  serialiser, `isEventStream`, the caps.
- **Integration** (`packages/engine/test/integration/rest/sse.test.ts` against `/sse/*`): rows arrive before
  the send resolves; a stream outlives `timeoutMs`; abort after headers resolves with `endedBy: 'client'`;
  abort before headers still fails `aborted`; a mid-stream socket drop resolves with `endedBy: 'error'`;
  gzip stream; a JSON response and a send without the hook are byte-identical to before.
- **Desktop:** `rest.live` ordering, redaction of live headers, Stop records History, the History cap, the
  log row name, HAR, resend refusal, cURL `-N`, the live store guard, the Events tab and Query document.
- **e2e** (CI only): send to `/sse/ticks`, see rows appear before the end, Stop, History lists it.
- **Perf:** `pnpm test:perf` unskipped; the parser budget test (100 000 events) in `packages/engine/test/perf`.

## 7. Boundaries

- **Always:** one commit per plan task after `WIREBENCH_SKIP_PERF=1 pnpm check`; no trailers; docs in the same
  change as the feature.
- **Ask first:** any new dependency; a behaviour change to the buffered `sendHttp` path; any change to the
  WebSocket or gRPC live plumbing beyond `capByEnds` and importing `useFollowBottom`.
- **Never:** name another tool; build reconnection, `Last-Event-ID` replay, `retry` honouring, SSE in the CLI,
  sending into the stream, or a new request kind for SSE; merge the HTTP Log with History; run e2e locally.

## 8. Success criteria

Rows to add to `docs/success-criteria.md`, one per AC:

| ID | Criterion |
|----|-----------|
| SC-S1 | An event-stream response lists name, id, data and arrival time per event while open (AC1) |
| SC-S2 | Stop ends the stream and records it with the events so far, not as a failure (AC2) |
| SC-S3 | JSON data pretty-prints; the Query view evaluates over the events document (AC3) |
| SC-S4 | History and the HTTP Log record the exchange as multi-message, capped, with HAR text (AC4) |
| SC-S5 | Comment lines and `retry:` fields appear as rows (AC5) |
| SC-S6 | Every other response, and every send without the hook, is unchanged (AC6) |

Done when each row names a passing test, `pnpm check` and CI e2e are green, and the REST spec's non-goal line
strikes Server-Sent Events and points here.
