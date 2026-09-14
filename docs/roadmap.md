# Roadmap

What Wirebench 1.1 deliberately leaves out, reorganised by what each item unlocks and in the order it is
worth building. The v1 design (`docs/specs/2026-09-09-wirebench-v1-explore-and-send-design.md`, §14) is
the phase plan this page argues from; where the two differ, [Departures from the v1 spec](#departures-from-the-v1-spec)
says so, and the spec stays authoritative until it is updated.

**Where things stand (2026-09-12).** 1.0.0 (explore and send) was tagged and withdrawn unpublished;
1.1.0 is the first published release. It adds workspaces (`docs/specs/2026-09-11-wirebench-workspaces-design.md`,
ADR-0006), the Environments view with per-variable enabling
(`docs/specs/2026-09-12-wirebench-layout-and-environments-design.md`), manual saving with per-tab
dirty marks (`docs/plans/2026-09-12-save-granularity-plan.md`), and OS- and arch-named release
artifacts. Unreleased on `main`: tab reordering and explorer fold state remembered per workspace.
Everything below is what is still open.

**Legend.** _Who_: Dev (an individual developer's daily use), Ent (what enterprise adoption needs), Both.
_Size_: XS hours · S days · M one to two weeks · L a plan of around fifteen tasks · XL larger than any single
v1 phase. _Status_: where the item stands today. `spec 1.1`, `phase 2` and so on name the bucket §14 of the
v1 spec puts the item in; the spec's "1.1" list is not the 1.1.0 release, which shipped workspaces instead.

## Recommended order

| #   | Item                                                                 | Who  | Size                 | Status         | Why here                                                                                                                                  |
| --- | -------------------------------------------------------------------- | ---- | -------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Signed and notarised releases                                        | Ent  | XS                   | follow-up      | Managed Macs and Windows fleets block unsigned apps. Nothing else matters if IT cannot install it.                                          |
| 2   | Documentation site                                                   | Both | S tooling, M content | new            | A release that people can install but cannot learn sends every question to the issue tracker.                                              |
| 3   | CLI runner with basic assertions and JUnit output                    | Ent  | M                    | phase 2 subset | "Runs in CI" is a procurement checkbox, and it turns a manual tool into a pipeline step.                                                   |
| 4   | Sync protocol design                                                 | Ent  | S (a spec)           | new            | Settles change sets, merge rules and the on-disk journal so a server can be added later without reworking the shipped workspace format.   |
| 5   | Kerberos/SPNEGO                                                      | Ent  | M                    | spec 1.1       | Windows-integrated auth fronts most internal SOAP services in large organisations. Needs a native module, so it needs an explicit ruling.   |
| —   | REST client, minimum viable                                          | Dev  | L                    | **shipped on `main`** | Most estates are mixed; a SOAP-only tool loses the "one tool" argument. Done, with OpenAPI 3 import; the follow-ups below are what it left out. |
| 6   | REST follow-ups                                                      | Dev  | S–M each             | new            | Each is a gap a user hits within a day of real use; none needed a format change, which is why they were cut from the first pass.            |
| 6b  | gRPC client                                                          | Dev  | L                    | reserved       | The third container, on the shape [ADR-0007](adr/0007-apis-beside-interfaces.md) was written to survive. `kind: grpc` is already reserved and refused by name. |
| 7   | Mock services with record-from-live                                  | Both | L                    | phase 3        | The upstream test system being down is the most common blocker a team has. Recording is the differentiator.                                |
| 8   | MCP server over the engine                                           | Dev  | S                    | idea           | The engine is pure Node with no Electron imports, so this is cheap, and it lets coding agents drive Wirebench.                             |
| 9   | Self-hosted Wirebench Server: sign-in, teams, SSO                    | Ent  | XL                   | new            | OIDC first, SCIM and audit second. The enterprise offer, with data inside their own network.                                               |
| 10  | JKS keystores, SAML tokens, WS-ReliableMessaging                     | Ent  | S each               | spec 1.1       | Build when a customer asks; each is a niche.                                                                                               |
| 11  | Full functional testing: suites, assertion catalogue, scripting, data | Both | XL                   | phase 2        | After the runner has proved the CI story.                                                                                                  |
| —   | Load testing, WSDL coverage and refactoring, code generation, TCP monitor | —    | XL                   | phase 4        | Deferred indefinitely; other tools do these better.                                                                                        |
| —   | Hosted cloud                                                         | Ent  | a business           | idea           | Only with a company behind it; see [Teams and sign-in](#teams-and-sign-in).                                                                |

## By theme

### Release and distribution

- **Signing.** macOS needs a Developer ID Application certificate and notarisation through the Apple
  Developer Program. Windows can use SignPath Foundation's free open-source programme or Azure Artifact
  Signing; a traditional CA certificate is the most expensive route and the most awkward in CI. The
  secrets are listed in `docs/release.md`; the workflow already skips signing for any that are unset.
- **Fleet installation.** Document the NSIS installer's silent mode; produce an MSI if Intune-managed
  customers require one.
- **Supply chain.** A CycloneDX SBOM and GitHub build attestations attached to every release.
- **Managed preferences.** A policy file at a system location that locks the proxy, CA bundle and update
  settings for managed machines.
- **Localisation.** English only today.

### Documentation site

- **Content.** Install and first run per OS (including the unsigned-app steps until signing lands); a
  ten-minute walkthrough; one guide per feature area (requests and editors, environments and property
  expansion with a scope table, MTOM and SwA attachments, Basic and NTLM auth, WS-Security with keystores
  and the incoming inspector, WS-Addressing, proxy and TLS, history and diff, WS-I validation, generated
  documentation, Update Definition, shortcuts); reference pages for the project folder format
  (ADR-0003), every preference, and the command and shortcut list; troubleshooting and FAQ; the existing
  security, release and contributing pages moved over.
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
folder, are the bridges to teams that need no server. Still parked:

- **Multi-window.** The workspaces design (`docs/specs/2026-09-11-wirebench-workspaces-design.md`
  §1, assumption 7) deliberately keeps one window holding one open workspace at a time. Several
  workspaces open at once, each in its own window, is a natural next step but changes how main's
  singletons (the open `WorkspaceService`, dialog picks) are scoped, so it is left as a
  follow-up rather than folded into workspaces v1.
- **Workspace sharing/syncing.** Nothing propagates a workspace's projects or environments to
  another machine or another person today — a workspace is one user's local app-data folder.
  Export/link/import are the only way a project crosses machines, one project at a time. Sharing
  a whole workspace (its environments, its project set) is a deliberately deferred idea, not a
  gap in what shipped (`docs/adr/0006-workspaces-in-app-data.md`, Consequences); see
  [Teams and sign-in](#teams-and-sign-in) for the networked version of this.

### Environments

Shipped: the Environments view (activity bar → left menu, its own editor page), a per-variable
enabled checkbox, and the `disabled` list format bump
(`docs/specs/2026-09-12-wirebench-layout-and-environments-design.md`). Parked:

- **Initial value / Current value split.** Postman-style: a variable's committed value versus a
  session-only override that never touches disk. Deliberately deferred at spec time (`docs/specs/
  2026-09-12-wirebench-layout-and-environments-design.md` §12, question 1) — it needs a
  session-only value store in main and a further format decision, and is a candidate for a later
  spec rather than something this pass should fold in.

### Compatibility and adoption

- **JKS keystores.** PKCS#12 and PEM are supported today.
- **HTTP/2.** Evaluate making it the default once enough servers negotiate it cleanly.
- **Same-host `http://` → `https://` 301 on a POST.** Wirebench does not follow redirects on send by
  default, because `fetch`/undici semantics downgrade a redirected POST to a GET, which would silently
  turn a SOAP call into a page fetch and lose the envelope. That is the right default, but a same-host,
  same-path upgrade is common enough (the `tempconvert` interop fixture is a live example) to deserve a
  purpose-built case: either preserve the method and body across exactly that redirect shape, or detect
  it and surface a Problem saying the request was declined. Which of the two, and how narrow "same-host,
  upgrade-only" needs to be, is a design decision a bug-fix pass should not make in passing.

### Authentication

- **Kerberos/SPNEGO.** Requires the native `kerberos` module as an optional dependency, which the v1
  boundaries make an ask-first decision.
- **SAML tokens.** Form and XML variants in outgoing WS-Security.
- **OAuth2 and Bearer.** Arrived with the REST client, for REST owners. Reusing them from a SOAP
  interface, endpoint or request is still open: the auth model and the inspector are already shared, but
  the project format persists SOAP owners under the narrower `endpointAuthSchema`, and the SOAP send path
  applies only the schemes the transport owns (Basic, NTLM). Widening it means the schema at three sites,
  the engine's `Interface`/`Endpoint`/`RequestDef` auth types, a SOAP-side `applyAuth` for the header and
  query schemes, and main resolving the new references — see §15.11 of the REST client design.

### Automation and CI

- **`wirebench run`.** Runs saved requests against a chosen environment, with assertions for HTTP status,
  SOAP fault or not, XPath/XQuery match, schema compliance and response SLA; JUnit and HTML reports;
  meaningful exit codes; secrets supplied through environment variables so CI never needs a keychain.
- **Full functional testing** follows: test suites, cases and steps, property transfer, data-driven runs,
  sandboxed JS/TS scripting with a typed context, and the full assertion catalogue.
- **MCP server.** Import, list, send and inspect exposed over MCP, with CLI parity, so external agents can
  drive the engine.
- **Plugin API.** An idea only.

### REST client — shipped on `main`

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

**Follow-ups, roughly in the order a real user hits them.** None needs a format change:

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
- **OpenAPI 2.0 (Swagger) import.** Refused today with a clear message; a converter step is the fix
  (spec §15.6).
- **_Update Definition_ for an API**, preserving edited values the way the WSDL one does (spec §15.7).
- **Response validation against the OpenAPI response schema** — the functional-testing phase, with the
  `ajv` ask (spec §15.8).

The test steps and assertions extend to REST in the functional-testing phase; JSONPath is already in
the engine (`xpath/jsonpath.ts`), so assertions can reuse it rather than adding a dependency.

### Mock services

Generated from a WSDL; dispatch by sequence, random, XPath, script or query match; start, stop, on-request
and after-request scripts; serves the WSDL; a headless `wirebench mock`; and recording responses from live
traffic.

### Teams and sign-in

Neither is in the v1 spec, and both differ in kind from every other item here: they need a server that
Wirebench does not have. Four principles bound the design:

1. **The app stays fully usable without an account.** Accounts unlock team features, never the product.
   Forced sign-in is the single reason a large share of a well-known REST client's users moved elsewhere.
2. **Sync is opt-in per workspace, with visible status.** The v1 boundaries forbid network calls the user
   did not initiate; a workspace is never synced on first launch.
3. **The server never holds plaintext secrets.** Team secrets are encrypted to member keys and decrypted
   locally; the keychain-only model gains a second path, it does not lose the first.
4. **The workspaces spec lists network sync as a non-goal.** It gets a follow-up spec, not a rewrite; the
   shipped ULID entity ids and per-project files are what make a sync protocol possible later.

| Route                       | What it is                                                                                                                                                        | Size            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Git-native teams            | Project folders kept in a git repository and linked into each member's workspace. Roles are repository permissions, history is git history, each member supplies their own secrets. The linking, importing and exporting shipped in 1.1.0; what remains is a documented recipe and a way to share the workspace-level environments that sit beside those projects. | S remaining     |
| Self-hosted Wirebench Server | An open-source service (Node, Postgres): accounts and organisations, roles, shared workspaces with sync, a secrets vault, OIDC and SAML SSO, SCIM, an audit log. | XL              |
| Hosted cloud                | The same server run as a service: billing, uptime, support, and eventually a SOC 2 report.                                                                        | a business      |

### Deferred (phase 4)

Load testing with strategies, load assertions and live charts; WSDL coverage; the WSDL refactoring
wizard; code generation; a TCP monitor proxy.

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

| Audience   | Already there                                                                                                                                                                                                                                                                 | Missing                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Developer  | Schema-aware XML editing with go-to-definition; XPath 3.1 and XQuery 3.1 on responses; persistent searchable history with diff; cURL both ways; workspaces with shared environments and one environment switch; property expansion across every scope; manual save with per-tab dirty marks; generated documentation; keyboard-first shell. | REST in the same project; scripting; the MCP surface; a user guide.                                                              |
| Enterprise | Secrets in the OS keychain and never in project files; git-friendly project folders that link into a workspace; TLS verification on by default with a persistent badge when bypassed; complete WS-Security both ways; NTLMv2, client certificates, authenticated proxies, custom CA bundle; no telemetry; consent-gated updates; Apache-2.0; axe and contrast gates. | Signed builds; Kerberos; a CI runner; MSI and silent install; SBOM and attestations; managed preferences; SSO and team sharing. |

## Departures from the v1 spec

- The CLI runner is pulled ahead of the rest of phase 2, and REST is started before mocks: both widen who
  can adopt the tool, while the full assertion catalogue and mocks deepen it for existing users.
- Workspaces was not in the spec at all and shipped as 1.1.0, ahead of the spec's own "1.1" list
  (Kerberos, JKS, SAML, WS-RM); that list is still open, under the `spec 1.1` status.
- The spec's legacy single-XML project import is dropped. Wirebench has no older format of its own to
  bring forward, and importing other tools' project files is not a goal.
- Signing and distribution, the documentation site, and teams and sign-in are new; the spec does not
  mention them.
- Everything else keeps the phase §14 assigns it.
