# Roadmap

What Wirebench 2.0 deliberately leaves out, reorganised by what each item unlocks and in the order it is
worth building. The v1 design (`docs/specs/2026-09-09-wirebench-v1-explore-and-send-design.md`, §14) is
the phase plan this page argues from; where the two differ, [Departures from the v1 spec](#departures-from-the-v1-spec)
says so, and the spec stays authoritative until it is updated.

**Where things stand (2026-09-14).** 2.0.0 adds the REST client (`docs/specs/2026-09-13-wirebench-rest-client-design.md`,
ADR-0007) and moves the project format to version 3 — the major bump is that one-way door, not a
rewrite. Before it: 1.0.0 (explore and send) was tagged and withdrawn unpublished; 1.1.0 was the first
published release. It added workspaces (`docs/specs/2026-09-11-wirebench-workspaces-design.md`, ADR-0006),
the Environments view with per-variable enabling (`docs/specs/2026-09-12-wirebench-layout-and-environments-design.md`),
manual saving with per-tab dirty marks (`docs/plans/2026-09-12-save-granularity-plan.md`), and OS- and
arch-named release artifacts. Unreleased on `main`: git-native shared workspaces
(`docs/specs/2026-09-13-wirebench-shared-workspaces-design.md`, ADR-0008, `docs/collaborate.md`). Everything
below is what is still open.

**Revised 2026-09-13** after a review of the surrounding tools — the Java-era SOAP workbenches, the cloud API
platforms, and the local-first REST clients. Three things were true of all of them: every one ships a CI
runner, importers and signed installers; every one is now racing on agent access, built-in AI and git-native
or self-hosted teams; and none of them reads a contract the way Wirebench does. So the order below moves the
adoption blockers first, then turns what the engine knows about a contract into features nobody else can
build cheaply, and keeps AI out of the product while making it easy for agents to drive. Items marked ✚ exist
in no other client. Re-read on 2026-09-14 against the two largest API platforms' own comparison pages, which
added the MCP-tools step to item 4, secret scanning under [Secrets](#secrets), and one open question under
[Departures from the v1 spec](#departures-from-the-v1-spec).

**Legend.** _Who_: Dev (an individual developer's daily use), Ent (what enterprise adoption needs), Both.
_Size_: XS hours · S days · M one to two weeks · L a plan of around fifteen tasks · XL larger than any single
v1 phase. _Status_: where the item stands today. `spec 1.1`, `phase 2` and so on name the bucket §14 of the
v1 spec puts the item in; the spec's "1.1" list is not the 1.1.0 release, which shipped workspaces instead.
The order is an argument about value, not a schedule: an item with an approved plan is built when its plan
is picked up.

## Recommended order

| # | Item | Who | Size | Status | Why here |
| --- | --- | --- | --- | --- | --- |
| 1 | Signed and notarised releases, MSI with silent install, SBOM | Ent | XS signing, S the rest | follow-up | Managed Macs and Windows fleets block unsigned apps, and every other client ships signed. Nothing else matters if IT cannot install it. |
| 2 | Documentation site, with a switching guide and a published benchmark | Both | S tooling, M content | new | A release that people can install but cannot learn sends every question to the issue tracker. The benchmark turns the performance budgets into an argument. |
| 3 | CLI runner: assertions, JUnit and JSON reports, CI recipes, baseline mode | Ent | M | phase 2 subset | "Runs in CI" is a procurement checkbox every other client already ticks. The baseline mode — compare each response with a committed golden file — is the one runner feature none of them has. |
| — | Shared workspaces, git-native | Ent | L | **shipped on `main`** | Done to `docs/specs/2026-09-13-wirebench-shared-workspaces-design.md` (ADR-0008): a whole workspace, environments included, as a git repository or a synced folder, with Sync and a conflict resolver in the app; one `SyncBackend` interface the server (item 15) reuses. |
| 4 | MCP server over the engine, with CLI parity | Dev | S | idea → next | Shares the runner's engine surface, so it is cheapest right after it. It lets coding agents import, generate, send, validate and query SOAP without any AI living in the app; a second step exposes an imported contract's operations as MCP tools, which no tool does from a WSDL. |
| 5 | Snapshot regression across environments ✚ | Both | S–M | new | Send one request to several environments at once, diff the responses semantically with ignore rules for volatile fields, commit the golden responses, and let the runner replay them. Mostly wiring over history's re-send and diff. |
| 6 | Secrets from external managers; encrypted team secrets | Ent | M | new | A secret scope resolved at send time from a vault, a cloud secret manager, a password manager's CLI or the keychain, so nothing sensitive is on disk anywhere; team secrets encrypted to member keys in a shared workspace. The follow-up the shared-workspaces spec names. |
| 7 | Enterprise authentication: Kerberos/SPNEGO and WS-Trust (STS-issued SAML tokens) | Ent | M + M | spec 1.1 + new | Windows-integrated auth and a security token service front most internal SOAP estates, and the same buyer asks for both. Kerberos needs a native module, so it needs an explicit ruling. |
| — | REST client, minimum viable | Dev | L | **shipped in 2.0.0** | Most estates are mixed; a SOAP-only tool loses the "one tool" argument. Done, with OpenAPI 3 import and OAuth2; item 8 is what it left out. |
| — | Importers: OpenAPI 3.2, Swagger 1.x/2.0, Postman Collections | Dev | M | **shipped in 2.1.0** | Switching cost is the moat, and anyone with saved requests elsewhere judges a client by whether it can bring them along. One Import… dialog detects the format; what it cannot map is reported rather than dropped. |
| 8 | REST follow-ups and contract validation | Dev | S–M each | new | Each follow-up is a gap a user hits within a day of real use, and none needs a format change. Responses validated against the OpenAPI schema match what SOAP already does against XSD. |
| 9 | Contract diff and breaking-change report ✚ | Both | M | new | Two WSDLs or two OpenAPI documents compared per operation, each change classified breaking or compatible, exportable and runnable in CI. Builds on Update Definition's change report; both definition caches already exist. |
| 10 | WS-Security debugger and policy-driven configuration ✚ | Ent | M | new | Explain a failed verify or decrypt — which reference, digest, canonicalisation, token or clock skew — and propose the configuration from the WSDL's security policy, as WS-Addressing is already enabled from policy. Engine-only work; can land at any time. |
| 11 | Mock services: contract-validated, recorded, file-based | Both | L | phase 3 | The upstream test system being down is the most common blocker a team has. Mocks that validate requests against the contract, live as reviewable files in the project, and are recorded from live traffic are what other mocks lack. |
| 12 | Sequences: chained requests, property transfer, declarative assertions | Both | M | phase 2 slice | The first slice of functional testing, without code, runnable from the UI and the CLI. |
| 13 | Typed scripting from the contract ✚ | Both | L | phase 2 slice | Sandboxed TypeScript whose context types are generated from the XSD or JSON Schema, so a script autocompletes the message and a wrong path fails before the run. |
| 14 | Full functional testing: suites, data-driven runs, callback listener | Both | XL | phase 2 | Suites, CSV and XLSX data sources, and a listener for WS-Addressing callbacks, after Sequences and scripting have proved the model. |
| 15 | Self-hosted Wirebench Server: sign-in, teams, SSO | Ent | XL | new | Spec 2 of the shared-workspaces design (§5.4): the same repository with the server running git, live updates, presence and OIDC-first sign-in; SCIM and audit second. The enterprise offer, with data inside their own network. |
| 16 | JKS keystores, WS-ReliableMessaging | Ent | S each | spec 1.1 | Build when a customer asks; each is a niche. SAML tokens moved into item 7. |
| 17 | gRPC (shipped) and GraphQL | Dev | L each | gRPC shipped 2026-09-16; GraphQL later phase | gRPC landed as the third container on the shape [ADR-0007](adr/0007-apis-beside-interfaces.md) was written to survive — see [the gRPC spec](specs/2026-09-16-wirebench-grpc-client-design.md). [Server reflection](specs/2026-09-17-grpc-server-reflection-design.md) shipped 2026-09-17 [live streaming with interactive bidirectional send](specs/2026-09-18-grpc-live-streaming-design.md) and [message completion from the descriptor](specs/2026-09-18-grpc-message-completion-design.md) on 2026-09-18; the remaining follow-up is resend from History. GraphQL stays demand-driven. |
| — | Load testing, WSDL coverage and refactoring, code generation | — | XL | phase 4 | Deferred indefinitely; other tools do these better. The TCP monitor's use case, recording traffic, is absorbed by the mock recorder. |
| — | MQTT, Kafka and JMS transports | — | L each | watch | A different buyer and native modules; only on a customer's ask. |
| — | Hosted cloud | Ent | a business | idea | Only with a company behind it; see [Teams and sign-in](#teams-and-sign-in). |

## By theme

### Release and distribution

- **Signing.** macOS needs a Developer ID Application certificate and notarisation through the Apple
  Developer Program. Windows can use SignPath Foundation's free open-source programme or Azure Artifact
  Signing; a traditional CA certificate is the most expensive route and the most awkward in CI. The
  secrets are listed in `docs/release.md`; the workflow already skips signing for any that are unset.
- **Fleet installation.** Document the NSIS installer's silent mode and produce an MSI in the same pass as
  signing (item 1): Intune-managed customers ask for both at once.
- **Supply chain.** A CycloneDX SBOM and GitHub build attestations attached to every release, also item 1.
- **Managed preferences.** A policy file at a system location that locks the proxy, CA bundle and update
  settings for managed machines.
- **Portable build.** A Windows zip with a relative data directory, for locked-down machines where nothing
  may be installed.
- **Localisation.** English only today.

### Documentation site

- **Content.** Install and first run per OS (including the unsigned-app steps until signing lands); a
  ten-minute walkthrough; one guide per feature area (requests and editors, environments and property
  expansion with a scope table, MTOM and SwA attachments, Basic and NTLM auth, WS-Security with keystores
  and the incoming inspector, WS-Addressing, proxy and TLS, history and diff, WS-I validation, generated
  documentation, Update Definition, shortcuts); reference pages for the project folder format
  (ADR-0003), every preference, and the command and shortcut list; troubleshooting and FAQ; the existing
  security, release and contributing pages moved over.
- **Switching guide.** One page per importer (item 8): what carries over, what does not, and where the
  equivalent lives in Wirebench.
- **Benchmark.** Startup, WSDL import and first-send timings taken from the performance budgets and
  published per release, so the speed claim is measured rather than asserted.
- **Tooling.** VitePress under `docs/`, so pages version with the code and still render on GitHub;
  published to GitHub Pages from a workflow on every push to `main`, at the `wirebench.github.io` address
  first and at wirebench.io once the domain is registered. The command and shortcut reference is
  generated from the command registry with a `--check` mode, like the WS-I tables. Screenshots come from
  the e2e suite so they never go stale. The banned-terms and doc-path checks extend to the site.
- **Naming.** The app's own "Generate HTML documentation" command documents the user's WSDL; the site
  calls itself the Wirebench user guide so the two are never confused.

### Workspaces

Shipped in 1.1.0 (`docs/specs/2026-09-11-wirebench-workspaces-design.md`,
`docs/plans/2026-09-11-wirebench-workspaces-plan.md`, `docs/adr/0006-workspaces-in-app-data.md`). A
workspace groups projects, owns environments and a shared property scope, and removed folder picking
from the normal flow. Linking a project folder that lives in git, and exporting an internal project to a
folder, are the bridges to teams that need no server.

**Workspace sharing shipped** (`docs/specs/2026-09-13-wirebench-shared-workspaces-design.md`,
[ADR-0008](adr/0008-shared-workspaces-are-git-repositories.md), `docs/collaborate.md`). A whole workspace —
its projects and its environments — can be shared as a git repository or a synced folder; members join by
URL or by pointing at an existing clone, and Sync pulls, merges, pushes and resolves conflicts in the app.
Wirebench Server (item 15) plugs into the same socket. Still parked:

- **Multi-window.** The workspaces design (`docs/specs/2026-09-11-wirebench-workspaces-design.md`
  §1, assumption 7) deliberately keeps one window holding one open workspace at a time. Several
  workspaces open at once, each in its own window, is a natural next step but changes how main's
  singletons (the open `WorkspaceService`, dialog picks) are scoped, so it is left as a
  follow-up rather than folded into workspaces v1.
- **Shared, encrypted secret values.** Secret refs travel with a shared workspace; values stay per member
  for now (`docs/specs/2026-09-13-wirebench-shared-workspaces-design.md` §1). Item 6 is the follow-up.

### Environments

Shipped: the Environments view (activity bar → left menu, its own editor page), a per-variable
enabled checkbox, and the `disabled` list format bump
(`docs/specs/2026-09-12-wirebench-layout-and-environments-design.md`). Parked:

- **Initial value / Current value split.** A variable's committed value versus a session-only override
  that never touches disk. Deliberately deferred at spec time (`docs/specs/
  2026-09-12-wirebench-layout-and-environments-design.md` §12, question 1) — it needs a session-only
  value store in main and a further format decision. Scheduled with the REST follow-ups
  (item 8), together with the cookie jar, because REST users expect both.
- **Multi-environment send.** Item 5 sends one request to several environments and shows the responses side
  by side; the environment model needs nothing new for it.

### Compatibility and adoption

- **Importers and exporters.** In, shipped in 2.1.0: OpenAPI 3.0/3.1/3.2, Swagger 1.x and 2.0, and
  Postman Collections v2.0/v2.1. Still wanted in: Postman environment files, HAR 1.2, `.http` request
  files as the JetBrains and VS Code clients write them, OpenCollection YAML; others when asked. Out:
  Postman Collection v2.1 and OpenCollection YAML, neither written yet. A published JSON Schema for
  Wirebench's own project files, so any editor validates them. Switching cost is the moat the cloud
  platforms rely on; every client that displaced one began as an importer.
- **JKS keystores.** PKCS#12 and PEM are supported today.
- **HTTP/2.** Evaluate making it the default once enough servers negotiate it cleanly.
- **Same-host `http://` → `https://` 301 on a POST.** Wirebench does not follow redirects on send by
  default, because `fetch`/undici semantics downgrade a redirected POST to a GET, which would silently
  turn a SOAP call into a page fetch and lose the envelope. That is the right default, but a same-host,
  same-path upgrade is common enough (the `tempconvert` interop fixture is a live example) to deserve a
  purpose-built case: either preserve the method and body across exactly that redirect shape, or detect
  it and surface a Problem saying the request was declined. Which of the two, and how narrow "same-host,
  upgrade-only" needs to be, is a design decision a bug-fix pass should not make in passing.

### Contracts

What the engine already knows about a WSDL, an XSD or an OpenAPI document, turned into features. Nothing
here needs a new parser; each item reuses the schema set, the definition cache or the validation path.

- **Contract diff and breaking-change report** (item 9). Two versions of a WSDL or an OpenAPI document
  compared per operation: operations added or removed, elements made required, types narrowed,
  enumerations changed, endpoints moved; each change classified breaking or compatible; Markdown and HTML
  export; `wirebench diff-contract` as a CI gate. Update Definition's per-operation report is the seed.
- **WS-Security debugger** (item 10). On a failed verify or decrypt: the reference that failed, expected
  versus computed digest, the canonicalisation used, the token expected and not found, clock skew against
  the Timestamp, and a timeline of what was signed and encrypted in which order. The same view previews an
  outgoing message before Send. Builds on the WSS inspector and the incoming verification path.
- **Policy-driven configuration** (item 10). Read the WSDL's WS-Policy and WS-SecurityPolicy attachments and
  propose the WS-Security configuration — which token, which parts signed and encrypted, which algorithm
  suite, whether transport binding requires TLS — the way `wsaw:UsingAddressing` already switches on
  WS-Addressing. One click applies it; a badge shows the request satisfies the policy.
- **Form view and response validation for REST** (item 8). A JSON body filled in as fields generated from
  the OpenAPI schema, round-tripping to the raw editor, and responses validated against the response schema
  with editor markers — the Form model and the XSD validation path, applied to JSON Schema.
- **Schema-driven variation and robustness scans.** From the XSD or JSON Schema, generate valid variations,
  boundary values and invalid inputs (missing required element, wrong enumeration, oversized string,
  entity expansion), send them, and report which the service rejected correctly; CLI-runnable. An idea,
  not scheduled; the sample generator makes it cheap when asked for.
- **Certificate expiry across a workspace.** Warn ahead of time for every endpoint's chain and every
  keystore in the open workspace. Small; folds into the SSL inspector.

### Authentication

- **Kerberos/SPNEGO** (item 7). Requires the native `kerberos` module as an optional dependency, which the
  v1 boundaries make an ask-first decision.
- **WS-Trust** (item 7). Request a SAML token from a security token service with a username, a certificate
  or Kerberos, cache it for its lifetime, and place it in the WS-Security header. Federated SOAP estates
  almost always front one.
- **SAML tokens.** Form and XML variants in outgoing WS-Security; built as part of the WS-Trust pass.
- **OAuth2, Bearer and API keys.** Arrived with the REST client, for REST owners. Reusing them from a SOAP
  interface, endpoint or request is still open (item 8): the auth model and the inspector are already
  shared, but the project format persists SOAP owners under the narrower `endpointAuthSchema`, and the SOAP
  send path applies only the schemes the transport owns (Basic, NTLM). Widening it means the schema at three
  sites, the engine's `Interface`/`Endpoint`/`RequestDef` auth types, a SOAP-side `applyAuth` for the header
  and query schemes, and main resolving the new references — see §15.11 of the REST client design.

### Secrets

The rule from v1 stands: no secret is ever written to a project or workspace file, a log, an export or the
renderer. Two extensions (item 6):

- **External secret managers.** A `${#Secret#…}` scope resolved in main at send time from a vault, a
  cloud provider's secret manager, a password manager's command-line tool, or the OS keychain — so a team
  that already has a vault keeps its secrets there and Wirebench holds only references. Resolution failures
  are Problems that block the send, like an unresolved property.
- **Encrypted team secrets.** In a shared workspace, secrets encrypted to each member's public key and
  committed with the repository, decrypted locally, never held in plaintext by a server. The keychain-only
  model gains a second path; it does not lose the first.
- **Secret scanning.** A check before every save and every Sync commit for credential-shaped strings pasted
  into a request body, a header or a property, offering to move the value into a secret. The format keeps
  secrets out of files; this keeps people from typing them in. Small; reuses the redaction rules.

### Automation and CI

- **`wirebench run`** (item 3). Runs saved requests against a chosen environment, with assertions for HTTP
  status, SOAP fault or not, XPath/XQuery match, schema compliance and response SLA; JUnit, HTML and JSON
  reports; meaningful exit codes; secrets supplied through environment variables so CI never needs a
  keychain. Ships with a GitHub Action, a container image and a GitLab template, and with `--baseline`,
  which compares every response with the committed golden file from item 5.
- **Snapshot regression** (item 5). Golden responses stored beside the request; a semantic XML and JSON
  diff that ignores the paths a request names (timestamps, ids); a fan-out send to several environments
  with the responses side by side.
- **Sequences** (item 12). A linear chain of requests with property transfers (XPath or JSONPath from one
  response into the next request's properties) and assertions declared in YAML rather than code, runnable
  from the UI and the CLI. The first slice of functional testing, on its own file kind.
- **Typed scripting** (item 13). Sandboxed TypeScript with a typed context whose `request` and `response`
  types are generated from the operation's schema, so Monaco autocompletes element names and the type
  checker catches a wrong path before the run.
- **Full functional testing** (item 14). Suites, cases and steps, data-driven runs from CSV and XLSX, the
  full assertion catalogue, and a callback listener: a local endpoint that receives WS-Addressing `ReplyTo`
  callbacks and one-way acknowledgements and acts as the MockResponse step in a sequence.
- **MCP server** (item 4). Import, list operations, generate a sample, send, validate, query with XPath and
  diff history exposed over MCP from the pure-Node engine, with CLI parity, so coding agents can drive
  Wirebench. A second step exposes an imported contract's operations as MCP tools — one tool per operation,
  its input schema derived from the XSD or JSON Schema, auth and environment taken from the workspace, every
  call sent through the engine and recorded in history — so an agent can call a legacy SOAP service without
  writing XML; the cloud platforms generate MCP servers from REST definitions, none from a WSDL. Later, an
  MCP request kind for testing MCP servers, decided together with gRPC (item 17),
  since both need a multi-message response record.
- **Plugin API.** An idea only, and deliberately after the CLI and MCP surfaces have settled: those two give
  extensibility without committing to an internal API for years.

### REST client — shipped in 2.0.0

Built to `docs/specs/2026-09-13-wirebench-rest-client-design.md` (implemented) by
`docs/plans/2026-09-13-wirebench-rest-client-plan.md`. APIs with folders and requests beside SOAP
interfaces in the same project, environments, history and search; OpenAPI 3.0/3.1 import cached like a
WSDL; query, path, form, multipart, binary and raw body editors; Basic, NTLM, Bearer, API-key and
OAuth2 (authorization code with PKCE, and client credentials); cURL both ways; the Query view over JSON
in XPath 3.1, XQuery 3.1 and JSONPath. The engine gained `rest/` and `rest/openapi/`, the renderer a
REST editor and an API tab, `formatVersion` went to 3, and the `kind` discriminator activated with
`grpc` reserved and refused by name — see [ADR-0007](adr/0007-apis-beside-interfaces.md) for why an API
is a sibling container rather than a generalised interface. Evidence per criterion is in
[`success-criteria.md`](success-criteria.md), rows SC-R1–SC-R8.

**Follow-ups (item 8), roughly in the order a real user hits them.** None needs a format change:

- **Resend and diff a REST send from History.** The entry is recorded with everything needed to show
  it, but `history.resend` still rebuilds a SOAP envelope, so a REST entry can be inspected and not
  replayed. The one §14 criterion only partly met (SC-R6).
- **The three token-style auth kinds for SOAP owners.** `bearer`, `api-key` and `oauth2` are offered to
  REST owners only; see [Authentication](#authentication) for what widening it costs and why it was not
  "tests only" as the spec first assumed.
- **A persistent cookie jar.** Today cookies are per-request session cookies with no jar; a
  workspace-wide jar with a manager was deliberately deferred (spec §15.4).
- **HTML response preview.** Needs a sandboxed frame and a CSP decision that deserves its own security
  review (spec §15.5). Pretty and Raw show the markup meanwhile.
- **_Update Definition_ for an API**, preserving edited values the way the WSDL one does (spec §15.7).
- **Response validation against the OpenAPI response schema** — the functional-testing phase, with the
  `ajv` ask (spec §15.8).
- **Re-redact a REST row in the HTTP Log when _show secrets_ is toggled.** REST sends reach the log
  now, but `refreshExchange` re-fetches through `exchanges.get`, which only knows the SOAP cache, so a
  REST row keeps the redaction it was given at send time instead of gaining the secret back. The row
  is never *wrong* — it is redacted, which is the safe direction — it just does not update.
- **Failed sends reach the HTTP Log — done 2026-09-16.** A send that fails at the network level
  (DNS, refused connection, TLS, proxy, timeout, abort, too many redirects) now gets a row with its
  error code, its duration and the request headers it was built with, redacted at emit and kept so;
  the log also gained a filter bar and a five-tab detail pane. See
  [`specs/2026-09-16-http-log-failures-filters-detail-design.md`](specs/2026-09-16-http-log-failures-filters-detail-design.md).
  The re-redaction line above still stands for REST rows; a failure row is redacted by design and
  the pane says so.
- **HTTP Log export, reuse, search, waterfall, compare, row limit and preserve log — done 2026-09-18.**
  Export HAR, copy as cURL, Resend and Open request from a row menu, search with regex and case, a Name
  column and sort, a waterfall column, comparing two rows, a row-limit setting and a session-only Preserve
  log. See
  [`specs/2026-09-18-http-log-export-search-compare-design.md`](specs/2026-09-18-http-log-export-search-compare-design.md).

- **The JSON form view** — see [Contracts](#contracts). The importers that used to sit beside it here
  shipped in 2.1.0.

The cookie jar and the initial/current value split go together. The test steps and assertions extend to
REST in the functional-testing slices (items 12–14); JSONPath is already in the engine
(`xpath/jsonpath.ts`), so assertions can reuse it rather than adding a dependency. gRPC and GraphQL
(item 17) are demand-driven parity after that; MQTT, Kafka and JMS are watched, not planned.

### Mock services

Generated from a WSDL or an OpenAPI document (item 11); every incoming request validated against the
contract, answering a fault or a 4xx when it does not conform; dispatch by sequence, random, XPath, script
or query match, plus stateful scenarios; stubs stored as plain files in the project so a reviewer can read
them; start, stop, on-request and after-request scripts; serves the WSDL; a headless `wirebench mock` for
CI; and a built-in recording proxy that turns live traffic into stubs, which is also what people used the
deferred TCP monitor for.

### Teams and sign-in

Neither is in the v1 spec, and both differ in kind from every other item here. Four principles bound the
design, and the shipped shared workspaces embody the first two:

1. **The app stays fully usable without an account.** Accounts unlock team features, never the product.
   Forced sign-in is the single reason a large share of a well-known REST client's users moved elsewhere.
2. **Sync is opt-in per workspace, with visible status.** The v1 boundaries forbid network calls the user
   did not initiate; a workspace is never synced on first launch.
3. **The server never holds plaintext secrets.** Team secrets are encrypted to member keys and decrypted
   locally (item 6); the keychain-only model gains a second path, it does not lose the first.
4. **The workspaces spec lists network sync as a non-goal.** It got a follow-up spec, not a rewrite; the
   shipped ULID entity ids and per-project files are what made the sync design possible.

| Route                        | What it is                                                                                                                                                                                                                                                         | Size                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| Git-native shared workspaces | **Shipped on `main`** ([ADR-0008](adr/0008-shared-workspaces-are-git-repositories.md), `docs/collaborate.md`): a whole workspace — projects and environments — shared as a git repository on the team's own hosting or a synced folder, with an in-app Sync control, a conflict resolver and per-member secrets until item 6. Roles are repository permissions; history is git history. | Shipped |
| Self-hosted Wirebench Server | Spec 2 of `docs/specs/2026-09-13-wirebench-shared-workspaces-design.md` (§5.4): the same repository with the server running git, plus live updates, presence, accounts and organisations, roles, OIDC and SAML SSO, SCIM, an audit log (item 15). Its own spec is next. | XL |
| Hosted cloud                 | The same server run as a service: billing, uptime, support, and eventually a SOC 2 report.                                                                                                                                                                         | a business                  |

### Deliberately not

- **Built-in LLM features.** The kickoff decision stands: Wirebench is agent-ready through the CLI and the
  MCP server, and no model runs in the app or receives its data. The surrounding tools all ship AI inside;
  the gap will come up in evaluations, so the docs say why. Revisit only on repeated customer pull, and
  then as an optional, off-by-default, bring-your-own-endpoint integration.
- **Load testing.** Dedicated load tools do it better; a response SLA assertion is enough.
- **A hosted cloud before there is a company.** The self-hosted server comes first and may be all that is
  ever needed.
- **Every protocol.** gRPC and GraphQL when asked; MQTT, Kafka and JMS are a different buyer with a
  different tool budget.
- **A plugin API before the CLI and MCP surfaces are stable.**

### Deferred (phase 4)

Load testing with strategies, load assertions and live charts; WSDL coverage; the WSDL refactoring
wizard; code generation. The TCP monitor proxy is no longer a separate item: the mock recorder covers it.

### Known limitations carried from 1.0 and 1.1

- The theme screenshot comparison runs on macOS only; the rest of the e2e suite runs on all three OSes.
- The `xmlsec1` cross-check is skipped locally unless `WIREBENCH_REQUIRE_XMLSEC=1`; CI always runs it.
- The interop suite covers four public services, not five: one was unreachable when fixtures were captured.
- English only.
- A 1.0.0 build cannot open a project or workspace saved by 1.1.0 (`formatVersion: 2`). Moot in
  practice, since 1.0.0 was never published, but the format bump is the first one the loaders refuse.

### Known limitations carried from the layout and environments work

- The global properties file's loader (`apps/desktop/src/main/global-properties.ts`) does not
  validate its `version` field, so a future version-3 globals file would be silently misread
  rather than refused — unlike the project and workspace loaders, which do refuse a too-new file.
- The Environments view's rows (`apps/desktop/src/renderer/features/environments/
  environments-view.tsx`) use `role="row"` without `gridcell` children or `aria-rowindex`, and the
  environment page's variables and endpoint-overrides tables
  (`apps/desktop/src/renderer/features/environments/{variables-table,endpoints-table}.tsx`) use
  native `<table>` markup instead of the `role="grid"` convention `history-view.tsx` and
  `keystores-view.tsx` use. Three views, two conventions; worth reconciling before another grid
  is added.
- The panel handle's hover tint (the `group-hover:bg-handle-hover` class in
  `apps/desktop/src/renderer/shell/panel-handle.tsx`) has no end-to-end coverage; it exists only
  as a CSS pseudo-class, unasserted by any unit or e2e test.

## Audience fit

| Audience   | Already there                                                                                                                                                                                                                                                                                                                                                         | Missing                                                                                                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer  | Schema-aware XML editing with go-to-definition; XPath 3.1 and XQuery 3.1 on responses; persistent searchable history with diff; cURL both ways; workspaces with shared environments and one environment switch; property expansion across every scope; manual save with per-tab dirty marks; unsaved changes kept across sessions; REST APIs beside SOAP interfaces with OpenAPI import, OAuth2 and cURL both ways; generated documentation; keyboard-first shell. | The REST follow-ups and importers for existing collections; Sequences and scripting; snapshot regression; the MCP surface; a user guide.                                                                             |
| Enterprise | Secrets in the OS keychain and never in project files; git-friendly project folders that link into a workspace; whole-workspace sharing over git or a synced folder, with an in-app Sync control and conflict resolver; TLS verification on by default with a persistent badge when bypassed; complete WS-Security both ways; NTLMv2, client certificates, authenticated proxies, custom CA bundle; no telemetry; consent-gated updates; Apache-2.0; axe and contrast gates.          | Signed builds, MSI and silent install, SBOM and attestations; Kerberos and WS-Trust; a CI runner; external secret managers and encrypted team secrets; SSO; managed preferences; a WS-Security debugger for the support desk. |

## Departures from the v1 spec

- The CLI runner is pulled ahead of the rest of phase 2, and REST shipped before mocks: both widen who
  can adopt the tool, while the full assertion catalogue and mocks deepen it for existing users.
- Functional testing is cut into three slices — Sequences, typed scripting, then suites with data-driven
  runs — instead of one XL phase, so each slice ships value and runs in the CLI.
- The MCP server moves from an idea to item 4, because it shares the runner's engine surface and because
  agent access is now expected of every client.
- The 2026-09-13 review added items the spec never had — importers (shipped in 2.1.0), contract diff, the WS-Security
  debugger and policy-driven configuration, snapshot regression, external secret managers and encrypted
  team secrets, WS-Trust, a portable build and a published benchmark. Each builds on something already in
  the engine; none adds AI to the product.
- Workspaces was not in the spec at all and shipped as 1.1.0, ahead of the spec's own "1.1" list
  (Kerberos, JKS, SAML, WS-RM); that list is still open, under the `spec 1.1` status, with SAML folded
  into the WS-Trust pass.
- The spec's legacy single-XML project import is dropped. Wirebench has no older format of its own to
  bring forward, and importing other SOAP tools' project files is not a goal. Importing collections in
  open interchange formats (item 8) is a different matter: it is how people arrive.
- gRPC and GraphQL become demand-driven parity items; MQTT, Kafka and JMS are watched, not planned. The
  TCP monitor is absorbed by the mock recorder.
- Signing and distribution, the documentation site, and teams and sign-in are new; the spec does not
  mention them.
- **Open question (2026-09-14): importing the legacy single-XML SOAP project format.** Both large API
  platforms now advertise migration from it, and one imports the project files directly with AI-assisted
  conversion of their scripts, so the largest population of SOAP testers can move to a cloud platform in an
  afternoon and cannot move to Wirebench at all. The roadmap still declines the import on principle (no
  lineage, no other tool's format); reversing that is the owner's decision. If it is reversed, the
  clean-room rule still holds: implement from the file format as observed, never from another tool's source.
- Everything else keeps the phase §14 assigns it.
