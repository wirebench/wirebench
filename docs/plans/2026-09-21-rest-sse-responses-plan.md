# Server-Sent Events Responses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship issue #97 — a REST response of type `text/event-stream` renders event by event while open, Stop
ends it and records what arrived, and History and the HTTP Log keep it as a multi-message exchange.

**Architecture:** An in-house WHATWG event-stream parser in `packages/engine/src/rest/sse.ts`, fed by an opt-in
`stream` hook on `sendHttp` that only the desktop REST send passes. Around it the gRPC/WebSocket live pattern
repeats: `onStream` hooks on `sendRest`, a `rest.live` event correlated by `sendId`, a renderer `live` half
dropped when the exchange arrives, Stop through the existing `sends` registry, and the WebSocket History cap
generalised to `capByEnds`.

**Tech Stack:** TypeScript 5.9 (`strict`, `exactOptionalPropertyTypes`), Node ≥ 24, undici 8, `node:zlib`,
Zod 4, vitest, Electron, React. No new dependency.

**Spec:** `docs/specs/2026-09-21-rest-sse-responses-design.md` — read it first; decision numbers below are its.

## Global Constraints

- Branch `feat/rest-sse-responses`. One commit per task, only after
  `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check` is green.
- Commit as Mohammed Naami. **No** `Co-Authored-By:` trailer, **no** `Claude-Session:` trailer, no
  generated-by footer. The message body says why.
- Never name, in code, docs or UI copy, a product that inspired a feature (`pnpm check:banned-terms`).
- No local Electron windows, no e2e run locally; CI runs e2e. Heavy checks under `nice`.
- No new dependency. `formatVersion` stays 3. `packages/engine/src` imports nothing from Electron.
- The buffered `sendHttp` path must not change for any response that is not an accepted stream (spec AC6).
  WebSocket and gRPC behaviour must not change; `capFrames` keeps its exact results.
- Engine style: `readonly` interfaces, discriminated unions, no `any`, conditional spreads, JSDoc that says why;
  a thing the server did is a result, not a throw.

## File Structure

```
packages/engine/src/rest/sse.ts             createSseParser, isEventStream, eventStreamDocument, serializeEventStream
packages/engine/src/rest/sse-transcript.ts  capSseRows, createSseRowStore, SSE_* limits
packages/engine/src/ws/transcript.ts        + capByEnds; capFrames delegates
packages/engine/src/http/{types,client,decompress}.ts   stream hook, streamEnd, createDecompressStream
packages/engine/src/rest/{send,browser}.ts, src/index.ts   onStream, RestExchange.stream, exports
packages/engine/test/helpers/test-rest-server.ts           /sse/* routes
packages/engine/test/unit/rest/{sse,sse-transcript}.test.ts
packages/engine/test/integration/rest/sse.test.ts, test/integration/http/stream.test.ts
packages/engine/test/perf/budgets.test.ts                  parser budget
apps/desktop/src/shared/{wire-types,ipc}.ts                rest.live, stream on the summary
apps/desktop/src/main/{engine-service,engine-wire,history-service,har,log-curl}.ts, main/ipc/{request,log}.ts
apps/desktop/src/renderer/state/exchanges.ts, shell/app-shell.tsx
apps/desktop/src/renderer/features/rest-editor/response/{response-pane,events-view,status-line}.tsx, rest-editor.tsx
apps/desktop/src/renderer/features/{history,console}/…
e2e/specs/rest-sse.spec.ts
docs/ success-criteria, roadmap, CHANGELOG, REST spec non-goal, docs-site guides/rest-client.mdx
```

---

### Task 1: The event-stream parser

**Files:** Create `packages/engine/src/rest/sse.ts`; Test `packages/engine/test/unit/rest/sse.test.ts`.

**Interfaces — Produces:** `SseRow`, `SseParser`, `createSseParser`, `isEventStream`, `eventStreamDocument`,
`serializeEventStream` (spec §3, exact shapes).

- [ ] **Step 1: Failing tests**
```ts
import { describe, expect, it } from 'vitest';
import {
  createSseParser, eventStreamDocument, isEventStream, serializeEventStream, type SseRow,
} from '../../../src/rest/sse.js';

const enc = new TextEncoder();
function parse(...chunks: (string | Uint8Array)[]): SseRow[] {
  const rows: SseRow[] = [];
  const parser = createSseParser((row) => rows.push(row));
  chunks.forEach((chunk, i) => parser.push(typeof chunk === 'string' ? enc.encode(chunk) : chunk, i));
  parser.end();
  return rows;
}
const events = (rows: SseRow[]) => rows.filter((r) => r.kind === 'event');

describe('createSseParser', () => {
  it('dispatches on a blank line with the default type', () => {
    expect(events(parse('data: hi\n\n'))).toMatchObject([{ event: 'message', data: 'hi', lastEventId: '' }]);
  });
  it('joins multi-line data with LF and drops the trailing one', () => {
    expect(events(parse('data: a\ndata:b\ndata\n\n'))[0]).toMatchObject({ data: 'a\nb\n' });
  });
  it('strips exactly one space after the colon', () => {
    expect(events(parse('data:  two\n\n'))[0]).toMatchObject({ data: ' two' });
  });
  it('reads event, id and carries the last id to later events', () => {
    const rows = events(parse('event: tick\nid: 7\ndata: 1\n\ndata: 2\n\n'));
    expect(rows[0]).toMatchObject({ event: 'tick', id: '7', lastEventId: '7' });
    expect(rows[1]).toMatchObject({ event: 'message', lastEventId: '7' });
    expect(rows[1]).not.toHaveProperty('id');
  });
  it('ignores an id containing NUL', () => {
    expect(events(parse('id: a\u0000b\ndata: x\n\n'))[0]).toMatchObject({ lastEventId: '' });
  });
  it('turns comments and digit-only retry into rows, ignoring a bad retry and unknown fields', () => {
    const rows = parse(': keep-alive\nretry: 3000\nretry: 3s\nfoo: bar\ndata: x\n\n');
    expect(rows.map((r) => r.kind)).toEqual(['comment', 'retry', 'event']);
    expect(rows[0]).toMatchObject({ text: ' keep-alive' });
    expect(rows[1]).toMatchObject({ ms: 3000 });
  });
  it('does not dispatch an empty data buffer, and resets the type', () => {
    expect(events(parse('event: a\n\ndata: x\n\n'))[0]).toMatchObject({ event: 'message' });
  });
  it('accepts CRLF, LF and CR line ends, and a CR split from its LF across chunks', () => {
    expect(events(parse('data: a\r\n\r\ndata: b\r\rdata: c\r', '\n\r\n'))).toMatchObject([
      { data: 'a' }, { data: 'b' }, { data: 'c' },
    ]);
  });
  it('strips one leading BOM only', () => {
    expect(events(parse('\uFEFFdata: x\n\n'))[0]).toMatchObject({ data: 'x' });
  });
  it('decodes a multi-byte character split across chunks', () => {
    const bytes = enc.encode('data: é\n\n');
    expect(events(parse(bytes.subarray(0, 7), bytes.subarray(7)))[0]).toMatchObject({ data: 'é' });
  });
  it('gives the same rows however the input is chunked', () => {
    const text = ': c\nevent: e\nid: 1\ndata: {"a":1}\n\nretry: 10\ndata: z\r\n\r\n';
    const whole = parse(text).map(({ at: _at, ...rest }) => rest);
    const bytewise = parse(...[...enc.encode(text)].map((b) => Uint8Array.of(b))).map(({ at: _at, ...rest }) => rest);
    expect(bytewise).toEqual(whole);
  });
  it('discards an unterminated event at the end', () => {
    expect(events(parse('data: never\n'))).toEqual([]);
  });
  it('numbers rows contiguously and stamps the push time', () => {
    const rows = parse(': a\n', 'data: b\n\n');
    expect(rows.map((r) => [r.index, r.at])).toEqual([[0, 0], [1, 1]]);
  });
});

describe('isEventStream', () => {
  it.each([
    ['text/event-stream', true], ['Text/Event-Stream; charset=utf-8', true],
    ['application/json', false], [undefined, false],
  ])('%s → %s', (type, expected) => expect(isEventStream(type)).toBe(expected));
});

describe('eventStreamDocument / serializeEventStream', () => {
  const rows = parse(': hi\nretry: 5\nevent: t\nid: 1\ndata: {"n":1}\n\ndata: plain\n\n');
  it('builds a JSON array of events only, data parsed when it is JSON', () => {
    expect(JSON.parse(eventStreamDocument(rows))).toEqual([
      { event: 't', id: '1', data: { n: 1 }, at: 0 },
      { event: 'message', data: 'plain', at: 0 },
    ]);
  });
  it('re-serialises every row in event-stream form', () => {
    expect(serializeEventStream(rows)).toBe(': hi\n\nretry: 5\n\nevent: t\nid: 1\ndata: {"n":1}\n\ndata: plain\n\n');
  });
});
```
- [ ] **Step 2: Run → FAIL** (`pnpm vitest run packages/engine/test/unit/rest/sse.test.ts`).
- [ ] **Step 3: Implement.** A line buffer over a `TextDecoder('utf-8', { stream: true })`; a `pendingCr` flag
  so a CR at a chunk's end swallows a following LF; BOM stripped on the first decoded text only; per-line
  field handling exactly as spec decision 4; `size` = `enc.encode(line).length + 1` summed over the row's
  lines; comment and retry rows emitted at their line, events at the blank line. `serializeEventStream`
  writes every row followed by a blank line, an event's data split on LF into `data:` lines. The module has no `node:` import (it is re-exported from `rest/browser.ts`).
- [ ] **Step 4: Run → PASS.** **Step 5: Gate and commit** — `feat(rest): parse a Server-Sent Events stream`.

### Task 2: Caps — `capByEnds`, `capSseRows`, the memory store

**Files:** Modify `packages/engine/src/ws/transcript.ts`; Create `packages/engine/src/rest/sse-transcript.ts`;
Test `packages/engine/test/unit/rest/sse-transcript.test.ts` (the existing `ws/transcript.test.ts` must pass
unchanged).

**Interfaces — Consumes:** `SseRow` (Task 1), `WS_HISTORY_HEAD/TAIL/MAX_BYTES`. **Produces:**
```ts
// ws/transcript.ts
export interface CapLimits { readonly head: number; readonly tail: number; readonly maxBytes: number }
export function capByEnds<T>(items: readonly T[], limits: CapLimits, sizeOf: (item: T) => number,
  strip: (item: T) => T | undefined): { readonly items: readonly T[]; readonly truncated: boolean; readonly omitted: number };
// rest/sse-transcript.ts
export const SSE_MEMORY_ROWS = 10_000;
export const SSE_MEMORY_BYTES = 33_554_432;
export const SSE_SUMMARY_LIMITS: CapLimits;   // { head: 400, tail: 4_600, maxBytes: SSE_MEMORY_BYTES }
export const SSE_HISTORY_LIMITS: CapLimits;   // the WS_HISTORY_* numbers
export interface SseTranscript { readonly rows: readonly SseRow[]; readonly truncated: boolean; readonly omittedRows: number }
export function capSseRows(rows: readonly SseRow[], limits: CapLimits): SseTranscript;
export interface SseRowStore { add(row: SseRow): void; readonly rows: readonly SseRow[]; readonly droppedRows: number }
export function createSseRowStore(limits?: { rows: number; bytes: number }): SseRowStore;
```
`strip` returns `undefined` when an item has no payload to lose (a comment or retry row keeps its text: it is
small; only `event` data is stripped, with `payloadTruncated: true`).

- [ ] **Step 1: Failing tests**
```ts
import { describe, expect, it } from 'vitest';
import type { SseRow } from '../../../src/rest/sse.js';
import { SSE_HISTORY_LIMITS, capSseRows, createSseRowStore } from '../../../src/rest/sse-transcript.js';

const ev = (index: number, size = 10): SseRow =>
  ({ kind: 'event', index, at: index, size, event: 'message', data: 'x'.repeat(size), lastEventId: '' });

describe('capSseRows', () => {
  it('keeps a short stream whole', () => {
    expect(capSseRows([ev(0)], SSE_HISTORY_LIMITS)).toEqual({ rows: [ev(0)], truncated: false, omittedRows: 0 });
  });
  it('keeps the first 400 and the last 100', () => {
    const r = capSseRows(Array.from({ length: 1000 }, (_, i) => ev(i)), SSE_HISTORY_LIMITS);
    expect(r.rows).toHaveLength(500);
    expect(r.rows[400]?.index).toBe(900);
    expect(r).toMatchObject({ truncated: true, omittedRows: 500 });
  });
  it('past 1 MB an event keeps its row and loses its data', () => {
    const r = capSseRows([ev(0, 700_000), ev(1, 700_000), ev(2, 5)], SSE_HISTORY_LIMITS);
    expect(r.rows[1]).toMatchObject({ kind: 'event', size: 700_000, data: '', payloadTruncated: true });
    expect(r.rows[2]).toMatchObject({ data: 'xxxxx' });
  });
});

describe('createSseRowStore', () => {
  it('keeps the head and drops the oldest after it past the row limit', () => {
    const store = createSseRowStore({ rows: 500, bytes: 1e9 });
    for (let i = 0; i < 600; i++) store.add(ev(i));
    expect(store.rows).toHaveLength(500);
    expect(store.rows[399]?.index).toBe(399);
    expect(store.rows[400]?.index).toBe(500);
    expect(store.droppedRows).toBe(100);
  });
  it('drops by bytes too', () => {
    const store = createSseRowStore({ rows: 1e9, bytes: 4_500 });
    for (let i = 0; i < 1000; i++) store.add(ev(i));
    expect(store.droppedRows).toBeGreaterThan(0);
    expect(store.rows[0]?.index).toBe(0);
  });
});
```
- [ ] **Step 2: Run → FAIL. Step 3:** implement `capByEnds` from the body of `capFrames` (same algorithm,
  lifted over `sizeOf`/`strip`), then `capFrames = (f) => { const r = capByEnds(f, WS limits, …); return
  { frames: r.items, truncated: r.truncated, omittedFrames: r.omitted } }`. The store keeps a head array
  (≤ 400) and a tail deque; drops from the tail's front.
- [ ] **Step 4: Run → PASS** (both test files). **Step 5: Gate and commit** —
  `feat(rest): cap an event stream at both ends, sharing the WebSocket transcript cap`.

### Task 3: The transport's stream hook

**Files:** Modify `packages/engine/src/http/{types,client,decompress}.ts`,
`packages/engine/test/helpers/test-rest-server.ts`; Test `packages/engine/test/integration/http/stream.test.ts`.

**Interfaces — Produces:**
```ts
export interface HttpStreamSink { onChunk(bytes: Uint8Array): void }
export interface HttpStreamHook {
  /** Called once with the final (non-redirect) response; returning a sink switches to streaming. */
  accept(status: number, headers: Readonly<Record<string, string>>): HttpStreamSink | undefined;
}
// HttpRequest.stream?: HttpStreamHook
// HttpExchange.streamEnd?: { readonly by: 'server' | 'client' | 'error'; readonly error?: string }
export function createDecompressStream(contentEncoding: string | undefined): Transform | undefined;
```
Test server routes: `/sse/ticks?n=&every=` (events every `every` ms, then end), `/sse/forever` (a comment every
50 ms, never ends), `/sse/drop` (two events, then `socket.destroy()`), `/sse/gzip` (gzip-encoded ticks),
`/sse/slow-headers` (headers after 500 ms). All `Content-Type: text/event-stream`.

- [ ] **Step 1: Failing tests** — chunks reach the sink before `sendHttp` resolves (the `resolved` flag
  technique of the gRPC `streaming.test.ts`); `/sse/forever` with `timeoutMs: 200` is still streaming at 600 ms
  and an abort then resolves with `streamEnd.by === 'client'`, `body.length === 0`; `/sse/drop` resolves with
  `by: 'error'`; `/sse/gzip` hands over decompressed text; `/sse/slow-headers` with `timeoutMs: 100` still
  fails `timeout`; abort before headers still throws `aborted`; with a hook whose `accept` returns
  `undefined`, and with no hook, `/json` gives an exchange deep-equal (timings aside) to today's.
- [ ] **Step 2: Run → FAIL. Step 3:** implement. After `tracker.markHeaders()` and the redirect branch, ask
  `req.stream?.accept(...)`; on a sink, `clearTimeout(timer)`, pipe `response.body` through
  `createDecompressStream`, forward chunks, and catch abort/socket errors into `streamEnd`. Pass
  `bodyTimeout: req.stream !== undefined ? 0 : req.timeoutMs` (spec decision 8). `rawResponse` holds the
  status line and headers only.
- [ ] **Step 4: Run → PASS.** **Step 5: Gate and commit** — `feat(http): hand an accepted stream's body over as it arrives`.

### Task 4: `sendRest` streams an event-stream response

**Files:** Modify `packages/engine/src/rest/send.ts`, `rest/browser.ts`, `src/index.ts`; Test
`packages/engine/test/integration/rest/sse.test.ts`; perf budget in `packages/engine/test/perf/budgets.test.ts`.

**Interfaces — Consumes:** `createSseParser`, `isEventStream` (Task 1), `createSseRowStore` (Task 2),
`HttpStreamHook` (Task 3). **Produces:** `RestEventStream`, `RestExchange.stream?`, `RestSendInput.onStream?`
(spec §3); exports of `SseRow`, `RestEventStream`, `eventStreamDocument`, `serializeEventStream`,
`capSseRows`, `SSE_SUMMARY_LIMITS`, `SSE_HISTORY_LIMITS` from the index and `rest/browser.ts` (the browser
subpath gets `sse.ts` only).

- [ ] **Step 1: Failing tests** — `onRow` fires per row before the send resolves; the exchange's `stream`
  has the same rows, `counts`, `lastEventId`, `retryMs`, `endedBy: 'server'`; `text === ''`; an abort after
  `onOpen` resolves with `endedBy: 'client'`; a send without `onStream` to `/sse/ticks?n=3` buffers exactly as
  today (`stream` absent, `text` holds the raw stream); perf: parsing 100 000 small events stays under the
  budget set beside the existing budgets (measure, then set 2× the measured value).
- [ ] **Step 2: Run → FAIL. Step 3:** implement: when `onStream` is set, `httpRequest.stream = { accept }`
  where `accept` returns a sink only if `isEventStream(headers['content-type'])`; the sink feeds the parser
  with `at = now - headersAt`; rows go to the store and to `onRow`; `decodeRestResponse` attaches `stream`
  from the store and `streamEnd`.
- [ ] **Step 4: Run → PASS.** **Step 5: Gate and commit** — `feat(rest): an event-stream response arrives row by row`.

### Task 5: Main — `rest.live`, the summary, Stop

**Files:** Modify `apps/desktop/src/shared/{wire-types,ipc}.ts`, `main/engine-service.ts`,
`main/engine-wire.ts`, `main/ipc/request.ts`; Test `apps/desktop/test/ipc-rest-sse.test.ts`.

**Interfaces — Produces:**
```ts
export const sseRowWireSchema;               // SseRow as zod, payloadTruncated optional
export const restEventStreamWireSchema;      // rows, counts, lastEventId, retryMs?, endedBy, error?,
                                             // droppedRows, truncated, omittedRows
// restExchangeSummarySchema gains stream: restEventStreamWireSchema.optional()
export const restLiveEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('open'), sendId: z.string(), status: z.number(), headers: z.record(z.string(), z.string()) }),
  z.object({ kind: z.literal('row'), sendId: z.string(), row: sseRowWireSchema }),
]);
export type RestLiveEvent = z.infer<typeof restLiveEventSchema>;
// ipc.ts: events.rest.live = defineEvent('rest.live', restLiveEventSchema)
// EngineService.sendRestRequest options gain onLive?: (event: RestLiveEvent) => void
// engine-wire: toSseRowWire(row), toRestEventStreamWire(stream) — applies capSseRows(SSE_SUMMARY_LIMITS)
```
- [ ] **Step 1: Failing tests** against `startTestRestServer`: every `row` event is emitted before the invoke
  resolves; `open` headers are redacted unless secrets are shown (the redactor `toRestExchangeSummary` uses);
  `request.cancel` on `/sse/forever` resolves `sendRest` with `stream.endedBy === 'client'` and no failure row;
  a 12 000-row stream's summary carries 5 000 rows, `truncated`, `omittedRows`; a JSON send emits no event.
- [ ] **Step 2: Run → FAIL. Step 3:** implement; `sendRestRequest` in `ipc/request.ts` passes
  `onLive: (event) => emitEvent(sender, events.rest.live, event)`, as `sendGrpcRequest` does.
- [ ] **Step 4: Run → PASS.** **Step 5: Gate and commit** — `feat(desktop): stream an event-stream response to the renderer`.

### Task 6: History, HTTP Log, HAR, cURL

**Files:** Modify `packages/engine/src/project/history.ts` (`HistorySse`, `HistoryEntry.sse?`),
`apps/desktop/src/main/{history-service,har,log-curl}.ts`, `main/ipc/log.ts`,
`packages/engine/src/rest/curl.ts`, `renderer/features/console/{log-name,log-row-actions}.ts`; Tests: the
history unit test, `history-service.test.ts`, `har.test.ts`, `ipc-log.test.ts`,
`packages/engine/test/unit/rest/curl.test.ts`, `renderer/log-row-actions.test.ts` gain blocks.

**Interfaces — Produces:**
```ts
export interface HistorySse {
  readonly rows: readonly SseRow[];
  readonly counts: RestEventStream['counts'];
  readonly lastEventId: string;
  readonly endedBy: 'server' | 'client' | 'error';
  readonly error?: string;
  readonly truncated?: boolean;
  readonly omittedRows?: number;
}
export function historySseOf(stream: RestEventStreamWire): HistorySse;   // capSseRows(SSE_HISTORY_LIMITS)
```
- [ ] **Step 1: Failing tests** — a stopped stream writes one `rest` entry with `sse`, `ok` by status; 1 000
  events store 500 with `omittedRows: 500`; the search haystack matches event data; the log name reads
  `… · 3 events`; HAR `content` is `{ mimeType: 'text/event-stream', text: serializeEventStream(rows) }` with
  `_sseTruncated`/`_sseOmittedRows` when capped; `log.resend` of an SSE row throws `rest-resend-streaming`
  and the row menu disables Resend with "Event streams resend from the editor"; `restToCurl` adds `-N` when
  `Accept` includes `text/event-stream` and not otherwise.
- [ ] **Step 2: Run → FAIL. Step 3:** implement. **Step 4: Run → PASS.**
- [ ] **Step 5: Gate and commit** — `feat(history): record an event stream as a multi-message REST exchange`.

### Task 7: Renderer state — the live half and Stop

**Files:** Modify `renderer/state/exchanges.ts`, `renderer/shell/app-shell.tsx`,
`features/rest-editor/rest-editor.tsx`; Test `apps/desktop/test/renderer/rest-live-store.test.ts`.

**Interfaces — Produces** (beside the gRPC/WS members):
```ts
export interface RestLiveState {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly rows: readonly SseRowWire[];
  readonly droppedRows?: number;
  readonly counts: { readonly events: number; readonly comments: number; readonly retries: number; readonly bytes: number };
}
// RestExchangeState.live?: RestLiveState
applyRestLive(event: RestLiveEvent): void;
subscribeToRestLive(): () => void;
```
- [ ] **Step 1: Failing tests** — rows append in order and past `WS_LIVE_FRAME_LIMIT` the oldest go with
  `droppedRows`; a repeated tail `index` is ignored; an event for a superseded `sendId` or after the exchange
  arrived lands nowhere; `live` is gone once the exchange is set; the send button reads *Stop* while `live`
  exists and pressing it calls `cancelRest`; after Stop the state is the exchange, not `error`.
- [ ] **Step 2: Run → FAIL. Step 3:** implement with the `applyGrpcLive` guard. **Step 4: Run → PASS.**
- [ ] **Step 5: Gate and commit** — `feat(renderer): an event stream's live half, and Stop`.

### Task 8: Events tab, Query document, History view

**Files:** Create `features/rest-editor/response/events-view.tsx`; Modify `response/response-pane.tsx`,
`response/status-line.tsx`, `features/history/history-entry-view.tsx`; Tests
`renderer/rest-events-view.test.tsx`, `rest-response-pane.test.tsx`, `history-entry-view.test.tsx` gain blocks.

**Interfaces — Consumes:** `useFollowBottom`, `WS_TIMELINE_WINDOW` (from `ws-editor/timeline.tsx`, imported,
not changed), `prettyFrameText` (`@wirebench/engine/ws`), `eventStreamDocument` (`@wirebench/engine/rest`).
**Produces:** `EventsView({ rows, droppedRows?, omittedRows?, readOnly? })`.

- [ ] **Step 1: Failing tests** — rows show `mm:ss.mmm`, the event chip, id and a one-line preview; comment
  and retry rows show muted and one toggle hides them; the filter narrows by text; selecting a JSON row shows
  it pretty with a *Raw* toggle; past 1 000 rows the list windows; *Copy events as JSON* copies
  `eventStreamDocument`; Events is the first tab (Body hidden) when `stream` or `live` is present; Query
  receives `eventStreamDocument(rows)` with `documentKind: 'json'`; Raw shows headers and "event stream of N
  rows"; the status line adds events, last id and `stopped` when `endedBy: 'client'`; a History `sse` entry
  renders the list read-only with the banner "The first 400 and last 100 rows were kept; N omitted".
- [ ] **Step 2: Run → FAIL. Step 3:** implement; run `pnpm contrast:check` for the muted rows and chip.
- [ ] **Step 4: Run → PASS.** **Step 5: Gate and commit** — `feat(rest-editor): show an event stream as it arrives`.

### Task 9: e2e, documentation and the success criteria

**Files:**
- Create `e2e/specs/rest-sse.spec.ts` — start the test REST server as `rest.spec.ts` does; a REST request to
  `/sse/forever` → Send → at least two rows appear while the button reads *Stop* → Stop → the status line
  reads `stopped` → History lists the entry → the Console row reads `· N events`. One axe pass over the Events
  tab. **Do not run it locally.**
- Modify `docs/success-criteria.md` — SC-S1–SC-S6 (spec §8), each naming its test files; the header line
  lists the new range.
- Modify `docs/roadmap.md` (item 17: Server-Sent Events shipped; the 2.4 milestone line), `CHANGELOG.md`
  (`[Unreleased]` → Added), `docs/specs/2026-09-13-wirebench-rest-client-design.md` non-goal line (strike
  Server-Sent Events, point to `docs/specs/2026-09-21-rest-sse-responses-design.md`), this spec's header
  (`Status: built`).
- Modify `docs-site/src/content/docs/guides/rest-client.mdx` — an "Event streams" section: what triggers it,
  Stop, timeouts, caps, Query document, what is not built (reconnect, CLI); `guides/history.mdx` and
  `guides/http-log.mdx` one line each.
- [ ] Steps: e2e spec → docs → `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
  → `nice pnpm test:perf` (unskipped) → commit `docs(rest): Server-Sent Events responses, their criteria and guide`.

---

## Self-review notes

- **Spec coverage.** AC1 → Tasks 1, 3, 4, 5, 7, 8. AC2 → Tasks 3, 4, 5, 7. AC3 → Tasks 1, 8. AC4 → Tasks 2, 6,
  8. AC5 → Tasks 1, 8. AC6 → Tasks 3, 4 (buffered path tests), Task 2 (`capFrames` unchanged). Decisions
  12 (no reconnect) and 16 (CLI) → nothing built, documented in Task 9.
- **Reused, not reinvented.** `sends` registry and `request.cancel` (Stop); the `grpc.live`/`ws.live` event
  shape and `applyGrpcLive` guard; `capFrames` → `capByEnds` and the `WS_HISTORY_*` numbers;
  `WS_LIVE_FRAME_LIMIT`; `useFollowBottom` and `WS_TIMELINE_WINDOW`; `prettyFrameText`; `QueryView`; the
  gRPC streaming resend refusal.
- **Names checked across tasks.** `SseRow`, `createSseParser`, `isEventStream`, `eventStreamDocument`,
  `serializeEventStream` (1 → 4, 6, 8); `capByEnds`, `capSseRows`, `createSseRowStore`, `SSE_SUMMARY_LIMITS`,
  `SSE_HISTORY_LIMITS` (2 → 4, 5, 6); `HttpStreamHook`, `streamEnd` (3 → 4); `RestEventStream`,
  `RestSendInput.onStream` (4 → 5); `restLiveEventSchema`, `RestLiveEvent`, `events.rest.live`,
  `toRestEventStreamWire` (5 → 6, 7); `HistorySse`, `historySseOf`, `rest-resend-streaming` (6);
  `RestLiveState`, `applyRestLive`, `subscribeToRestLive` (7 → 8); `EventsView` (8).
- **Known risk, with its stop rule.** If undici's `bodyTimeout: 0` or streaming the body changes a buffered
  exchange in any Task 3 comparison test, stop and ask before touching the buffered path.
