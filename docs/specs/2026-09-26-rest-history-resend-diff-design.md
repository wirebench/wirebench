# REST resend and diff from History — design

Issue #42. Today History resends SOAP and gRPC entries only. A REST entry can be opened and read, but
`history.resend` refuses it with `history-resend-unsupported` (`apps/desktop/src/main/ipc/history.ts:133`)
and the row shows no ↻ button (`canResendHistoryEntry`,
`apps/desktop/src/renderer/features/history/history-actions.ts:25`). Comparing two REST entries diffs
the response bodies only, so a changed status, header or request is not shown.

## What a REST entry records

`recordRest` (`apps/desktop/src/main/ipc/request.ts:943`) writes one entry per send through
`buildRestHistoryEntry` (`apps/desktop/src/main/history-service.ts:322`). What it keeps decides what a
resend can take from it:

- **Method:** the request's method.
- **URL (`endpoint`):** the URL the exchange reports (`request.ts:963`). This is the final URL, with
  path parameters filled, the query appended and an API key that travels in the query included. It is
  redacted by `toRestExchangeSummary` (`apps/desktop/src/main/engine-wire.ts:355`). Two cases differ:
  - After a followed redirect, it is the URL of the last hop (`packages/engine/src/http/client.ts:530`).
  - A send that failed before a response has no exchange, so the entry keeps only the API's base URL
    (`resolved.input.baseUrl`).
- **Headers:** only the request's own enabled header rows, after property expansion
  (`request.ts:964`). Auth headers, the computed `Content-Type`, cookies and default headers are
  merged in below those rows at send time (`packages/engine/src/rest/send.ts:201-209`) and are
  **not** recorded. Values are redacted by name (`Authorization`, `Cookie`, `X-API-Key` and so on) and
  wherever a `${secret:name}` value appears (`apps/desktop/src/main/redact.ts`). If the table has two
  rows with the same name, the entry keeps the last one.
- **Body:** the text of a raw body. Form, multipart, binary and empty bodies are recorded as `''`
  (`request.ts:967`). Secret values are masked, and a body longer than 256 KB is cut and ends with a
  `… truncated, N more characters` marker (`history-service.ts:282-295`).
- **Event streams:** an event-stream response is recorded in `sse`.

A redacted value is `REDACTED_MARKER`, `<redacted>`. In a URL, a parameter masked by name is written
through `URLSearchParams` (`packages/engine/src/redact/index.ts:117`), so it appears percent-encoded
as `%3Credacted%3E`. `containsRedaction` looks only for the literal form, so the URL check below
looks for both forms.

## What a resend sends

A resend combines two sources, as the gRPC resend does:

- **From the entry:** the method, URL, headers and body. These are what went on the wire.
- **From the saved request, as it is now:** auth, TLS, proxy and send settings, all resolved the
  usual way under the active environment.

The URL comes from the entry only while its host is still the saved request's current host; otherwise
the resend is refused (refusal 5). The proxy is still looked up for the saved request's base URL (`request.ts:837`), which
is also what happens for an editor draft with an absolute URL.

### The draft

The entry becomes a `RestRequestPatchWire` (`apps/desktop/src/shared/wire-types.ts:1488`), the same
draft input the editor sends with. `resolveRestSend` applies it over the saved request for one send
only (`withDraft`, `apps/desktop/src/main/rest-send.ts:86`). Nothing is written back, so the saved
request never changes. A new pure function, `restResendDraft(entry, saved, savedOrigin)`, sits next to
`grpcResendDraft` in `ipc/history.ts`. `saved` is the result of `project.restSend(requestId)` with no
draft: its `request` is the saved request as typed, and its `auth` is the effective credentials from
the folder chain. `savedOrigin` is the origin of the saved request's own URL once its property
references resolve, or `undefined` when it can't be resolved.

- **`method`:** the entry's method.
- **`url`, `query`, `pathParams`:** the entry's URL split by `splitQuery`
  (`packages/engine/src/rest/url.ts:165`). The part before `?` becomes `url`, which is absolute, so
  `joinBase` ignores the base URL. The query becomes `query`, and `pathParams` is `[]` because the
  path is already filled. `composeUrl` does not re-encode a valid escape, so a recorded query is sent
  as it was recorded. There is one exception: when the query holds `%3Credacted%3E`, the redactor has
  rewritten it as form encoding, so a `+` in it stands for a space and is read as one.
  - When the entry has no response, it recorded no sent URL. The draft then leaves `url`, `query` and
    `pathParams` out, and the saved request's own values are used.
  - The recorded URL is used only when its origin matches the saved request's own origin, once its
    property references resolve (`savedOrigin`, compared case-insensitively). A redirect that crosses
    origins — to a CDN or a pre-signed object-store URL, say — makes the engine client drop
    `authorization`, `proxy-authorization` and `cookie` before following it
    (`packages/engine/src/http/client.ts:172-190`), but the entry records only that last hop's URL.
    Resending it with the saved auth would hand a credential to an origin the original send never
    gave one to, and sending the saved URL in its place would not be the request History shows. So
    when the entry has a response, a different origin, an undefined `savedOrigin`, or a recorded URL
    that fails to parse is refused with `history-resend-origin` (see **Refusals**). The same rule
    covers an environment switch: the request now resolves to another host, so the entry is re-sent
    from the request, not from History.
- **`headers`:** every recorded header, as an enabled row. Disabled rows were never sent, so they are
  left out.
- **`body`:** the recorded text:
  - If the saved body is raw, it is that body with the recorded text, which keeps its language and
    content type.
  - If the recorded text is `''` and the saved body is not raw (form, multipart, binary or none), the
    draft leaves `body` out, and the saved body is sent as it is now. The entry had no text form to
    replay.
  - Otherwise it is a raw body in `json` if the text parses as JSON, `xml` if it starts with `<`, or
    `text`.

The recorded values were already expanded, and expansion runs again on the draft. So every recorded
text that enters the draft is made literal first, with the tokenizer's own escape: each `${` becomes
`$${`, which expansion turns back into `${` (`packages/engine/src/project/properties.ts`). That covers
the recorded path, each recorded query name and every query value not filled from a saved row, every
recorded header name and every header value not filled from a saved row, and the recorded body. The
wire then gets exactly the recorded text: a same-origin redirect to `/cb?x=${secret:aws-prod}` (the
URL standard keeps `${}` in a query) is sent as that text, and no secret is read for it; a body that
went out as `${x}` from a typed `$${x}` goes out as `${x}` again. Values filled from the saved rows are
not escaped: they are typed, and must expand.

### Filling redacted values

- **Header:** a recorded header whose value contains the marker is replaced whole by the value of the
  saved request's last enabled header row with that name, compared without regard to case. That is
  the row History recorded. The saved value is taken as typed (for example `${secret:token}` or
  `${#Env#key}`), so it expands and resolves on the normal send path. The marker never goes out.
- **Query:** a recorded query value that contains the marker, in either form, is filled the same way
  from the saved request's enabled query rows with that exact name. Those are the rows inline in its
  URL and the rows in its Query table, and the last one wins.
- **Anywhere else:** the marker in the URL's path, user info or fragment, or anywhere in the body,
  cannot be filled.

### Auth is applied once

Auth goes through `applyAuth` (`packages/engine/src/rest/auth.ts:61`) for the saved request's
effective credentials, exactly as for an editor send:

- Bearer and OAuth2 add an `Authorization` header.
- An API key goes into a header or into the query.
- Basic and NTLM are handled by the transport.

Auth headers are never in the entry, so there is no recorded auth header to drop. A header row that
the user typed with the same name (an `Authorization` row, say) wins over auth, as it did on the
original send, and is filled from the saved row like any other.

The one place auth is recorded is an API key in the query. When the saved request's effective auth
is `api-key` with `in: 'query'`, the draft drops every recorded query row with exactly that name,
whatever its value, before `applyAuth` appends the key again. This also covers an entry recorded
with *show secrets* on, whose URL holds the key in the clear. If the effective auth has since changed
to something else, a recorded key parameter is an ordinary redacted value. It is filled from a saved
query row of that name, or the resend is refused.

## Refusals (typed `WirebenchError` codes)

The checks run in this order:

1. `unknown-history-entry`: no entry has this id.
2. `history-resend-unsupported`: the entry is not REST, or main was started without the REST sender.
3. `rest-resend-streaming`: the entry was an event stream (`sse` is set). For an entry with no
   response, a recorded enabled `Accept` header that asks for `text/event-stream` also counts. This is
   the same line `log.resend` draws (`apps/desktop/src/main/ipc/log.ts:42-58`), and the message is the
   same: "Event streams resend from the editor." A resend has no live pane, so a stream the server
   never closes would never finish.
4. `history-resend-orphan`: the entry has no `requestId`, or `project.restSend(requestId)` returns
   `undefined` because the saved request was deleted. Auth, TLS and settings have nowhere else to come
   from.
5. `history-resend-origin` (new): the entry has a response, and its recorded URL is not on the saved
   request's current origin, the saved URL does not resolve to an origin, or the recorded URL does
   not parse. The message is "This entry was sent to another host (a redirect or another
   environment); re-send it from the request." An entry with no response is not checked, since it
   keeps the saved URL.
6. `history-resend-redacted`: a redacted header or query value has no saved row to fill it from, the
   marker is anywhere else in the URL, or the body contains the marker.
7. `history-resend-truncated` (new): the body is History's truncated copy, which is longer than
   256 KB and ends with the truncation marker. Sending it would send a different body. A helper
   exported from `history-service.ts` beside `storedBody` detects it.

Errors from `sendRestRequest` pass through unchanged, for example `rest-unresolved-properties`,
`secret-missing` or a transport error.

An earlier draft of this design fell back silently to the saved URL on an origin mismatch. That is
reversed: the fallback sent a request other than the one History shows, so a mismatch is refused.

## The send path

The call goes through `sendRestRequest` (`request.ts:796`) with `{ sendId, requestId, draft }` and no
`onLive`, the same buffered path `log.resend` uses. That function records History itself
(`recordRest`, on success and on failure) and reports failures to the HTTP Log. `sendAndRecordHistory`
is the SOAP path and is not involved. A resend therefore adds a new History entry under the same
request, and the entry it came from is untouched.

## Wire

- `wire-types.ts`: add `historyResendRestRequestSchema = z.object({ id: z.string() })` beside
  `historyResendGrpcRequestSchema` (`:3571`).
- `apps/desktop/src/shared/ipc.ts:858`: add
  `resendRest: defineChannel('history.resendRest', historyResendRestRequestSchema, restExchangeSummarySchema)`.
- `HistoryChannelDeps` gains `rest?: { send(request: RequestSendRestRequest): Promise<RestExchangeSummary> }`,
  and `project` adds `Partial<Pick<ProjectRouter, 'restSend'>>`.
- `apps/desktop/src/main/index.ts:454` wires
  `rest: { send: (request) => sendRestRequest(engineService, requestDeps, request) }`.
- `apps/desktop/test/mocks/wirebench-api.ts:243` gains `resendRest`.

`history.resend` and `history.resendGrpc` do not change. `history.resend` keeps refusing REST.

## UI: resend

- `canResendHistoryEntry` accepts `rest` as well as `soap` and `grpc`, except for an entry with `sse`
  set. That mirrors the HTTP Log's row menu, which does not offer Resend for a streamed row, and main
  refuses such an entry anyway. The ↻ button on a History row and **Re-send** on the entry tab
  (`history-entry-view.tsx:123`) follow it, and the comments there saying REST resends from its
  request are updated.
- `resendHistoryEntry` calls `history.resendRest` for a REST entry. The result arrives as a new History
  entry through `history.appended`, and a failure shows a toast with main's message (its code
  when the message is empty), as for SOAP and gRPC.
- The "Re-send Last SOAP Request" command (`resendLastHistoryEntry`) is unchanged.

## Diff

`DiffView` (`apps/desktop/src/renderer/features/history/diff-view.tsx`) diffs one body per side:
`response.envelopeXml ?? request.envelopeXml`.

### When both sides are REST

The diff tab shows two tabs, **Response** (the default) and **Request**. Each one is a single text
diff in the existing `DiffXmlEditor`, with the same *Side by side* and *Ignore whitespace* toggles.
The selected tab is component state. The normalised texts are built by a new module,
`apps/desktop/src/renderer/features/history/rest-diff-text.ts`:

- **Response:**
  - The first line is the status line, `200 OK` (status, then status text). An entry with no response
    reads `No response (<error code>)`.
  - Then the response headers from `rawHeaders`, one `name: value` per line, sorted by name without
    regard to case. Headers with the same name keep their recorded order, and each name keeps its
    recorded spelling.
  - Then a blank line, and the body pretty-printed by `prettyPrintBody`
    (`apps/desktop/src/renderer/features/history/history-format.ts:30`).
- **Request:**
  - The first line is `METHOD URL`.
  - Then the recorded headers, sorted the same way.
  - Then a blank line, and the body, pretty-printed the same way so that two formats of the same JSON
    do not fill the diff.

Redacted values are shown as they are recorded: `<redacted>`, or `%3Credacted%3E` in a URL. Nothing
is filled or hidden.

### Entry points

All three entry points build the tab through one new function in `history-actions.ts`, so they cannot
drift. It takes two sides and returns the tab's `diff` data, choosing the REST form when both sides
are REST.

- **Pick two** (`history-view.tsx:193`, `openDiff`): both entries are `kind: 'rest'`.
- **Compare with current** (`history-view.tsx:223`): the entry is REST and its request has a
  finished exchange in `restByRequest` (`apps/desktop/src/renderer/state/exchanges.ts:323`). The
  current code reads only the SOAP map, `byRequest` (`:225`), so today this button does nothing for a
  REST entry.
  - The Current side comes from the `RestExchangeSummary`: `http.status`, `http.statusText`,
    `http.rawHeaders` and `text` for the Response tab; `method`, `url`, `http.request.headers` and the
    body after the blank line of `http.rawRequestBase64` (as `requestBodyOf` does,
    `apps/desktop/src/renderer/features/console/log-compare.ts:81`) for the Request tab.
  - These are the headers as sent, so the Request tab shows auth, computed and default headers as
    added on the Current side, which the entry never recorded.
  - The Current side is redacted as the exchange is, under the session's *show secrets* setting.
- **`compareLastTwoHistoryEntries`** (`history-actions.ts:70`): the two newest entries are both REST.

SOAP, gRPC and mixed pairs keep the body-only diff, exactly as today.

### Tab data

`EditorTab.diff` (`apps/desktop/src/renderer/state/editors.ts:88`) gains one optional field:

```ts
/** Set when both sides are REST: each side's normalised text, per tab of the diff. */
readonly rest?: {
  readonly response: { readonly left: string; readonly right: string };
  readonly request: { readonly left: string; readonly right: string };
};
```

The texts are built when the tab opens, so `DiffView` only renders them. `leftXml` and `rightXml` are
still filled with the body-only values, so the snapshot panel's use of the same tab
(`snapshot-panel.tsx:148`) and anything else that reads them is unaffected. `DiffView` shows the two
tabs when `rest` is set, and its current single diff otherwise.

A diff tab is never persisted. `persist` in `apps/desktop/src/renderer/state/workspace-tabs.ts:47`
returns `undefined` for it, and the file header (`:4-6`) says a diff is dropped. So there is no
persisted tab state to migrate and no format change.

## Testing

- **Draft builder:** `restResendDraft` in `apps/desktop/test/ipc-history.test.ts`, beside the
  `grpcResendDraft` tests, with `makeEntry` for REST entries:
  - Method, URL, query, headers and raw body come from the entry.
  - A redacted header, and a redacted query value in either form, are filled from the saved rows as
    typed.
  - A query API key is dropped when the effective auth is `api-key` in `query`, including an
    unredacted one.
  - A failed entry keeps the saved URL.
  - A saved non-raw body is kept when the recorded text is empty.
  - One test per refusal: `history-resend-redacted` for an unfillable header, a query value, the
    marker in the path, and the marker in the body; `history-resend-truncated`; and
    `history-resend-origin` for a cross-origin redirect, an environment switch, an undefined
    `savedOrigin` and an unparsable recorded URL.
  - A `${…}` in a recorded path, query name or value, header name or value and body is escaped, a
    value filled from a saved row is not, and each escape expands back to exactly the recorded text.
- **Channel:** a `describe('history.resendRest')` in the same file, with a fake `rest.send`:
  - `unknown-history-entry`.
  - `history-resend-unsupported` for SOAP and gRPC entries.
  - `rest-resend-streaming` for an entry with `sse`, and for a failed entry with an event-stream
    `Accept`.
  - `history-resend-orphan`.
  - A good entry calls `rest.send` with its `requestId`, a fresh `sendId` and the built draft.
- **A resend creates a new entry:** a new
  `apps/desktop/test/ipc-history-resend-rest.test.ts` (node environment). It registers the History
  channels with `rest.send` bound to the real `sendRestRequest`, an `EngineService`, and a history
  whose `recordRestSend` builds entries with `buildRestHistoryEntry`, against `startTestRestServer`'s
  `/echo`. It checks that:
  - A resend appends a second entry under the same `requestId`.
  - The saved request is unchanged.
  - The echoed request carries a query API key exactly once.
  - An entry recorded on another origin is refused, and neither host receives anything.
  - Recorded `${secret:s}` text in the query, a header and the body reaches the server literally, and
    the secret getter is never called.
- **Normalised text:** a new `apps/desktop/test/renderer/rest-diff-text.test.ts`:
  - The status line, and the no-response line.
  - Headers sorted without regard to case, with the order kept for equal names.
  - A JSON and an XML body pretty-printed.
  - The request line.
  - Redacted values left as recorded.
  - The Current side built from a `RestExchangeSummary`.
- **Renderer:**
  - `apps/desktop/test/renderer/history-view.test.tsx`: the ↻ button on a REST row (and not on a
    streamed one) calls `history.resendRest`. Pick-two over two REST entries opens a tab with `rest`
    set, and a SOAP and REST pair opens one without it. Compare with current reads `restByRequest`.
  - `apps/desktop/test/renderer/history-entry-view.test.tsx`: **Re-send** on a REST entry's tab.
  - `apps/desktop/test/renderer/diff-view.test.tsx`: the Response and Request tabs render and switch
    when `rest` is set; one diff when it is not.
  - `apps/desktop/test/renderer/history-commands.test.ts`: `compareLastTwoHistoryEntries` over two
    REST entries.
- **e2e:** one test in `e2e/specs/history.spec.ts`, "re-sends a REST entry and compares it with the
  original":
  - Set up with `startTestRestServer` (`e2e/helpers/test-server.ts`), `createWorkspace` and
    `createProject` (`e2e/helpers/project.ts`), and `createApi`, `createRestRequest`,
    `setMethodAndUrl`, `addHeader` and `sendRest` (`e2e/helpers/rest.ts`).
  - Send once, press ↻ on the History row, and expect two rows.
  - Press **Compare…** on both rows. Expect a Compare tab with **Response** and **Request** tabs, and
    read the Request diff with `monacoModelText` (`e2e/helpers/editor.ts`) to find the request line.

## Out of scope

- A WebSocket resend.
- Diffing across kinds: a REST entry against a SOAP or gRPC one keeps the body-only diff.
- Resending with the entry's recorded auth. Auth always comes from the saved request as it is now.
- Replaying a redirect chain. The entry keeps only where it landed.
- Diffing an event stream's rows. The Response tab shows the recorded response body.

## Success criteria

- A REST entry's ↻ and **Re-send** send the entry's method, URL, headers and body through the saved
  request's auth, TLS, proxy and settings. The result is a new History entry, and the saved request
  is unchanged.
- A redacted header or query value is filled from the saved request. A value that cannot be filled,
  or the marker in the body, is refused with `history-resend-redacted`, and the marker is never sent.
- A query API key is sent exactly once.
- An event-stream entry is refused with `rest-resend-streaming`, and an entry whose request is gone
  with `history-resend-orphan`.
- Comparing two REST entries, by pick-two, compare with current or the last-two command, shows
  Response and Request tabs over the normalised texts. SOAP, gRPC and mixed pairs diff as before.
- `history.resend`, `history.resendGrpc` and the "Re-send Last SOAP Request" command behave as before.

## Docs

- `docs-site/src/content/docs/guides/history.mdx`:
  - Under *Re-send an entry*, REST entries can be re-sent. Add a *Re-send a REST request* section:
    what comes from the entry and what comes from the request, redacted values, streams and
    refusals.
  - Under *Diff two runs*, the Response and Request tabs for two REST entries. Also correct *Compare
    with current*: it compares with the request's latest response, not with what it would send now.
  - Update the two *Limits* bullets that say only SOAP and gRPC re-send and that Compare always diffs
    the body.
- `docs-site/src/content/docs/guides/rest-client.mdx`: a short *Re-send from History* section linking
  to the History guide, as `grpc.mdx:63` does.
- `docs/roadmap.md`: mark the item 8 follow-up "Resend and diff a REST send from History" done
  (`:319`), and mark #42 **shipped** in the 2.4 milestone row (`:89`).
- `docs/success-criteria.md`: SC-R6 (`:57`) becomes Met, citing the tests above.
- `CHANGELOG.md`: an *Added* entry under Unreleased.
