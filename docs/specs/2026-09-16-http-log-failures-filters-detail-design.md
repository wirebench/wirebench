# Spec: HTTP Log — failed sends, filter bar and detail tabs

- Status: **draft** (under review)
- Date: 2026-09-16
- Builds on: `docs/specs/2026-09-09-wirebench-v1-explore-and-send-design.md` (the console and the
  HTTP Log), `docs/specs/2026-09-13-wirebench-rest-client-design.md` (REST sends reaching the log),
  `docs/security.md` (no secret is ever written to a log) and `docs/roadmap.md` (item 8 follow-ups).

## Assumptions I'm making

1. **The HTTP Log stays a session view; History stays the persistent record.** The owner considered
   merging the two into one persisted per-project record and decided against it (2026-09-16). This
   spec does not persist the log, and History is untouched.
2. **Failed sends are reported by main, not reconstructed by the renderer.** Main is the only place
   that has the resolved request headers, and it already catches every transport error once, to
   write History. It gains one broadcast there. A renderer-built row would carry no headers, which
   is what a user debugging a proxy or TLS failure needs most.
3. **A failure row's headers are redacted at emit time and stay redacted.** Failures are not held
   in the unredacted `ExchangeCache`, so the _show secrets_ toggle cannot reveal them later. This is
   the safe direction and matches the known REST re-redaction gap (roadmap item 8). The detail pane
   says so on such a row.
4. **The exchange schemas do not change.** A failure is a new, separate wire shape; the log becomes
   a list of "exchange or failure" entries. The response pane, inspectors, status bar and History
   keep consuming `ExchangeSummary` / `RestExchangeSummary` exactly as before.
5. **Filter state lives in the exchanges store**, so it survives switching console tabs, and is
   dropped with the log on workspace close. It is not persisted.
6. **Out of scope, deliberately:** persistence of the log, HAR export and per-row copy-as-cURL
   (recorded as the next slice), a waterfall column, DNS timing (unimplemented in the engine by
   design), the REST re-redaction gap, and grouping rows by request.

---

## 1. Objective

**What.** Make the console's HTTP Log a complete record of every send the app performed this
session — including the ones that never produced a response — and make it usable at volume, the
way a browser's network panel is: filter it, and read one row's headers, bodies, timing and
connection details in tabs.

**Why.**

- A send that fails at the network level (DNS, refused connection, TLS, proxy, timeout, abort, too
  many redirects) today leaves no trace in the log. It shows once in the response pane header and
  in Problems, then is gone when the next send runs. "What exactly did I send, and how long before
  it failed?" cannot be answered afterwards.
- The log has no filter. Past a few dozen rows, finding the one 4xx or the one call to a given host
  is scrolling.
- The detail pane shows raw bytes only. Redirect hops and TLS peer information are captured on the
  record but not rendered there; timings phases are shown with no explanation of why one is `n/a`.

---

## 2. Data

### 2.1 `FailedExchangeWire` (new, `apps/desktop/src/shared/wire-types.ts`)

Plain JSON, beside `httpExchangeWireSchema`:

| Field        | Type                       | Notes                                                             |
| ------------ | -------------------------- | ----------------------------------------------------------------- |
| `sendId`     | string                     | Same id the renderer generated for the send.                      |
| `protocol`   | `'soap' \| 'rest'`         |                                                                   |
| `requestId`  | string, optional           | Absent for an ad-hoc resend of an orphaned History entry.         |
| `request`    | `{ url, method, headers }` | Same shape as `httpExchangeWireSchema.request`; headers redacted. |
| `startedAt`  | ISO string                 | Wall-clock start, as `timingsWireSchema.startedAt`.               |
| `durationMs` | number                     | Start to failure.                                                 |
| `error`      | `{ code, message }`        | From the engine's `HttpErrorCode` set, or `internal-error`.       |

Redaction of `request.headers` uses the same header redaction History applies, always with
`show: false` (assumption 3).

### 2.2 Log entry (renderer, `state/exchanges.ts`)

```ts
type LogEntry =
  | { readonly kind: 'exchange'; readonly exchange: AnyExchangeSummary }
  | { readonly kind: 'failure'; readonly failure: FailedExchangeWire };
```

`log` becomes `readonly LogEntry[]`. Cap (500), newest-last order, `clearLog` and `reset` are
unchanged. The success paths wrap what they push today; a new `appendFailure(failure)` appends the
other variant, ignoring a `sendId` already present.

### 2.3 Filter (renderer, `state/exchanges.ts`)

```ts
interface LogFilter {
  readonly text: string; // case-insensitive substring of request.url
  readonly methods: readonly string[]; // empty = all
  readonly statuses: readonly StatusClass[]; // '2xx' | '3xx' | '4xx' | '5xx' | 'failed'; empty = all
  readonly protocols: readonly ('soap' | 'rest')[]; // empty = all
}
```

`matchesFilter(entry, filter)` is a pure function in `features/console/log-filter.ts`. A SOAP
exchange with a fault but a 200 status is `2xx` — the class is the HTTP status; the fault stays
visible through the row's danger tone. A failure entry matches `failed` only.

---

## 3. Main process

### 3.1 Event

`events.exchange.failed` in `shared/ipc.ts`, payload `{ failure: FailedExchangeWire }`, broadcast
from `main/index.ts` the same way `events.history.appended` is.

### 3.2 Emit points

One helper, `failedExchangeOf(...)` in `main/failed-exchange.ts`, builds the wire shape from what
the catch block has: the send id, protocol, request id, URL, method, the resolved request headers,
the start time and the error. Its callers:

- `sendAndRecordHistory` (`main/send-with-history.ts`), SOAP sends and History resends: a new
  optional `onSendFailed` dep beside `onHistoryAppended`, called in the `catch` after `record`.
- The REST send handler in `main/ipc/request.ts`: the same dep on `RequestChannelDeps`, called in
  its `catch` after `recordRest`.

The rethrow is unchanged, so the renderer's existing error path (response pane header, Problems)
keeps working.

**Headers on a failure.** For SOAP the helper takes the resolved input's headers; for REST the
resolved request's headers with auth applied where the resolver already applied it. Where a header
was never materialised because the failure happened before the request was built (`invalid-url`),
the map is empty — the row is still recorded.

---

## 4. Renderer

### 4.1 Store wiring

The renderer subscribes to `exchange.failed` where it subscribes to `history.appended` and calls
`appendFailure`.

### 4.2 Table (`features/console/http-log.tsx`)

Columns, in order: **time · proto · method · URL · status · ms · size**.

- A failure row: `proto` and `method` as sent, `status` shows the error code (`dns`, `timeout`,
  `connection-refused`…) in the danger tone, `ms` is the duration to failure, `size` is empty. The
  row title carries the error message.
- Selection: click, or ↑/↓ while the table has focus. Follow-newest scroll behaviour is unchanged.
- Empty states: the existing copy when the log is empty; "No rows match the filter." when the
  filter hides everything, with the count still showing.

### 4.3 Filter bar

Sits above the header row.

- Text field, placeholder "Filter URL", debounced ~100 ms.
- Chip groups, multi-select, none selected = all: **method** (the methods present in the log),
  **status** (`2xx 3xx 4xx 5xx failed`), **protocol** (`SOAP REST`).
- A count, "12 of 40". A "Reset" that clears the filter (distinct from **Clear**, which empties
  the log).
- The secrets toggle and **Clear** stay where they are.

### 4.4 Detail tabs

Replaces the two raw panes. Tabs, left to right:

| Tab            | Exchange row                                                                                                                                   | Failure row                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Headers**    | Request headers and response `rawHeaders` as two tables.                                                                                       | Request headers; a note that they are redacted and stay so.                        |
| **Request**    | Raw request bytes (today's `rawText`).                                                                                                         | "Raw request was not captured for a failed send."                                  |
| **Response**   | Raw response bytes.                                                                                                                            | Error code and message, prominent.                                                 |
| **Timing**     | `TimingsBar` plus a phase list; an `n/a` phase says why (socket reused, several sends in flight, or DNS not measured).                          | Total only.                                                                        |
| **Connection** | Redirect hops (reuse `RedirectsView` once it takes an `http` exchange rather than a REST summary) and TLS peer (reuse `SslInspector` likewise). | URL and method; for a TLS-class error, the peer subject if the message carries it. |

The selected tab is remembered across row selections within the session.

---

## 5. Affected files

```
apps/desktop/src/shared/
├── wire-types.ts                       # failedExchangeWireSchema
└── ipc.ts                              # events.exchange.failed
apps/desktop/src/main/
├── failed-exchange.ts                  # failedExchangeOf(...)
├── send-with-history.ts                # onSendFailed dep, emit in catch
├── ipc/request.ts                      # same for REST
└── index.ts                            # broadcast wiring
apps/desktop/src/renderer/
├── state/exchanges.ts                  # LogEntry union, appendFailure, filter
├── features/console/
│   ├── http-log.tsx                    # columns, filter bar, tabs, keyboard selection
│   ├── log-filter.ts                   # matchesFilter, StatusClass
│   ├── log-filter-bar.tsx
│   └── log-detail.tsx                  # the five tabs
├── features/rest-editor/response/redirects-view.tsx     # accept HttpExchangeWire
└── features/request-editor/inspectors/ssl-inspector.tsx # accept HttpExchangeWire
apps/desktop/test/
├── main/failed-exchange.test.ts
├── main/send-with-history.test.ts      # onSendFailed called with the wire shape
├── renderer/log-filter.test.ts
├── renderer/exchanges-store.test.ts    # appendFailure, dedupe, cap
└── renderer/http-log.test.tsx          # failure row, filter, tabs
e2e/specs/http-log.spec.ts              # a send to a closed port produces a connection-refused row
docs/roadmap.md                         # item 8 follow-ups
CHANGELOG.md
```

---

## 6. Commands

```bash
pnpm vitest run apps/desktop/test
WIREBENCH_SKIP_PERF=1 pnpm check
pnpm build && xvfb-run -a pnpm test:e2e
```

---

## 7. Success criteria

- [ ] A send to `http://127.0.0.1:1` produces one log row whose status cell reads
      `connection-refused` in the danger tone, with a duration, and whose Response tab shows the
      engine's message. The response pane header and Problems behave exactly as before.
- [ ] A SOAP resend from History that fails also produces a row.
- [ ] Headers on a failure row are redacted with the toggle on or off; the Headers tab says why.
- [ ] Filtering by `4xx`, by `REST`, by `POST` and by URL text each narrow the rows, combine with
      AND, and the count reads "n of m". Reset restores all rows; Clear empties the log.
- [ ] Each detail tab renders for both an exchange and a failure row; the Timing tab explains an
      `n/a` phase; the Connection tab lists hops and the TLS peer for an exchange that has them.
- [ ] All existing HTTP Log unit and e2e assertions pass with the new columns.
- [ ] No secret appears in any log row, event payload or test fixture (`pnpm check:banned-terms`
      and the secrets e2e stay green).
- [ ] `WIREBENCH_SKIP_PERF=1 pnpm check` passes.

---

## 8. Decisions taken by the owner (2026-09-16)

| Decision                                             | Choice                             |
| ---------------------------------------------------- | ---------------------------------- |
| Merge HTTP Log and History into one persisted record | No; keep both, log stays in memory |
| Show-secrets on rows loaded from disk                | Moot — nothing is loaded from disk |
| Failure source                                       | Main emits `exchange.failed` (B)   |
| HAR export, copy-as-cURL                             | Follow-up slice                    |
