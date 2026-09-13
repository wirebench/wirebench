# Plan: REST client

Spec: `docs/specs/2026-09-13-wirebench-rest-client-design.md` (draft 2026-09-13; this plan assumes its §15 defaults —
_API_ as the container name, `formatVersion: 3`, `jsonpath-plus` approved, no cookie jar, no HTML preview, OpenAPI 2.0
refused, `Mod+Shift+I` for _Import OpenAPI…_). "§n" points at that spec; "v1 §n" at
`docs/specs/2026-09-09-wirebench-v1-explore-and-send-design.md`.
Executors: one commit set per task, Conventional Commits, no `Co-Authored-By` trailer, `pnpm check` green before every
commit, full e2e green at every checkpoint, CI on three OSes at every push.

**Goal:** APIs with folders and REST requests beside SOAP interfaces in the same project and environments; a REST
request editor and response pane; Basic, NTLM, Bearer, API-key and OAuth2 auth shared with SOAP; OpenAPI 3 import
cached like a WSDL; cURL both ways; history, search, diff and a JSON Query view — with the shapes a later gRPC client
needs fixed now (§8).
**Architecture:** the engine gains `rest/` on top of the unchanged `http/` transport; the project format gains `apis/`
at `formatVersion: 3`; `EndpointAuth` grows into one `AuthConfig` union; main dispatches send, preflight, cURL and
history on the request's `kind`; the renderer adds a per-kind editor behind the existing tab opener and three explorer
node kinds. Everything flows engine → main → IPC → stores, as before.
**Stack:** unchanged (v1 §3) plus `jsonpath-plus` (MIT, §9) — the one new runtime dependency, added in T24 and only
if still approved then.

## Global constraints (every task inherits)

- Everything in v1 §12, ADR-0003, ADR-0004, ADR-0005, ADR-0006, and the constraints of the workspaces and
  layout-and-environments plans.
- The only format change is the one §4 describes: `apis/` with `api.yaml`, `folder.yaml`, `<slug>.request.yaml` and
  `<slug>.body.<ext>`; `kind` widened to `'soap' | 'rest'` with `grpc` refused; `AuthConfig` types added; `FORMAT_VERSION
  = 3` with a no-op migration from 2. A version-2 project loads unchanged and is rewritten at 3 on save; version 4 fails
  with the existing clear error. A SOAP file written by 1.1.0 must load byte-for-byte into the same model.
- `packages/engine/src/rest` imports nothing from Electron, the DOM or React; every I/O entry takes an `AbortSignal`;
  every export has JSDoc; errors are `WirebenchError` subclasses with stable kebab-case codes prefixed `rest-`/`openapi-`/
  `oauth2-`.
- The renderer sends ids, never URLs, bodies-to-send or secrets. Every new channel and file is zod-validated with
  `exact<T>()`. No path leaves the renderer.
- Secrets by ref only (`tokenRef`, `valueRef`, `clientSecretRef`, `refreshTokenRef`); access tokens live in main's memory
  and never on disk; redaction is extended in the same task that introduces a new value that could be logged.
- SOAP behaviour does not change: `RequestDef` is aliased to `SoapRequestDef` for one release, and every existing SOAP
  test and e2e spec stays green **without edits** except where a renamed type or a widened union forces one.
- Clean-room: HTTP semantics from RFC 9110, URIs from RFC 3986, cookies from RFC 6265, OAuth2 from RFC 6749/7636/8252,
  multipart from RFC 7578, OpenAPI 3.0.x/3.1.x and JSON Schema 2020-12; no other tool named anywhere
  (`pnpm check:banned-terms`).
- UI copy: _API_, _folder_, _request_, _base URL_, _Params_, _Headers_, _Body_, _Auth_, _Settings_; methods uppercase;
  never _collection_.
- Every new control keyboard reachable with an accessible name; the method badge always carries its text; new colour
  tokens pass `pnpm contrast:check`; a11y snapshots and docs screenshots regenerated only after the suite is green, in
  their own commit, on macOS.
- Ask first: any further format field; any dependency beyond `jsonpath-plus`; any CSP change; any change to
  `shell.openExternal`'s allow-list; any shortcut beyond `Mod+Shift+I`; OpenAPI 2.0.

## Progress (updated 2026-09-13)

W0 through W3 are done — the hand-built REST path works end to end — each task as its own commit on
`claude/rest-support-spec-pgogjv` with `pnpm check` green before it. The full Playwright suite is green too (92
tests, including the new `rest.spec.ts`), run under `xvfb-run` on this machine. `WIREBENCH_SKIP_PERF=1` is set for
the unit gate: the XPath 1 MB budget fails on the development machine even on an unmodified tree, so `pnpm
test:perf` is left to CI.

| Wave | Tasks | State |
| --- | --- | --- |
| W0 format | 1, 2 | done |
| W1 engine | 3–7 | done |
| W2 main | 8–10 | done |
| W3 renderer | 11–17 | done |
| W4 openapi | 18–21 | next |
| W5–W6 | 22–26 | not started |

**Deliberate deviations from this plan, and why.** Each was taken in the task that hit it and is described in that
task's commit message.

- **T1** — the `kind: grpc` refusal uses the code `project-kind-not-supported`, prefixed like every sibling error in
  `project/`, rather than the plan's bare `kind-not-supported`.
- **T4** — the REST multipart part type is `MultipartFormPart`: `MultipartPart` was already the SOAP attachment part.
- **T6** — the chain resolver is `resolveAuthChain`, because `effectiveAuth` was already exported by
  `project/endpoints.ts`.
- **T7** — the redirect rules stay in the HTTP transport behind one new flag (`preserveMethodOnRedirect`) instead of a
  second redirect loop inside `rest/send.ts`.
- **T9** — REST send and preflight are their own channels (`request.sendRest`, `request.preflightRest`) rather than an
  overload of the SOAP pair: the payloads share no field, and one schema covering both would validate neither.
- **T11** — the spec's _Import cURL…_, _Copy as cURL_, _Send_ and _Reveal definition_ context-menu items are not in the
  menu yet; their handlers arrive in T16, T20 and T23, and a menu entry that no-ops is worse than none. The method badge
  and its six palette tokens landed here rather than in T15, because the explorer row needs it first.
- **T12** — `variables-table.tsx` stays its own component instead of becoming a `KvTable` wrapper: its data is a keyed
  map with an inheritance chain and a bulk-paste flow, none of which the ordered grid models. What the two genuinely
  share — the commit-on-Enter rule and the editable cell's look — has one implementation in `kv-table.tsx`, which the
  variables table imports.
- **T13** — the URL field is an input with a highlighted mirror behind it, not a single-line Monaco instance: a URL
  needs none of an editor's machinery, and one Monaco per open tab would be paid for on every tab switch. `rest/url.ts`
  is reached through a new browser-safe `@wirebench/engine/rest` subpath (ESLint's engine ban lists it beside `/xml`)
  rather than duplicated in the renderer. Monaco gains a worker-free JSON grammar, since this build deliberately
  carries no JSON language service.
- **T14** — _Save response_ goes through a new `exchanges.saveRestBody` channel that takes a send id and nothing else,
  following `attachments.saveResponse`, rather than the plan's `dialogs.saveFile` + `fs.saveText` route: that route
  would carry server-sent bytes across the bridge and let the renderer name the target file.
- **T15** — _View document_ and _Export…_ on the definition card are rendered disabled with a title naming the task
  that fills them in (T20), so the card's shape does not change under the user later.
- **T16** — `rest.copyAsCurl`, `rest.importCurl`, `rest.getToken` and `rest.importOpenApi` are registered with their
  final ids and shortcut, each reporting which task fills it in, so no shortcut moves under the user when those tasks
  land. `EffectiveEndpointSource` gains an `api` member: an API's own base URL is the same rung an interface's declared
  address is, named apart so the endpoints table can say which kind of row it is.
- **T17** — the spec covers everything §14 asks of the hand-built path except a REST **resend and diff** from history:
  `history.resend` rebuilds a SOAP send from a recorded entry, and no task in this plan teaches it the REST shape. It
  needs a task of its own (main: dispatch `history.resend` on `HistoryEntry.kind` and rebuild a `RestSendInput` from
  the recorded method, URL, headers and body). The plan is otherwise complete on this wave.

**Defects the e2e spec found, all fixed in T17.** Worth recording because four of the five were invisible to the unit
suite: the workspace's entity routing table never learned about APIs, folders or REST requests (so every REST send
failed `unknown-entity`); a REST tab sized its panel from its content, collapsing the body editor to five pixels;
`Mod+Enter` did nothing with the caret in Monaco; an unsaved REST edit did not survive a relaunch, because the drafts
stash carried only SOAP patches; and `Mod+S` after a rename wrote nothing, on **both** protocols, because the rename
reaches main unstaged and a clean request stopped the save there.

## Order & rationale

```
W0 format     1 (rest model + apis/ format + history kind) → 2 (AuthConfig union)
W1 engine     3 (url) · 4 (body) · 5 (response + cookies) · 6 (auth + oauth2 shapes) → 7 (send + REST test server)
W2 main       8 (wire types, channels, mutations, drafts, watch) → 9 (send path by kind, preflight, redaction, history) → 10 (OAuth2 in main)
W3 renderer  11 (explorer) → 12 (kv-table) → 13 (REST editor) → 14 (response pane) → 15 (API tab, badges) → 16 (history, search, environments, code, preferences, commands) → 17 (rest.spec)
W4 openapi   18 (model + parse + refs) → 19 (samples) → 20 (import + cache + channels) → 21 (dialog + e2e)
W5 auth ui   22 (auth inspector for both kinds, oauth2.spec, secrets.spec)
W6 round-out 23 (cURL both ways) · 24 (Query view over JSON) · 25 (perf budgets) → 26 (docs, ADRs, changelog, screenshots)
```

- The format lands first and alone, so the migration, the `kind: grpc` refusal and the round trip are reviewed before
  anything depends on them (§8 is one line of schema in T1).
- The engine is complete and integration-tested against its own REST test server before main touches it, so main's
  branch-on-kind is a wiring task, not a design task.
- The renderer is built in the order a user meets it — explorer, editor, response — and the e2e spec closes W3 on the
  hand-built path; OpenAPI arrives as a second way to make the same objects.
- Auth UI is after OpenAPI because import needs to _record_ security schemes (T20) before the inspector can _edit_ them,
  and because the engine and main halves (T6, T10) are already proven by then.
- cURL, Query and perf are independent of each other and go last, before the docs task closes the plan.

## Names later tasks depend on (define once, reuse verbatim)

```ts
// engine — packages/engine/src (T1–T7)
FORMAT_VERSION = 3                                     // project/model.ts; migrate 2 → 3 is a no-op (apis defaults to [])
type RequestKind = 'soap' | 'rest'                      // 'grpc' reserved: schema refuses it with code 'kind-not-supported'
Project.apis: readonly RestApi[]                        // order interleaves with interfaces (shared `order` space)
SoapRequestDef (= RequestDef alias) · RestRequestDef · AnyRequestDef = SoapRequestDef | RestRequestDef
RestApi · RestFolder · RestRequestDef · RestBody · RestRequestSettings · KeyValueEntry · HttpMethod   // rest/model.ts, §4.3
AuthConfig = { type: 'inherit' | 'none' | 'basic' | 'ntlm' | 'bearer' | 'api-key' | 'oauth2', … }   // project/model.ts; EndpointAuth = AuthConfig minus 'inherit'
createApi(name, input) · createFolder(name, input) · createRestRequest(name, input)                 // rest/model.ts factories, id-injectable
HistoryEntry.kind: 'soap' | 'rest'                      // project/history.ts; missing on read → 'soap'
composeUrl(base, url, pathParams, query, { encode }): { url: string; problems: UrlProblem[] }        // rest/url.ts
splitQuery(url): { path: string; query: KeyValueEntry[] } · joinQuery(path, query): string           // rest/url.ts (table ⇄ URL)
encodeBody(body, resolvers, signal): Promise<{ bytes?: Uint8Array; contentType?: string }>           // rest/body.ts
detectLanguage(contentType, bytes): BodyLanguage · decodeText(bytes, charset) · prettyBody(text, lang) · parseSetCookie(rawHeaders): Cookie[]   // rest/response.ts
cookiesToSend(cookies, url, now): Cookie[]              // rest/cookies.ts
effectiveAuth(chain: readonly (AuthConfig | undefined)[]): AuthConfig   // rest/auth.ts; first non-inherit wins, else none
applyAuth(auth: SendAuth, headers, query): { headers; query }          // rest/auth.ts
SendAuth += { type: 'bearer'; token; scheme } | { type: 'api-key'; name; value; in } | { type: 'oauth2'; accessToken }   // types.ts
buildTokenRequest(config, secrets, grantInput): HttpRequest · parseTokenResponse(exchange): TokenSet · pkce(): { verifier; challenge }   // rest/oauth2.ts
sendRest(input: RestSendInput): Promise<RestExchange>   // rest/send.ts
toRestSendInput(args): RestSendInput                    // send-options.ts; precedence request → API → project → preference
startTestRestServer(): Promise<TestRestServer>          // test/helpers/test-rest-server.ts, exported from @wirebench/engine/test-helpers
// main — apps/desktop/src/main (T8–T10)
ProjectChange += 'add-api' { name, baseUrl } · 'update-api' { apiId, patch } · 'remove-api' { apiId } · 'add-folder' { apiId, parentId?, name } · 'update-folder' { folderId, patch } · 'remove-folder' { folderId } · 'move-node' { nodeId, parentId, index } · 'add-rest-request' { apiId, parentId?, name? } · 'update-rest-request' { requestId, patch: RestRequestPatchWire }
channels: api.importOpenApi · api.cancelImport · api.definitionDocuments · api.definitionText · api.exportDefinition · oauth2.fetchToken { ownerId } · oauth2.status { ownerId } · oauth2.clearToken { ownerId } · oauth2.cancel
request.send / request.cancel / request.curl / request.preflight: unchanged shapes, dispatched on kind in main
request.importCurl.target: { kind: 'soap', … } | { kind: 'rest', apiId, folderId? }
wire: RestApiWire · RestFolderWire · RestRequestWire · RestRequestPatchWire · AuthConfigWire · RestExchangeWire · OAuth2StatusWire { state: 'none' | 'valid' | 'expired' | 'pending'; expiresAt?; scopes?; token? }
files: project-rest-mutations.ts · oauth2.ts (token cache + loopback) · rest-send.ts (the REST half of send-with-history)
// renderer (T11+)
ExplorerNodeKind += 'api' | 'folder' | 'rest-request'
EditorTab.kind += 'rest-request' | 'api' · PersistedTab likewise · tab ids: rest:<requestId> · api:<apiId>
components/kv-table.tsx: KvTable({ rows, onChange, columns: 'enabled' | 'name' | 'value' | 'description', allowDuplicates, testidPrefix })
testids: api-row · folder-row · rest-request-row · method-badge · rest-editor · rest-method · rest-url · rest-send · rest-params · rest-path-table · rest-query-table · rest-headers · rest-body · rest-body-kind · rest-body-editor · rest-auth · rest-auth-source · rest-settings · rest-response · rest-response-status · rest-response-body · rest-response-view (pretty|raw|preview) · rest-response-headers · rest-response-cookies · rest-response-redirects · rest-response-timing · rest-response-tls · rest-response-raw · rest-response-query · api-tab · api-base-url · api-definition-card · import-openapi-dialog · import-openapi-summary · oauth2-status · oauth2-get-token · oauth2-clear-token
commands: rest.newApi · rest.newFolder · rest.newRequest · rest.importOpenApi (Mod+Shift+I) · rest.send (Mod+Enter in a REST tab) · rest.copyAsCurl · rest.importCurl · rest.getToken
preferences.rest: { followRedirects: true, maxRedirects: 5, prettyPrintMaxBytes: 5_242_880, defaultAccept: '', oauth2CallbackPort?: number }
e2e helpers (e2e/helpers/rest.ts): createApi(page, name, baseUrl) · createRestRequest(page, apiName, name) · setMethodAndUrl(page, method, url) · sendRest(page) · responseStatus(page) · openResponseTab(page, tab)
fixtures: fixtures/openapi/public/{petstore-3.0.yaml, …} · fixtures/openapi/crafted/<construct>.yaml · fixtures/openapi/SOURCES.md
```

## Tasks

### W0 — Format and model

- [x] **1. REST model, `apis/` format, `formatVersion: 3`, history kind, `grpc` refused**
  - `rest/model.ts` (§4.3 types, factories, `RestRequestSettings` with every field optional, `DEFAULT_REST_SETTINGS`
    for the preference layer); `project/model.ts` (`apis`, `FORMAT_VERSION = 3`, `RequestDef` → `SoapRequestDef` with
    the alias, `AnyRequestDef`, `createProject` sets `apis: []`); `project/schema.ts` (`apiFileSchema`,
    `folderFileSchema`, `restRequestFileSchema`, `restBodySchema`; `kind` as `z.enum(['soap','rest'])` on request and
    interface files with a `superRefine` that maps `'grpc'` to `kind-not-supported`; `formatVersion: z.literal(3)`);
    `project/paths.ts` (`apiDir`, `folderDir`, `restRequestFile`, `restBodyFile(slug, language)`, the depth cap of 8,
    the API-vs-interface slug uniqueness check reported as a project problem); `project/load.ts` (walk `apis/**`,
    synthesise a folder for a directory without `folder.yaml`, read the sidecar body); `project/serialize.ts`
    (deterministic, `enabled` only when false, `servers` and `definition` omitted when empty); `project/save.ts`
    (managed set includes `apis/**` so a deleted request's two files are removed); `project/migrate.ts` (2 → 3 no-op,
    4 → too-new); `project/history.ts` (`kind` with the `'soap'` default on read; the per-kind request/response union,
    §8 point 5); `index.ts` exports.
  - Acceptance: round trip of a project with two APIs, nested folders to depth 3, every body kind and `auth: inherit`
    is byte-identical; a version-2 fixture (committed under `packages/engine/test/fixtures/format-v2/`) loads with
    `apis: []` and is rewritten with only the version line changed; version 4 → too-new; a `kind: grpc` request file →
    `kind-not-supported` naming the file; an API slug equal to an interface slug → problem, API skipped; a folder
    deeper than 8 → problem; renaming a request changes exactly `<old>.request.yaml` + `<old>.body.json` →
    `<new>.*`; a `.jsonl` line without `kind` reads as `soap`.
  - Verify: `pnpm vitest run packages/engine/test/unit/project packages/engine/test/unit/rest/model`
  - Files: packages/engine/src/rest/model.ts, packages/engine/src/project/{model,schema,paths,load,serialize,save,migrate,history}.ts, packages/engine/src/index.ts, packages/engine/test/unit/project/{roundtrip,schema,paths,migrate,history,rest-format}.test.ts, packages/engine/test/unit/rest/model.test.ts, packages/engine/test/fixtures/format-v2/\*\*

- [x] **2. `AuthConfig` union**
  - `project/model.ts`: `AuthConfig` per §3.5 (`inherit`, `none`, `basic`, `ntlm`, `bearer`, `api-key`, `oauth2`);
    `EndpointAuth = Exclude<AuthConfig, { type: 'inherit' }>` so SOAP interface/endpoint/request fields keep their type
    name; `project/schema.ts` discriminated union with every secret field a `secretRef` string; `serialize.ts` stable
    key order per type; `RestApi.auth`, `RestFolder.auth`, `RestRequestDef.auth` typed. SOAP `authMode`
    override/complement untouched.
  - Acceptance: each type round-trips; an existing `basic`/`ntlm` file loads into the same object as before (golden
    from the v2 fixture); an `oauth2` file with a plaintext-looking `clientSecret` key is rejected by `exact()` (unknown
    key), proving the ref-only rule at the schema; `type: inherit` is refused on an interface or endpoint.
  - Verify: `pnpm vitest run packages/engine/test/unit/project/auth-config`
  - Files: packages/engine/src/project/{model,schema,serialize}.ts, packages/engine/test/unit/project/auth-config.test.ts

**Checkpoint W0:** engine coverage ≥ 85 %; no desktop file touched; every SOAP unit test green unedited.

### W1 — Engine

- [x] **3. URL composition**
  - `rest/url.ts`: `composeUrl` (absolute URL wins over base; base with/without trailing slash joins with one `/`;
    `{name}` filled from `pathParams`, missing → `UrlProblem { code: 'missing-path-param', name }`; query from enabled
    entries, RFC 3986 encoding that leaves valid `%XX` alone, `encode: false` passes through; duplicates kept in
    order; unicode → UTF-8 percent-encoded; a `${…}` left in the URL is a problem, not encoded); `splitQuery` /
    `joinQuery` for the editor's table ⇄ URL sync (idempotent both ways); `parseUrlParams(url): string[]` for the
    Params table.
  - Acceptance: table tests for every rule above; property test: `joinQuery(splitQuery(u)) === u` for a corpus of
    URLs.
  - Verify: `pnpm vitest run packages/engine/test/unit/rest/url`
  - Files: packages/engine/src/rest/url.ts, packages/engine/test/unit/rest/url.test.ts

- [x] **4. Bodies**
  - `rest/body.ts`: `encodeBody` for `none` (no bytes, no content type), `raw` (text in the request charset,
    `contentType` from the entry, else the language default), `form` (RFC 1866 `application/x-www-form-urlencoded`,
    `+` for space), `multipart` (RFC 7578 with a random boundary injectable for tests; text parts; file parts through
    the existing `AttachmentResolver` with `filename` and part content type; disabled parts skipped), `binary` (bytes
    from the resolver, content type as given). The `escapeProperties` transform (`escapeForLanguage(value, lang)`) lives
    here for the expansion step to call.
  - Acceptance: golden bytes per kind with a fixed boundary; a multipart with a 1 MB file is streamed into one buffer
    without a copy per part (assert allocation count via a counting resolver); a `GET` with a raw body still returns
    bytes (the transport decides nothing); `escapeForLanguage` for JSON and XML.
  - Verify: `pnpm vitest run packages/engine/test/unit/rest/body`
  - Files: packages/engine/src/rest/body.ts, packages/engine/test/unit/rest/body.test.ts, packages/engine/test/fixtures/rest/bodies/\*\*

- [x] **5. Response decoding and cookies**
  - `rest/response.ts`: `detectLanguage` (`Content-Type` first — `json`, `+json`, `xml`, `+xml`, `html`,
    `javascript`, `image/*`, `text/*` — then a sniff of the first 512 bytes for `{`/`[`/`<?xml`/`<!DOCTYPE`; `binary`
    otherwise), `decodeText` (charset from the header through the existing SOAP charset table; BOM stripped; invalid →
    replacement characters, never a throw), `prettyBody` (JSON via `JSON.parse`/`stringify` with 2 spaces, XML via
    `xml/pretty.ts`, HTML via a minimal tag-indent pass, else identity), `parseSetCookie` over `rawHeaders` (every
    `set-cookie`, RFC 6265 §5.2 attributes, malformed lines kept as `{ name, value, malformed: true }`);
    `rest/cookies.ts`: `cookiesToSend` (domain-match, path-match, `Secure` needs https, expired dropped) and
    `cookieHeader(cookies)`.
  - Acceptance: detection table incl. `text/plain` that is JSON, `application/problem+json`, no header; charset
    cases (`iso-8859-1`, `utf-16`); pretty-print golden; the RFC 6265 example cookies and the malformed cases;
    matching rules incl. a leading-dot domain and a path prefix.
  - Verify: `pnpm vitest run packages/engine/test/unit/rest/response packages/engine/test/unit/rest/cookies`
  - Files: packages/engine/src/rest/{response,cookies}.ts, packages/engine/test/unit/rest/{response,cookies}.test.ts

- [x] **6. Auth application and OAuth2 shapes**
  - `types.ts`: `SendAuth` gains `bearer`, `api-key`, `oauth2` (§ names block); `rest/auth.ts`: `effectiveAuth(chain)`
    and `applyAuth` (Bearer → `Authorization: <scheme> <token>`; api-key → header or query entry; basic preemptive →
    header, challenge → left to the transport as today; NTLM → the existing transport path; oauth2 → Bearer with the
    access token); a caller-supplied `Authorization` header wins, as for SOAP. `rest/oauth2.ts` (pure):
    `buildTokenRequest` for client credentials, authorization-code exchange and refresh (`clientAuth: 'basic' | 'body'`,
    scopes joined by space, `audience`), `parseTokenResponse` (RFC 6749 §5.1 and §5.2, `expires_in` → absolute
    `expiresAt` from an injected clock, error → `oauth2-token-error` with `error`/`error_description`), `pkce()` (RFC 7636
    S256; the verifier alphabet and length), `authorizationUrl(config, state, challenge, redirectUri)`.
  - Acceptance: every `SendAuth` type produces the documented header/query; inheritance table (request inherit →
    folder none → API bearer ⇒ none; all inherit ⇒ none); RFC 7636 appendix B vectors; token request golden per grant
    and `clientAuth`; the RFC 6749 example responses parse; error responses map to codes.
  - Verify: `pnpm vitest run packages/engine/test/unit/rest/auth packages/engine/test/unit/rest/oauth2`
  - Files: packages/engine/src/types.ts, packages/engine/src/rest/{auth,oauth2}.ts, packages/engine/test/unit/rest/{auth,oauth2}.test.ts

- [x] **7. `sendRest`, send options, the REST test server, integration**
  - `rest/send.ts` per §5 and §11: compose, encode, apply auth and cookies, add `User-Agent`/`Accept-Encoding`/
    `Connection` per preferences exactly as `send-options.ts` does for SOAP, call `sendHttp` with `followRedirects:
    false` and run the §3.3 redirect loop in this module (307/308 keep method and body; 303 → GET; 301/302 on a
    non-GET → GET unless `keepBodyOnRedirect`; drop `Authorization` and `Cookie` on a cross-origin hop; record every
    hop; `maxRedirects` → `too-many-redirects`); decode into `RestExchange` (`HttpExchange` + `text`, `language`,
    `cookies`, `redirects`, `methodChanged`). `send-options.ts`: `toRestSendInput` with the precedence request → API →
    project → preference; `rest.followRedirects`, `rest.maxRedirects` added to `Preferences` with defaults
    (`preferences.ts` schema). `test/helpers/test-rest-server.ts`: `startTestRestServer()` with routes `/echo`
    (method, headers, query, body, cookies as JSON), `/status/:code`, `/redirect/:code?to=`, `/auth/basic`,
    `/auth/bearer`, `/auth/apikey` (header and query), `/gzip`, `/slow?ms=`, `/chunked`, `/image.png`, `/large?bytes=`,
    `/cookies/set`, `/charset/latin1`, `/oauth2/token` and `/oauth2/authorize` (a stub that redirects to the given
    `redirect_uri` with a code; validates `state`, PKCE and client auth; issues expiring tokens and refresh tokens);
    exported from `test/helpers/index.ts`.
  - Acceptance: integration against the server: every method; each body kind echoed byte-exact; the redirect matrix
    (5 statuses × GET/POST × keep-body) asserting method, body presence and the recorded chain; cross-origin auth
    drop (a second server instance); Basic preemptive and challenge, NTLM (existing simulator), Bearer, api-key in
    header and query; gzip/deflate/br; `maxSizeBytes` → `too-large` with `truncated`; cancel mid-flight; timeout;
    binary response detected as `image`; latin1 decoded; cookies set then sent back only when matching;
    `toRestSendInput` precedence table.
  - Verify: `pnpm vitest run packages/engine/test/integration/rest packages/engine/test/unit/send-options packages/engine/test/unit/project/preferences`
  - Files: packages/engine/src/rest/send.ts, packages/engine/src/send-options.ts, packages/engine/src/project/preferences.ts, packages/engine/src/index.ts, packages/engine/test/helpers/{test-rest-server,index}.ts, packages/engine/test/integration/rest/{send,redirects,auth,bodies,responses}.test.ts, packages/engine/test/unit/send-options.test.ts

**Checkpoint W1:** engine coverage ≥ 85 %; `pnpm bench` unchanged for SOAP scenarios; no desktop file touched.

### W2 — Main

- [x] **8. Wire types, channels, mutations, drafts, watch**
  - `shared/wire-types.ts`: `RestApiWire`, `RestFolderWire`, `RestRequestWire` (body text inline, capped by the
    existing size rule), `RestRequestPatchWire` (every field optional, `body` whole-replace), `AuthConfigWire`,
    `projectChangeSchema` gains the nine change kinds; `ProjectWire.apis`; `shared/ipc.ts`: `request.importCurl.target`,
    the `api.*` and `oauth2.*` channels declared (handlers for `api.*` land in T20, `oauth2.*` in T10; declare now so
    the preload API is complete once). `main/project-rest-mutations.ts`: apply each kind to the model (slug on rename,
    move re-parents and re-orders, remove cascades, `add-rest-request` creates `Request N` with `auth: inherit`);
    `project-host.ts` routes the kinds and marks dirty; `project-wire.ts` maps APIs; `unsaved-store.ts` and
    `state/unsaved-drafts.ts` carry `{ kind: 'rest', patch: RestRequestPatchWire }` drafts; `project-watch.ts` watches
    `apis/**` and reloads a request whose body file changed; `search.ts` indexes REST name, URL, header names/values,
    body text.
  - Acceptance: ipc tests per change kind with the exact model result; drafts round trip through `unsaved-store`;
    an external body-file edit emits `project.changedOnDisk` with the request id; search finds a request by URL
    fragment; the preload API test lists the new methods.
  - Verify: `pnpm vitest run apps/desktop/test/{project-rest-mutations,project-host,project-wire,unsaved-store,project-watch,search,preload-api}`
  - Files: apps/desktop/src/shared/{ipc,wire-types}.ts, apps/desktop/src/main/{project-rest-mutations,project-host,project-wire,unsaved-store,project-watch,search}.ts, apps/desktop/src/preload/\*\*, apps/desktop/src/renderer/state/unsaved-drafts.ts, apps/desktop/test/{project-rest-mutations,project-host,project-wire,unsaved-store,project-watch,search,preload-api}.test.ts, apps/desktop/test/mocks/wirebench-api.ts

- [x] **9. Send path by kind, preflight, redaction, history**
  - `main/rest-send.ts`: resolve the API's effective base URL through `endpoint-override` precedence (workspace env →
    linked project env → API `baseUrl`), expand `${…}` across scopes in base, URL, params, headers, body and form/
    multipart text values (with `escapeForLanguage` when set), resolve the effective `AuthConfig` chain and its refs
    through `secret-resolver.ts` (`resolveAuthConfig` covering the new types; oauth2 asks `oauth2.ts` for a token —
    stubbed until T10), keystore/TLS/proxy as SOAP, cookies from the per-request session store, then `sendRest`;
    `send-with-history.ts` branches on `kind` after `requestMeta`; `history-service.ts` builds the `kind: 'rest'`
    entry (§3.9; body text capped with `truncated`, binary as size + type) and the exchange cache keeps the bytes;
    `expansion-preflight.ts` gains the REST fields and `missing-path-param`; `redact.ts` redacts `Authorization`,
    `Proxy-Authorization`, `Cookie`, `Set-Cookie` values and named api-key query parameters in URLs; `ipc/request.ts`
    `send`/`cancel`/`preflight` dispatch on kind; `history.resend` works for REST.
  - Acceptance: a real-engine test (`rest-send.test.ts`) sends to `startTestRestServer()` through `sendAndRecordHistory`
    and asserts the history entry, the redacted raw request, the base-URL override from a workspace environment, the
    unresolved-property and missing-path-param preflight problems, api-key-in-query redaction in both history and the
    HTTP log; `redact.test.ts` cases for each new value; resend replays the same bytes.
  - Verify: `pnpm vitest run apps/desktop/test/{rest-send,send-with-history,history-service,expansion-preflight,redact,secret-resolver,ipc-request,ipc-history}`
  - Files: apps/desktop/src/main/{rest-send,send-with-history,history-service,expansion-preflight,redact,secret-resolver,project-auth,exchange-cache}.ts, apps/desktop/src/main/ipc/{request,history}.ts, apps/desktop/test/{rest-send,send-with-history,history-service,expansion-preflight,redact,secret-resolver,ipc-request,ipc-history}.test.ts

- [x] **10. OAuth2 in main**
  - `main/oauth2.ts`: `TokenCache` keyed by a hash of the resolved config (memory only; `get`, `set`, `clear`,
    `status`); `fetchToken(ownerId)` — client credentials through the engine's `buildTokenRequest` + `sendHttp` with the
    send's TLS/proxy; authorization code: `startLoopback({ port? })` bound to `127.0.0.1` (random port unless
    `preferences.rest.oauth2CallbackPort`), one pending flow, `state` + PKCE, five-minute timeout, single response
    then close; opens the authorization URL through the existing allow-listed `shell.openExternal`; exchanges the
    code; refresh when a token is within 30 s of expiry and a refresh token exists (from the cache, or from
    `refreshTokenRef` when the user opted in); `secrets.set` for the refresh token only on opt-in. `ipc/oauth2.ts`
    handlers for the four channels; `oauth2.status` returns the token value only when `secrets.getShowSecrets()` is
    true. `rest-send.ts` unstubbed: a missing or expired token on an authorization-code config fails the send with
    `oauth2-sign-in-required` instead of opening a browser. `docs/security.md` gains a section on the loopback
    listener.
  - Acceptance: against the stub authorization server: client credentials obtains, caches, refreshes near expiry;
    authorization-code end to end with an injected "browser" that follows the URL (asserting `state`, PKCE and the
    single-use listener); wrong `state` → refused and the flow stays pending until timeout; a second flow while one is
    pending → `oauth2-flow-pending`; listener closes after one response and never binds to `0.0.0.0` (assert the
    address); status never carries the token without show-secrets; refresh token written only on opt-in (grep
    `secrets.json` for the value in both cases); `security-baseline.test.ts` extended for the new listener rules.
  - Verify: `pnpm vitest run apps/desktop/test/{oauth2,ipc-oauth2,rest-send,security-baseline}`
  - Files: apps/desktop/src/main/{oauth2,rest-send,secrets}.ts, apps/desktop/src/main/ipc/{oauth2,register}.ts, apps/desktop/test/{oauth2,ipc-oauth2,rest-send,security-baseline}.test.ts, docs/security.md

**Checkpoint W2:** a REST request created through `project.mutate` and sent through `request.send` round-trips
end-to-end in main tests, with history and redaction proven; no renderer file touched.

### W3 — Renderer

- [x] **11. Explorer: APIs, folders, requests**
  - `tree-nodes.ts` (`api`, `folder`, `rest-request` nodes under a project, interleaved with interfaces by `order`;
    `method` on request nodes; `apiId`/`folderId`); `explorer-view.tsx` rows (`api-row` with a REST badge, `folder-row`,
    `rest-request-row` with `method-badge` before the name; drag-and-drop reorder/move within a project via
    `react-arborist`'s move → `move-node`); `context-menu.tsx` items per §7.1; `explorer-actions.ts`
    (`newApi`, `newFolder`, `newRestRequest`, `renameNode`, `duplicateRestRequest`, `removeApi`/`removeFolder` with
    `ConfirmDialog` when non-empty); `register-explorer-commands.ts` (`rest.newApi`, `rest.newFolder`,
    `rest.newRequest`); `state/project.ts` mirrors `apis` and exposes `restRequestById`, `apiOf(requestId)`,
    `folderChain(requestId)`; fold state includes the new node ids. Single click on a request opens its tab (T13
    provides the editor; until then the tab shows a placeholder so this task stays independently green).
  - Acceptance: component tests: node order (interfaces and APIs interleaved), badges, menu items per kind, each
    action's exact `project.mutate` payload, DnD move → `move-node` with the right parent and index, fold state
    persisted for API and folder ids.
  - Verify: `pnpm vitest run --project desktop -- explorer project-store`
  - Files: apps/desktop/src/renderer/features/explorer/{tree-nodes,explorer-view,context-menu,explorer-actions,project-actions}.ts(x), apps/desktop/src/renderer/commands/register-explorer-commands.ts, apps/desktop/src/renderer/state/{project,editors,workspace-tabs,ui-state}.ts, apps/desktop/test/renderer/{explorer-view,explorer-context-menu,explorer-actions,project-store,tree-nodes}.test.ts(x)

- [x] **12. `KvTable` component**
  - `components/kv-table.tsx` generalised from `features/environments/variables-table.tsx`: configurable columns
    (`enabled`, `name`, `value`, `description`), `allowDuplicates`, inline commit on Enter/Tab and revert on Escape,
    always-present add row, delete per row, keyboard row navigation from `grid-navigation`, `role="grid"` per the
    convention `history-view.tsx` uses, `testidPrefix`. `variables-table.tsx` becomes a thin wrapper (same testids,
    duplicates disallowed) so the Environments tests stay green.
  - Acceptance: component tests for every behaviour with both duplicate modes; the existing `variables-table`,
    `environment-page` and `endpoints-table` tests pass unchanged.
  - Verify: `pnpm vitest run --project desktop -- kv-table variables-table environment-page`
  - Files: apps/desktop/src/renderer/components/kv-table.tsx, apps/desktop/src/renderer/features/environments/variables-table.tsx, apps/desktop/test/renderer/kv-table.test.tsx

- [x] **13. REST request editor**
  - `features/rest-editor/rest-editor.tsx` (`rest-editor`; tab kind `rest-request`, id `rest:<id>`, opened by the
    existing request-tab opener on `kind`), `url-bar.tsx` (`rest-method` select with custom entry, `rest-url` with the
    greyed effective base prefix for a relative URL and `${…}`/`{param}` highlighting via a Monaco single-line editor
    as `curl-highlight.ts` does, `rest-send` with cancel, overflow menu), `params-tab.tsx` (`rest-path-table` from
    `parseUrlParams`, `rest-query-table` kept in sync with the URL through `splitQuery`/`joinQuery` — engine functions
    reachable through the browser-safe subpath, or duplicated in `state/rest-url.ts` with a shared test corpus if the
    subpath rule forbids it), `headers-tab.tsx` (typed rows plus the greyed computed rows), `body-tab.tsx`
    (`rest-body-kind` switch keeping each kind's draft; raw → Monaco in the language with _Format_ and the escape
    toggle; form and multipart → `KvTable` plus the file picker path attachments use; binary → one file), `auth-tab.tsx`
    (effective-source label `rest-auth-source` + the `AuthFields` component; the new types' forms land in T22 — this
    task shows `inherit`/`none`/`basic`/`ntlm`), `settings-tab.tsx` (`SettingsGrid` with inherited values greyed),
    `request-breadcrumb` reused for the path line; `state/drafts.ts` `stageRestRequest(id, patch)` + per-tab dirty
    dot, `Mod+S`/`Mod+Alt+S` through the existing save path; `register-request-commands.ts` binds `rest.send` to
    `Mod+Enter` in a REST tab.
  - Acceptance: component tests: URL ⇄ query table sync both ways incl. duplicates and encoding-off; path table
    follows `{param}` edits; body kind switch preserves drafts; each edit stages the exact patch; save sends
    `update-rest-request`; dirty dot; `Mod+Enter` calls send with the id only; a relative URL shows the base prefix
    from the active environment.
  - Verify: `pnpm vitest run --project desktop -- rest-editor url-bar params-tab headers-tab body-tab settings-tab drafts-store`
  - Files: apps/desktop/src/renderer/features/rest-editor/{rest-editor,url-bar,params-tab,headers-tab,body-tab,auth-tab,settings-tab,rest-actions}.ts(x), apps/desktop/src/renderer/state/{drafts,editors,rest-url}.ts, apps/desktop/src/renderer/shell/editor-area.tsx, apps/desktop/src/renderer/commands/register-request-commands.ts, apps/desktop/test/renderer/{rest-editor,url-bar,params-tab,headers-tab,body-tab,settings-tab,drafts-store}.test.ts(x)

- [x] **14. Response pane**
  - `features/rest-editor/response/response-pane.tsx` (`rest-response`, the existing request/response split and layout
    toggles), `status-line.tsx` (`rest-response-status`: status + reason coloured by class, duration, body and total
    size, protocol), `body-view.tsx` (`rest-response-view` Pretty/Raw/Preview; Monaco read-only in the detected mode
    with fold and find; JSON node _Copy path_ giving a JSONPath-style path; Preview renders `image/*` from a blob built
    from `exchanges.get` bytes and a hex view otherwise; above `preferences.rest.prettyPrintMaxBytes` Pretty is disabled
    with a note and Raw uses `@tanstack/react-virtual`), `headers-view.tsx`, `cookies-view.tsx` (parsed table),
    `redirects-view.tsx` (hops with a method-change note), the existing timing and SSL inspectors mounted as tabs,
    `raw-view` reused, `query` tab placeholder until T24; _Save response_ through `dialogs.saveFile` + `fs.saveText`/
    binary; `state/exchanges.ts` keeps the REST exchange per request.
  - Acceptance: component tests per tab with a fixture `RestExchangeWire`; language switch by content type and by
    sniff; the size threshold; image preview creates and revokes its blob URL; save calls the id-only channel; the
    status colours map to tokens that pass contrast.
  - Verify: `pnpm vitest run --project desktop -- response-pane status-line body-view cookies-view redirects-view`
  - Files: apps/desktop/src/renderer/features/rest-editor/response/{response-pane,status-line,body-view,headers-view,cookies-view,redirects-view}.tsx, apps/desktop/src/renderer/state/exchanges.ts, apps/desktop/src/renderer/styles/tokens.css, apps/desktop/test/renderer/{response-pane,status-line,body-view,cookies-view,redirects-view}.test.tsx

- [x] **15. API tab and method badges**
  - `features/rest-api/api-tab.tsx` (`api-tab`, tab id `api:<id>`, opened by a single click on the API row and by
    _Open_): name, description, `api-base-url` with the environment override and its source beside it and the server
    list as a datalist, auth (the shared `AuthFields`), `api-definition-card` (source, fetched at, version, _View
    document_ and _Export…_ wired in T20, hidden for a hand-built API); `features/rest-api/method-badge.tsx` with the
    six colour tokens added to `tokens.css` and used by the explorer (T11) and history (T16).
  - Acceptance: component tests: edits send `update-api` patches; the override label for workspace/project/API
    sources; the badge renders text for every method incl. custom; contrast check green.
  - Verify: `pnpm vitest run --project desktop -- api-tab method-badge`; `pnpm contrast:check`
  - Files: apps/desktop/src/renderer/features/rest-api/{api-tab,method-badge,api-actions}.tsx, apps/desktop/src/renderer/state/{editors,workspace-tabs}.ts, apps/desktop/src/renderer/shell/editor-area.tsx, apps/desktop/src/renderer/styles/tokens.css, apps/desktop/test/renderer/{api-tab,method-badge}.test.tsx

- [x] **16. History, search, environments rows, code slide-over, preferences, commands**
  - `history-view.tsx` method-badge column for `kind: rest` rows and the SOAP version for others; `history-entry-view`
    opens the response pane read-only; `diff-view` pretty-prints both sides when both are JSON or XML; search results
    with a badge; `endpoints-table.tsx` gains API rows under each project (§3.8) using the same `environment-endpoint`
    control and `workspace-env-source`; `state/endpoint-override.ts` `effectiveEndpointSource` accepts an API
    (`'api'` source label); `code-panel.tsx` shows the REST cURL from `request.curl` (engine side in T23 — until then
    the SOAP path returns a "not yet" placeholder for REST ids, asserted); `features/preferences` gains the _REST_ page
    (`preferences.rest` fields, `state/preferences-defaults.ts`); `shared/commands.ts` and the register files declare
    `rest.copyAsCurl`, `rest.importCurl`, `rest.getToken` (handlers filled in T22/T23), `rest.importOpenApi` with
    `Mod+Shift+I` (handler in T21).
  - Acceptance: component tests for each surface; the command palette lists every `rest.*` command; the shortcut
    table snapshot updated; `keybindings.test.ts` covers `Mod+Shift+I`.
  - Verify: `pnpm vitest run --project desktop -- history-view diff-view endpoints-table endpoint-override code-panel preferences-editor commands keybindings`
  - Files: apps/desktop/src/renderer/features/history/{history-view,history-entry-view,diff-view}.tsx, apps/desktop/src/renderer/features/search/\*\*, apps/desktop/src/renderer/features/environments/endpoints-table.tsx, apps/desktop/src/renderer/state/{endpoint-override,preferences-defaults,preferences}.ts, apps/desktop/src/renderer/shell/code-panel.tsx, apps/desktop/src/renderer/features/preferences/\*\*, apps/desktop/src/shared/commands.ts, apps/desktop/src/renderer/commands/{register-request-commands,register-explorer-commands,register-history-commands}.ts, apps/desktop/test/renderer/{history-view,diff-view,endpoints-table,endpoint-override,code-panel,preferences-editor,commands,keybindings}.test.ts(x)

- [x] **17. e2e `rest.spec.ts`**
  - `e2e/helpers/rest.ts` (names block) and `e2e/helpers/test-server.ts` re-exporting `startTestRestServer`;
    `rest.spec.ts`: new API with the test server as base URL → new request `GET /echo?x=1` with a header → send →
    status 200, pretty JSON containing the header and query → Headers, Cookies (after `/cookies/set`), Redirects
    (`/redirect/302`), Timing tabs → history entry with the `GET` badge → resend → diff two runs; POST with a JSON raw
    body echoed; multipart with a file from `WIREBENCH_E2E_FILE_DIALOG_PATH`; `${#Env#missing}` and `{id}` unfilled
    block Send with Problems; a workspace environment override of the API's base URL points the next send at a second
    server instance; rename a request and assert exactly two files changed (the `project.spec.ts` helper); relaunch
    keeps the tab and an unsaved draft; `a11y.spec.ts` and `keyboard.spec.ts` gain the REST editor and `Mod+Enter`.
  - Acceptance: the spec green on three OSes; every SOAP spec green unedited; a11y baselines regenerated in a
    dedicated commit.
  - Verify: `pnpm build && pnpm test:e2e -- --grep "rest|a11y|keyboard"`; then the full suite
  - Files: e2e/helpers/{rest,test-server}.ts, e2e/specs/{rest,a11y,keyboard}.spec.ts, e2e/specs/\_\_screenshots\_\_/\*\*

**Checkpoint W3:** §14 SC1 (hand-built half), SC2, SC5 (base URL and properties), SC6 (history, search) and SC7
(explorer, editor) hold; full e2e green.

### W4 — OpenAPI

- [ ] **18. OpenAPI model, parser, `$ref` resolution**
  - `rest/openapi/model.ts` (the consumed subset of 3.0.x/3.1.x as readonly types: info, servers with variables,
    paths, operations, parameters, requestBody, media types with example/examples/schema, components, security
    schemes, security requirements, tags, deprecated; unknown keys preserved on a `extensions` bag and counted);
    `parse.ts` (JSON or YAML by sniff, zod-validated tolerantly: a malformed operation is skipped and counted, never
    fatal; `swagger: '2.0'` → `openapi-unsupported-version`; a non-OpenAPI document → `openapi-not-a-document`);
    `refs.ts` (local JSON pointers per RFC 6901 incl. `~0`/`~1`; relative document refs through an injected fetcher
    and the reference policy generalised from `wsdl/ref-policy.ts` (`http(s)` and file relative to the root; no
    absolute file paths from a URL root); cycle-safe via a visited set; every fetched document returned for caching);
    `import.ts` skeleton exporting `parseOpenApi(source, { fetch, signal })` → `{ document, documents, skipped }`.
  - Acceptance: `fixtures/openapi/crafted/` parse goldens (one per construct in §12); local, relative-file and URL
    refs resolve in the fetcher-injected tests; a cyclic ref set terminates; 2.0 and a random YAML refused with the
    codes; the skip counters match.
  - Verify: `pnpm vitest run packages/engine/test/unit/rest/openapi/parse packages/engine/test/unit/rest/openapi/refs`
  - Files: packages/engine/src/rest/openapi/{model,parse,refs,import}.ts, packages/engine/src/wsdl/ref-policy.ts, packages/engine/test/unit/rest/openapi/{parse,refs}.test.ts, fixtures/openapi/crafted/\*\*, fixtures/openapi/SOURCES.md

- [ ] **19. JSON Schema samples**
  - `rest/openapi/sample.ts` per §3.6: `sampleFromSchema(schema, { includeOptional, sampleValues, resolve })` with
    the precedence `example` > `default` > first `enum` > type default; required always, optional per preference;
    `allOf` merged, `oneOf`/`anyOf` first branch; depth cap 8 with `null`; `format` placeholders only with
    `sampleValues`; 3.1 `type: [..., 'null']` and `const`; `sampleXml` honouring the `xml` object via `xml/serialize.ts`.
  - Acceptance: golden samples per construct fixture (JSON and XML), both preference combinations; a recursive schema
    produces a finite document; deterministic output.
  - Verify: `pnpm vitest run packages/engine/test/unit/rest/openapi/sample`
  - Files: packages/engine/src/rest/openapi/sample.ts, packages/engine/test/unit/rest/openapi/sample.test.ts, packages/engine/test/fixtures/openapi-samples/\*\*

- [ ] **20. Import, definition cache, `api.*` channels**
  - `rest/openapi/import.ts`: `importOpenApi(source, options)` → `{ api: RestApi, definition: CachedDefinition, summary }`
    applying the §3.6 mapping (title → name, servers → base URL and list, folders by first tag else first path
    segment, request naming, parameter tables with enabled per `required`, header parameters as disabled headers,
    bodies by media-type preference with example > examples > sample, binary media types, security schemes → API auth
    or per-request auth, `Deprecated` folder rule, the summary counts); `rest/openapi/cache.ts` writes `definition/`
    with `manifest.yaml` sharing `wsdl/cache-naming.ts`, and `RestApi.definition` set. Main: `ipc/api.ts` handlers for
    `api.importOpenApi` (progress over `engine.progress`, cancel via `api.cancelImport`, target project through
    `ProjectRouter`, name and slug collision handled per T1), `api.definitionDocuments`, `api.definitionText`,
    `api.exportDefinition` (mirroring `ipc/definition.ts` with the same dialog-pick rules); `project-host.ts`
    `addApi(api, definition)` writes the cache under containment.
  - Acceptance: import goldens for every crafted fixture and both public fixtures (tree shape, params, bodies, auth,
    summary); the cache is byte-identical to the fetched documents; cancel mid-fetch leaves nothing on disk; ipc tests
    for the four channels incl. path safety of the export target.
  - Verify: `pnpm vitest run packages/engine/test/unit/rest/openapi/import apps/desktop/test/ipc-api`
  - Files: packages/engine/src/rest/openapi/{import,cache}.ts, packages/engine/src/index.ts, apps/desktop/src/main/ipc/{api,register}.ts, apps/desktop/src/main/{project-host,project-router,workspace-service}.ts, packages/engine/test/unit/rest/openapi/import.test.ts, apps/desktop/test/ipc-api.test.ts, fixtures/openapi/public/\*\*, scripts/fixtures-refresh.ts

- [ ] **21. Import dialog, definition viewer, e2e**
  - `features/explorer/import-openapi-dialog.tsx` (`import-openapi-dialog`: URL or file — the file through
    `dialogs.openFile` — target project, name, cache checkbox, the security scheme choice when the document offers
    several, progress and cancel, then `import-openapi-summary` listing created folders/requests and skipped items);
    `rest.importOpenApi` handler and the project row's _Import OpenAPI…_ menu item; the API tab's definition card
    wired to `api.definitionText`/`api.definitionDocuments` (reusing the interface editor's document viewer) and
    _Export…_; `openapi-import.spec.ts`: import a crafted fixture by URL (test server serving `fixtures/openapi`) and by
    file, assert the explorer tree against a golden shape, open an imported `POST`, send its sample body to `/echo`,
    open the definition viewer, export and compare bytes.
  - Acceptance: component tests for the dialog states and the exact channel payloads; e2e green on three OSes.
  - Verify: `pnpm vitest run --project desktop -- import-openapi-dialog api-tab`; `pnpm build && pnpm test:e2e -- --grep "openapi"`
  - Files: apps/desktop/src/renderer/features/explorer/{import-openapi-dialog,context-menu,explorer-actions}.tsx, apps/desktop/src/renderer/features/rest-api/api-tab.tsx, apps/desktop/src/renderer/commands/register-explorer-commands.ts, apps/desktop/test/renderer/import-openapi-dialog.test.tsx, e2e/specs/openapi-import.spec.ts, e2e/helpers/rest.ts

**Checkpoint W4:** §14 SC4 holds and SC1's imported half; full e2e green.

### W5 — Auth UI

- [ ] **22. Auth inspector for both kinds, OAuth2 UI, secrets proof**
  - `components/auth-fields.tsx` gains the `bearer` (token as `SecretField`, scheme), `api-key` (name, value as
    `SecretField`, in), `oauth2` (grant, URLs, client id, client secret as `SecretField`, scopes, audience, client
    auth, PKCE, fixed port hint showing the redirect URI, _Remember refresh token_) forms and, for REST owners,
    `inherit`; the SOAP `auth-inspector.tsx` and the REST `auth-tab.tsx` both use it; `oauth2-status` panel with
    `oauth2-get-token` / `oauth2-clear-token` calling the channels, the token shown only under the show-secrets
    switch; `rest.getToken` command; the API tab and folder (via the explorer's _Auth…_ item opening the API tab
    scrolled, or an inline dialog for folders — dialog) use the same form. `oauth2.spec.ts`: client credentials against
    the stub server from the API tab → status _valid_ with expiry → a request inheriting it sends and `/auth/bearer`
    accepts → redaction on in Raw, off with show-secrets → _Clear_ → next send obtains again; authorization code is
    covered in main tests (T10) and here only by asserting the redirect URI display and the pending state.
    `secrets.spec.ts` extended: a project with every auth type on an API, a folder and a request is saved and the
    folder grepped for the token, key, secret and refresh values; `auth.spec.ts` gains a SOAP endpoint with Bearer
    against the SOAP test server.
  - Acceptance: component tests per form and for the effective-source label chain; both e2e specs green on three
    OSes.
  - Verify: `pnpm vitest run --project desktop -- auth-fields auth-inspector auth-tab oauth2-status`; `pnpm build && pnpm test:e2e -- --grep "oauth2|secrets|auth"`
  - Files: apps/desktop/src/renderer/components/{auth-fields,secret-field}.tsx, apps/desktop/src/renderer/features/request-editor/inspectors/auth-inspector.tsx, apps/desktop/src/renderer/features/rest-editor/{auth-tab,oauth2-status}.tsx, apps/desktop/src/renderer/features/rest-api/{api-tab,folder-auth-dialog}.tsx, apps/desktop/src/renderer/commands/register-request-commands.ts, apps/desktop/test/renderer/{auth-fields,auth-inspector,auth-tab,oauth2-status}.test.tsx, e2e/specs/{oauth2,secrets,auth}.spec.ts

**Checkpoint W5:** §14 SC3 holds; full e2e green.

### W6 — Round-out

- [ ] **23. cURL both ways**
  - `http/curl.ts` generalised to `toCurl(input: HttpSendInput, options)` (method, URL, headers, body as raw
    heredoc, `--data-urlencode` per form field, `-F` per multipart part with `@file` for files, `--data-binary @file`
    for binary, `-u`/`-H Authorization` per auth with redaction when asked, `-k` for `trustInvalid`, `-L` when
    following) with the SOAP exporter delegating; `rest/curl.ts` `fromCurl(text): Partial<RestRequestDef> + problems`
    (§3.7 flag mapping, URL split against a given base, `-u` password offered as a secret); main `request.curl`
    dispatches on kind, `request.importCurl` honours `target.kind: 'rest'` (creates the request through
    `add-rest-request` + `update-rest-request` and returns the id, prompting for the `-u` password through the existing
    secrets flow); renderer: `import-curl-dialog.tsx` gains the REST target when opened from an API/folder row or the
    REST editor, `rest.copyAsCurl`/`rest.importCurl` handlers, `code-panel.tsx` placeholder removed.
  - Acceptance: golden cURL per body kind and shell, redacted and not; `fromCurl` round-trips the goldens and parses a
    corpus of real-world commands (crafted fixtures); ipc tests for both targets; component tests for the dialog
    target; `curl.spec.ts`: paste → request fields; copy from the slide-over → golden text.
  - Verify: `pnpm vitest run packages/engine/test/unit/http/curl packages/engine/test/unit/rest/curl apps/desktop/test/ipc-request-actions`; `pnpm build && pnpm test:e2e -- --grep "curl"`
  - Files: packages/engine/src/http/curl.ts, packages/engine/src/rest/curl.ts, packages/engine/src/soap/\*\* (delegation only), apps/desktop/src/main/ipc/request.ts, apps/desktop/src/renderer/features/request-editor/import-curl-dialog.tsx, apps/desktop/src/renderer/features/rest-editor/rest-actions.ts, apps/desktop/src/renderer/shell/code-panel.tsx, packages/engine/test/unit/{http/curl,rest/curl}.test.ts, apps/desktop/test/ipc-request-actions.test.ts, e2e/specs/curl.spec.ts

- [ ] **24. Query view over JSON**
  - `xpath/evaluate.ts` accepts a JSON document (`parse-json()` of the response text as the context item; the
    existing worker path); `rest-response-query` tab reusing `query-view.tsx` with the language switch _XPath 3.1_ /
    _XQuery 3.1_ / _JSONPath_ (the last only when `jsonpath-plus` is approved: `rest/jsonpath.ts` wrapping it with a
    result shape identical to the XPath one; `THIRD-PARTY-LICENSES.md` regenerated); results as a JSON tree with
    _Copy path_.
  - Acceptance: engine tests for XPath over JSON (map/array lookups, `?` operators, a filter); JSONPath cases from
    RFC 9535's examples when included; component tests for the switch and results; `rest.spec.ts` gains one query
    step.
  - Verify: `pnpm vitest run packages/engine/test/unit/xpath packages/engine/test/unit/rest/jsonpath`; `pnpm licenses:third-party --check`; `pnpm build && pnpm test:e2e -- --grep "rest"`
  - Files: packages/engine/src/xpath/{evaluate,evaluate-async}.ts, packages/engine/src/rest/jsonpath.ts, packages/engine/package.json, THIRD-PARTY-LICENSES.md, apps/desktop/src/renderer/features/request-editor/views/query-view.tsx, apps/desktop/src/renderer/features/rest-editor/response/response-pane.tsx, packages/engine/test/unit/{xpath/json,rest/jsonpath}.test.ts, apps/desktop/test/renderer/query-view.test.tsx, e2e/specs/rest.spec.ts

- [ ] **25. Performance budgets**
  - `test/bench/budgets.ts` + `scenarios.ts`: `openapi-import-1mb` (a generated 300-operation document under
    `fixtures/openapi/crafted/large.json`, < 1 s), `openapi-samples` (< 200 ms for the fixture set),
    `rest-pretty-5mb` (< 500 ms), `rest-send-overhead` (< 20 ms, engine only, against the in-process server);
    `test/perf/budgets.test.ts` gates them with the same median-of-samples rule and `WIREBENCH_SKIP_PERF`;
    `e2e/specs/perf.spec.ts` scrolls a 5 MB Raw response at ≥ 50 fps.
  - Acceptance: budgets hold on CI's three OSes with the existing headroom rule; `pnpm bench` reports the new
    scenarios.
  - Verify: `pnpm test:perf`; `pnpm bench`; `pnpm build && pnpm test:e2e -- --grep perf`
  - Files: packages/engine/test/bench/{budgets,scenarios}.ts, packages/engine/test/bench/rest.bench.ts, packages/engine/test/perf/budgets.test.ts, e2e/specs/perf.spec.ts, fixtures/openapi/crafted/large.json, scripts/fixtures-refresh.ts

- [ ] **26. Docs, ADRs, changelog, screenshots**
  - README (REST in the intro and quick start step 6 "or import an OpenAPI document", shortcuts table `Mod+Shift+I`,
    the Documentation list pointing at this plan, roadmap section updated), `docs/architecture/overview.md` (the
    `rest/` module in the engine box and "Where things live", the send-by-kind paragraph, the loopback listener),
    `docs/security.md` (already extended in T10; cross-check), `docs/adr/0003-project-folder-format.md` update
    paragraph for version 3 and `apis/`, new `docs/adr/0007-apis-beside-interfaces.md` (the container decision, the
    `kind` union with `grpc` reserved, the history union — §8), `docs/success-criteria.md` rows SC-R1…SC-R8 citing
    real test paths (checked by `pnpm check:doc-paths`), `docs/roadmap.md` (REST item moved to shipped-on-`main`;
    follow-ups listed: cookie jar, HTML preview, OpenAPI 2.0, Update Definition, response validation; gRPC entry pointing
    at §8), `CHANGELOG.md` Unreleased _Added_ / _Changed_ (project format version 3 — a 1.1.0 build cannot open a
    project this version has saved) / dependencies, the spec's status line set to _implemented_. Regenerate
    `docs/images` (`screenshots.spec.ts` gains a REST request and response shot) and the a11y baselines in a dedicated
    commit after the full suite is green.
  - Acceptance: `pnpm check` green (doc paths, banned terms, licences, contrast); every §14 criterion has evidence in
    the success-criteria table; the plan's boxes all ticked.
  - Verify: `pnpm check`; `pnpm build && pnpm test:e2e`; `pnpm build && WIREBENCH_SCREENSHOTS=1 pnpm test:e2e -- screenshots.spec.ts`
  - Files: README.md, CHANGELOG.md, docs/architecture/overview.md, docs/security.md, docs/adr/{0003-project-folder-format,0007-apis-beside-interfaces}.md, docs/success-criteria.md, docs/roadmap.md, docs/specs/2026-09-13-wirebench-rest-client-design.md, docs/images/\*\*, e2e/specs/screenshots.spec.ts, e2e/specs/\_\_screenshots\_\_/\*\*

**Checkpoint W6 (done):** all eight §14 criteria met with evidence; `pnpm check` and the full e2e suite green on
macOS, Windows and Linux; the SOAP suites unedited except for the renames T1 forced.

## Sizes

| Wave | Tasks | Size            |
| ---- | ----- | --------------- |
| W0   | 1–2   | S               |
| W1   | 3–7   | M               |
| W2   | 8–10  | M               |
| W3   | 11–17 | L               |
| W4   | 18–21 | M               |
| W5   | 22    | S               |
| W6   | 23–26 | M               |

Roughly two L-sized phases back to back, in line with the roadmap's "L" for the minimum viable client plus its
OpenAPI and OAuth2 follow-ons folded in. W0–W2 and W3 can be reviewed as separate pull requests; W4 and later each
as one.
