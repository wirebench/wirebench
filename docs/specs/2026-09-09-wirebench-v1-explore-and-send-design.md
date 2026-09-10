# Wirebench v1 — Explore & Send

**Date:** 2026-09-09
**Status:** Approved 2026-09-09 (rev 1). §16 open questions resolved to their bold defaults; change any by editing this doc first.
**Scope:** whole product, first release — WSDL import → request generation → editors → send → inspect → validate. Functional testing, mocks, load tests are later phases (§14).
**Plan:** `docs/plans/2026-09-09-wirebench-v1-explore-and-send-plan.md`
**Living document:** update this file before implementing any change of scope or design.

---

## 1. Objective

**What.** An open-source, cross-platform desktop workbench for SOAP/WSDL services with the same or greater capabilities than SoapUI's SOAP feature set (https://www.soapui.org/docs/soap-and-wsdl/), wrapped in a modern IDE shell modeled on the Claude Code desktop app (sidebar, tabbed editors, bottom console, command palette, keyboard-first, dark theme).

**Why.** SoapUI Open Source is a Java/Swing app: slow start, one giant XML project file with plaintext passwords, no environments, XPath 2.0 only, EUPL-licensed, and effectively in maintenance mode. Teams that still run SOAP (banking, telco, government, ERP integrations) need a fast, git-friendly, native-feeling tool.

**Who.** Integration/backend engineers and QA engineers testing SOAP services; developers exploring third-party WSDLs.

**Decisions already made (from kickoff Q&A on 2026-09-09).**
| Decision | Choice |
|---|---|
| "Like Claude Code IDE" means | IDE *layout and feel* only. **No AI/LLM features in the product.** |
| Stack | Electron + TypeScript + React |
| First release scope | **Explore & Send** (WSDL import → request generation → editors → send → inspect → validate). Functional testing, mocks, load tests come in later phases. |
| Audience / distribution | Open-source product: public repo, permissive license, macOS/Windows/Linux builds via CI, auto-update. |
| Name | **Wirebench** (chosen 2026-09-09). Protocol-neutral because a REST/HTTP client "like Postman" is planned (§14). npm scope `@wirebench/*`, bundle id `io.wirebench.desktop`, domain wirebench.io (free at time of check). Repo folder renamed to `wirebench` on 2026-09-09. |

**User stories (v1).**
1. As an integration engineer, I import a WSDL by URL or file (including nested `wsdl:import` / `xsd:import` / `xsd:include`) and browse services, bindings, operations, and schema types.
2. I open a generated sample request, edit it in XML or Form view, pick an endpoint, press ⌘⏎, and see the response with status, timing, size, headers, and raw bytes.
3. I attach a file with MTOM and reference it with `cid:`; the service receives a valid XOP package.
4. I configure WS-Security (UsernameToken + Timestamp + Signature from my PKCS#12) once at project level and apply it to any request.
5. I validate a request or response against the WSDL schema and see errors in the editor gutter.
6. I run WS-I Basic Profile checks on an interface and export the report.
7. I save the project as a folder, commit it to git, and a colleague opens it. No secrets are in the folder.
8. I switch environment (dev → uat) and endpoints/properties change accordingly.
9. I find any previously sent request in History and re-send or diff it.

**Non-goals (v1).** Functional testing (TestSuites/assertions), mock services, load testing, WSDL coverage/refactoring, code generation, REST/HTTP client (planned later, §14), GraphQL/JMS/JDBC/AMF, Groovy compatibility, WSDL 2.0, SoapUI project import (phase 1.1), plugin API, AI features, telemetry.

---

## 2. Parity matrix (SoapUI SOAP/WSDL → Wirebench)

Legend: **v1** = first release · **1.1** = fast-follow · **v2/v3/v4** = later phases (§14) · **✚** = beyond SoapUI OSS.

| SoapUI capability | Wirebench | Notes |
|---|---|---|
| Import WSDL from URL/file; multiple services/ports/bindings | v1 | Full `wsdl:import`, `xsd:import`/`include`, relative + absolute locations, HTTP auth for fetching |
| WSDL caching ("Cache Definition") | v1 | Exact bytes cached in project folder; toggle per interface |
| Update Definition (create new / recreate / keep existing / keep headers / backups / update test requests) | v1 (except test requests → v2) | |
| Export Definition (incl. imported docs) | v1 | Rewrites `schemaLocation`/`location` to relative paths |
| Generate HTML documentation | v1 | Also Markdown ✚ |
| Interface editor: Overview, Service Endpoints, WSDL Content (navigable), WS-I Compliance | v1 | |
| Interface Viewer / schema browser (Pro) | v1 ✚ | Element/type/namespace navigation; "go to definition" from XML |
| Sample request generation (optional elements, type comments, sample values, headers) | v1 | document/literal wrapped+bare, rpc/literal, rpc/encoded, SOAP 1.1 + 1.2 |
| Request actions: Submit, Recreate, Create Empty, Clone, Cancel, endpoint dropdown | v1 | |
| Editors: XML, Raw, Outline (Pro), Form (Pro), Overview (Pro) | v1 | Monaco-based XML editor |
| Editor layout: split/tabs, horizontal/vertical | v1 | |
| XML editor actions: Validate, Format, Add WSS-Username Token, Add WS-Timestamp, Outgoing WSS, WS-A headers, Save as / Load from, Go to line | v1 | |
| HTTP headers (custom, override standard, property expansion) | v1 | |
| Attachments: MTOM (`cid:`), SwA, swaRef, inline files (`file:`), cached/non-cached, part binding, response attachments | v1 | |
| Auth: Basic, NTLM (preemptive toggle, domain) | v1 | NTLMv2 implemented in engine (§15 risk) |
| Auth: SPNEGO/Kerberos | 1.1 | Needs native `kerberos` module |
| WS-Security outgoing: Timestamp, UsernameToken, Signature, Encryption | v1 | |
| WS-Security outgoing: SAML (form/XML) | 1.1 | |
| WS-Security incoming: decrypt, verify signature; WSS inspector | v1 | |
| Keystores/truststores | v1 (PKCS#12, PEM) · 1.1 (JKS) | |
| WS-Addressing (WS-A tab, versions, auto-detect from WSDL policy) | v1 | 2005/08 and 2004/08 |
| WS-ReliableMessaging | 1.1 | |
| SSL Info inspector; client certificates; custom CA | v1 | |
| Proxy (none/system/manual + excludes) | v1 | |
| HTTP log, error log | v1 | |
| Request properties (timeout, encoding, MTOM flags, inline files, remove empty content, entitize, pretty print, strip whitespace, WS-A, dump file, max size, bind address, follow redirects, SOAPAction skip) | v1 | |
| Preferences (HTTP, proxy, SSL, WSDL, WS-I, editor, UI) | v1 | |
| Property expansion `${#Project#x}`, `${#Global#x}`, `${#System#x}` | v1 | plus `${#Env#x}` ✚ |
| Environments (Pro) | v1 ✚ | endpoint + property overrides |
| Request history (persistent, searchable, re-send, diff) | v1 ✚ | |
| XPath/XQuery scratchpad on response | v1 ✚ | XPath 3.1 / XQuery 3.1 (SoapUI: XPath 2.0 / XQuery 1.0) |
| Copy as cURL / import cURL | v1 ✚ | |
| Git-friendly project folder; secrets in OS keychain | v1 ✚ | SoapUI: one XML with plaintext passwords |
| WS-I Basic Profile 1.1 validation (WSDL + message) | v1 (documented subset) | Full assertion port is "ask first" (§12) |
| SoapUI project (`*-soapui-project.xml`) import | 1.1 | |
| TestSuites/TestCases/TestSteps, all assertion types, property transfer, data-driven, scripting, CLI runner + reports | v2 | Scripting in sandboxed JS/TS, not Groovy |
| MockResponse test step (async services) | v2 | |
| Mock services (dispatch: sequence/random/XPath/script/query-match; start/stop/OnRequest/AfterRequest scripts; headless runner) | v3 | WAR export replaced by standalone runner |
| Load testing, WSDL coverage, WSDL refactoring, code generation, TcpMon | v4 | |

---

## 3. Tech stack

| Layer | Choice | Version (2026-09-09) | License | Why |
|---|---|---|---|---|
| Runtime | Electron | 44.x | MIT | Same family as Claude Code desktop; mature packaging/updates |
| Language | TypeScript (strict) | 7.x | Apache-2.0 | |
| Package manager / workspaces | pnpm | 9.x (installed 9.13.2) | MIT | Monorepo: engine + desktop |
| Build | electron-vite + Vite | 5.x / 7.x | MIT | HMR for renderer, bundles main/preload |
| UI | React | 19.x | MIT | |
| Editor | monaco-editor + @monaco-editor/react | 0.56 / 4.7 | MIT | VS Code editor experience (find/replace, folding, minimap, markers) |
| State | zustand + immer | 5.x / 11.x | MIT | Small, testable slices per feature |
| Styling | Tailwind CSS v4 + design tokens; Radix UI primitives; lucide-react icons | 4.x / 1.x | MIT/ISC | Accessible primitives, fast iteration |
| Layout | react-resizable-panels; react-arborist (virtualized tree); cmdk (command palette); @tanstack/react-virtual | 4.x / 3.x / 1.x / 3.x | MIT | |
| XML DOM | @xmldom/xmldom | 0.9.x | MIT | Namespace-aware DOM shared by xml-crypto/xml-encryption |
| XPath/XQuery | fontoxpath | 3.34.x | MIT | XPath 3.1 + XQuery 3.1, pure JS |
| XSD validation | xmllint-wasm (libxml2) | 5.x | MIT | XSD 1.0 validation, no native build |
| WS-Security | xml-crypto (XML-DSig), xml-encryption (XML-Enc), node:crypto | 6.x / 6.x | MIT | |
| HTTP | undici (Agent/ProxyAgent, TLS options, timings via diagnostics_channel) | 8.x | MIT | Raw control over headers, bodies, connection reuse (NTLM needs affinity) |
| NTLM | in-engine NTLMv2 (js-md4 for MD4) | 0.3.x | MIT | No maintained NTLM lib for undici |
| Serialization | yaml; zod (schemas for project files + IPC) | 2.9 / 4.x | ISC / MIT | |
| Tests | vitest (+ @vitest/coverage-v8), @testing-library/react, @playwright/test (Electron) | 5.x / 16.x / 1.63 | MIT/Apache | |
| Lint/format | eslint 10 + typescript-eslint 8 (type-checked), prettier 3 | | MIT | |
| Packaging/updates | electron-builder, electron-updater | 26.x / 6.x | MIT | DMG/ZIP, NSIS/MSIX, AppImage/deb/rpm |
| CI | GitHub Actions (assumed, see §16) | | | 3-OS matrix |

Toolchain present on the dev machine: Node 24.11, pnpm 9.13, Rust 1.95 (unused), Java 25 + Maven (unused; only for optional interop harnesses), Python 3.13 (unused).

Explicitly rejected: Tauri (Rust XML-DSig/XML-Enc immaturity), Java desktop (UI feel), JVM sidecar (two runtimes to ship), CodeMirror (Monaco gives the VS Code feel for free), fast-xml-parser as primary DOM (lossy namespaces), saxon-js (no XQuery, non-OSS license), libxmljs2 (native module).

---

## 4. Architecture

```
┌──────────────────────────────── Electron ─────────────────────────────────┐
│ Renderer (sandboxed, contextIsolation, no Node)                            │
│   React UI · zustand stores · Monaco · calls window.wirebench.* (preload)    │
│                          ▲ typed IPC (zod-validated)                      │
│ Preload: contextBridge exposes a typed, narrow API (no ipcRenderer leak)   │
│                          ▲                                                 │
│ Main: windows/menus/dialogs · project files · keychain (safeStorage) ·     │
│       EngineService (in-process in v1; interface allows utilityProcess)    │
└───────────────────────────────────────────────────────────────────────────┘
                              ▲ plain TS API
                  packages/engine  (@wirebench/engine — Node-only, zero Electron/DOM deps)
                  wsdl · xsd · soap · http · wss · wsa · validate · project · xpath
```

Principles.
- **Engine is a library.** Everything protocol-related lives in `packages/engine`, is unit-testable without Electron, and will power the phase-2 CLI runner unchanged.
- **Protocol-neutral core.** Engine modules are per protocol (`soap/` now, `rest/` later); project and history models carry a `kind` discriminator (`soap` in v1, `rest` reserved) and the HTTP, auth, TLS, proxy, environments, properties, and history layers are protocol-agnostic, so adding a Postman-style REST client later is a new module and new editors, not a format migration.
- **Renderer never touches the network, filesystem, or secrets.** All side effects go through main via typed IPC channels defined in one file (`apps/desktop/src/shared/ipc.ts`), each with a zod request/response schema.
- **Immutable domain model.** Parsed WSDL/XSD model objects are `readonly`; UI state derives from them.
- **Secrets never enter the project folder.** Passwords, keystore passwords, and tokens are stored via Electron `safeStorage` in app data and referenced by `secretRef: "sec_…"` ids.
- **Electron security baseline.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP, `webSecurity` on, no remote content, navigation blocked, `shell.openExternal` only for http(s) after allow-list.
- **Cancellable, observable operations.** Long engine ops (import, send, validate) take an `AbortSignal` and emit progress events; UI shows progress and offers cancel.

---

## 5. UI: Claude Code-style IDE shell

```
┌ ● ● ●  wirebench · CountryInfo ─────────────── ⌘K Search or run a command ──────────── ◐ ─┐
├──┬────────────────┬──────────────────────────────────────────────────────┬────────────────┤
│  │ EXPLORER       │ [CountryInfo.wsdl] [ListOfCountryNamesByCode ×] [+]  │ DETAILS        │
│⌂ │ ▾ CountryInfo  │ ┌ Request ────────────┐ ┌ Response ─── 200 · 143ms ─┐ │ Endpoint      │
│⌕ │   ▾ Endpoints  │ │ XML│Form│Outline│Raw │ │ XML│Outline│Raw│Query     │ │ SOAP 1.1     │
│↺ │   ▾ Operations │ │ <soapenv:Envelope…   │ │ <soap:Envelope…           │ │ Action: ""    │
│⚙ │     ▸ Capital… │ │                      │ │                           │ │ Auth: Basic   │
│  │     ▾ ListOf…  │ │                      │ │                           │ │ WSS: prod-sig │
│  │       Request1 │ ├ Headers│Attach│Auth│WS-A│SSL ┤ ├ Headers│Attach│WSS│SSL ┤ │ Props …    │
│  │ ▾ Environments │ └──────────────────────┘ └───────────────────────────┘ │               │
│  │   dev · uat    ├──────────────────────────────────────────────────────┴────────────────┤
│  │ ▾ WS-Security  │ CONSOLE  HTTP Log │ Problems (2) │ WS-I Report │ Errors                │
│  │   outgoing…    │ 12:01:03 POST http://webservices.oorsprong.org/… 200 143ms 1.2 KB      │
├──┴────────────────┴───────────────────────────────────────────────────────────────────────┤
│ ● dev · TLS 1.3 · last: 200 in 143 ms · 1.2 KB                                  Ln 12 Col 8│
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Activity bar** (left edge): Explorer, Search (find in project), History, Settings.
- **Sidebar**: project tree (Interfaces → Endpoints / Operations → Requests; Environments; WS-Security configs; Properties). Context menus mirror SoapUI's interface/operation/request actions.
- **Editor area**: tabbed editors — Request editor (request/response split, toggle split/tabs and horizontal/vertical), Interface editor (Overview · Endpoints · WSDL Content · Schema · WS-I), Environment editor, WSS config editor, Preferences.
- **Details panel** (right, toggleable): properties of the selected node with inline editing (SoapUI's Properties inspector).
- **Console** (bottom, toggleable): HTTP Log (raw request/response, timings), Problems (validation/WS-I with click-to-navigate), WS-I Report, Errors.
- **Command palette** (⌘K / ⌘⇧P): every action is a command with an id, label, shortcut, and context; menus and context menus are generated from the same command registry.
- **History** view: every sent request (time, endpoint, operation, status, duration); open, re-send, compare (diff) with current.
- **Status bar**: active environment, TLS state of last call, last status/duration/size, cursor position.
- **Theme**: dark default (near-black surfaces, warm accent, subtle borders), light theme, follows OS; monospace for XML, system UI font; respects reduced motion; every control keyboard reachable with visible focus.
- **Shortcuts (default)**: ⌘⏎ send · Esc cancel · ⌘K palette · ⌘P quick-open operation/request · ⌘⇧F format XML · ⌘⇧V validate · ⌘S save project · ⌘W close tab · ⌘B toggle sidebar · ⌘J toggle console · ⌘\ toggle split · ⌥←/→ next/prev element value (SoapUI parity) · ⇧Tab request↔response focus.

---

## 6. Functional scope, v1 (detailed)

### 6.1 WSDL import and interface management
- Sources: URL (with optional Basic/NTLM auth for fetching, proxy honoured), local file, drag-drop, paste.
- Resolves `wsdl:import`, `xsd:import`, `xsd:include`, `xsd:redefine` (import only; redefine flagged unsupported), chameleon includes, relative/absolute locations, HTTP redirects; detects cycles.
- Model: definitions → types (schema set) → messages/parts → portTypes/operations (in/out/fault, parameterOrder) → bindings (SOAP 1.1/1.2, style document/rpc, use literal/encoded, transport, soapAction, header/headerfault parts, mime multipart parts) → services/ports (addresses). WS-Policy attachments parsed for WS-Addressing (`wsaw:UsingAddressing`, `wsam:Action`, policy `Addressing`) only; other policies surfaced as raw XML.
- Cache Definition on/off per interface; cached files stored byte-exact under `interfaces/<name>/definition/` with a `manifest.yaml` mapping original locations.
- Update Definition dialog with SoapUI's options (create new requests, recreate requests, recreate optional, keep existing values, keep SOAP headers, create backups, open request list). Value-preserving merge uses element paths.
- Export Definition to a folder; Generate Documentation (HTML + Markdown).
- Interface editor tabs: Overview (URL, target namespace, SOAP version, style/use, WS-A detection), Endpoints (add/edit/remove; default auth per endpoint: username/password/domain/WSS/mode override|complement), WSDL Content (each document, navigable, syntax highlighted), Schema (browse namespaces → elements/types/groups; jump from XML editor to definition), WS-I Compliance (run + report).

### 6.2 Request generation
- One sample request per operation on import ("Request 1"); any number of requests per operation; clone/rename/delete.
- Generator follows SoapUI's SampleXmlUtil behaviour: sequence/choice(first branch, others commented)/all, groups, attributes, `minOccurs=0` elements included only with "Create optional" (default from preferences), `maxOccurs>1` emits one instance + comment (`<!--Zero or more repetitions:-->`), enumerations listed in comments, restrictions honoured for sample values (`?` placeholder by default, or type-appropriate samples when "Sample values" preference on), abstract/derived types via `xsi:type`, substitution groups, `nillable`, `anyType`/`any` comments, recursion depth limit, soapenc arrays for rpc/encoded, SOAP header parts from binding into `soapenv:Header`, correct SOAPAction / `action=` parameter for SOAP 1.2.
- Actions: Recreate request (with keep-values option), Create Empty, Clone, Add WSS-Username Token, Add WS-Timestamp.

### 6.3 Request editor
- Views: **XML** (Monaco; XML highlighting, folding, find/replace, go to line, line numbers, format, validate with gutter markers, autocomplete of child elements from schema ✚), **Form** (schema-driven: required/optional, enum dropdowns, date/time/number editors, repeat add/remove, "hide empty/optional" view types, Get Data → insert property expansion), **Outline** (tree of elements with schema type column; edit values; no add/remove, SoapUI parity), **Raw** (exact bytes sent incl. HTTP headers and MIME parts, after property expansion and WSS/WS-A processing).
- Response views: XML (formatted, read-only), Outline, Raw (exact bytes received), **Query** ✚ (XPath 3.1/XQuery 3.1 evaluation with namespace panel; results as values or highlighted nodes), Overview for faults (code/reason/detail rendered).
- Toolbar: Submit, Cancel, Recreate, Create Empty, Clone, Copy as cURL, Endpoint dropdown (edit/add/delete), layout toggles.
- Inspectors (request): Headers, Attachments, Auth, WS-A, SSL (client cert selection). Inspectors (response): Headers, Attachments, WSS (processing results), SSL Info (peer chain, protocol, cipher, validity).
- Request properties (Details panel): Name, Description, Encoding, Endpoint, Timeout, Bind Address, Follow Redirects, Username, Password (secretRef), Domain, Authentication Type, WSS-Password Type, WSS TimeToLive, SSL Keystore, Skip SOAP Action, Enable MTOM, Force MTOM, Inline Response Attachments, Expand MTOM Attachments, Disable Multiparts, Encode Attachments, Enable Inline Files, Remove Empty Content, Entitize Properties, Pretty Print, Strip Whitespaces, Dump File, Max Size, WS-Addressing.

### 6.4 Sending
- HTTP/1.1 (HTTP/2 off by default, toggle), gzip/deflate (request compression optional), chunking threshold, keep-alive, connection close option, user-agent, per-request timeout, bind address, redirects, proxy none/system/manual with excludes, TLS: min version, custom CA bundle, client certificate (PKCS#12/PEM) globally or per endpoint, "trust invalid certificate" per endpoint with a persistent warning badge.
- Auth: None, Basic (preemptive toggle), NTLMv2 (domain\user), endpoint-default credentials with override/complement modes.
- Timing breakdown ✚ (DNS, connect, TLS, TTFB, download) in HTTP log.
- Response size cap (Max Size) with truncation notice; dump to file.
- Cancel at any time; UI never blocks.

### 6.5 Attachments
- Attachments tab columns: Name, Content Type (auto by extension, editable), Size, Part (from WSDL mime parts), Type (XOP/MIME/SWAREF/CONTENT/UNKNOWN), ContentID, Cached.
- MTOM: `cid:` references in base64 elements become `xop:Include`; Force MTOM; response XOP expansion/inlining options.
- SwA (plain + swaRef), anonymous attachments, inline files via `file:` prefix with `ResourceRoot`.
- Cached attachments stored under `attachments/` in the project; non-cached by path.
- Drag-drop files; double-click to open with OS.

### 6.6 WS-Security
- Project-level Outgoing configurations (ordered entries): Timestamp (TTL, millisecond precision), UsernameToken (nonce, created, PasswordText/PasswordDigest), Signature (keystore/alias, key identifier: BinarySecurityToken direct ref / IssuerSerial / SKI / Thumbprint / X509KeyIdentifier; signature algorithm RSA-SHA256 default, RSA-SHA1 legacy; digest SHA-256/SHA-1; canonicalization exclusive; parts by id/name/namespace with Content|Element; single certificate option), Encryption (keystore/alias, key identifier, symmetric AES-128/256-CBC/GCM, key transport RSA-OAEP/RSA-1.5 legacy, parts Content|Element, embed encrypted key). Config metadata: default alias, actor, mustUnderstand.
- Incoming configurations: decrypt keystore, signature truststore; response WSS inspector shows actions found, signature validity, decrypted view, errors.
- Keystores: PKCS#12 and PEM (cert + key, optional chain) with secretRef passwords; alias list; status (loaded/error).
- Apply via Auth inspector (outgoing/incoming selection) or "Outgoing WSS" context action that materialises headers into the XML for inspection.
- Interop verification: signatures/encryption cross-checked with `xmlsec1` in CI (§11).

### 6.7 WS-Addressing
- WS-A inspector: enable, version (2005/08 default, 2004/08), Action, To, MessageID (auto UUID or fixed), ReplyTo, From, FaultTo, RelatesTo, mustUnderstand, generate/remove headers; property expansion in all fields; auto-enable from WSDL policy/`wsam:Action`.

### 6.8 Validation
- Schema validation of request/response against the interface schema set (XSD 1.0 via libxml2): errors with line/column mapped to editor markers and the Problems panel; "auto-validate on send" preference.
- SOAP structure checks: envelope namespace/version, header/body order, fault structure, SOAPAction/Content-Type consistency.
- WS-I Basic Profile 1.1 (documented subset, each check carries the BP assertion id, e.g. R2201, R2210, R2710, R2716, R2803): WSDL-level (styles, use=literal, parts/elements per style, soapAction, imports, namespaces, no soapenc in document/literal) and message-level (envelope, encodingStyle absence, mustUnderstand values, fault detail, HTTP status/Content-Type/SOAPAction quoting). Report view + HTML export. The list of implemented assertions lives in `docs/ws-i-assertions.md`.

### 6.9 Project, environments, properties, history
- Project folder format (§7); recent projects; autosave on change with atomic writes; external change detection (reload prompt).
- Environments: list of named environments; each maps interface → endpoint and overrides properties; active environment in status bar and command palette.
- Properties: Global (app-level), Project, Environment; expansion syntax `${#Project#name}`, `${#Env#name}`, `${#Global#name}`, `${#System#name}` (env vars), nesting allowed; unresolved expansions flagged in Problems.
- History: persisted per project in app data (not in project folder), searchable, capped (default 1000 entries), re-send, diff two responses, clear.
- Preferences: HTTP, Proxy, SSL, WSDL (cache, pretty print, sample values, type comments, include optional, strict schema), WS-I, Editor (font, tab size, line numbers, auto-validate), UI (theme, layout defaults), Shortcuts (rebindable).

---

## 7. Data model and project format

Project = a directory. Everything is UTF-8 text, stable key order, one concept per file, so diffs are reviewable.

```
my-service/                        ← project root (any name)
  wirebench.yaml                     ← manifest: name, formatVersion, settings, property definitions, environment list
  environments/
    dev.yaml                       ← { endpoints: {CountryInfo: "http://…"}, properties: {…} }
  interfaces/
    CountryInfo/
      interface.yaml               ← definitionUrl, cache: true, soapVersion, endpoints[], wsa, defaultAuth (secretRefs only)
      definition/
        manifest.yaml              ← original location → local file map, fetchedAt, sha256
        CountryInfoService.wsdl    ← exact bytes
        types/…xsd
      operations/
        ListOfCountryNamesByCode/
          Request 1.request.yaml   ← endpointRef, headers[], attachments[], auth, wsa, properties (§6.3), wssOutgoingRef
          Request 1.xml            ← the envelope, exactly as edited
  wss/
    outgoing/prod-signature.yaml   ← entries[] (no secrets), keystoreRef
    incoming/default.yaml
    keystores.yaml                 ← id, path (relative or absolute), type, passwordSecretRef
  attachments/                     ← cached attachment bytes, content-addressed (sha256)
```

App data (never in the project): `secrets.json` (safeStorage-encrypted map secretRef → value), `history/<projectId>.jsonl`, `preferences.yaml`, definition cache for non-cached interfaces.

Core engine types (in `packages/engine/src/*/model.ts`): `WsdlDefinition`, `SchemaSet`, `Service`, `Port`, `Binding`, `BindingOperation`, `Operation`, `Message`, `Part`, `SoapVersion`, `Project`, `Interface`, `Endpoint`, `SoapRequest`, `SoapResponse`, `Attachment`, `WssOutgoingConfig`, `WssIncomingConfig`, `Keystore`, `Environment`, `PropertyScope`, `ValidationProblem`, `WsiReport`. All `readonly`; discriminated unions use a `kind` field; ids are ULIDs. `Interface.kind`, `Request.kind`, and history entries are `'soap'` in v1 with `'rest'` reserved, and `interface.yaml` / `*.request.yaml` carry `kind: soap` from the first release.

`formatVersion` is bumped on breaking changes with an in-app migration; opening a newer format shows a clear error.

---

## 8. Commands

```
pnpm install                       # bootstrap workspace (Node 24, pnpm 9)
pnpm dev                           # electron-vite dev: main/preload/renderer with HMR
pnpm build                         # pnpm typecheck && electron-vite build (all workspaces)
pnpm package                       # electron-builder --dir (unpacked app for the current OS)
pnpm package:mac | package:win | package:linux   # signed/notarized when certs are configured (see §16)
pnpm test                          # vitest run (root vitest.config.ts with test.projects) (engine + desktop unit/component tests)
pnpm test:watch                    # vitest (watch, all projects)
pnpm test:coverage                 # vitest run --coverage (engine threshold 85% lines/branches)
pnpm test:e2e                      # playwright test (Electron, uses the built app from pnpm build)
pnpm test:interop                  # WIREBENCH_NETWORK_TESTS=1 vitest run --project engine-interop (public services, opt-in)
pnpm test:wss-xmlsec               # cross-checks generated signatures/encryption with xmlsec1 (requires `brew install libxmlsec1` / apt xmlsec1)
pnpm lint                          # eslint . --max-warnings 0 && prettier --check .
pnpm lint:fix                      # eslint . --fix && prettier --write .
pnpm typecheck                     # tsc -b (project references: engine, desktop main/preload/renderer, e2e)
pnpm check                         # lint + typecheck + test  ← the pre-commit and CI gate
pnpm fixtures:refresh              # re-download public WSDL fixtures into fixtures/wsdl/public (records source + date)
pnpm --filter @wirebench/engine <cmd>   # run any script in a single workspace
```

---

## 9. Project structure

```
wirebench/
  README.md · LICENSE · CONTRIBUTING.md · CHANGELOG.md
  package.json · pnpm-workspace.yaml · tsconfig.base.json · vitest.config.ts · eslint.config.js · .prettierrc · .editorconfig
  .github/workflows/ci.yml         → lint+typecheck+test on ubuntu/macos/windows; e2e; package on tags
  scripts/                         → repo tooling: fixtures refresh, xmlsec1 cross-check, fuses, contrast check
  packages/
    engine/                        → @wirebench/engine — pure TypeScript, Node-only, no Electron/DOM
      src/
        index.ts                   → public API surface (only file other packages import from)
        xml/                       → DOM helpers, namespace context, pretty-printer, line/col mapping, cid/xop utils
        wsdl/                      → parse-wsdl.ts, resolver.ts (imports/includes, cache), model.ts, export-definition.ts, docs-generator.ts
        xsd/                       → schema-set.ts, model.ts, sample-generator.ts, form-model.ts (schema → form descriptors)
        soap/                       → envelope.ts (1.1/1.2), fault.ts, soap-action.ts, mime/ (mtom, swa, inline-files), request-builder.ts, response-parser.ts
        http/                      → client.ts (undici), auth/basic.ts, auth/ntlm.ts, proxy.ts, tls.ts, timings.ts, raw-capture.ts
        wss/                       → outgoing/{timestamp,username-token,signature,encryption}.ts, incoming/{verify,decrypt}.ts, keystore/{pkcs12,pem}.ts, key-identifiers.ts
        wsa/                       → headers.ts, policy-detect.ts
        validate/                  → schema-validator.ts (xmllint-wasm), soap-structure.ts, wsi/ (assertions/*.ts, report.ts)
        project/                   → model.ts, schema.ts (zod), load.ts, save.ts, migrate.ts, environments.ts, properties.ts (expansion), history.ts
        xpath/                     → evaluate.ts (fontoxpath), namespaces.ts
        errors.ts                  → WirebenchError + coded subclasses
      test/
        unit/                      → mirrors src/ (e.g. test/unit/wsdl/parse-wsdl.test.ts)
        integration/               → in-process SOAP test server scenarios
        interop/                   → public-service tests (opt-in)
        fixtures/                  → golden outputs (parsed models, generated samples, signed envelopes)
        helpers/                   → test-soap-server.ts, keystores (test-only, generated), factories
      package.json · tsconfig.json · vitest.config.ts
  apps/
    desktop/                       → @wirebench/desktop — Electron app (electron-vite layout)
      src/
        main/                      → index.ts, windows.ts, menu.ts, ipc/ (one handler file per domain), engine-service.ts, secrets.ts, project-files.ts, updater.ts
        preload/                   → index.ts (contextBridge API), api.d.ts
        shared/                    → ipc.ts (channel names + zod schemas + types), commands.ts (command ids), constants.ts
        renderer/
          main.tsx · app.tsx
          shell/                   → title-bar, activity-bar, sidebar, editor-area, console, details-panel, status-bar, command-palette
          features/
            explorer/ · interface-editor/ · request-editor/ (views, inspectors) · history/ · environments/ · wss/ · preferences/ · problems/
          components/              → reusable UI primitives (button, tabs, tree, table, dialog, toast, split)
          editor/                  → Monaco setup, XML language features (format, markers, completion), themes
          state/                   → zustand stores: project, ui, editors, history, preferences
          lib/                     → renderer utilities, keyboard, theming
          styles/                  → tokens.css, tailwind.css
      resources/                   → icons, entitlements
      electron.vite.config.ts · electron-builder.yml · package.json · tsconfig.*.json
      test/                        → renderer component/store tests (vitest + jsdom)
  e2e/                             → Playwright Electron tests (specs/, fixtures/, helpers/)
  fixtures/wsdl/
    public/                        → downloaded public WSDLs (Calculator, TempConvert, CountryInfo, NumberConversion, SOAP.Demo) + SOURCES.md
    crafted/                       → hand-written: nested imports, chameleon include, rpc/encoded arrays, choice/substitution groups, mime parts, WS-Policy addressing, SOAP 1.2 binding, faults, soap headers
  docs/
    specs/                         → dated design docs, `YYYY-MM-DD-<topic>-design.md` (this spec: 2026-09-09-wirebench-v1-explore-and-send-design.md — source of truth)
    plans/                         → dated implementation plans, `YYYY-MM-DD-<topic>-plan.md`, each linking back to its spec
    adr/                           → ADR-0001-electron-stack.md, ADR-0002-engine-in-main-process.md, ADR-0003-project-folder-format.md, …
    architecture/ · runbooks/ · ws-i-assertions.md · user-guide/
```

---

## 10. Code style

```ts
// packages/engine/src/wsdl/parse-wsdl.ts
import type { WsdlDefinition, WsdlDocumentSource } from './model.js';
import { WsdlParseError } from '../errors.js';
import { parseXml } from '../xml/parse.js';
import { WSDL_NS } from '../xml/namespaces.js';

export interface ParseWsdlOptions {
  /** Fetches a document by absolute URL or file path. Injected so the parser is testable offline. */
  readonly fetchDocument: (location: string, signal?: AbortSignal) => Promise<WsdlDocumentSource>;
  readonly resolveImports: boolean;
  readonly signal?: AbortSignal;
}

/** Parses a WSDL 1.1 document and every transitively imported document into an immutable model. */
export async function parseWsdl(root: WsdlDocumentSource, options: ParseWsdlOptions): Promise<WsdlDefinition> {
  const doc = parseXml(root.text, { location: root.location });
  const definitions = doc.documentElement;
  if (definitions.namespaceURI !== WSDL_NS || definitions.localName !== 'definitions') {
    throw new WsdlParseError('not-a-wsdl', root.location, {
      found: `{${definitions.namespaceURI}}${definitions.localName}`,
    });
  }
  const resolved = options.resolveImports ? await resolveImports(doc, root.location, options) : [doc];
  return buildDefinition(resolved, { targetNamespace: definitions.getAttribute('targetNamespace') });
}
```

```tsx
// apps/desktop/src/renderer/features/request-editor/send-button.tsx
export function SendButton({ requestId }: { readonly requestId: RequestId }) {
  const status = useRequestStore((s) => s.sendStatus[requestId] ?? 'idle');
  const send = useRequestStore((s) => s.send);
  return (
    <Button variant="primary" shortcut="Mod+Enter" disabled={status === 'sending'} onClick={() => void send(requestId)}>
      {status === 'sending' ? 'Sending…' : 'Send'}
    </Button>
  );
}
```

Conventions.
- Files `kebab-case.ts`; types/classes `PascalCase`; functions/vars `camelCase`; constants `SCREAMING_CASE` only for true constants (namespaces, limits). Named exports only; `index.ts` re-exports define a package's public API.
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; no `any` (use `unknown` + narrowing); `import type` for types; discriminated unions over boolean flags; `readonly` on all model fields and arrays.
- Errors: subclass `WirebenchError` with a stable `code` (kebab-case) and `details`; never throw strings; user-facing messages come from `code` via a message table in the renderer.
- Engine: no Electron, no DOM globals, no `process.env` reads outside `config.ts`; every I/O function takes `AbortSignal`; pure functions preferred; max ~50 lines per function, split otherwise.
- IPC: one channel = one zod schema pair; renderer calls `window.wirebench.<domain>.<verb>()`; no `ipcRenderer` exposure.
- React: function components, hooks in `use-*.ts`, one zustand slice per feature, selectors for reads, no prop-drilling deeper than two levels (use a store), all interactive elements accessible (labels, roles, focus order), no inline styles except dynamic sizes.
- Comments explain *why*; JSDoc on every exported engine function; no commented-out code.
- Formatting by Prettier (2 spaces, single quotes, semicolons, 120 columns, trailing commas); lint clean with zero warnings.
- Commits: Conventional Commits (`feat(engine): …`, `fix(renderer): …`); one logical change per commit; no `Co-Authored-By` trailers (user preference).

---

## 11. Testing strategy

| Level | Tool | Location | What it proves |
|---|---|---|---|
| Unit (engine) | vitest | `packages/engine/test/unit` | Parser, schema model, sample generator (golden files per fixture WSDL), MIME/XOP encode/decode, WSS header construction, NTLM message vectors (MS-NLMP examples), property expansion, WS-I assertions, project load/save round-trip |
| Integration (engine) | vitest + in-process Node SOAP test server | `packages/engine/test/integration` | End-to-end send/receive: SOAP 1.1/1.2, faults, gzip, redirects, timeouts/cancel, Basic + NTLM challenge flow (server simulates NTLM), MTOM/SwA round-trip, WSS UsernameToken/Timestamp/Signature/Encryption verified by the server using the same libs *and* by `xmlsec1` (independent implementation) |
| Interop (engine, opt-in) | vitest, `WIREBENCH_NETWORK_TESTS=1` | `packages/engine/test/interop` | Real-world WSDLs and calls: dneonline Calculator, w3schools TempConvert, oorsprong CountryInfo, dataaccess NumberConversion, crcind SOAP.Demo. Skipped in CI by default; run nightly |
| Component (renderer) | vitest + jsdom + Testing Library | `apps/desktop/test` | Stores, form-view generation from schema descriptors, command registry, keyboard handling, IPC client mocks |
| E2E | Playwright (Electron) | `e2e/` | Launch → new project → import fixture WSDL from local test server → open request → edit → send → response shown → history entry → validate → save → reopen; theme switch; command palette; layout toggles. Runs on all three OSes in CI |
| Static | eslint (type-checked), tsc, prettier | CI gate | |
| Performance budgets | vitest bench + e2e timing | | CountryInfo WSDL (37 KB) parse+generate < 300 ms; 5 MB schema set < 3 s; cold start to interactive < 2 s (M1); 1 MB XML editor stays ≥ 50 fps while scrolling; send overhead (engine, excluding network) < 20 ms |

Rules: TDD for engine code (failing test first, then implementation); every bug fix adds a regression test; golden files are updated only through `pnpm test -u` in a dedicated commit with rationale; coverage threshold 85% lines/branches on `packages/engine` enforced in CI; renderer coverage reported, not gated; no test touches the network unless in `interop`; test keystores are generated at test time, never committed.

---

## 12. Boundaries

**Always**
- Run `pnpm check` before every commit; keep CI green on all three OSes.
- Write the failing test before engine code; keep golden fixtures deterministic (fixed UUIDs/timestamps via injected clocks).
- Keep `packages/engine` free of Electron/DOM/renderer imports (enforced by eslint `no-restricted-imports` + a dependency-cruiser check).
- Validate every IPC payload and every project file with zod; treat project files as untrusted input.
- Route all network/file/secret access through main; secrets only via `safeStorage` and `secretRef`.
- Redact `Authorization`, WSS passwords, and decrypted keys from the HTTP log and history unless the user enables "show secrets" for the session.
- Keep TLS verification on by default; any per-endpoint bypass shows a persistent warning.
- Record architecture decisions as ADRs in `docs/adr`; update this design doc when scope or design changes.
- Implement protocol behaviour from the public specs (WSDL 1.1, SOAP 1.1/1.2, XOP/MTOM, SwA, WS-Security 1.1, WS-Addressing, WS-I BP 1.1) and SoapUI's *documentation*, never from SoapUI's source.

**Ask first**
- Adding any runtime dependency, or any native module (`kerberos`, `libxmljs2`, …).
- Changing the project folder format (`formatVersion`), the IPC contract, or default keyboard shortcuts.
- Changing CI, release, signing, or auto-update configuration; changing the license.
- Porting the full WS-I assertion catalogue or bundling third-party test tools.
- Pulling scope from later phases (testing, mocks, load, codegen, SoapUI import) into v1.
- Adding any telemetry, crash reporting, or network calls not initiated by the user.
- Deleting or rewriting golden fixtures, or lowering coverage thresholds.

**Never**
- Commit secrets, real credentials, customer WSDLs, or keystores; commit `.env` files.
- Copy code from SoapUI/ReadyAPI (EUPL) or any GPL/AGPL project.
- Set `nodeIntegration: true`, disable `contextIsolation`/`sandbox`/`webSecurity`, load remote URLs in the app window, or expose `ipcRenderer` to the renderer.
- Ship with certificate verification disabled, log secrets in plaintext, or store passwords in project files.
- Remove or skip failing tests to make CI pass; merge with lint warnings.
- Block the renderer with synchronous IPC or CPU-heavy work on the UI thread.
- Auto-update or send data without explicit user consent.

---

## 13. Success criteria (v1 is "done" when all are true)

1. **Import.** All 5 public fixtures and all crafted fixtures in `fixtures/wsdl` import with zero errors from both URL (via local test server) and file; nested imports/includes resolve; cached definitions are byte-identical to sources; Update Definition preserves edited values when "keep existing" is on (e2e-covered).
2. **Generate.** A sample request is generated for 100% of operations across the fixture set; document/literal (wrapped and bare), rpc/literal, rpc/encoded, SOAP 1.1 and 1.2; optional-element toggle, enumeration comments, `xsi:type` for abstract types, header parts, correct SOAPAction all verified by golden tests.
3. **Send.** A request sent from the UI to the local test server and to at least three live public services returns the response with status, duration, size, headers, raw request/response bytes, and an HTTP log entry with timing breakdown; cancel works mid-flight; timeouts and connection errors surface as readable problems.
4. **Editors.** XML, Form, Outline, and Raw views round-trip edits without loss; format/validate/find/go-to-line work; layout toggles persist; response Query view evaluates XPath 3.1 and XQuery 3.1 with namespaces.
5. **Headers and attachments.** Custom headers override standard ones; MTOM and SwA round-trip through the test server with byte-identical attachments; inline `file:` and `cid:` handling verified; response attachments are listed and openable.
6. **Auth.** Basic (preemptive and challenge) and NTLMv2 succeed against the test server's simulated challenge; endpoint defaults with override/complement behave as documented.
7. **WS-Security.** Timestamp, UsernameToken (text/digest), Signature (all listed key identifiers, RSA-SHA256), and Encryption (AES-256-GCM + RSA-OAEP) produce headers that `xmlsec1` verifies/decrypts; incoming signed+encrypted responses verify/decrypt with the WSS inspector showing results; PKCS#12 and PEM keystores load; passwords never appear in project files (asserted by a test that greps the saved folder).
8. **WS-Addressing.** Headers generated for both versions; auto-enabled for a crafted WSDL with `wsaw:UsingAddressing`; raw view shows them.
9. **Validation.** Schema errors map to correct line/column markers; WS-I subset produces a report with assertion ids for a compliant and a deliberately non-compliant crafted WSDL; HTML report export opens in a browser.
10. **Project and environments.** Save/open/recent work; a git diff after renaming one request touches only that request's two files; switching environments changes the endpoint used in the next send; property expansion resolves across scopes; unresolved expansions appear in Problems.
11. **History.** Every send appears in History; re-send and diff work; history survives restart and lives outside the project folder.
12. **IDE shell.** Sidebar, editor tabs, details panel, console, status bar, command palette with every command searchable, all default shortcuts, dark/light themes, keyboard-only navigation of the main flow (import → send) verified by e2e.
13. **Quality and release.** `pnpm check` green on macOS/Windows/Linux in CI; engine coverage ≥ 85%; performance budgets in §11 met; packaged installers for all three OSes produced by CI from a tag; README quick start lets a new user import a WSDL and send a request in under five minutes; LICENSE, CONTRIBUTING, and ADR-0001..0003 present.

---

## 14. Roadmap (after v1)

- **1.1** SPNEGO/Kerberos (native `kerberos`, optional dependency), WS-ReliableMessaging, SAML tokens (form + XML), JKS keystores, SoapUI project import (interfaces/requests/endpoints/WSS configs), HTTP/2 default evaluation.
- **v2 Functional testing.** TestSuites/TestCases/TestSteps (SOAP Request, Property Transfer, Script in sandboxed JS/TS with typed context, Properties, Conditional Goto, Delay, Run TestCase, MockResponse, DataSource/DataSink/DataGen/Loop), all SoapUI assertions (XPath/XQuery match, Contains/Not Contains, Schema Compliance, SOAP Response, SOAP Fault/Not SOAP Fault, WS-Security Status, WS-A Request/Response, Response SLA, Valid/Invalid HTTP status, Script, Message Content), property transfers, `wirebench run` CLI with JUnit/HTML reports, CI recipes.
- **v3 Mock services.** Generate from WSDL; dispatch sequence/random/XPath/script/query-match; Start/Stop/OnRequest/AfterRequest/response scripts; serve WSDL; headless `wirebench mock`; record responses from live traffic ✚.
- **v4** Load testing (strategies, load assertions, live charts), WSDL coverage, WSDL refactoring wizard, code generation (external toolchains + built-in TypeScript client ✚), TCP monitor proxy.
- **REST/HTTP client, Postman-style (after v2, can run in parallel with v3/v4).** Collections and requests beside SOAP interfaces in the same project and environments; OpenAPI import; query/path/form/multipart/body editors; auth reuse (Basic/NTLM/Bearer/OAuth2); the v2 test steps and assertions extend to REST (JSONPath, JSON Schema). Engine gains `rest/`; renderer gains a REST request editor; `kind: rest` activates the reserved discriminator.
- **Ideas, not committed.** Plugin API; MCP/CLI automation surface so external agents can drive the engine; team sharing of environments.

---

## 15. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Sample generation edge cases (substitution groups, recursive types, rpc/encoded arrays, `xs:any`) | Wrong requests → user distrust | Golden tests per construct in `fixtures/wsdl/crafted`; compare against SoapUI output for the same WSDLs during development (manual) |
| WS-Security interop with WSS4J/WCF/.NET services | Signatures rejected in the field | `xmlsec1` cross-check in CI; key-identifier matrix tests; early beta testers with real services; keep RSA-SHA1/AES-CBC legacy options |
| NTLMv2 in-house implementation | Auth failures on Windows-hosted services | Test vectors from MS-NLMP; simulated server; fallback plan: optional native SSPI module in 1.1 |
| WS-I parity expectations | "Not the same as SoapUI" | Publish the implemented assertion list; report clearly labels scope; full port is a tracked ask-first item |
| Monaco bundle size / startup | Slow cold start | Lazy-load Monaco per editor, code-split features, measure cold start in e2e |
| TypeScript 7 / tooling compatibility | Build breakage | Pin versions; fall back to TypeScript 5.9 if any tool lags (open question) |
| Electron security regressions | Vulnerabilities | Security baseline enforced by tests (`webPreferences` snapshot test) and Electron Fuses |
| Scope creep into testing/mocks | v1 slips | Boundaries §12; parity matrix marks phases |

---

## 16. Open questions (approved with the bold defaults on 2026-09-09)

1. **License:** **Apache-2.0** or MIT?
2. ~~Name/brand~~ **Resolved 2026-09-09: Wirebench** (candidates in §16a). Follow-ups: register wirebench.io and the GitHub org `wirebench`. Repo folder renamed 2026-09-09.
3. **Code signing:** do you have an Apple Developer ID and a Windows code-signing certificate? **Default: unsigned builds in v1 CI; signing wired but disabled.**
4. **Repo hosting/CI:** **GitHub + GitHub Actions**?
5. **Minimum OS:** **macOS 13+, Windows 10 22H2+, Ubuntu 22.04+ / glibc 2.35+**?
6. **Engine placement:** **in main process behind `EngineService`** (ADR-0002) vs. Electron `utilityProcess` from day one?
7. **Keystores in v1:** **PKCS#12 + PEM only**; JKS in 1.1 — acceptable?
8. **NTLM in v1** (in-house NTLMv2) vs. defer with SPNEGO to 1.1? **Default: in v1.**
9. **TypeScript 7** vs. 5.9 if tooling lags? **Default: 7.x, fall back if blocked.**
10. **i18n:** **English-only v1**, strings centralised so translation is possible later?
11. **History cap and retention:** **1000 entries per project, no expiry**?
12. **Auto-update channel:** GitHub Releases feed via electron-updater, **opt-in check on launch**?

### 16a. Name candidates (availability checked 2026-09-09; npm = unscoped package, GitHub = org/user, domains via RDAP)

| Name | Reads as | npm | GitHub | .dev | .app | .io | .com |
|---|---|---|---|---|---|---|---|
| Wirebench | wire protocols (SOAP, REST, gRPC) + workbench | free | free | taken | taken | free | taken |
| Callbench | API calls + workbench | free | free | free | free | free | taken |
| Reqlab | request lab | free | free | free | free | ? (rate-limited) | ? |
| Postbench | post/send + workbench (Postman-adjacent) | free | free | free | taken | free | taken |
| Relaybench | relay + workbench | free | free | ? | ? | ? | ? |

Rejected (taken on npm or GitHub): sendbox, wirehub, reqbench, apibench, wirelab, apilab, envelop.

---

## 17. Decision log

| Date | Decision | Where |
|---|---|---|
| 2026-09-09 | IDE layout only, no AI features | §1 |
| 2026-09-09 | Electron + TypeScript + React; engine as separate Node package | §3, §4, ADR-0001 |
| 2026-09-09 | v1 = Explore & Send; testing/mocks/load phased | §2, §14 |
| 2026-09-09 | Open-source, cross-platform, CI builds, auto-update | §1, §16 |
| 2026-09-09 | Folder-based project format, secrets in OS keychain | §7, ADR-0003 |
| 2026-09-09 | fontoxpath (XPath/XQuery 3.1), xmllint-wasm (XSD), xml-crypto + xml-encryption (WSS), undici (HTTP) | §3 |
| 2026-09-09 | JS/TS scripting instead of Groovy (v2) | §2 |
| 2026-09-09 | Name: Wirebench — protocol-neutral, REST client planned; `@wirebench/*`, `io.wirebench.desktop` | §1, §14, §16a |
| 2026-09-09 | Spec approved (rev 1) with §16 defaults: Apache-2.0, unsigned CI builds, engine in main process, PKCS#12+PEM, NTLM in v1, TS 7, English-only, history cap 1000, opt-in updates | §16 |
