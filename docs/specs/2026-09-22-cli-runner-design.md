# Spec: CLI runner slice S7 — gRPC unary calls and headless OAuth2 client credentials

- Status: **Shipped**
- Date: 2026-09-22
- Issue: [#30](https://github.com/wirebench/wirebench/issues/30), the last unticked box
- Builds on: `docs/specs/2026-09-18-cli-runner-design.md` (S1–S6 shipped; this is its §9 slice S7),
  `docs/specs/2026-09-16-wirebench-grpc-client-design.md`, ADR-0004 (secrets outside project files).

## Assumptions

1. **Everything S1–S6 built stays as it is.** `wirebench run`, its flags, exit codes, reporters and
   `…Env` secret names are unchanged; S7 widens what a run can send, nothing else.
2. **Unary only.** A server-, client- or bidirectional-streaming gRPC request is not selected, as a
   WebSocket request is not today: a selector naming one matches nothing and the run is refused
   (exit 2). Streams in a pipeline need their own assertion model and are out of scope.
3. **The schema comes from the project.** A gRPC API's definition is read from its cache under
   `apis/<slug>/definition/` (`.proto` sources or a reflected descriptor set). A run never reflects
   against a server; an API without a cached definition errors each of its requests with
   `grpc-definition-missing`.
4. **OAuth2 runs the client-credentials grant only**, for REST and gRPC alike. The
   authorization-code grant keeps its existing `auth-grant-unsupported` error. No refresh token is
   read or written: a run starts with no token and throws its cache away when it ends.
5. **Engine changes are additive.** New union members and new optional fields; no existing export
   changes shape or meaning for the desktop app, which does not use the run module.

## 1. Objective

A project that holds gRPC APIs, or REST/gRPC requests protected by an OAuth2 client-credentials
configuration, runs in a pipeline exactly as its SOAP and plain REST requests already do.

## 2. Behaviour

### 2.1 gRPC unary requests

- **Selection.** `selectRequests` walks gRPC APIs in the shared ordering space (folders, then
  requests, by `order` then name), skipping orphaned and non-unary requests. Display path
  `<API>/<folder…>/<request>`; on-disk path `apis/<slug>/requests/<folder-slugs…>/<request-slug>`.
- **Preparation** mirrors the desktop's `grpc-send.ts`: the target resolves through the environment's
  `endpoints[<api slug>]` override, falling back to `api.target`; `toGrpcSendInput` builds the
  transport input from the request, the API's `tls` and metadata and the project settings;
  `expandGrpcInput` expands target, metadata and message text in one pass (unresolved refs refuse
  the send with `unresolved-properties`). Auth resolves request → folders inside-out → API.
  TLS: the request's `sslKeystoreRef` identity; verification off under `--insecure` or the request's
  `trustInvalid`. `--timeout` replaces the call deadline.
- **Send** is `callGrpc` with the proto set loaded once per API per run.
- **Result.** `protocol: 'grpc'`; `status` is the gRPC status code (0 = OK); `durationMs` is the
  exchange's. The kept exchange (failed/errored only) is the raw request and response text, capped
  as today.

### 2.2 Assertions on a gRPC call

| Type | Behaviour |
| --- | --- |
| `status` | Compares the gRPC status code. `equals` accepts `0`–`16` or a status name (`OK`, `NOT_FOUND`, …; the names `grpcStatusName` produces). A name on a SOAP/REST request errors; a number keeps its HTTP meaning there. |
| `match` | JSONPath (or XPath over JSON, as today) against the response message as JSON — the single decoded message for a unary call. A message that did not decode makes the body `other`, so `match` errors. |
| `sla` | Unchanged. |
| `soap-fault`, `schema` | Errored, as on a REST request: they apply to SOAP only. |

The schema change is additive: `statusValue` also accepts an integer 0–16 and a gRPC status name.

### 2.3 OAuth2 client credentials

- `prepareSend` for REST and gRPC: an effective auth of `oauth2` with `grant: client-credentials`
  obtains an access token and sends it as `Authorization: Bearer <token>` (the existing
  `resolveAuthConfig(…, { accessToken })` path).
- The token request is built by the engine's `buildTokenRequest` and read by `parseTokenResponse`,
  sent with `sendHttp`, using the run's proxy for the token URL, `--insecure`, and `--timeout`. Token
  URL, client id, scopes and audience are property-expanded with the same scopes as the request.
- The client secret is the configuration's `clientSecretRef`, resolved through the run's
  `getSecret` — so `WIREBENCH_SECRET_<clientSecretEnv>` or the ref-derived name, and
  `wirebench secrets list` already names it. A missing one is `secret-missing` (exit 3).
- **One token per configuration per run**: cached by token URL, client id, scopes and audience, and
  fetched again only when `needsRefresh` says so. A failed fetch is not cached, so the next request
  tries again.
- A token endpoint that answers with an OAuth error errors the request with the engine's
  `oauth2-token-error` / `oauth2-token-malformed` code (exit 3, like any run error).
- **The token is a secret.** `RunContext` gains `onSecretValue?: (value: string) => void`, called with
  every access token obtained; the CLI adds it to the values its masker redacts, so no report,
  stdout or stderr line carries it.

## 3. Interfaces (engine, all additive)

- `SelectedRequest` gains `{ kind: 'grpc'; path; group; api: GrpcApi; chain: readonly GrpcFolder[];
  request: GrpcRequestDef }`.
- `RequestResult['protocol']` and `AssertionSubject['protocol']` gain `'grpc'`.
- `PreparedSend` gains `{ kind: 'grpc'; input: Omit<GrpcSendInput, 'messages'>; messageText: string }`.
- `RunContext` gains `onSecretValue?` and `fetchToken?` (a test seam: the token request sender,
  defaulting to `sendHttp`).
- New `run/oauth2-token.ts`: `createRunTokenSource(options) → { accessTokenFor(config, request) }`.
- `grpcEffectiveAuth(selected)` beside `restEffectiveAuth`; `secretNeedsOf` covers gRPC requests
  (auth chain and keystore).

## 4. CLI

- JSON report's `protocol` documents `'grpc'`; JUnit, HTML and CLI reporters show it like the others.
- The masker includes access tokens reported through `onSecretValue`.
- README: gRPC requests and OAuth2 client credentials in the runner section; CHANGELOG entry.

## 5. Testing

- **Engine unit:** gRPC selection (order, unary-only, orphaned skipped, both path forms);
  status assertion by code and name, name on HTTP errors, schema accepts/rejects; secret needs of a
  gRPC request; token source: fetch, cache hit, refresh on expiry, failure not cached, secret
  missing, token reported through `onSecretValue`.
- **Engine integration:** `runRequests` against `test/helpers/test-grpc-server.ts` — a passing unary
  call, a failing status assertion, a JSONPath match, a missing definition cache; a REST request with
  client credentials against a local token endpoint plus resource server.
- **CLI integration:** the fixture project gains a gRPC API (cached `.proto`) and an OAuth-protected
  REST request; exit 0 when all pass, exit 1 on a failing gRPC assertion, and the leak test greps
  every output for the access token and the client secret.

## 6. Out of scope

Streaming gRPC calls; reflection during a run; the authorization-code grant; refresh tokens;
token caching across runs; a `schema` assertion for gRPC messages.

## 7. Success criteria

1. `wirebench run` on a project with a unary gRPC request exits 0 when its `status`, `match` and `sla`
   assertions pass, 1 when one fails, and names the gRPC status in the report.
2. A REST or gRPC request behind OAuth2 client credentials fetches one token per configuration per
   run, with the client secret supplied through an environment variable.
3. Neither the client secret nor the access token appears in any report, stdout or stderr.
