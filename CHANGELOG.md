# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Workspaces.** Wirebench now groups any number of projects into a workspace stored under
  Electron's `userData`, with no folder to manage — the launch picker creates or opens one by
  name. A workspace holds its own environments, shared by every project it contains, with a
  `${#Workspace#…}` property scope; an interface's effective endpoint is the workspace
  environment's override, falling back to a linked project's own (name-matched) environment,
  then the interface's default. *Link existing project folder…* and *Import project folder…*
  bring an external project in for teams that keep it in git; *Export project…* writes it back
  out. Removing a project is trash-only and confirmed; a linked project's folder is never
  touched. Tabs, the explorer, and History span every project in the open workspace, and the
  last-open workspace (with its tab set) reopens on launch.

### Removed

- **Opening or creating a project by picking a folder.** The Welcome-screen "Open Project…" and
  folder-picker "New Project" flows are gone; a project is now created by name inside a
  workspace, and a folder dialog only appears for linking, importing or exporting a project.

## [1.0.0] - 2026-09-11

First release: **Explore & Send**. Import a WSDL, understand it, build a request from the
contract, send it with whatever the service demands, and read the answer.

### Added

**WSDL and XSD**

- WSDL 1.1 parsing with `wsdl:import`, `xs:import` and `xs:include` resolved recursively from
  URLs or the filesystem, with a byte-exact local cache and a manifest recording origin and
  sha256.
- Schema sets over the imported documents: type resolution, substitution groups, element and
  attribute lookup, and position-aware queries used by editing and completion.
- Interface viewer, generated documentation, definition export, and Update Definition — which
  re-fetches a contract, reports what changed per operation, and can keep edited values.

**Request generation**

- A sample request for every operation: document/literal (wrapped and bare), rpc/literal and
  rpc/encoded, SOAP 1.1 and 1.2, header parts, `xsi:type` for abstract types, enumeration
  comments, optional-element and sample-value toggles, and the correct SOAPAction spelling per
  version.
- A form model over the same schema, so a request can be filled in as fields instead of XML and
  round-trips back to the envelope.
- `curl` import and export.

**Sending**

- HTTP over undici with raw request and response bytes captured, a timing breakdown, redirects,
  compression, encodings, per-request timeouts and mid-flight cancellation.
- Authentication: HTTP Basic (preemptive and on challenge) and NTLMv2, per request or per
  endpoint, with override/complement semantics.
- TLS: custom trust anchors and client certificates per endpoint, an SSL Info inspector, and a
  per-endpoint (never global) option to send to an endpoint whose certificate does not verify,
  badged permanently in the UI.
- Proxy support, including proxy authentication.

**WS-Security, WS-Addressing, attachments**

- Outgoing: Timestamp, UsernameToken (text and digest), Signature with the full key-identifier
  matrix (RSA-SHA256 and legacy options), and Encryption (AES-256-GCM with RSA-OAEP, plus legacy
  CBC). Verified against `xmlsec1` in CI.
- Incoming: signature verification and decryption, with a WSS inspector showing the result.
- PKCS#12 and PEM keystores, with passphrases held in the OS keychain.
- WS-Addressing headers for both versions, auto-enabled from `wsaw:UsingAddressing`.
- MTOM/XOP and SwA attachments, inline `file:` and `cid:` references, and response attachments
  listed and openable.

**Validation**

- XSD validation of requests and responses via libxml2 (WASM), with problems mapped to exact
  line and column markers.
- A WS-I Basic Profile subset check for both WSDLs and messages, with assertion ids, an HTML
  report export, and the implemented list published in `docs/ws-i-assertions.md`.

**Projects, environments, history**

- Folder-based project format (`formatVersion: 1`): YAML for configuration, XML for envelopes,
  one concept per file, stable key order — renaming a request touches exactly two files.
- Environments with per-environment endpoints and properties; property expansion across global,
  project, environment and request scopes, with unresolved expansions surfaced in Problems.
- History of every send, outside the project folder, with re-send and diff, surviving restart.
- Secrets in `safeStorage` behind `secretRef` ids; no secret ever reaches a project file, a log,
  an export or the renderer.

**The IDE shell**

- Sidebar with explorer, search, history, trust and settings views; editor tabs; a details panel;
  a console with HTTP log, problems, WS-I report and errors; a status bar.
- Monaco everywhere text is edited, with XML, Form, Outline and Raw views for requests and an
  additional Query view (XPath 3.1 and XQuery 3.1) for responses.
- A command palette listing every command, full keyboard navigation of the import→send flow, and
  dark and light themes with a contrast-checked token palette.

**Quality and release**

- `pnpm check` (lint, typecheck, docs check, contrast check, tests, performance budgets) on
  macOS, Windows and Linux in CI, with the engine held at ≥ 85% coverage.
- A Playwright suite driving the built app — and, in `packaged.spec.ts`, the packaged one.
- An `xmlsec1` cross-check job, and a nightly interop suite against four live public services.
- electron-builder packaging for all three platforms with six hardened Electron fuses, an opt-in
  consent-gated update check, and a tag-driven draft-release workflow.
- Documentation: quick start with screenshots, architecture overview, security model, ADR-0001 to
  ADR-0005, and a success-criteria evidence table.

### Known limitations

- The theme screenshot comparison runs on macOS only; the rest of the e2e suite runs on all three
  platforms.
- The `xmlsec1` cross-check needs `xmlsec1` installed, so locally it is skipped unless
  `WIREBENCH_REQUIRE_XMLSEC=1`; CI always runs it.
- The interop suite covers four public services, not five: crcind's SOAP.Demo was unreachable both
  when fixtures were captured and when the suite was written.
- Keystores are PKCS#12 and PEM; JKS is planned. NTLM is NTLMv2 only; SPNEGO/Kerberos is planned.
- English only.

<!-- The `v1.0.0` tag does not exist yet; both links resolve once it is pushed (see docs/release.md). -->
[Unreleased]: https://github.com/wirebench/wirebench/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/wirebench/wirebench/releases/tag/v1.0.0
