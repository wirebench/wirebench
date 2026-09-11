# Roadmap

What Wirebench 1.0 deliberately left out, reorganised by what each item unlocks and in the order it is
worth building. The v1 design (`docs/specs/2026-09-09-wirebench-v1-explore-and-send-design.md`, §14) is
the phase plan this page argues from; where the two differ, [Departures from the v1 spec](#departures-from-the-v1-spec)
says so, and the spec stays authoritative until it is updated. The workspaces spec
(`docs/specs/2026-09-11-wirebench-workspaces-design.md`) is approved and its plan is the next implementation work.

**Legend.** _Who_: Dev (an individual developer's daily use), Ent (what enterprise adoption needs), Both.
_Size_: XS hours · S days · M one to two weeks · L a plan of around fifteen tasks · XL larger than any single
v1 phase. _Status_: where the item stands today.

## Recommended order

| #   | Item                                                                 | Who  | Size                 | Status         | Why here                                                                                                                                  |
| --- | -------------------------------------------------------------------- | ---- | -------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Signed and notarised releases                                        | Ent  | XS                   | follow-up      | Managed Macs and Windows fleets block unsigned apps. Nothing else matters if IT cannot install it.                                          |
| 2   | Documentation site                                                   | Both | S tooling, M content | new            | A 1.0 that people can install but cannot learn sends every question to the issue tracker.                                                  |
| 3   | Workspaces, including git-native teams                               | Both | L                    | specced        | Approved 2026-09-11, 15 tasks. Multi-project with one environment switch; linking a project folder kept in git is the first team story.     |
| 4   | Import of the legacy one-file XML project format                     | Both | M                    | 1.1            | The adoption unlock for teams with years of existing projects. Clean-room, from the file format itself.                                    |
| 5   | CLI runner with basic assertions and JUnit output                    | Ent  | M                    | phase 2 subset | "Runs in CI" is a procurement checkbox, and it turns a manual tool into a pipeline step.                                                   |
| 6   | Sync protocol design                                                 | Ent  | S (a spec)           | new            | Settles change sets, merge rules and the on-disk journal so a server can be added later without reworking workspaces.                     |
| 7   | Kerberos/SPNEGO                                                      | Ent  | M                    | 1.1            | Windows-integrated auth fronts most internal SOAP services in large organisations. Needs a native module, so it needs an explicit ruling.   |
| 8   | REST client, minimum viable                                          | Dev  | L                    | later phase    | Most estates are mixed; a SOAP-only tool loses the "one tool" argument. OpenAPI import follows.                                            |
| 9   | Mock services with record-from-live                                  | Both | L                    | phase 3        | The upstream test system being down is the most common blocker a team has. Recording is the differentiator.                                |
| 10  | MCP server over the engine                                           | Dev  | S                    | idea           | The engine is pure Node with no Electron imports, so this is cheap, and it lets coding agents drive Wirebench.                             |
| 11  | Self-hosted Wirebench Server: sign-in, teams, SSO                    | Ent  | XL                   | new            | OIDC first, SCIM and audit second. The enterprise offer, with data inside their own network.                                               |
| 12  | JKS keystores, SAML tokens, WS-ReliableMessaging                     | Ent  | S each               | 1.1            | Build when a customer asks; each is a niche.                                                                                               |
| 13  | Full functional testing: suites, assertion catalogue, scripting, data | Both | XL                   | phase 2        | After the runner has proved the CI story.                                                                                                  |
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

Specced and planned (`docs/plans/2026-09-11-wirebench-workspaces-plan.md`). A workspace groups projects,
owns environments and a shared property scope, and removes folder picking from the normal flow. Linking a
project folder that lives in git, and exporting an internal project to a folder, are the bridges to teams
that need no server. Parked for after it ships: multi-window; syncing shared environments over a network
(see [Teams and sign-in](#teams-and-sign-in)).

### Compatibility and adoption

- **Legacy project import.** The one-file XML format older SOAP workbenches use: interfaces, requests,
  endpoints and WSS configurations. Implemented from the file format alone, never from another tool's
  source.
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
- **OAuth2 and Bearer.** Arrive with the REST client and are reusable by SOAP requests.

### Automation and CI

- **`wirebench run`.** Runs saved requests against a chosen environment, with assertions for HTTP status,
  SOAP fault or not, XPath/XQuery match, schema compliance and response SLA; JUnit and HTML reports;
  meaningful exit codes; secrets supplied through environment variables so CI never needs a keychain.
- **Full functional testing** follows: test suites, cases and steps, property transfer, data-driven runs,
  sandboxed JS/TS scripting with a typed context, and the full assertion catalogue.
- **MCP server.** Import, list, send and inspect exposed over MCP, with CLI parity, so external agents can
  drive the engine.
- **Plugin API.** An idea only.

### REST client

Collections and requests beside SOAP interfaces in the same project and environments; OpenAPI import;
query, path, form, multipart and body editors; auth reuse; the test steps and assertions extend to REST
with JSONPath and JSON Schema. The engine gains `rest/`, the renderer a REST request editor, and the
reserved `kind: rest` discriminator activates.

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
   plan's ULID entity ids and per-project files are what make a sync protocol possible later.

| Route                       | What it is                                                                                                                                                        | Size            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Git-native teams            | A workspace in a git repository. Roles are repository permissions, history is git history, each member supplies their own secrets. Part of the workspaces plan.   | S               |
| Self-hosted Wirebench Server | An open-source service (Node, Postgres): accounts and organisations, roles, shared workspaces with sync, a secrets vault, OIDC and SAML SSO, SCIM, an audit log. | XL              |
| Hosted cloud                | The same server run as a service: billing, uptime, support, and eventually a SOC 2 report.                                                                        | a business      |

### Deferred (phase 4)

Load testing with strategies, load assertions and live charts; WSDL coverage; the WSDL refactoring
wizard; code generation; a TCP monitor proxy.

### Known limitations carried from 1.0

- The theme screenshot comparison runs on macOS only; the rest of the e2e suite runs on all three OSes.
- The `xmlsec1` cross-check is skipped locally unless `WIREBENCH_REQUIRE_XMLSEC=1`; CI always runs it.
- The interop suite covers four public services, not five: one was unreachable when fixtures were captured.
- English only.

## Audience fit

| Audience   | Already there                                                                                                                                                                                                                                                                 | Missing                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Developer  | Schema-aware XML editing with go-to-definition; XPath 3.1 and XQuery 3.1 on responses; persistent searchable history with diff; cURL both ways; environments and property expansion; generated documentation; keyboard-first shell.                                            | Workspaces; REST in the same project; scripting; the MCP surface; a user guide.                                                  |
| Enterprise | Secrets in the OS keychain and never in project files; git-friendly project folders; TLS verification on by default with a persistent badge when bypassed; complete WS-Security both ways; NTLMv2, client certificates, authenticated proxies, custom CA bundle; no telemetry; consent-gated updates; Apache-2.0; axe and contrast gates. | Signed builds; Kerberos; a CI runner; MSI and silent install; SBOM and attestations; managed preferences; SSO and team sharing. |

## Departures from the v1 spec

- The CLI runner is pulled ahead of the rest of phase 2, and REST is started before mocks: both widen who
  can adopt the tool, while the full assertion catalogue and mocks deepen it for existing users.
- Signing and distribution, the documentation site, and teams and sign-in are new; the spec does not
  mention them.
- Everything else keeps the phase §14 assigns it.
