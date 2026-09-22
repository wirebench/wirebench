# Spec: AsyncAPI import

- Status: **approved** 2026-09-22 (the owner asked to proceed without check-ins)
- Date: 2026-09-22
- Issue: #100 (P2, size M).
- Builds on: the WebSocket request kind (`docs/specs/2026-09-19-websocket-request-kind-design.md`, which left
  `WsApi.definition` and the `onFrame` seam for this), the OpenAPI importer and its definition cache
  (`packages/engine/src/rest/openapi/{import,refs,sample,cache}.ts`), gRPC's reconcile
  (`packages/engine/src/grpc/reconcile.ts`), WSDL Update Definition (`packages/engine/src/wsdl/update-definition.ts`),
  ADR-0003, ADR-0005, ADR-0007.

## Assumptions and decisions

Grounded in the code on 2026-09-22; each is decided here, none waits on the owner.

1. **No container change, no format bump.** `WsApi.definition` (`{ kind: 'asyncapi', source, cache }`) already
   exists in `ws/model.ts` and in `wsApiFileSchema` (`project/schema.ts`), reserved for this issue. The cached
   document lives in `apis/<slug>/definition/`, the directory `apiDefinitionDir` already names for REST and gRPC.
   `formatVersion` stays **4**, the version the project format already writes; ADR-0007 gets a short update
   note, not a new decision.
2. **The closest model is the OpenAPI cache, not gRPC's.** An AsyncAPI document is JSON or YAML with `$ref`s to
   sibling files, exactly what `resolveRefs` and `writeApiDefinitionCache` already handle byte-exact with a
   SHA-256 manifest. The only change there: `writeApiDefinitionCache` gains a `rootFile` option (default
   `openapi.yaml`, AsyncAPI passes `asyncapi.yaml`) — the name the root is cached under only when its location
   gives no file name; a root read from `chat.yaml` is cached as `chat.yaml`. The manifest's `declaredVersion` records the `asyncapi`
   string. The manifest schema (`apiDefinitionCacheManifestSchema`) is unchanged.
3. **Two new optional fields, both safe for older builds.** `WsRequestDef.contract?: { channel }` plus
   `orphaned?: boolean`, and `WsSavedMessage.contract?: { message, generated }`. Every project schema is a
   `looseObject`, so a build that predates them **loads** the file and **ignores** the keys; if it then saves that
   request, the keys are dropped — the request, its URL and saved messages are intact, only the link to the
   contract is lost (the next Update Definition treats it as a hand-made request and adds a fresh one). That is
   loss of metadata, not corruption, so it does not justify a `formatVersion` bump — the rule gRPC's `orphaned`
   followed.
4. **One API per document.** A document describes one application; its servers are alternative addresses, not
   separate APIs. The API's `url` is the chosen WebSocket server (the dialog offers a picker when there are
   several `ws`/`wss` servers; default the first). Every server is listed on the definition card.
5. **Wirebench is the peer of the described application**, so directions invert the document's words:

   | Version | Document says | Wirebench frame direction |
   | --- | --- | --- |
   | 2.x | `publish` (others send to the app) | **sent** (outgoing) |
   | 2.x | `subscribe` (the app sends to others) | **received** (incoming) |
   | 3.0 | `action: receive` | **sent** |
   | 3.0 | `action: send` | **received** |
   | 3.0 | `reply` of either | the opposite of its operation |

6. **Which channels become requests.** A channel is a WebSocket channel when it carries a `bindings.ws` object,
   or when one of the servers it is available on (2.x `channel.servers`, 3.0 `channel.servers` refs; absent
   means all) has protocol `ws` or `wss`. One request per WebSocket channel, in a folder per first tag
   (untagged at the root). A channel whose only bindings are `kafka`, `mqtt`, `amqp` (or any other non-`ws`
   key), or whose servers are all non-WebSocket, is **skipped and reported** with the protocol named.
7. **URL mapping.** Server `url`/`host`+`pathname` (3.0) or `url` (2.x) with server variables replaced by their
   `default` (else first `enum`, else left as `${name}` and reported); channel address (3.0 `address`, 2.x the
   channel key; a `null` 3.0 address → the server URL alone) becomes the request path. Channel parameters
   `{p}` take the parameter's `default`, else first `enum`, else first `examples`, else become `${p}` and are
   listed in the summary so the user knows to define the property.
8. **`bindings.ws`.** `query` and `headers` are JSON Schemas of objects: each property becomes a query or header
   entry whose value is the sample of its schema. A header property `Sec-WebSocket-Protocol` with a `const` or
   `enum` fills `subprotocols` (the binding has no subprotocol field of its own; this is the only place a
   document can say one) and is removed from headers. `method` other than `GET` is reported and ignored.
9. **Security → existing auth kinds**, set as the API's default auth (first scheme the WebSocket server lists):
   `userPassword`, `http`/`basic` → `basic`; `http`/`bearer` → `bearer`; `httpApiKey` (header or query) →
   `api-key` with the named key and location; `oauth2`/`openIdConnect` → `oauth2` with the token URL and scopes
   of the first flow and empty client credentials. `apiKey` (in user/password), `X509` (note: use a client
   certificate in settings), `symmetricEncryption`, `asymmetricEncryption`, `plain`, `scramSha*`, `gssapi` →
   reported, auth left `inherit`. Secrets are never filled.
10. **Samples reuse `sampleFromSchema`** (`rest/openapi/sample.ts`) unchanged, with `includeOptional: false`,
    `sampleValues: true`. A message's own `examples[0].payload` wins over a generated sample. Samples are made
    for **outgoing** messages only (what the user sends); saved as `WsSavedMessage` named after the message
    (`name` → `title` → key), `format: text`, JSON pretty-printed with two spaces, or the raw string when the
    payload schema is `type: string`. Messages whose `schemaFormat` is not JSON Schema (Avro, RAML, Protobuf)
    get no sample and no validation — reported.
11. **There is no JSON Schema validator in the engine.** `validate/schema-validator.ts` is XSD over
    `xmllint-wasm`; `rest/openapi` only generates. No new dependency is allowed, so one is written in-house:
    `json/schema-validate.ts`, a draft-07-shaped subset — `type` (string or list, `integer`), `nullable`,
    `enum`, `const`, `properties`, `required`, `additionalProperties`, `patternProperties`, `items` (schema or
    tuple list), `minItems`/`maxItems`, `uniqueItems`, `minLength`/`maxLength`, `pattern`,
    `minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum` (boolean and numeric forms), `multipleOf`,
    `minProperties`/`maxProperties`, `allOf`/`anyOf`/`oneOf`/`not`. **Not asserted, by scope:** `format`,
    `if`/`then`/`else`, `dependencies`/`dependentSchemas`, `propertyNames`, `contains`, `unevaluated*`, and an
    unresolved `$ref` (passes). A document that uses any of them gets one summary line naming the keywords.
    Each problem carries a JSON pointer `path`, the `keyword` and a sentence.
12. **Frame validation runs in a worker, per frame, off the main thread**, fed from the `onFrame` hook the
    session already calls (`engine-service.ts`). It is bounded by construction: text frames only (binary, ping,
    pong, close are not validated), frames over **256 KiB** are marked `skipped` before they are queued, the
    validator stops after **10 000** schema nodes and **20** problems, and each message's schema is prepared once
    per session. Each frame's check has a **1000 ms** deadline from the moment it reaches the worker; a check that
    runs past it (or a frame refused because more than 1 000 frames or 8 MiB are waiting) gets the status
    `not-checked`, which says nothing either way about the frame, and a fresh worker takes the next one. A perf
    test pins the cost.
13. **Matching a frame to a message.** Candidates are the channel's messages for that direction. One candidate →
    validate against it. Several → validate against each in document order; the **first with no problems**
    wins. None clean → the frame is a `violation` reported against the candidate with the fewest problems (tie:
    first). A text frame that is not JSON when the candidate's content type is JSON (default) is a `violation`
    with "not JSON". No candidates for that direction → `unmatched` ("the contract declares no incoming
    messages on this channel"). No discriminator guessing: trying each is exact and the caps bound it.
14. **Where it shows.** `WsFrame.contract?` (`ok` | `violation` | `unmatched` | `skipped`, the matched message
    name, problems). The timeline shows a marker only for `violation` and `unmatched` (a warning glyph in the
    row, `aria-label` with the first problem); `ok` shows nothing so a healthy session looks as it does today.
    The frame detail gets a **Contract** section: matched message and each problem with its path. A
    "Contract problems only" toggle joins the direction filter. History keeps each frame's `contract.status` and
    message name (not problems: the transcript cap is about size). The HTTP Log is unchanged (it holds the
    handshake only).
15. **Update Definition** re-fetches the source, re-parses, and shows a **per-operation** report before applying:
    operations added, removed and changed, each change with reasons `address`, `payload`, `bindings`,
    `security`, `messages`. Keyed by operation id (3.0 operation key; 2.x `operationId`, else
    `<channel>#publish|subscribe`). Applying never deletes (the gRPC and WSDL rule): a channel gone → its
    request is `orphaned` and badged; a new channel → a new request; a changed channel's URL, query, headers
    and subprotocols are rewritten **only where they still equal what the old contract generated**; the same
    for saved messages — a message whose content still equals its `contract.generated` sample is replaced by
    the new sample, an edited one is kept and the new sample is added beside it as `<name> (updated)`. New
    outgoing messages are added. The API's auth follows the same rule.
16. **Versions.** 2.0–2.6 and 3.0 are imported. Any other `asyncapi` string (1.x, 3.1+) is refused with
    `asyncapi-version-unsupported` naming the version, rather than half-mapped.
17. **Not mapped, reported:** message `headers` (no WebSocket frame has them), `correlationId`, traits beyond a
    shallow merge of `name`/`title`/`summary`/`contentType`, `externalDocs`, 2.x `x-*` extensions, non-ws
    bindings on a WebSocket channel.
18. **The CLI is out of scope.** The runner already refuses `kind: websocket` by name; nothing changes there.
19. **Copy never names other tools** (`pnpm check:banned-terms`).

---

## 1. Objective

**What.** Import an AsyncAPI document through the one Import… dialog into a WebSocket API: requests per
WebSocket channel with URL, subprotocol and auth filled in, sample messages saved, every frame checked against
the contract on the timeline, and Update Definition with a per-operation report.

**Why.** AsyncAPI is to a WebSocket endpoint what a WSDL is to a SOAP service. The engine has the pieces; many
endpoints have no contract, so this sits on top of the plain kind and never gates it.

**Acceptance criteria** (the issue's, made testable):

- AC1. AsyncAPI 2.x and 3.0 documents (YAML or JSON, URL, file or paste) are detected and imported through the
  Import… dialog, cached under `apis/<slug>/definition/` byte-exact; everything not mapped is in the summary.
- AC2. Each WebSocket channel becomes a request with the server URL, path, query, headers, subprotocol and auth
  from the security scheme filled in.
- AC3. Outgoing messages get a sample from their payload schema (or example), saved with the request.
- AC4. Sent and received text frames are validated against the channel's messages for that direction; a frame
  that breaks the contract has a marker on the timeline and its problems, with paths, in the frame detail.
- AC5. Update Definition on an imported API shows a per-operation change report and applies it without deleting
  requests or overwriting edits.
- AC6. Kafka, MQTT and AMQP (any non-`ws`) channels and bindings are reported as skipped.

## 2. Tech stack

TypeScript, Node 24, `yaml` (already a dependency, via `project/yaml.ts` and `resolveRefs`), `zod`, vitest,
Electron/React. **No new dependency.**

## 3. Commands

```
Gate (commit):  NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
Gate (push):    pnpm test:perf
One file:       pnpm vitest run packages/engine/test/unit/asyncapi/map.test.ts
e2e (CI only):  pnpm build && xvfb-run -a pnpm test:e2e
```

## 4. Data model

```
apis/<slug>/
  api.yaml                       kind: websocket, …, definition: { kind: asyncapi, source, cache: true }
  definition/manifest.yaml       apiDefinitionCacheManifestSchema; declaredVersion: "3.0.0"
  definition/asyncapi.yaml       the root, byte-exact (its own file name when its location has one);
                                 siblings under cache-naming's names
  requests/<slug>.request.yaml   …, contract: { channel: userChat }, orphaned?: true,
                                 messages: [{ id, name, format, file, contract: { message: sendChat, generated: "<sample text>" } }]
```

```ts
// packages/engine/src/ws/model.ts (additions)
export interface WsContractLink { readonly channel: string }             // the channel key/id in the document
export interface WsMessageContractLink {
  readonly message: string;   // message key/id
  readonly generated: string; // the sample text as imported — the "untouched?" test for Update Definition
}
export type WsFrameContractStatus = 'ok' | 'violation' | 'unmatched' | 'skipped';
export interface WsFrameContract {
  readonly status: WsFrameContractStatus;
  readonly message?: string;                    // matched (or closest) message name
  readonly problems?: readonly JsonSchemaProblem[];
  readonly reason?: string;                      // for unmatched / skipped
}
// WsRequestDef += contract?: WsContractLink; orphaned?: boolean
// WsSavedMessage += contract?: WsMessageContractLink
// WsFrame += contract?: WsFrameContract
```

```ts
// packages/engine/src/json/schema-validate.ts
export interface JsonSchemaProblem { readonly path: string; readonly keyword: string; readonly message: string }
export interface ValidateJsonOptions { readonly maxNodes?: number; readonly maxProblems?: number }
export function validateJsonSchema(value: unknown, schema: unknown, options?: ValidateJsonOptions): readonly JsonSchemaProblem[];
export const UNSUPPORTED_JSON_SCHEMA_KEYWORDS: readonly string[];
export function unsupportedKeywordsIn(schema: unknown): readonly string[];
```

```ts
// packages/engine/src/asyncapi/model.ts — the version-neutral view both normalisers produce
export type AsyncApiVersion = '2' | '3';
export interface AsyncApiServer {
  readonly key: string; readonly url: string; readonly protocol: string;
  readonly security: readonly AsyncApiSecurityScheme[]; readonly unresolvedVariables: readonly string[];
}
export interface AsyncApiMessage {
  readonly key: string; readonly name: string; readonly contentType: string;
  readonly schemaFormat?: string; readonly payload?: unknown; readonly example?: unknown;
}
export interface AsyncApiOperation {
  readonly key: string; readonly channel: string;
  readonly direction: 'sent' | 'received';      // Wirebench's side, per decision 5
  readonly messages: readonly AsyncApiMessage[];
}
export interface AsyncApiChannel {
  readonly key: string; readonly address: string | null; readonly servers: readonly string[] | 'all';
  readonly parameters: Readonly<Record<string, { default?: string; enum?: readonly string[]; examples?: readonly string[] }>>;
  readonly bindings: Readonly<Record<string, unknown>>; readonly tags: readonly string[];
}
export interface AsyncApiSkip { readonly where: string; readonly reason: string }
export interface AsyncApiDocument {
  readonly version: AsyncApiVersion; readonly declaredVersion: string; readonly title: string;
  readonly servers: readonly AsyncApiServer[]; readonly channels: readonly AsyncApiChannel[];
  readonly operations: readonly AsyncApiOperation[]; readonly notes: readonly AsyncApiSkip[];
}
```

## 5. Engine

```
packages/engine/src/json/schema-validate.ts     validateJsonSchema, unsupportedKeywordsIn
packages/engine/src/asyncapi/
  model.ts        the types above
  parse.ts        parseAsyncApi(source, { fetchDocument, signal }) → { document, documents, problems }
                  — resolveRefs, then version check, then normalise2 / normalise3
  normalise-2.ts  publish/subscribe inversion, message.oneOf, channel parameters, servers map
  normalise-3.ts  operations.action, channel.messages, operation.messages refs, reply, host+pathname
  security.ts     authFromScheme(scheme) → AuthConfig | AsyncApiSkip
  map.ts          mapAsyncApi(document, { server?, newId? }) → { api: WsApi, summary: AsyncApiImportSummary }
  import.ts       importAsyncApi(source, options) = parse + map; the documents for the cache
  frame-check.ts  createFrameChecker(document, channel) → (frame: WsFrame) => WsFrameContract | undefined
  update.ts       planAsyncApiUpdate(old, next, api) → AsyncApiUpdatePlan; applyAsyncApiUpdate(api, old, next, plan)
  browser.ts      subpath @wirebench/engine/asyncapi (model + types only)
packages/engine/src/import-detect.ts   'asyncapi' kind: parsed `asyncapi` string (definite), `^asyncapi:` regex
                                       (probable), a file name containing `asyncapi` (probable) — all before the
                                       `.yaml` → openapi fallback
packages/engine/src/rest/openapi/cache.ts   writeApiDefinitionCache({ rootFile })
packages/engine/src/project/{schema,load,serialize}.ts   the optional fields
packages/engine/src/ws/transcript.ts         keeps contract.status + message, drops problems
```

- `parseAsyncApi` throws `AsyncApiError` (`asyncapi-malformed`, `asyncapi-version-unsupported`); everything else
  is a note.
- `mapAsyncApi` is pure; `newId` injected for tests. Summary:
  `{ declaredVersion, title, server, servers, requests, messages, skipped: AsyncApiSkip[], unresolved: string[],
  unsupportedKeywords: string[] }`.
- `createFrameChecker` compiles nothing ahead (the validator walks the plain schema) but groups the channel's
  messages by direction once; it returns `undefined` for non-text opcodes.
- `planAsyncApiUpdate` returns
  `{ added: OpRef[], removed: OpRef[], changed: { op: OpRef, reasons: AsyncApiChangeReason[] }[] }` with
  `OpRef = { key, channel, direction }`; channels are compared through what `mapAsyncApi` would generate for
  them, so "changed" means "the generated request would differ".

## 6. IPC and main

- `channels.api.importAsyncApi` `{ source: OpenApiSourceWire-shaped, target, server? }` →
  `{ projectId, project, apiId, summary: AsyncApiImportSummaryWire }`. `project-host.importAsyncApi` writes the
  cache with `writeApiDefinitionCache(documents, apiDefinitionDir(dir, slug), { rootFile: 'asyncapi.yaml',
  declaredVersion })`, then the API.
- `channels.api.asyncApiPlanUpdate` `{ apiId }` → the plan (reads the cached old document, fetches the source
  again); `channels.api.asyncApiApplyUpdate` `{ apiId }` → `{ project, plan, applied }` and rewrites the cache.
- `engine-service.openWsSession`: when the request has `contract` and its API a `definition`, the parsed
  contract (memoised per API, invalidated on update, read from the cache like `readGrpcDefinitionCache` at
  `project-host.ts` §grpc) yields a checker; `onFrame` sets `frame.contract` before `toWsFrameWire`. A contract
  that fails to load leaves validation off and posts one console line — sending never waits on it.
- `wsFrameWireSchema` += optional `contract`. `ws-send.ts` unchanged.

## 7. Renderer

- `import-dialog.tsx`: `asyncapi` in the format override list; a server picker when the summary preview lists
  more than one WebSocket server; an `AsyncApiSummary` block: requests, messages, skipped (with reasons),
  unresolved properties, unsupported keywords.
- `ws-editor/timeline.tsx`: a marker cell for `violation`/`unmatched`; "Contract problems only" toggle.
- `ws-editor/frame-detail.tsx`: **Contract** section.
- `ws-api/ws-api-tab.tsx` + new `ws-api/asyncapi-definition-card.tsx`: version, source, servers, *Update
  definition* → `asyncapi-update-dialog.tsx` with the per-operation report and *Apply*.
- Explorer: an `orphaned` WebSocket request shows the same badge gRPC's does.

## 8. Testing

Fixtures in `packages/engine/test/fixtures/asyncapi/`:

- `chat-2.6.yaml` — servers `public` (`wss`, variable `region` default `eu`) and `broker` (`kafka`); channel
  `/chat/{roomId}` with `bindings.ws` (query `token`, header `Sec-WebSocket-Protocol` const `chat.v1`), `publish`
  of `sendMessage`, `subscribe` of `oneOf` `chatMessage`/`presence`; channel `audit` on `broker` only with a
  `kafka` binding; `httpApiKey` security in query; one Avro message.
- `chat-3.0.yaml` — the same service in 3.0: `host`+`pathname`, `address: /chat/{roomId}`, operations
  `sendChat` (`receive`) and `onChat` (`send`), a `reply`, `http`/`bearer` security, a Kafka channel and an MQTT
  server, `$ref` to `schemas.yaml` (a sibling, to prove the cache keeps two files).
- `unsupported-1.2.yaml` — refused by version.

Unit: `json/schema-validate.test.ts`, `asyncapi/{parse,map,security,frame-check,update}.test.ts`,
`import-detect.test.ts` (added cases), `project/ws-format.test.ts` (round trip of the new fields; byte-identical
without them). Integration: `asyncapi/import.test.ts` (file fixture → cache → reload). Perf:
`test/perf/asyncapi-frame-check.perf.test.ts` (10 000 frames of a 2 KiB message against a 3-way `oneOf` under
the budget). Desktop: `ipc-asyncapi.test.ts`, `engine-ws-contract.test.ts`, renderer timeline/frame-detail/
update dialog tests. e2e (CI): `e2e/specs/asyncapi-import.spec.ts` — import 3.0 fixture, connect to the test
ws server, send the sample, see a clean row, send a broken message, see the marker.

## 9. Boundaries

- Always: never delete on update; bounded validation; `assertPathSegment` on every cache file name.
- Never: a new dependency; a `formatVersion` bump; validation on the UI thread; naming other tools.
- Not built: non-ws bindings, message headers, a mock server from the contract, CLI support, AsyncAPI export or
  generation from traffic, `format` assertion, 3.1+.

## 10. Success criteria

| ID | Criterion |
| --- | --- |
| SC-A1 | AsyncAPI 2.x and 3.0 import through the Import… dialog, cached byte-exact; unmapped items reported (AC1) |
| SC-A2 | A WebSocket channel becomes a request with URL, query, headers, subprotocol and auth (AC2) |
| SC-A3 | Outgoing messages have saved samples from payload schema or example (AC3) |
| SC-A4 | Frames are validated per direction; a violating frame is marked on the timeline with paths in the detail (AC4) |
| SC-A5 | Update Definition reports per operation and applies without deleting or overwriting edits (AC5) |
| SC-A6 | Kafka, MQTT, AMQP channels and bindings are reported as skipped (AC6) |
