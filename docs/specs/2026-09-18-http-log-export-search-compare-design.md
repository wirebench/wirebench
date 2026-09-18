# Spec: HTTP Log — export, reuse, search, waterfall, compare and the capture gaps

- Status: **draft** (under review)
- Date: 2026-09-18
- Builds on: `docs/specs/2026-09-16-http-log-failures-filters-detail-design.md` (failed rows, filter
  bar, detail tabs — shipped in #26), `docs/security.md` (no secret is ever written to a log or a
  file the app produces), and the existing `request.curl` channel (`main/ipc/request.ts`).

## Assumptions I'm making

1. **The log stays a session view held in memory.** Nothing here persists it or merges it with
   History; the owner rejected both (2026-09-16). Item 14 only changes how long rows live *within*
   a running app.
2. **Every file that leaves the log is redacted unconditionally**, whatever the _show secrets_
   toggle says. HAR files are shared by design, so a HAR export always masks headers, URL
   userinfo/params, `wsse:Password`, and the JSON/form secrets of S1. Copy-as-cURL and the copy
   actions follow the toggle for exchange rows (they land on the user's own clipboard, like the code
   panel's existing cURL) and are always redacted for failure rows, which are redacted at emit.
3. **Main does the redaction and the file write.** The renderer sends the rows it holds; main
   re-redacts with `show: false` (the helpers are idempotent on masked text), builds the HAR, shows
   the save dialog and writes the file. The renderer never gets to choose a filesystem path.
4. **cURL for a row describes what was sent, not what the editor holds now.** It is built from the
   logged request (method, URL, headers, body), not from `request.curl`'s live input. The formatter
   is shared; the input differs.
5. **Timing already exists.** The Timing tab and `TimingsBar` show connect, TLS, TTFB and download.
   DNS stays unmeasured by design (`packages/engine/src/http/timings.ts`). So "timing" adds no new
   measurement: it becomes the waterfall column plus a "connection reused" note.
6. **Text search already exists for the URL** (`LogFilter.text`). It widens to headers, bodies and
   names and gains regex and match-case toggles; no second search box.
7. **One branch, seven slices, each shippable alone** in the order of §3, so the owner can stop after
   any slice.

## 1. Objective

Finish the HTTP Log as a debugging tool: get a row *out* (cURL, HAR, copy, resend), *find* a row
among hundreds (search, name, sort), *see* where time went across rows (waterfall), *compare* two
rows, close the three gaps the first round left (early failures, JSON secrets, arrow-key scrolling),
and let the user decide how many rows the session keeps.

**Success looks like:** a user whose call failed through a corporate proxy finds the row by request
name, copies it as cURL, compares it with a successful row from earlier in the session, and hands a
colleague a HAR file with no secret in it.

## 2. Features

### S1 — Capture gaps

**Failures before the request is built.** An invalid URL, a failed OAuth2 token fetch or a failed
proxy lookup throws before the `try` that emits `exchange.failed`, so no row appears today.
- `failedExchangeWireSchema` gains `stage: z.enum(['prepare', 'send']).optional()` (absent = `send`,
  so existing rows and tests stay valid).
- Each early throw in `main/ipc/request.ts` / `main/send-with-history.ts` emits a failure with
  `stage: 'prepare'`, the best request it has (the unresolved URL text when it could not be parsed;
  the method from the request), `durationMs` from the send's start, and the error's code
  (`invalid-url`, the OAuth2 service's code, the proxy lookup's code).
- The status column shows `Failed · before send`; the detail says the request never went on the wire.

**Secrets in JSON and form bodies.** A new `redactStructuredBody(text, contentType)` in
`main/redact.ts` masks the values of keys in one exported `SECRET_BODY_KEYS` list (case-insensitive:
`password`, `passwd`, `secret`, `token`, `access_token`, `refresh_token`, `id_token`,
`client_secret`, `api_key`, `apikey`, `authorization`) at any depth in `application/json` / `+json`
bodies, and the same keys in `application/x-www-form-urlencoded` bodies. Unparseable JSON is left
as is. Wired into `redactRawHttp` beside the XML path, and into REST body redaction wherever
`show: false` applies today.

**Arrow keys scroll under 200 rows.** When the list is not virtualised, ↑/↓ call
`scrollIntoView({ block: 'nearest' })` on the newly selected row (the virtualised path already calls
`scrollToIndex`).

### S2 — Reuse a row

A row menu (right-click on a row, the `⋯` button in the detail header, or `Shift+F10`):
- **Copy as cURL (POSIX)** / **(PowerShell)** — new channel `log.curl` `{ entry, shell }` →
  `{ command, notes? }`. Main builds it with the formatter `request.curl` uses, from the logged
  request. The body comes from the raw request when the row has one; a truncated body adds a note
  and is omitted.
- **Copy URL**, **Copy request headers**, **Copy response headers**, **Copy response body** — in the
  renderer from what the row already shows. Actions whose data the row lacks are disabled.
- **Resend** — sends the saved request as it is now (even if edited since the row was logged)
  through the path History's resend uses; the result arrives as a new row. Its tooltip says "Sends
  the saved request as it is now". Disabled for rows with no saved request, `stage: 'prepare'` rows
  and streaming gRPC.
- **Open request** — selects the source request in the tree and opens its editor. Disabled when the
  row has no `requestId` or the request no longer exists.

### S3 — HAR export

- **Export HAR** toolbar button beside Clear; exports the rows the filter shows, in display order.
- New channel `log.exportHar` `{ entries }` → `{ saved: boolean; path?: string }`. Main builds HAR 1.2
  (`creator = { name: 'Wirebench', version }`), shows a save dialog defaulting to
  `wirebench-<yyyyMMdd-HHmmss>.har`, writes it.
- Mapping: `startedDateTime`, `time`, `request` (method, url, httpVersion, headers, queryString,
  `postData` with mimeType and text), `response` (status, statusText, headers, `content` with size,
  mimeType, text or base64 + `encoding`), `timings` (`blocked`/`dns` = -1, `connect`, `ssl`,
  `send` = 0, `wait` = ttfb, `receive` = download; unknown = -1).
- A failure becomes an entry with `response.status = 0`, empty headers and content, and
  `_error: { code, message, stage }` (custom fields start with `_`, as HAR allows).
- Bodies are included up to the log's existing caps; a truncated body gets `_truncated: true` and no
  text. Everything passes `show: false` redaction first.

### S4 — Find a row

- **Search** matches URL, request/response header names and values, body text (first 256 KiB of each
  body) and the request name. Toggles `.*` (regex) and `Aa` (match case) sit in the field. An invalid
  regex outlines the field in the error token and filters nothing. Bodies are decoded once per
  entry and cached by `sendId`.
- **Name column**: the saved request's name (gRPC: `Service/Method`), resolved in the renderer from
  `requestId` via the project tree store; the path when no request is known.
- **Sort**: clicking the Time, Name, Status, Duration or Size header cycles ascending → descending →
  log order. Sort lives with the filter in the exchanges store; Reset clears it; ↑/↓ follow the
  displayed order.

### S5 — Waterfall

- A **Waterfall** column (hidden while a row is selected, like the other wide columns) draws each
  row's start offset and duration against the span of the rows shown, split into connect / TLS /
  wait / download in the `TimingsBar` colours; a failure draws one bar in the error token.
- Hovering a bar shows the phase breakdown.
- The Timing tab adds "Connection reused — no connect or TLS phase" when both are absent on a
  successful exchange.

### S6 — Compare two rows

- `Cmd/Ctrl+click` adds a second row to the selection (at most two; a third replaces the older one).
  With two selected, the detail pane shows **Compare** instead of the tabs.
- Compare shows a summary line per row (method, URL, status, duration), a headers table marking
  added / removed / changed, and request and response bodies in the shared Monaco diff editor
  (read-only; JSON/XML pretty-printed when both sides parse).
- Escape or a plain click on one row returns to the normal detail.

### S7 — Row limit and preserve log

- **Log size** setting (Settings › Console): 100–5000, default 500, replacing the `LOG_CAP` const.
  Lowering it trims the oldest rows at once.
- **Preserve log** toggle in the log toolbar: when on, closing or switching the workspace keeps the
  rows (still in memory, gone when the app quits). Clear still empties it. Default off.

## 3. Order and boundaries

S1 → S2 → S3 → S4 → S5 → S6 → S7. Each slice ends green with its own e2e step and CHANGELOG line.

- **Always:** redact in main for anything written to disk; keep wire schemas backward compatible
  (new fields optional); new UI in new files under `renderer/features/console/`.
- **Ask first:** changes to History, to `request.curl`'s behaviour, or to the engine's timing capture.
- **Never:** persist the log; name another product anywhere; put an unmasked secret in a fixture.

## 4. Testing

- **Unit:** `redactStructuredBody` (nested keys, arrays, form bodies, bad JSON); the HAR builder
  (golden file per protocol plus a failure entry, checked against HAR 1.2 required fields); cURL from
  a row (both shells, truncated body); `matchesFilter` over headers/body/regex/case/name; the sort
  comparator; waterfall geometry; the header diff.
- **Main:** each early failure path emits one `stage: 'prepare'` row; `log.exportHar` writes no
  secret even with show-secrets on; cancelling the dialog returns `saved: false`.
- **Renderer:** menu enable/disable rules, compare selection rules, arrow-key scroll, log-size trim,
  preserve-log across a workspace switch.
- **e2e (CI):** a bad URL produces a row; copy a row as cURL; export HAR to a temp path (dialog
  stubbed) and parse it; search by a header value; compare two rows.

## 5. Out of scope

Importing a HAR; throttling; WebSocket frames; DNS timing; persisting the log; grouping rows by
request. HAR `serverIPAddress` is omitted for now (the wire summary carries no peer address); a
possible later follow-up.
