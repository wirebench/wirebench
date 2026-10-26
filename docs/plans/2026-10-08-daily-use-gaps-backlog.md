# Backlog: daily-use gaps

**Date:** 2026-10-08
**Status:** Filed 2026-10-08 as #333–#349, on the board. #77, #79 and #80 were moved to 5.2, and #323 to 5.0.
**Milestones:** 5.0 Contracts, mocks and testing (finish only) · 5.1 Daily driver · 5.2 Protocols, auth and contracts · 6.0 Team operations · Later
**Scope:** The gaps a developer meets in an ordinary working day of building, sending and testing API requests, plus
the follow-on items, ranked P0–P3. Measured against `main` at `8b3648ac` (4.0.0 plus multi-window #72 and the
project-file schemas #66).

Every task follows the issue body style: metadata line, Why, Done when, Blocked by / Related, References. A task that
extends an existing issue names that issue instead of opening a new one.

Sizes: XS–S take days, M one or two weeks, L–XL longer.

---

## P0 — met every day, or breaks imported collections

### 1. Dynamic variables (#333 · 5.1)

> **P0** · **S** · Developers · `area: environments` `area: importers`

#### Why

Requests often need a fresh ID, timestamp or random value on every send. Today an imported `{{$guid}}`,
`{{$timestamp}}` or `{{$randomInt}}` is kept as text with a warning, so the request sends a literal placeholder.

#### Done when

- [ ] A dynamic scope (for example `${#Dynamic#guid}`, with a short form) resolves to a new value on every send:
      `guid`/`uuid`, `timestamp` (Unix seconds), `isoTimestamp`, `randomInt`, `randomUUID`, `randomBoolean`,
      `randomAlphaNumeric`.
- [ ] Fake-data generators for names, emails, addresses, phone numbers, company, lorem, dates (past/future/recent),
      IP/IPv6/MAC, URL/domain, colour, currency, file name and MIME type.
- [ ] Arguments where they make sense, such as `randomInt(1,100)`, `isoTimestamp(+1d)` or `lorem(words=5)`.
- [ ] The importers map the common `{{$name}}` placeholders onto the new scope. Names with no mapping keep today's
      warning.
- [ ] Each value is resolved once per send, so the same placeholder used twice in one request gives the same value.
      The resolved values appear in the HTTP Log and History.
- [ ] Completion lists the generators, and the CLI and MCP `send` resolve them the same way as the desktop app.

#### Blocked by

None.

#### References

- `packages/engine/src/project/properties.ts`
- `packages/engine/src/rest/postman/variables.ts`

---

### 2. Collection- and folder-level scripts (#334 · 5.1)

> **P0** · **M** · Developers · `area: testing` `area: rest`

#### Why

Teams fetch tokens, sign requests and share checks once for a whole API, not once per request. Scripts can be set
only on a request today, so this logic is copied into every request, and imported collections lose their
collection- and folder-level scripts.

#### Done when

- [ ] An API (or project) and each folder can carry a pre-request and a post-response script, in SOAP, REST and gRPC
      containers.
- [ ] Order: API, then folder (outermost first), then request, for both hooks, matching how auth is inherited.
- [ ] Each level's script is typed from the same contract as request scripts, and `wirebench run` type-checks every
      level.
- [ ] The Script tab shows which levels ran and their output, in order.
- [ ] The importers place collection- and folder-level scripts at the matching level instead of dropping them.
- [ ] Project format documented, and the format version bumped if needed.

#### Blocked by

None.

#### References

- ADR-0016
- `packages/engine/src/project/schema-parts.ts` (`scriptsSchema`)

---

### 3. Run a folder or project from the app, with data files (#336 · 5.1)

> **P0** · **L** · Developers · `area: testing` `area: cli`

#### Why

Running a whole folder against a list of test inputs is a routine daily check. From the app, only a sequence can be
run today. Folders and projects run only from the CLI, and no run can take iteration data.

#### Done when

- [ ] **Run…** on any folder, API or project opens a runner panel with: iterations, delay between requests, run order
      (reorder, exclude), environment, and a data file.
- [ ] CSV and JSON data files: each row is one iteration. Columns resolve as `${#Data#column}` and are readable from
      scripts. When there are more iterations than rows, a setting picks between repeating the last row, wrapping
      round, and stopping.
- [ ] Results per iteration and per request (assertions, errors and failures kept separate), with a run history kept
      outside the project.
- [ ] `wirebench run --data <file> --iterations <n>` produces the same runs and reports.
- [ ] Stop on first failure is an option, matching `--bail`.

#### Blocked by

None. This is the data-driven part of #73; suites and the callback listener stay in #73.

#### References

- #73
- `docs/cli.md`

---

### 4. Code generation in common languages (#337 · 5.1)

> **P0** · **M** · Developers · `area: rest` `area: shell`

#### Why

Developers copy a working request into the application they are building every day. The Code slide-over offers cURL
only, plus grpcurl and websocat.

#### Done when

- [ ] Targets: JavaScript fetch, Node axios, Python requests, Go net/http, Java HttpClient, Java OkHttp,
      C# HttpClient, PHP cURL, Ruby Net::HTTP, PowerShell Invoke-RestMethod, HTTPie, plus a `wirebench run` line for
      the saved request.
- [ ] Secrets go into each snippet as placeholders or environment variable reads, never as resolved values, unless
      Show Secrets is on. This is the same rule as the HTTP Log.
- [ ] Settings per target: indent, follow redirects, timeout.
- [ ] The language picked last is remembered for each user.
- [ ] A snapshot test per target over a fixed set of requests (query, headers, JSON, multipart, binary, auth).

#### Blocked by

None.

#### References

- `apps/desktop/src/renderer/shell/code-panel.tsx`

---

### 5. Finish mock services (#59, #61, #323 · 5.0)

> **P0** · **L** · Developers · `area: mocks`

#### Why

Mocking a dependency while building, and running against mocks in CI, is daily work. The engine half is in review.
The desktop UI, the headless command and response templating are still missing.

#### Done when

- [ ] #329 part 2: the desktop UI for creating, running and editing mocks.
- [ ] #61: `wirebench mock` runs headless in CI, and `wirebench run` can start a mock for the duration of a run.
- [ ] #323: response templates echo values from the request body (by JSONPath/XPath), headers, query and path
      segments, with defaults.
- [ ] A per-request switch that sends to the mock instead of the real endpoint for one run.

#### Blocked by

- #329

#### References

- `docs/specs/2026-10-08-mock-services-design.md`
- ADR-0021
- #61, #323, #324, #325

---

### 6. Import Postman Collection v3 (YAML folders) (#349 · 5.1)

> **P0** · **M** · Developers · `area: importers`

#### Why

The newest Postman Collection format is a folder of YAML files, one per request, kept in git. Teams that have moved to
it can't bring it in: the importer reads v2.0/2.1 JSON only. The older command-line runner can't run the new format,
so many of these teams are moving their CI right now.

#### Done when

- [ ] Import accepts a folder containing `*.request.yaml` files, `.resources/definition.yaml` (auth, variables,
      description at collection and folder level), `*.example.yaml` examples and path-backed script files.
- [ ] The documented request kinds map onto Wirebench's: HTTP becomes REST, gRPC becomes gRPC, WebSocket becomes
      WebSocket. GraphQL, Socket.IO, MQTT, MCP and LLM requests are reported as not mapped.
- [ ] The documented auth and body enums are covered. Unknown fields are listed in the import report.
- [ ] Order comes from the fractional order indexes.
- [ ] Detected automatically by the Import… dialog and by `wirebench import`.
- [ ] Fixtures built from real exports are checked in, because no published JSON Schema exists for the format.

#### Blocked by

None.

#### References

- `packages/engine/src/rest/postman/`
- `packages/engine/src/import/`

---

## P1 — weekly, or core for a large group of users

### 7. GraphQL queries and mutations (#77 · 5.2)

> **P1** · **L** · Developers · `area: protocols`

Moves #77 from Later up to P1, with no change of scope. Subscriptions stay in #99.

#### Done when (in addition to #77)

- [ ] GraphQL requests run in sequences and in `wirebench run`, with the same assertions as REST.

#### References

- #77
- #99

---

### 8. More OAuth 2 grants and client authentication (#338 · 5.2)

> **P1** · **M** · Both · `area: auth`

#### Why

The password grant is still common on internal enterprise APIs. Device code suits CLI-first and headless use. Signed
client assertions are required by some identity providers.

#### Done when

- [ ] Grants: resource-owner password credentials, and device authorization (RFC 8628) with a code and verification URL
      shown in the app.
- [ ] Client authentication: `private_key_jwt` and `client_secret_jwt`, with the key from a keystore.
- [ ] The token is refreshed automatically before it expires when a refresh token exists, both in the app and in
      `wirebench run`. Confirm how the app behaves today first (see "Check first").
- [ ] The CLI runs the password and refresh-token grants headless.

#### References

- `packages/engine/src/http/auth/oauth2.ts`
- `apps/desktop/src/renderer/features/rest-editor/oauth2-status.tsx`

---

### 9. AWS Signature v4 and Digest auth (#339 · 5.2)

> **P1** · **S–M** · Both · `area: auth`

#### Why

APIs hosted on AWS need SigV4. Digest is still found on appliances and older enterprise systems.

#### Done when

- [ ] SigV4: signs headers or produces a presigned query string. Takes region, service, and access key/secret/session
      token as secrets. The canonical request can be seen in the HTTP Log. Tested against the AWS test suite vectors.
- [ ] Digest: MD5, SHA-256 and their `-sess` forms, `qop=auth`. The second request goes out automatically after the
      401 challenge, and the nonce count is kept per connection.
- [ ] cURL import maps `--digest` and `--aws-sigv4`.
- [ ] Both work in the CLI and in MCP `send`.

#### References

- `packages/engine/src/project/schema-parts.ts` (`authConfigSchema`)
- `packages/engine/src/http/auth/`

---

### 10. Variables in the editor (#340 · 5.1)

> **P1** · **S–M** · Developers · `area: environments`

#### Why

Every request a developer edits uses variables. Unresolved names show up in Problems and block the send, but the
editing help around them may be thin. Check what exists first (see "Check first").

#### Done when

- [ ] Typing `${` in the URL, params, headers, auth fields and body completes variable names, showing each one's scope.
- [ ] Hovering a variable shows its resolved value (masked if it is a secret) and its scope, with a link to edit it.
- [ ] An unresolved name is marked inline where it is written.
- [ ] **Set as variable** on text selected in a request or response creates a variable in a scope you choose.

#### References

- `packages/engine/src/project/properties.ts`

---

### 11. HTTP/2 negotiated automatically, per request (#80 · 5.2)

> **P1** · **S–M** · Developers · `area: rest`

Folds the per-request setting into #80.

#### Done when (in addition to #80)

- [ ] Each request has an HTTP version setting: Auto (ALPN), HTTP/1.1, or HTTP/2.
- [ ] The version actually used is shown in Timing and in the HTTP Log.

#### References

- #80

---

### 12. MCP server as a request kind (#79 · 5.2)

> **P1** · **M** · Developers · `area: mcp` `area: protocols`

Moves #79 from Later up to P1.

#### Done when (in addition to #79)

- [ ] Connects over stdio and over Streamable HTTP, with auth.
- [ ] Lists tools, resources and prompts.
- [ ] Calls a tool through a form built from its input schema.
- [ ] Server notifications are shown on a timeline.
- [ ] MCP steps run in sequences and in `wirebench run`, with assertions on the results.

#### References

- #79

---

## P2 — common, but not daily

### 13. Capture proxy that records traffic into requests (#341 · Later)

> **P2** · **L** · Developers · `area: workspaces` `area: mocks`

#### Why

Documenting an API that nobody wrote down starts from its live traffic. #60 records traffic only into mock stubs.

#### Done when

- [ ] A local HTTP/HTTPS proxy with a generated CA that you install yourself, and start/pause/stop controls.
- [ ] Filters by host, method, path and status.
- [ ] Captured exchanges are listed live and can be saved as REST requests, grouped by host and path, with their
      responses saved as examples.
- [ ] Secrets in captured headers are flagged by the secret scan before anything is saved.

#### Blocked by

- #60, which shares the proxy

#### References

- #60

---

### 14. OpenAPI linting in the CLI (#342 · 5.2)

> **P2** · **M** · Both · `area: contracts` `area: cli`

#### Why

Contract-first teams check definitions in CI before any request is sent. Wirebench checks WSDLs against WS-I but has no
lint for OpenAPI.

#### Done when

- [ ] `wirebench lint <definition>` checks OpenAPI 2.0, 3.0, 3.1 and 3.2 with a built-in hygiene rule set
      (descriptions, examples, operationId, reusable schemas).
- [ ] A built-in OWASP API Top 10 rule set: no security scheme, credentials over plain HTTP, undefined OAuth scopes.
- [ ] Rule sets you write yourself, as YAML files in the project.
- [ ] Output as CLI, JSON and SARIF. `--fail-severity` sets the exit code.
- [ ] The same findings show in Problems in the desktop app.

#### Blocked by

None.

#### References

- `packages/engine/src/validate/wsi/`

---

### 15. Scheduled runs and monitors on the server (#343 · 6.0)

> **P2** · **L** · Enterprise · `area: server` `area: testing`

#### Why

Teams want smoke checks running from inside their own network on a schedule, with alerts when something breaks.

#### Done when

- [ ] Wirebench Server runs `wirebench run` jobs on a cron schedule against a shared workspace and environment.
- [ ] Alerts by email, Slack and Microsoft Teams, a recovery notice when a run passes again, and muting after a set
      number of failures in a row.
- [ ] Run history with per-request results, kept by age.
- [ ] Jobs and their results are written to the audit log.
- [ ] Which edition includes this is settled in the editions doc.

#### Blocked by

- #199 for edition gating

#### References

- `docs/roadmap.md`, "Editions and compliance"
- `packages/server/`

---

### 16. SAML SSO and SCIM (#344 · 6.0)

> **P2** · **L** · Enterprise · `area: server`

#### Why

Enterprise buyers require SAML sign-in and automatic user provisioning. The server offers local accounts and OIDC only.

#### Done when

- [ ] SAML 2.0 sign-in, alongside OIDC, using metadata from the identity provider.
- [ ] SCIM 2.0 creates, updates and deactivates users, and creates groups and changes their members, mapped onto teams
      and roles.
- [ ] Tested against Entra ID and Okta.
- [ ] Sign-in and provisioning events are written to the audit log.

#### Blocked by

None.

#### References

- `packages/server/src/identity/`
- `packages/server/src/teams/`

---

### 17. More script reach for imported scripts (#335 · 5.1)

> **P2** · **S** · Developers · `decision needed` `area: testing`

#### Why

`sendRequest`, `setNextRequest` and `skipRequest` are the most common reasons an imported script fails. The sandbox
(ADR-0016) rules them out on purpose.

#### Done when

- [ ] The owner decides one of two options:
  - (a) Allow them, behind a permission prompt for each project and still sandboxed.
  - (b) Map them onto sequence steps when importing, and report what can't be mapped.
- [ ] ADR-0016 is amended or confirmed.
- [ ] The importer follows the decision.

#### Blocked by

None.

#### References

- ADR-0016
- `packages/engine/src/script/api/postman.ts`

---

### 18. Environment colour and a production guard (#345 · 5.1)

> **P2** · **S** · Developers · `area: environments`

#### Why

Sending to production by mistake is the most expensive slip in a day of API work.

#### Done when

- [ ] Each environment can have a colour, and the title-bar switcher and tab strip show it.
- [ ] An environment can be marked protected. Sending to it asks for confirmation in the app.
- [ ] `wirebench run` prints a warning for a protected environment and can refuse it with
      `--refuse-protected`.

#### Blocked by

None.

#### References

- `docs-site` guide `guides/environments.mdx`

---

### 19. Preview of generated headers (#346 · 5.1)

> **P2** · **S** · Developers · `area: rest`

#### Why

When a request fails, the first question is what was actually sent. Today you can see the headers the engine adds
(`Content-Type`, `Content-Length`, `User-Agent`, `Cookie`, auth) only afterwards, in the HTTP Log.

#### Done when

- [ ] Confirm what exists today (see "Check first" in the backlog).
- [ ] The Headers tab can show the headers that will be added, each with its source, before the request is sent.
- [ ] Each added header can be turned off or overridden from that view.

#### Blocked by

None.

#### References

- `apps/desktop/src/renderer/features/rest-editor/headers-tab.tsx`

---

### 20. Branching in sequences (#347 · 5.1)

> **P2** · **M** · Developers · `area: testing`

#### Why

Sequences run straight through. Real flows need a retry until something is ready, a branch on an error, or skipping
a step.

#### Done when

- [ ] A step can go to a named step, skip the next step, or repeat with a counter and a maximum, based on a
      condition over the last response (status, header, XPath/JSONPath match).
- [ ] Every loop has a maximum that can't be turned off.
- [ ] The run panel and the CLI report show which path was taken.

#### Blocked by

None.

#### References

- `docs/specs/2026-09-28-sequences-design.md`

---

### 21. Client-signed JWT bearer auth (#348 · 5.2)

> **P2** · **S** · Developers · `area: auth`

#### Why

Many service APIs expect a JWT that the client signs itself.

#### Done when

- [ ] The client signs the JWT from JSON claims with HS, RS, ES or PS at 256, 384 or 512 bits.
- [ ] HMAC secrets come from secrets, and private keys from a keystore.
- [ ] `iat`, `exp` and `jti` can be generated automatically.
- [ ] The token is sent as a header with a configurable prefix, or as a query parameter.
- [ ] It works in the CLI and in MCP `send`.

#### Blocked by

None.

#### References

- `packages/engine/src/http/auth/`

---

## P3 — niche, pick up on request

- OAuth 1.0, Hawk, Akamai EdgeGrid and ASAP auth types.
- HTTP over Unix domain sockets and Windows named pipes.
- An `SSLKEYLOGFILE` option for decrypting captures in Wireshark.
- A response visualizer that draws on the sandboxed HTML preview.
- More than 5 saved examples per request, and hand-written examples.
- Find and replace across the workspace.
- SOCKS proxy support. The proxy code skips SOCKS entries today because undici can't use them.
- A VS Code extension.
- Published HTML documentation for REST APIs, matching what exists for WSDL.

---

## Check first

Each of these needs a quick look in the app before an issue is filed, because the inventory and a code search didn't
settle it:

- [ ] A pre-send preview of the headers the engine adds (task 19).
- [ ] Variable completion and hover, inline unresolved marks, and **Set as variable** (task 10).
- [ ] `//` comments in a JSON body, stripped before sending.
- [ ] Re-running a request's assertions against its last response without sending again.
- [ ] Environment colours. None were found in the code (task 18).
- [ ] OAuth 2 refreshing the token automatically before it expires. The engine leaves that decision to the host
      (task 8).

## Out of scope

Deliberately not planned: built-in AI or an assistant, visual flow builders, Socket.IO, MQTT, in-app comments and pull
requests, and load testing. The roadmap's "Deliberately not" section records these decisions.
