# Wirebench: one send path for the desktop, the CLI and MCP — design

Date: 2026-10-01 · Status: approved; refined at planning (§13) · Issue #184 (phase 2 of the epic).
Phase 1 (the protocol registry, PR #185) is merged (1d7be1e6).

- Builds on:
  - The phase 1 spec (`docs/specs/2026-09-30-wirebench-protocol-modules-design.md`): the
    `ProtocolModule` interface, its run facet, the registry and the feature set.
  - ADR-0002 (the engine runs in main), ADR-0016 (a script runs with no capabilities).
  - The engine's run module (`packages/engine/src/run/`) and the desktop's send code
    (`apps/desktop/src/main/ipc/request.ts`, `send-with-history.ts`, `rest-send.ts`, `grpc-send.ts`,
    `ws-send.ts`, `engine-service.ts`, `sequence-runner.ts`, `multi-env-send.ts`, `webhook-send.ts`).
- Decisions recorded here (owner, 2026-10-01):
  - **Everything goes through the engine, streaming included.** SSE, gRPC streams and WebSocket
    sessions are sent by the engine; the desktop keeps no send loop of its own.
  - **The engine becomes the superset, and the desktop's order wins.** Every capability the desktop
    has and the engine lacks is added to the engine behind a host seam. Where the two behave
    differently, the desktop's behaviour is kept and the CLI/MCP change is listed in the changelog.
  - **A host object and an exchange handle** (approach A): one entry `openExchange(item, host,
    options)` returning a handle; the host's capabilities are an explicit `SendHost` interface.
  - **Streams run in runs.** A run sends a streaming request's saved messages, closes its side, and
    collects everything until the stream ends or the timeout. WebSocket and streaming gRPC become
    runnable from the CLI, MCP and sequences.
  - **One pull request, sliced per protocol** (§10).

## 1. Goal

A request is sent the same way whoever sends it. The CLI, the MCP server, a sequence and a click on
Send in the desktop all go through the engine's `openExchange`; the desktop keeps only what is about
its own window: History, the HTTP Log, redacted summaries over IPC, live events and the editor draft.

Today there are two send paths. The CLI and MCP call `runRequests`, which calls each module's
`run.send`. The desktop has its own path in `ipc/request.ts` (2,020 lines), `send-with-history.ts`
and the `EngineService` send methods, and parity is kept by imitation. The desktop path can do a lot
the engine cannot (§2), and the two differ in the order they prepare a request.

### 1.1 In scope

- `SendHost`, `openExchange`, `ExchangeHandle` and `resolveExchange` in core (§3).
- The run facet's `send` replaced by `open`; SOAP, REST, gRPC and WebSocket implement it (§4).
- `runRequests` rebuilt on `openExchange`; streaming requests become runnable (§5).
- The desktop's `SendHost` adapters and one send function for every kind and every caller (§6).
- The old desktop send path deleted (§6.4).

### 1.2 Not in scope

- Splitting desktop mutations, IPC channels and wire types per kind (phase 3).
- Any renderer change. The IPC channels keep their names and payloads.
- The feature switches' user-facing side (phase 4).
- A change to the project folder format.

## 2. What the desktop does that the engine does not

Measured on `feat/protocol-registry`, 2026-10-01. Each row becomes a host seam (§3.1) or engine code.

| Gap | Desktop today | Engine today | After |
|---|---|---|---|
| Preferences | user prefs to `toRestSendInput` / `toGrpcSendInput` | defaults | `host.preferences` |
| TLS | request keystore, global client keystore, CA bundle, test anchors | request keystore only | `host.tls` |
| OAuth2 | client credentials, authorization code (browser), cache, refresh | client credentials, drops a refused token | `host.tokens`; the engine keeps dropping a refused token |
| Proxy | async: prefs, keychain password, system proxy, also WebSocket | sync, env | `host.proxyFor`, async |
| Cookies | per-request jar | none | `host.cookies` |
| Webhook callback URL | newest History exchange | target only | `host.callbackUrlFor` |
| gRPC schema | definition cache or reflection | cache only | `host.protoSetFor` |
| Contract check | OpenAPI response contract | none | `host.contractFor` |
| SSE | live events, Stop | whole body | `ExchangeHandle.events` |
| gRPC streams | server, client, bidi, interactive | unary only | `open` + `push` / `halfClose` |
| WebSocket | sessions, per-message send | cannot run | `open` + `push` / `close` |
| Cancel | per send | per run | per handle |
| Pre-script order | before TLS, proxy, OAuth | after everything | desktop order (§3.4) |
| Unresolved codes | `rest-` / `grpc-` / `ws-unresolved-properties`, `grpc-method-unset` | `unresolved-properties` | desktop codes (§8) |
| SOAP input | the renderer's envelope and endpoint, properties folded in | built from the saved request | the desktop applies its draft to the item (§6.2) |

Assertions differ too: the engine evaluates them on every sent item; a desktop single send evaluates
none. That stays as it is, because assertions live in `runRequests`, not in `openExchange` (§5).

## 3. Core interfaces (`packages/engine/src/run/`)

### 3.1 `SendHost`

What a host lends the engine for one send. Only the secret getter is required; every other member
has a default that is today's CLI behaviour.

```ts
export interface SendHost {
  readonly getSecret: GetSecret;
  readonly onSecretValue?: (value: string) => void;
  readonly proxyFor?: (url: string) => Promise<ProxyOptions | undefined>;
  readonly tls?: { readonly anchors?: readonly string[]; defaultIdentity?(): Promise<ClientIdentity | undefined> };
  readonly tokens?: RunTokenSource;
  readonly cookies?: {
    headerFor(url: string): string | undefined;
    remember(url: string, setCookie: readonly string[]): void;
  };
  readonly preferences?: Preferences;
  readonly protoSetFor?: (item: GrpcSelected) => Promise<ProtoSet>;
  readonly contractFor?: (item: RestSelected) => Promise<RestContract | undefined>;
  readonly callbackUrlFor?: (item: RestSelected) => Promise<string | undefined>;
  readonly events?: {
    onPrepareFailed?(item: SelectedRequest, failure: SendFailure): void;
    onExchange?(item: SelectedRequest, exchange: Exchange): void;
  };
}
```

- `RunContext` keeps run-level fields (project, environment, overrides, timeout, registry,
  scripting, sequence) and gains `host: SendHost`. Its own `getSecret`, `proxyFor`, `onSecretValue`,
  `fetchToken` and `tokenSource` move into the host. `scopesFor` is unchanged.
- The engine never opens a browser. The authorization-code grant is the host's token source; a host
  without one refuses it with `auth-grant-unsupported`, as the engine does today.
- Exact type names follow the code at planning time; the shape above is binding.

### 3.2 `openExchange` and `ExchangeHandle`

```ts
export function openExchange(item: SelectedRequest, host: SendHost, options: ExchangeOptions): ExchangeHandle;

export interface ExchangeHandle {
  readonly events: AsyncIterable<LiveEvent>;
  push(message: string): Promise<void>;
  halfClose(): void;
  close(code?: number, reason?: string): void;
  cancel(): void;
  readonly result: Promise<SentRequest>;
}
```

- `ExchangeOptions` carries the `RunScope` (context and memo), the optional `ScriptedSend`, and
  `interactive: boolean`. Interactive means the host drives `push` / `halfClose` / `close`; not
  interactive means the engine sends the saved messages itself (§5.2).
- Each handle has its own `AbortController`, linked to the run's `signal`. `cancel()` aborts this
  send only.
- `LiveEvent` is a union with one member per protocol event the desktop forwards today
  (`rest.live`, `grpc.live`, `ws.live`), moved into core from `wire-types.ts`.
- `push` on a kind or method that takes no messages rejects with `exchange-not-streaming`.
- `result` rejects with the send's `WirebenchError`; `events` then ends.

### 3.3 `resolveExchange`

`resolveExchange(item, host, scope)` runs the resolve step (§3.4, step 1) and returns the resolved
input without connecting. The desktop's preflight badges and its cURL and command export use it, so
what they show is what a send would send.

### 3.4 Prepare order

The same for every protocol, and the desktop's order:

1. **Resolve.** The draft is already on the item. Base URL or target, the auth chain, preferences,
   cookies, expansion, `${secret:}` (or placeholders when scripts run). An unresolved reference
   refuses here.
2. **Pre-request script**, with the phase 1 rules and the re-check after a view's write-back.
3. **Connect.** TLS, proxy, OAuth2 token, signing.
4. **Send.**

A failure in 1–3 calls `host.events.onPrepareFailed` and rejects `result`.

## 4. The run facet

`ProtocolRun.send(selected, scope, scripts?)` is replaced by:

```ts
open(selected: S, scope: RunScope, host: SendHost, options: OpenOptions): ExchangeHandle;
resolve(selected: S, scope: RunScope, host: SendHost): Promise<ResolvedInput>;
```

`defineProtocol` keeps its kind check on both. `groups`, `whyNotRunnable`, `scriptTypes` and
`secretNeeds` stay.

- **REST** (`rest/run.ts`). `resolve` takes preferences and cookies; `open` streams SSE into
  `events` when the response is `text/event-stream`, stores cookies through `host.cookies.remember`,
  checks the contract when the host has one, and keeps webhook signing. A webhook item's callback URL
  comes from `host.callbackUrlFor`, else the target.
- **SOAP** (`soap/run.ts`). Unchanged steps in the new order. The item may carry an envelope and
  endpoint override (§6.2).
- **gRPC** (`grpc/run.ts`). Proto set from `host.protoSetFor`, else the cache. Server streams yield
  each message; client and bidi streams take `push` / `halfClose`. A proxy is still not applied.
- **WebSocket** (`ws/module.ts`, `ws/session.ts`). The stub becomes real. `open` dials with TLS,
  proxy and OAuth2 from the host; the handshake is reported through `host.events.onExchange`; `push`
  expands and resolves each message, one at a time in order; `close` ends the session and settles
  `result` with the transcript.

## 5. Runs

### 5.1 `runRequests`

`createRunSender` calls `openExchange(item, context.host, { scope, scripts, interactive: false })`
and awaits `result`. `runOne` keeps assertions, callback waits, the SLA, script tests and the
failed-exchange cap. `RunOptions.onSent` stays the History hook.

### 5.2 Streaming requests in a run

- A gRPC client or bidi stream sends the saved `message` array in order, then half-closes.
- A WebSocket request sends its saved `messages` in order, then closes after the last reply or the
  timeout.
- An SSE response is read until the stream ends or the timeout.
- Everything received is the assertion subject: the messages in order, with the final status.
- `STREAMING_STEP_REASON` and the WebSocket "cannot run" reason are removed. The run timeout bounds
  every stream; a stream cut by the timeout fails with the HTTP layer's `timeout` code, not a pass.

## 6. The desktop

### 6.1 `apps/desktop/src/main/send/host.ts`

`desktopSendHost(...)` builds a `SendHost` from services that exist today: keychain and team
secrets, the prefs proxy with its keychain password and the system proxy, the CA bundle and the
global client keystore (and the test anchors), `OAuth2Service`, the cookie jar (only when the
request's `sendCookies` is on), preferences, gRPC reflection, the OpenAPI contract and the History
callback-URL lookup. `events.onPrepareFailed` and `events.onExchange` write HTTP Log rows (the
`stage: 'prepare'` row and the WebSocket handshake row as today).

### 6.2 `apps/desktop/src/main/send/exchange.ts`

`sendThroughEngine(sendId, item, options)`, shared by every kind and every caller:

1. Applies the editor draft to the item (`withDraft`, `withGrpcPatch`, `withWsPatch`; for SOAP the
   renderer's envelope, endpoint and header overrides).
2. Calls `openExchange` with the desktop host, `interactive: true` for gRPC streams and WebSocket.
3. Keeps the handle by `sendId`. `request.cancel`, `grpcPush`, `grpcHalfClose`, `wsSend` and
   `wsClose` act on it; `abortRestStreamsWhere`, `closeWsWhere` and `closeAllWs` loop over the kept
   handles.
4. Forwards `events` to the renderer as `rest.live`, `grpc.live`, `ws.live`.
5. When `result` settles: records History (`recordRest`, `recordGrpc`, `recordWs`, `record`),
   puts the exchange in the cache, builds the redacted IPC summary (`showSecrets`), writes the SOAP
   dump file, hands script values to the session (`finishScripts`), and on failure calls
   `onSendFailed`.

Session values (`${#Sequence#}`) are passed in through `RunContext.sequence`, as the engine already
supports.

### 6.3 Callers

The IPC handlers in `ipc/request.ts`, the resends in `ipc/history.ts` and `ipc/log.ts`,
`multi-env-send.ts`, `webhook-send.ts` and `sequence-runner.ts` all call `sendThroughEngine`.
`sequence-runner.ts` stops passing its own sender to `runSequence`.

### 6.4 Deleted

- `send-with-history.ts`.
- `EngineService.send`, `sendRestRequest`, `sendGrpcRequest`, `openWsSession` and their stream maps.
  `EngineService` keeps the exchange cache and `observe`.
- The resolution in `rest-send.ts`, `grpc-send.ts` and `ws-send.ts`; whatever is left (draft
  application) moves into `send/`.
- `ipc/request.ts` keeps only IPC wiring.

## 7. Security

- The phase 1 script rules, including the re-check after a view's write-back, apply unchanged.
  Moving the pre-script before Connect does not let it see a token: auth is applied in step 3, after
  the script, as on the desktop today.
- Secrets reach a script only as placeholders, as today, on both hosts.
- Redaction stays in the host: the CLI's `redact.ts` and the desktop's `showSecrets` summaries.
  `onSecretValue` is told every token and script secret, as today.
- A project file can enable nothing: `SendHost` is built by the host from its own settings.

## 8. Errors

- New: `exchange-not-streaming` (a push on something that takes no messages).
- The engine raises the desktop's codes: `rest-unresolved-properties`, `grpc-unresolved-properties`,
  `ws-unresolved-properties`, `grpc-method-unset`. SOAP keeps `unresolved-properties`. No aliases
  (the engine is already at v3.0.0 on this line).
- Removed with the reasons they named: `STREAMING_STEP_REASON` and the WebSocket "cannot run" text.
- The desktop refuses a SOAP send with unresolved references too (`unresolved-properties`), where it used to
  send the envelope half-expanded and list the references on the result (owner, 2026-10-01).

## 9. Testing

- **Engine.** `openExchange` per protocol against the existing local test servers: live events,
  `push` / `halfClose` / `close`, per-handle `cancel`, the prepare order (a pre-script sees no token),
  `resolveExchange` equal to what is sent, cookies, preferences, TLS anchors, async proxy, streams in
  a run with the timeout.
- **Parity.** One request through a CLI-shaped host and a desktop-shaped fake host sends the same
  bytes.
- **Desktop.** The existing send tests are retargeted at `send/`, assertions kept or strengthened:
  `rest-send`, `rest-send-path`, `grpc-send-path`, `ws-send-path`, `send-with-history`,
  `script-send`, `secret-token-send`, `ipc-secret-token-send`, `soap-owner-auth-send`,
  `ipc-log-resend`, `ipc-history-resend-rest`, `ipc-rest-history-redaction`,
  `ipc-rest-history-auth-echo`, `ipc-rest-sse`, `engine-grpc-stream`, `engine-ws-session`,
  `ws-history`, `multi-env-send`, `sequence-runner`, `webhook-send`, `ipc-request-*`. A test whose
  subject is deleted moves to the new seam; none is dropped.
- **CLI.** `run` and the MCP `send` op on a WebSocket and a streaming gRPC request.
- Gates: `WIREBENCH_SKIP_PERF=1 pnpm check` per task, `pnpm test:perf` before a push, e2e in CI.

## 10. Slices

1. Core: `SendHost`, `openExchange`, `ExchangeHandle`, `resolveExchange`, the facet's `open` /
   `resolve`; the four modules adapted for unary with today's behaviour; `runRequests` and the CLI
   on them.
2. REST: preferences, cookies, TLS anchors, async proxy, token source, SSE, contract, webhooks; the
   desktop's REST sends on `sendThroughEngine`.
3. SOAP on `sendThroughEngine`.
4. gRPC: reflection, server, client and bidi streams, interactive push; desktop on it.
5. WebSocket: the real run facet, sessions; desktop on it.
6. Callers: sequences, multi-env, History and Log resends, webhooks; streams in runs; CLI tests.
7. Delete the old desktop path; docs and changelog.

Each slice keeps `pnpm check` green.

## 11. Documentation

- `docs/architecture/overview.md`: one send path, the host seam.
- The CLI reference: WebSocket and streaming gRPC runnable; SSE collected; the changed error codes.
- `CHANGELOG.md`: the CLI/MCP changes under the 3.0.0 entry (pre-script order, preferences honoured,
  streams runnable, error codes).

## 12. Risks

1. **History and HTTP Log rows drift.** Rows must stay byte for byte; the redaction and History tests
   guard them, and slice 2 compares a REST row before and after.
2. **A reordered prepare leaks a secret to a script.** Covered by the phase 1 rules and new tests on
   the order (§9).
3. **Size.** One PR over seven slices; each slice is green on its own.
4. **Streams in runs hang.** Every stream is bounded by the run timeout and a closed handle.

## 13. Refinements at planning

Reading the code during planning changed the type details below. The owner accepted them on 2026-10-01, and
they replace the matching lines in §3 and §4. The plan is
`docs/plans/2026-10-01-wirebench-one-send-path-plan.md`.

1. `SendHost.cookies` is keyed by request: `cookiesFor(item)` and `remember(item, cookies)`. The engine sends
   them only when the request's `sendCookies` is on.
2. `SendHost.tls` is `{ anchors?, identityFor?(keystoreId) }`. `identityFor` answers for the request's
   keystore, or for the host's default identity when there is none.
3. `SendHost.contractFor(item, exchange)` returns the check result. The engine attaches it to the REST
   exchange. An optional third argument, `sent`, is the protocol's input as it went out: the desktop looks
   the operation up by the request's own path and method from it, as it always has, not by the joined URL.
4. `events.onPrepareFailed` is `events.onFailed(item, failure)`, where `failure.stage` is `'prepare'` or
   `'send'` and `failure.attempted` holds the URL, method and headers. `failure.input` is the protocol's
   input at the stage that failed, from which the desktop writes a failed send's History row. It holds live
   credentials (auth, a signing secret, a proxy password, TLS keys): a host never logs or serialises it.
5. `ExchangeHandle.push(message)` resolves with what was sent: a gRPC message's canonical JSON, or a WebSocket
   frame. `cancel()` returns `boolean`.
6. `ExchangeOptions.live`, `false` by default: events are buffered only for a caller that reads them.
7. `LiveEvent` is a union in `protocols.ts`. Each module declares its own events.
8. The engine's default token source refuses the OAuth2 authorization-code grant. A host whose `tokens` can
   do it, as the desktop's can, is not refused.
9. Ad-hoc SOAP sends (no saved request) go through the engine as a synthetic item (owner, 2026-10-01).
10. `ExchangeOptions.run`, `false` by default, marks a run's send. Only a run waits for a stream's answer
    within the run timeout and fails a stream that timeout cuts with `timeout` (§5.2). A host's own send that is
    not interactive is not a run, and keeps what it received.
11. A WebSocket run row stays unasserted until WebSocket requests can carry assertions. That needs a
    project-format change, outside phase 2.
