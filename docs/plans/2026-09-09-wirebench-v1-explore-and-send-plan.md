# Plan: Wirebench v1 — Explore & Send

Spec: `docs/specs/2026-09-09-wirebench-v1-explore-and-send-design.md` (approved 2026-09-09, §16 defaults). Section refs below (§n) point at the spec.
Executors: superpowers:subagent-driven-development (fresh subagent per task, review between tasks) or superpowers:executing-plans. Tick boxes as tasks land. One commit per task, Conventional Commits, no `Co-Authored-By` trailer, `pnpm check` green before every commit.

**Goal:** ship v1 = import any WSDL 1.1 → generated requests → IDE editors → send with auth/WSS/attachments → inspect/validate, as a packaged open-source Electron app on 3 OSes.
**Architecture:** `packages/engine` (pure TS, all protocol work) ← `apps/desktop` main process (`EngineService`, files, secrets) ← typed zod IPC ← sandboxed React renderer. Engine runs in-process in main (§4, ADR-0002).
**Stack:** Electron 44 · TS 7 strict · React 19 · electron-vite 5 / Vite 8 · Monaco · zustand · Tailwind 4 + Radix · undici · @xmldom/xmldom · fontoxpath · xmllint-wasm · xml-crypto · xml-encryption · yaml · zod · vitest 5 · Playwright · electron-builder.

## Global constraints (every task inherits)

- Node 24 / pnpm 9; TS `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`; named exports only; files kebab-case; no `any`.
- Engine: zero Electron/DOM/React imports (lint-enforced); every I/O takes `AbortSignal`; JSDoc on exports; errors are `WirebenchError` subclasses with stable `code`.
- Renderer: no network/fs/secrets; `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP; IPC = one zod schema pair per channel; never expose `ipcRenderer`.
- Secrets only via `safeStorage` + `secretRef`; never in project files or logs (redact `Authorization`, WSS passwords).
- TDD for engine; engine coverage ≥ 85% lines/branches (CI gate); golden fixtures deterministic (injected clock/uuid); no network in tests except `test/interop`.
- Clean-room; do not copy code from other SOAP tools (many are copyleft, incompatible with Apache-2.0). Implement from public specs + published documentation. Name is Wirebench everywhere (`@wirebench/*`, `io.wirebench.desktop`, `WIREBENCH_*`); never "SoapHub".
- New runtime deps/native modules, project-format changes, IPC-contract changes, CI/release changes = ask first (§12). Deps already approved: those in §3.
- Layout per §9; docs per `docs/specs`, `docs/plans`, `docs/adr`; commands exactly as §8.

## Order & rationale

```
M0 foundation ─┬─ Lane E (engine)  5→6→7→8→9→10→11 ──┐
               └─ Lane D (desktop) 12 ────────────────┴→ 13→14→15→16  = walking skeleton (import→generate→send in UI)
M2 project/secrets/env/history  17→18,19,20 (E) ‖ 21→22→23→24 (D)
M3 editors/inspectors           25,27,28,29(E parts) ‖ 26,29,30,31 (D)
M4 attachments/auth/WSS/WS-A    32→33 · 34→35 · 36→37→38→39→40 · 41   (engine parts can start right after 9/10)
M5 validation/WS-I/interface    42→43→44 · 45 · 46
M6 polish/network/perf/ship     47,48 · 49 · 50 · 51 · 52
```

- Foundations first (tooling, security baseline, IPC shape) because every later task types against them.
- Then one thin vertical slice end-to-end (M1) so the riskiest engine code (schema model + sample generation, T7/T8) and the IPC/UI seam are proven before widening.
- Persistence before editors (M2 before M3): editors need a real request model and save path; history/secrets shape the exchange model.
- WSS (T36–40) is the second-highest risk; its engine tasks depend only on T9/T10 and may run in parallel with M2/M3 desktop work.
- Validation/WS-I (M5) last among features: needs schema set, exchange model, interface editor.
- Checkpoints map to spec §13 success criteria (SC#). Every checkpoint: `pnpm check` green on 3 OS + listed SCs demonstrated.
- Task size: S/M; scaffold tasks (1, 3, 12) are mechanical and touch more files by nature.

## Names later tasks depend on (define once, reuse verbatim)

```ts
// @wirebench/engine — packages/engine/src/index.ts
importDefinition(source: DefinitionSource, opts: ImportOptions): Promise<ImportResult>      // T6/T11  ImportResult {definition: WsdlDefinition, bundle: DefinitionBundle, schemaSet: SchemaSet, problems: Problem[]}
generateRequest(result: ImportResult, op: OperationRef, opts: GenerateOptions): GeneratedRequest // T8/T9/T11  {envelopeXml, soapVersion, soapAction, contentType}
sendSoapRequest(input: SoapSendInput, opts: SendOptions): Promise<SoapExchange>              // T10/T11  SoapExchange {http: HttpExchange, response: {envelopeXml, fault?: SoapFault}, durationMs, wss?: WssResult, ssl?: SslInfo}
validateMessage(result: ImportResult, xml: string, opts: {side: 'request'|'response'}): ValidationProblem[]  // T42
runWsdlWsi(result: ImportResult): WsiReport · runMessageWsi(exchange: SoapExchange): WsiReport               // T43/T44
applyOutgoingWss(doc: Document, cfg: WssOutgoingConfig, ctx: WssContext): Document                          // T37–39
processIncomingWss(doc: Document, cfg: WssIncomingConfig, ctx: WssContext): WssResult                        // T40
buildWsaHeaders(cfg: WsaConfig, ctx: {uuid(): string}): Element[]                                            // T41
expand(text: string, scopes: PropertyScopes): {text: string; unresolved: UnresolvedRef[]}                    // T19
buildForm(schemaSet, element: QName, xml?: string): FormNode · applyForm(form: FormNode): string             // T27
evaluate(xml: string, expr: string, opts: {language: 'xpath'|'xquery'; namespaces: Record<string,string>}): QueryResult // T28
// IPC channels — apps/desktop/src/shared/ipc.ts (renderer: window.wirebench.<domain>.<verb>())
app.version · definition.import · request.generate · request.send · request.cancel · project.{create,open,save,recent}
secrets.{set,exists,delete} · history.{list,get,clear} · preferences.{get,set} · fs.{saveText,openText} · dialogs.{openFile,openFolder,saveFile}
events (main→renderer, window.wirebench.on): engine.progress · project.changedOnDisk · theme.changed
```

## Tasks

### M0 — Foundation

- [x] **1. Repo + workspace scaffold** (scaffold, mechanical)
  - `git init`; pnpm workspace (`packages/*`, `apps/*`); root scripts exactly §8; `tsconfig.base.json` (strict flags above, ES2023, NodeNext, project references); eslint flat config: typescript-eslint type-checked + `no-restricted-imports` blocking `electron`/`react`/`@wirebench/desktop` inside `packages/engine`; prettier per §10; `.editorconfig`; `.gitignore` (node_modules, dist, out, coverage, .DS_Store, `*.p12`, `*.pem`, `*.jks`, `.env*`); `LICENSE` Apache-2.0; `.nvmrc` 24; README/CONTRIBUTING stubs.
  - Acceptance: `pnpm install && pnpm check` green on empty workspaces (`--passWithNoTests`); commit `chore: scaffold workspace`.
  - Verify: `pnpm check`
  - Files: package.json, pnpm-workspace.yaml, tsconfig.base.json, eslint.config.js, .prettierrc, .editorconfig, .gitignore, LICENSE, README.md, .nvmrc

- [x] **2. Engine package skeleton + XML base**
  - `packages/engine` (`@wirebench/engine`, ESM, `exports` → `src/index.ts` in dev, `dist/` via `tsc -b`); root `vitest.config.ts` with `test.projects`: `engine-unit`, `engine-integration`, `engine-interop` (skipped unless `WIREBENCH_NETWORK_TESTS=1`), `desktop` (jsdom); coverage v8 thresholds 85/85 on engine; `src/errors.ts` (`WirebenchError {code, details?, cause?}` + `WsdlParseError`, `SchemaError`, `HttpError`, `WssError`, `ProjectError`, `ValidationError`); `src/xml/parse.ts` (xmldom with locator → `lineNumber/columnNumber`), `serialize.ts`, `namespaces.ts` (WSDL, SOAP11/12 env+binding, XSD, XSI, XOP, MIME, WSSE, WSU, DS, XENC, WSA 2005/08 + 2004/08, WSAW, WSAM, WSP), `positions.ts` (offset ↔ line/col).
  - Acceptance: parse→serialize round-trip; element line/col asserted; namespace table snapshot; lint fails on `import 'electron'` in engine (test via eslint API).
  - Verify: `pnpm vitest run packages/engine/test/unit/xml`
  - Files: packages/engine/{package.json,tsconfig.json}, packages/engine/src/{index.ts,errors.ts}, packages/engine/src/xml/{parse.ts,serialize.ts,namespaces.ts,positions.ts}, packages/engine/test/unit/xml/parse.test.ts, vitest.config.ts

- [x] **3. Desktop skeleton + security baseline + typed IPC** (scaffold, mechanical)
  - `pnpm create @quick-start/electron apps/desktop --template react-ts`, trimmed to §9 layout; `@wirebench/desktop`; `main/windows.ts` BrowserWindow with `contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true`, CSP `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:` (Monaco needs inline styles), `will-navigate` denied, `setWindowOpenHandler` → deny + `shell.openExternal` for http(s) only; `shared/ipc.ts`: `defineChannel(name, request: ZodType, response: ZodType)` + `channels` registry; `main/ipc/register.ts` (`ipcMain.handle`, zod parse, errors serialised `{code, message, details}`); preload builds `window.wirebench` from registry (invoke + `on` for events), `api.d.ts`; first channel `app.version`.
  - Acceptance: `pnpm dev` shows version via IPC; `test/security-baseline.test.ts` snapshots `webPreferences` + CSP; malformed payload rejected with `ipc-invalid-request`.
  - Verify: `pnpm --filter @wirebench/desktop test`; manual `pnpm dev`
  - Files: apps/desktop/{package.json,electron.vite.config.ts,tsconfig.node.json,tsconfig.web.json}, apps/desktop/src/main/{index.ts,windows.ts,ipc/register.ts,ipc/app.ts}, apps/desktop/src/preload/{index.ts,api.d.ts}, apps/desktop/src/shared/ipc.ts, apps/desktop/test/security-baseline.test.ts

- [x] **4. CI + public fixtures**
  - `.github/workflows/ci.yml`: matrix ubuntu/macos/windows × Node 24, pnpm cache, `pnpm check`; `scripts/fixtures-refresh.ts` downloads the 5 public WSDLs (+ their imports) into `fixtures/wsdl/public/<name>/` and writes `SOURCES.md` (URL, date, sha256); fixtures committed.
  - Acceptance: CI green 3 OS; second `pnpm fixtures:refresh` run produces no diff.
  - Verify: CI run URL; `pnpm fixtures:refresh && git status --porcelain fixtures` empty
  - Files: .github/workflows/ci.yml, scripts/fixtures-refresh.ts, fixtures/wsdl/public/**, fixtures/wsdl/SOURCES.md

**Checkpoint 0:** `pnpm check` green locally + CI; empty IDE window launches on the dev machine.

### M1 — Walking skeleton (import → generate → send)

- [x] **5. WSDL 1.1 parser (single document)**
  - `wsdl/model.ts`: `WsdlDefinition {targetNamespace, documentation, messages, portTypes, bindings, services}`, `Message/Part {name, element?|type?}`, `PortType/Operation {input, output, faults[], parameterOrder}`, `Binding {soapVersion: '1.1'|'1.2', style, transport, operations}`, `BindingOperation {soapAction, style?, use, input/output {body parts, headers[], headerFaults}, faults}`, `Service/Port {binding, address}`; `wsdl/qname.ts`; `wsdl/parse-wsdl.ts` (`parseWsdl` signature per §10) — SOAP 1.1 vs 1.2 binding NS, `soap:header`, documentation.
  - Acceptance: golden model JSON for Calculator (both bindings), TempConvert, NumberConversion; XSD as input → `WsdlParseError('not-a-wsdl')`.
  - Verify: `pnpm vitest run packages/engine/test/unit/wsdl/parse-wsdl`
  - Files: packages/engine/src/wsdl/{model.ts,qname.ts,parse-wsdl.ts}, packages/engine/test/unit/wsdl/parse-wsdl.test.ts, packages/engine/test/fixtures/wsdl-model/*.json

- [x] **6. Import resolver + definition bundle**
  - `wsdl/resolver.ts`: `resolveDefinition(source, {fetchDocument, signal}) → DefinitionBundle {root, documents: [{location, bytes, text, kind: 'wsdl'|'xsd', importedBy, namespace}]}`; `wsdl:import`, `xsd:import` (namespace-only → resolved within bundle), `xsd:include` incl. chameleon (adopt including NS), `xsd:redefine` → problem `unsupported-redefine`; relative URL/file resolution, redirects, cycle detection (visited by absolute location), every fetch via injected `fetchDocument`; `parseWsdl` accepts a bundle (merges imported WSDL sections). Crafted fixtures: `crafted/nested-imports` (wsdl→wsdl→xsd→xsd), `crafted/chameleon-include`, `crafted/cycle`.
  - Acceptance: 3 crafted + CountryInfo resolve; cycle fetches each doc once; fetch count asserted; file:// and http(s) locations.
  - Verify: `pnpm vitest run packages/engine/test/unit/wsdl/resolver`
  - Files: packages/engine/src/wsdl/{resolver.ts,parse-wsdl.ts}, packages/engine/test/unit/wsdl/resolver.test.ts, fixtures/wsdl/crafted/{nested-imports,chameleon-include,cycle}/**

- [x] **7. Schema set model**
  - `xsd/model.ts` (`SchemaSet`, `ElementDecl`, `ComplexType {content: sequence|choice|all|groupRef, attributes, base, derivation: extension|restriction, abstract, mixed}`, `SimpleType {base, facets: enumeration|pattern|min/max(In|Ex)clusive|length|…}`, `AttributeDecl`, `Group`, `AttributeGroup`), `xsd/builtins.ts` (xs:* table with sample values), `xsd/schema-set.ts`: `buildSchemaSet(bundle) → SchemaSet` with `lookupElement(qname)`, `lookupType(qname)`, `substitutionsFor(qname)`, `resolveContent(type)` (flatten extension chains, group refs, anonymous types, attribute groups).
  - Acceptance: `crafted/schema-constructs` (sequence/choice/all, groups, attributeGroup, extension+restriction, substitution group, abstract, anonymous, enum/pattern/range, recursion, `any`/`anyType`, `nillable`) builds; table-driven query tests; CountryInfo schema builds.
  - Verify: `pnpm vitest run packages/engine/test/unit/xsd/schema-set`
  - Files: packages/engine/src/xsd/{model.ts,builtins.ts,schema-set.ts}, packages/engine/test/unit/xsd/schema-set.test.ts, fixtures/wsdl/crafted/schema-constructs/**

- [x] **8. Sample XML generator**
  - `xsd/sample-generator.ts`: `generateElement(schemaSet, element: QName, opts: {includeOptional, sampleValues, typeComments, maxDepth: 5, choice: 'first'}) → string` per §6.2: `<!--Optional:-->`, `<!--Zero or more repetitions:-->`, choice alternatives commented, enum list comments, `xsi:type` for abstract/derived, nillable, `any`/`anyType` comments, `?` placeholders vs typed samples, recursion cut with comment; `xsd/sample-values.ts` (facet-aware values); soapenc array helper for rpc/encoded.
  - Acceptance: golden XML per construct × option matrix (optional on/off, sampleValues on/off); depth cut verified.
  - Verify: `pnpm vitest run packages/engine/test/unit/xsd/sample-generator`
  - Files: packages/engine/src/xsd/{sample-generator.ts,sample-values.ts}, packages/engine/test/unit/xsd/sample-generator.test.ts, packages/engine/test/fixtures/samples/**

- [x] **9. SOAP envelope, request builder, fault parser**
  - `soap/envelope.ts` (`createEnvelope(version)`, prefix `soapenv`), `soap/request-builder.ts` (`buildSampleRequest(result, bindingOp, genOpts) → GeneratedRequest`: doc/literal wrapped + bare, rpc/literal (`ns:op` wrapper, `parameterOrder`), rpc/encoded (`encodingStyle`, soapenc arrays), header parts → `soapenv:Header`), `soap/soap-action.ts` (`SOAPAction: "…"` quoting for 1.1; `action=` param in `application/soap+xml` for 1.2; skip flag), `soap/fault.ts` (`parseFault(doc) → SoapFault {version, code, subcodes[], reason, actor|role, detailXml, node}`), `soap/response-parser.ts`.
  - Acceptance: golden envelopes Calculator 1.1+1.2, NumberConversion, `crafted/rpc-encoded`, `crafted/rpc-literal`, `crafted/soap-headers`; faults both versions parsed.
  - Verify: `pnpm vitest run packages/engine/test/unit/soap`
  - Files: packages/engine/src/soap/{envelope.ts,request-builder.ts,soap-action.ts,fault.ts,response-parser.ts}, packages/engine/test/unit/soap/*.test.ts, fixtures/wsdl/crafted/{rpc-encoded,rpc-literal,soap-headers}/**

- [x] **10. HTTP transport + test SOAP server**
  - `http/types.ts` (`HttpRequest {url, method, headers, body: Uint8Array, timeoutMs, followRedirects, maxSizeBytes, signal, tls?, proxy?}`, `HttpExchange {status, statusText, headers, body, timings: Timings, rawRequest, rawResponse, redirects[]}`), `http/client.ts` on undici `Agent`/`Client` (keep-alive, gzip/deflate decode keeping raw bytes, redirects, size cap → `HttpError('too-large')`, `timeout`, `aborted`, `connection-refused`, `tls`), `http/raw-capture.ts`, `http/timings.ts` (undici `diagnostics_channel`: dns/connect/tls/ttfb/download).
  - `test/helpers/test-soap-server.ts`: `http` server serving any fixture WSDL + routes `echo`, `fault`, `delay/:ms`, `gzip`, `redirect`, `big/:mb`, `headers` (echoes request headers) — later tasks add `auth/*`, `mime`, `wss`, `tls`.
  - Acceptance: integration tests per route; cancel mid-flight; timeout; truncation; raw bytes verbatim.
  - Verify: `pnpm vitest run packages/engine/test/integration/http`
  - Files: packages/engine/src/http/{types.ts,client.ts,raw-capture.ts,timings.ts}, packages/engine/test/helpers/test-soap-server.ts, packages/engine/test/integration/http/client.test.ts

- [x] **11. Engine facade + first end-to-end**
  - `src/import.ts` (`importDefinition` = resolve → parse → schema set → problems; default `fetchDocument` over `sendHttp` + `fs`), `src/send.ts` (`sendSoapRequest`: headers (Content-Type per version, SOAPAction), body encode, response parse, fault detect, `durationMs`), `src/index.ts` public surface (names block above), `src/types.ts` (`DefinitionSource`, `OperationRef {interfaceId, bindingName, operationName}`, `SoapSendInput {endpoint, envelopeXml, soapVersion, soapAction, headers, timeoutMs, encoding, followRedirects, maxSizeBytes, skipSoapAction}`).
  - Acceptance: integration: import from test-server URL → generate → send `echo` → response body equals request; same via file path; fault route → `response.fault` populated.
  - Verify: `pnpm vitest run packages/engine/test/integration/end-to-end`
  - Files: packages/engine/src/{index.ts,import.ts,send.ts,types.ts}, packages/engine/test/integration/end-to-end.test.ts

- [x] **12. IDE shell layout + command registry + palette** (renderer only; parallel with 5–11; scaffold, mechanical)
  - `shell/{title-bar,activity-bar,sidebar,editor-area,console,details-panel,status-bar,command-palette}.tsx` in `react-resizable-panels` per §5 diagram; `state/ui.ts` (visibility/sizes, persisted to localStorage, try/catch); `styles/tokens.css` (dark palette, spacing, type scale) + `tailwind.css`; `shared/commands.ts` (`CommandId` string-literal union) and `lib/commands.ts` (`registerCommand({id, label, shortcut?, when?, run})`, `runCommand`, `listCommands(ctx)`), `lib/keybindings.ts` (parse `Mod+Shift+F`, dispatcher, context); palette (cmdk) with `view.toggleSidebar` ⌘B, `view.toggleConsole` ⌘J, `view.toggleDetails`, `palette.open` ⌘K, `definition.import` (stub until T14).
  - Acceptance: all regions render; ⌘B/⌘J/⌘K work; registry tests (duplicate id throws, `when` filter, shortcut parse/format, mac vs win modifier).
  - Verify: `pnpm --filter @wirebench/desktop test`; manual `pnpm dev`
  - Files: apps/desktop/src/renderer/shell/*.tsx, apps/desktop/src/renderer/{state/ui.ts,lib/commands.ts,lib/keybindings.ts,styles/tokens.css,styles/tailwind.css}, apps/desktop/src/shared/commands.ts, apps/desktop/test/commands.test.ts

- [x] **13. IPC + stores for import/generate/send**
  - Channels: `definition.import` (source, opts → `InterfaceSummary {id, name, definitionUrl, soapVersions, services: [{name, ports: [{name, address, binding, soapVersion}]}], operations: [{name, binding, soapAction, documentation}], problems}`; full `ImportResult` stays in main keyed by id), `request.generate`, `request.send` (bytes base64), `request.cancel(sendId)`, event `engine.progress {phase, message, pct?}`; `main/engine-service.ts` (in-process engine, definitions map, per-send `AbortController`, progress relay); `renderer/state/project.ts` (in-memory interfaces/operations/requests/endpoints), `state/exchanges.ts` (last exchange + send status per request).
  - Acceptance: IPC unit tests with mocked engine (zod validation, error mapping to `{code}`, cancel); store tests.
  - Verify: `pnpm --filter @wirebench/desktop test`
  - Files: apps/desktop/src/shared/ipc.ts, apps/desktop/src/main/{engine-service.ts,ipc/definition.ts,ipc/request.ts}, apps/desktop/src/renderer/state/{project.ts,exchanges.ts}, apps/desktop/test/ipc-request.test.ts

- [x] **14. Explorer tree + Import WSDL dialog**
  - `features/explorer/{explorer-view.tsx, tree-nodes.ts (model → arborist nodes: Interface → Endpoints / Operations → Requests), context-menu.tsx, import-dialog.tsx}` (URL field, file picker via `dialogs.openFile`, drag-drop, paste); progress + cancel from `engine.progress`; problems → Problems tab (minimal list until T42); double-click request → opens editor tab (T15).
  - Acceptance: import Calculator from test-server URL → 2 ports, 4 ops, "Request 1" under each; bad URL shows problem; tree-mapping tests.
  - Verify: `pnpm --filter @wirebench/desktop test`; manual
  - Files: apps/desktop/src/renderer/features/explorer/{explorer-view.tsx,tree-nodes.ts,context-menu.tsx,import-dialog.tsx}, apps/desktop/src/main/ipc/dialogs.ts

- [x] **15. Request editor v0 (XML + response + send + HTTP log)**
  - `editor/monaco.ts`: configure `@monaco-editor/react` `loader.config({ monaco })` from the bundled `monaco-editor` package — never the CDN loader (CSP); XML language, dark/light themes; `features/request-editor/{request-editor.tsx, request-pane.tsx, response-pane.tsx, toolbar.tsx, endpoint-select.tsx}`; Send ⌘⏎ / Cancel Esc → `request.send`/`request.cancel`; response header line `status · duration · size`, formatted XML, fault → red; `features/console/http-log.tsx` (rows: time, method, URL, status, ms, size; click → raw request/response text); `state/editors.ts` (tabs).
  - Acceptance: edit → send → response shown; cancel works; log row; fault flagged.
  - Verify: `pnpm --filter @wirebench/desktop test`; manual vs test server and dneonline Calculator
  - Files: apps/desktop/src/renderer/editor/monaco.ts, apps/desktop/src/renderer/features/request-editor/{request-editor.tsx,request-pane.tsx,response-pane.tsx,toolbar.tsx,endpoint-select.tsx}, apps/desktop/src/renderer/features/console/http-log.tsx, apps/desktop/src/renderer/state/editors.ts

- [x] **16. E2E harness**
  - `e2e/playwright.config.ts`, `helpers/launch-app.ts` (`_electron.launch` on `pnpm build` output, per-test userData dir), `helpers/test-server.ts` (reuses engine test SOAP server), `specs/walking-skeleton.spec.ts`: import Calculator via URL → open Add → send → response contains `AddResult`; HTTP log row present. CI `e2e` job on 3 OS after build (xvfb on Linux).
  - Acceptance: green locally + CI.
  - Verify: `pnpm build && pnpm test:e2e`
  - Files: e2e/{playwright.config.ts,helpers/launch-app.ts,helpers/test-server.ts,specs/walking-skeleton.spec.ts}, .github/workflows/ci.yml

**Checkpoint 1:** SC1 (public fixtures via URL + file), SC2 (all fixture ops generate), SC3 (send/cancel/log) at skeleton level. Demo: Calculator `Add` from the UI.

### M2 — Project format, secrets, environments, history

- [x] **17. Project model + folder load/save**
  - `project/model.ts` (`Project`, `Interface {kind: 'soap', …}`, `Endpoint`, `RequestDef {kind: 'soap', …}`, `Environment`, `PropertyScopes`), `project/schema.ts` (zod for `wirebench.yaml`, `interface.yaml`, `*.request.yaml`, `environments/*.yaml`, `wss/*.yaml`, `formatVersion: 1`), `project/paths.ts` (§7 layout), `project/load.ts` / `save.ts` (yaml `sortMapEntries`, atomic temp+rename, rewrite only changed files, `.xml` bodies verbatim), `project/migrate.ts` (v1 no-op; newer → `ProjectError('project-format-too-new')`); ids via `ulidx` (Q1).
  - Acceptance: model→folder→model deep-equal; renaming one request changes exactly its two files (dir-listing snapshot); malformed yaml → error with path.
  - Verify: `pnpm vitest run packages/engine/test/unit/project/roundtrip`
  - Files: packages/engine/src/project/{model.ts,schema.ts,paths.ts,load.ts,save.ts,migrate.ts}, packages/engine/test/unit/project/roundtrip.test.ts

- [x] **18. Definition cache + Export Definition**
  - `wsdl/cache.ts` (`writeCache(bundle, dir)` byte-exact + `manifest.yaml {location→file, sha256, fetchedAt}`, `readCache(dir) → DefinitionBundle`; `Interface.cacheDefinition` toggle → import from cache first, offline-capable), `wsdl/export-definition.ts` (folder export rewriting `location`/`schemaLocation` to relative paths).
  - Acceptance: cached sha256 == source; export → re-import equals model; offline load with fetch mocked to throw.
  - Verify: `pnpm vitest run packages/engine/test/unit/wsdl/cache packages/engine/test/unit/wsdl/export`
  - Files: packages/engine/src/wsdl/{cache.ts,export-definition.ts}, packages/engine/test/unit/wsdl/{cache,export}.test.ts

- [x] **19. Property expansion**
  - `project/properties.ts`: `expand` (names block) for `${#Project#x}`, `${#Env#x}`, `${#Global#x}`, `${#System#x}`, nesting, escape `$${`; `send.ts` expands envelope, headers, endpoint, attachment names, WS-A fields; unresolved refs returned (not thrown).
  - Acceptance: table tests incl. nested/unresolved/escape; integration: send uses expanded endpoint + header.
  - Verify: `pnpm vitest run packages/engine/test/unit/project/properties`
  - Files: packages/engine/src/project/properties.ts, packages/engine/src/send.ts, packages/engine/test/unit/project/properties.test.ts

- [x] **20. Environments (engine)**
  - `project/environments.ts`: `resolveEndpoint(project, envId, interfaceId, requestEndpointRef) → string`, `resolveScopes(project, envId, globals) → PropertyScopes`; env file `{endpoints: {<interfaceName>: url}, properties: {}}`.
  - Acceptance: env override beats interface default; unknown env → base; tests.
  - Verify: `pnpm vitest run packages/engine/test/unit/project/environments`
  - Files: packages/engine/src/project/environments.ts, packages/engine/test/unit/project/environments.test.ts

- [x] **21. Desktop: new/open/save/recent, autosave, external changes**
  - IPC `project.{create,open,save,recent}`; `main/project-files.ts` (folder dialogs, recent list in userData, `fs.watch` on project dir → `project.changedOnDisk` event → reload prompt); `state/project.ts` disk-backed (dirty flags, 500 ms debounced autosave); `features/welcome/welcome-screen.tsx` (recent, New, Open); window title `name — Wirebench`; ⌘S.
  - Acceptance: e2e: new project → import → relaunch → recent → request restored; external edit → prompt.
  - Verify: `pnpm test:e2e -- --grep project`
  - Files: apps/desktop/src/main/{project-files.ts,ipc/project.ts}, apps/desktop/src/renderer/features/welcome/welcome-screen.tsx, apps/desktop/src/renderer/state/project.ts, e2e/specs/project.spec.ts

- [x] **22. Desktop: environments + properties UI**
  - Sidebar "Environments" section + env editor tab (endpoint table per interface, properties table); status-bar switcher + command `env.switch`; Details panel property tables (Project, Global); pre-send `expand` dry-run → unresolved refs in Problems.
  - Acceptance: e2e: switch env → next send hits the other URL; `${#Env#missing}` listed in Problems.
  - Verify: `pnpm test:e2e -- --grep environment`
  - Files: apps/desktop/src/renderer/features/environments/{environments-section.tsx,environment-editor.tsx,env-switcher.tsx}, apps/desktop/src/renderer/features/properties/property-table.tsx, e2e/specs/environments.spec.ts

- [x] **23. Secrets (keychain-backed)**
  - `main/secrets.ts` (`safeStorage`-encrypted `secrets.json` in userData; `set(value) → secretRef`, `get(ref)`, `delete(ref)`, `exists(ref)`), IPC `secrets.{set,exists,delete}` (no `get` to renderer); `engine-service.ts` resolves refs in `SoapSendInput` before send; `components/secret-field.tsx` (stores ref, masked, Replace); `main/redact.ts` masks `Authorization`, `Proxy-Authorization`, `wsse:Password` in HTTP log/history unless session "show secrets".
  - Acceptance: test greps saved project folder for the password → absent; `window.wirebench.secrets.get` absent (type + runtime); redaction test.
  - Verify: `pnpm --filter @wirebench/desktop test`; `pnpm test:e2e -- --grep secrets`
  - Files: apps/desktop/src/main/{secrets.ts,redact.ts,ipc/secrets.ts,engine-service.ts}, apps/desktop/src/renderer/components/secret-field.tsx, e2e/specs/secrets.spec.ts

- [x] **24. History + diff**
  - `project/history.ts` (`appendHistory(file, entry)`, `listHistory(file, {query, limit})`, jsonl per project id under userData, cap 1000 with rotation, redacted at write); IPC `history.{list,get,clear}`; History view (activity bar): rows time/op/endpoint/status/ms, search; Open (restores request+response tab), Re-send, Compare (Monaco `DiffEditor`: two entries or current vs entry); every send appends.
  - Acceptance: survives relaunch (e2e); cap test; diff renders.
  - Verify: `pnpm vitest run packages/engine/test/unit/project/history`; `pnpm test:e2e -- --grep history`
  - Files: packages/engine/src/project/history.ts, apps/desktop/src/main/ipc/history.ts, apps/desktop/src/renderer/features/history/{history-view.tsx,diff-view.tsx}, e2e/specs/history.spec.ts

**Checkpoint 2:** SC10 (project/env/properties), SC11 (history). Git diff of a renamed request touches two files.

### M3 — Editors and inspectors

- [x] **25. XML editor features + schema completion**
  - `xml/pretty.ts` (`formatXml(text, {indent})` keeps comments/CDATA/PI), `xsd/locate.ts` (`elementPathAt(text, offset) → QName[]`, `childrenAllowedAt(schemaSet, path) → ElementDecl[]`, `declarationOf(schemaSet, path) → {document, range}`); `editor/xml-language.ts` (format provider ⌘⇧F, completion of allowed children, ⌘G go to line, line-number toggle, Save as… / Load from… via `fs.{saveText,openText}`).
  - Acceptance: pretty golden (comments/CDATA intact); completion inside `<Add>` offers `intA`/`intB`; e2e format.
  - Verify: `pnpm vitest run packages/engine/test/unit/xml/pretty packages/engine/test/unit/xsd/locate`; desktop tests
  - Files: packages/engine/src/{xml/pretty.ts,xsd/locate.ts}, packages/engine/test/unit/{xml/pretty.test.ts,xsd/locate.test.ts}, apps/desktop/src/renderer/editor/xml-language.ts, apps/desktop/src/main/ipc/fs.ts

- [x] **26. Outline view**
  - `views/xml-model.ts` (text ↔ tree with ranges via `xml/positions.ts`), `views/outline-view.tsx` (element, value, schema type column via `xsd/locate`; inline value edit writes back at exact range; response outline read-only).
  - Acceptance: edit in outline updates only that text range; types shown for Calculator; component tests.
  - Verify: `pnpm --filter @wirebench/desktop test`
  - Files: apps/desktop/src/renderer/features/request-editor/views/{xml-model.ts,outline-view.tsx}, apps/desktop/test/outline-view.test.tsx

- [x] **27. Form view**
  - `xsd/form-model.ts` (`buildForm`/`applyForm`; `FormNode {kind: field|group|choice|repeat, name, required, type, enum?, occurs, value, children}`), `views/form-view.tsx` + `form-fields.tsx` (text/number/bool/date/time/dateTime/enum select, repeat add/remove, choice tabs, view types Full / Required only / Non-empty), `get-data-dialog.tsx` (insert `${#…}`); two-way sync with XML text.
  - Acceptance: form golden for `schema-constructs`; XML→form→XML stable; e2e: fill Calculator form → send.
  - Verify: `pnpm vitest run packages/engine/test/unit/xsd/form-model`; desktop tests
  - Files: packages/engine/src/xsd/form-model.ts, packages/engine/test/unit/xsd/form-model.test.ts, apps/desktop/src/renderer/features/request-editor/views/{form-view.tsx,form-fields.tsx,get-data-dialog.tsx}

- [x] **28. Raw views + Query (XPath 3.1 / XQuery 3.1) view**
  - `xpath/evaluate.ts` (fontoxpath over xmldom; `QueryResult {kind: 'nodes'|'values', items: [{text, range?}], error?}`), `xpath/namespaces.ts` (in-scope prefixes of a document); `views/raw-view.tsx` (request = bytes actually sent; response raw), `views/query-view.tsx` (expression, language toggle, namespace table, results, click → highlight in response XML); `views/fault-overview.tsx` (code/subcodes/reason/detail rendered when `response.fault` present, links clickable).
  - Acceptance: XPath 3.1 maps/arrays, XQuery FLWOR, namespace resolution, error text; e2e query returns `AddResult` value.
  - Verify: `pnpm vitest run packages/engine/test/unit/xpath`; e2e
  - Files: packages/engine/src/xpath/{evaluate.ts,namespaces.ts}, packages/engine/test/unit/xpath/evaluate.test.ts, apps/desktop/src/renderer/features/request-editor/views/{raw-view.tsx,query-view.tsx,fault-overview.tsx}

- [x] **29. Editor layout, toolbar actions, cURL**
  - `soap/recreate.ts` (`recreateRequest(currentXml, generatedXml, {keepValues}) → string`, merge by element path), `http/curl.ts` (`toCurl(input)`, `fromCurl(text) → Partial<SoapSendInput>`); split/tabs + horizontal/vertical toggles persisted per editor (`layout.ts`); toolbar Recreate / Create Empty / Clone / Copy as cURL / Import cURL / endpoint Edit·Add·Delete; explorer context menu parity (Clone, Rename, Remove, Recreate, Show Interface Viewer → T45).
  - Acceptance: keep-values merge keeps edits + adds new elements; cURL round-trip; e2e layout toggle persists.
  - Verify: `pnpm vitest run packages/engine/test/unit/soap/recreate packages/engine/test/unit/http/curl`; e2e
  - Files: packages/engine/src/{soap/recreate.ts,http/curl.ts}, packages/engine/test/unit/{soap/recreate.test.ts,http/curl.test.ts}, apps/desktop/src/renderer/features/request-editor/{toolbar.tsx,layout.ts}, apps/desktop/src/renderer/features/explorer/context-menu.tsx

- [x] **30. Request properties + Preferences**
  - `RequestDef.properties` = §6.3 list; `send-options.ts` (`toSendInput(request, endpoint, prefs) → SoapSendInput`), `soap/transforms.ts` (remove empty content, entitize, pretty print, strip whitespace); `main/preferences.ts` (`preferences.yaml` in userData) + IPC `preferences.{get,set}`; Details panel property grid; Preferences tab (HTTP, Proxy, SSL, WSDL, WS-I, Editor, UI, Shortcuts sections; Proxy/SSL fields wired in T49).
  - Acceptance: mapping table test; transforms tested; e2e: timeout 100 ms vs `delay/500` → `timeout` problem.
  - Verify: `pnpm vitest run packages/engine/test/unit/send-options packages/engine/test/unit/soap/transforms`; e2e
  - Files: packages/engine/src/{send-options.ts,soap/transforms.ts}, packages/engine/test/unit/{send-options.test.ts,soap/transforms.test.ts}, apps/desktop/src/main/{preferences.ts,ipc/preferences.ts}, apps/desktop/src/renderer/features/{details/request-properties.tsx,preferences/preferences-editor.tsx}

- [x] **31. Headers, SSL Info, timings inspectors**
  - Request Headers inspector (add/remove, override standard by name, expansions) + response Headers; `http/tls.ts` (`SslInfo {protocol, cipher, authorized, peerChain: [{subject, issuer, validFrom, validTo, sans, fingerprint256}]}` from `socket.getPeerCertificate(true)`), SSL Info inspector; HTTP log detail timings bar. Test certs generated at test time in `test/helpers/test-certs.ts` (node-forge, Q1); test server gains `tls` mode.
  - Acceptance: custom `Content-Type` overrides default (`headers` route); TLS route yields chain + protocol; timings present.
  - Verify: `pnpm vitest run packages/engine/test/integration/http/tls`; desktop tests
  - Files: packages/engine/src/http/{tls.ts,client.ts}, packages/engine/test/helpers/{test-certs.ts,test-soap-server.ts}, packages/engine/test/integration/http/tls.test.ts, apps/desktop/src/renderer/features/request-editor/inspectors/{headers-inspector.tsx,ssl-inspector.tsx}

**Checkpoint 3:** SC4 (editors round-trip, query view), SC3 complete (headers, raw, timings).

### M4 — Attachments, auth, WS-Security, WS-Addressing

- [x] **32. Attachments + MIME (engine)**
  - `soap/mime/multipart.ts` (build/parse `multipart/related`, boundaries, Content-ID, transfer encodings, CRLF/LF tolerant), `mtom.ts` (`cid:` in base64 elements → `xop:Include`; Force MTOM; response XOP expand/inline options), `swa.ts` (SwA + swaRef per WS-I AP 1.0), `inline-files.ts` (`file:` prefix → base64/binary, `ResourceRoot`); `Attachment {id, name, contentType, size, part?, type: 'XOP'|'MIME'|'SWAREF'|'CONTENT'|'UNKNOWN', contentId, cached, source: {kind: 'path'|'cache', ref}}`; `project/attachments-cache.ts` (sha256-named under `attachments/`); test server `mime` route echoes parts.
  - Acceptance: MTOM/SwA/swaRef round-trips byte-identical; XOP response expanded when option on; inline file inserted; parser edge cases.
  - Verify: `pnpm vitest run packages/engine/test/unit/soap/mime packages/engine/test/integration/mime`
  - Files: packages/engine/src/soap/mime/{multipart.ts,mtom.ts,swa.ts,inline-files.ts}, packages/engine/src/project/attachments-cache.ts, packages/engine/test/unit/soap/mime/*.test.ts, packages/engine/test/integration/mime.test.ts, packages/engine/test/helpers/test-soap-server.ts

- [x] **32b. Request toolbar: visible endpoint, right-click actions, Code panel** (inserted 2026-09-10 from user feedback)
  - Endpoint becomes a full-width editable combobox (input + declared-address dropdown); Recreate/Clone/cURL move to a right-click context menu on the request pane (Monaco menu off) and palette `request.*` commands; Postman-style Code tab in the Details panel with live cURL preview, shell selector, Copy, Import; `</>` toolbar button opens it.
  - Acceptance: long URL fully visible; right-click menu works in every request view; Code tab updates on edit.
  - Verify: `pnpm check`; `pnpm test:e2e -- --grep "editor actions|preferences"`
  - Files: apps/desktop/src/renderer/features/request-editor/{toolbar,endpoint-select,request-context-menu,request-editor}.tsx, apps/desktop/src/renderer/features/details/code-panel.tsx, apps/desktop/src/renderer/shell/details-panel.tsx, apps/desktop/src/renderer/state/ui.ts, e2e/specs/editor-actions.spec.ts

- [x] **33. Attachments inspector (UI)**
  - Table per §6.5 (Name, Content Type editable, Size, Part from WSDL mime parts, Type, ContentID, Cached), Add via dialog, drag-drop, Remove, double-click open (`shell.openPath` allow-listed to project + cache dirs), response Attachments tab with Save as…; request property flags wired (Enable/Force MTOM, Inline Response Attachments, Expand MTOM, Disable Multiparts, Encode Attachments, Enable Inline Files).
  - Acceptance: e2e: MTOM send with fixture PNG → echo → response attachment listed, saved file equals source.
  - Verify: `pnpm test:e2e -- --grep attachments`
  - Files: apps/desktop/src/renderer/features/request-editor/inspectors/attachments-inspector.tsx, apps/desktop/src/main/ipc/attachments.ts, e2e/specs/attachments.spec.ts

- [x] **34. Basic auth + endpoint defaults + Auth inspector**
  - `http/auth/basic.ts` (preemptive header, or 401 challenge → retry once), `project/endpoints.ts` (`effectiveAuth(request, endpoint, mode: 'override'|'complement')`), `AuthConfig {type: 'none'|'basic'|'ntlm', username, passwordRef, domain?, preemptive}` on request + endpoint; Auth inspector (type, fields with secret-field, preemptive, "use endpoint default"); test server `auth/basic`.
  - Acceptance: challenge + preemptive pass; wrong password → 401 surfaced; override/complement table test.
  - Verify: `pnpm vitest run packages/engine/test/integration/auth/basic packages/engine/test/unit/project/endpoints`
  - Files: packages/engine/src/http/auth/basic.ts, packages/engine/src/project/endpoints.ts, packages/engine/test/integration/auth/basic.test.ts, packages/engine/test/unit/project/endpoints.test.ts, apps/desktop/src/renderer/features/request-editor/inspectors/auth-inspector.tsx

- [x] **35. NTLMv2**
  - `http/auth/ntlm.ts` (Type 1/2/3 codec, NTLMv2 + LMv2 responses via HMAC-MD5, NT hash via js-md4, AV pairs, flags), `http/auth/ntlm-transport.ts` (3-leg handshake on one dedicated undici `Client` connection); vectors from MS-NLMP §4.2.4; `test/helpers/ntlm-server.ts` simulating challenge/verify; test server `auth/ntlm`.
  - Acceptance: vectors pass; handshake succeeds; wrong password → 401.
  - Verify: `pnpm vitest run packages/engine/test/unit/http/auth/ntlm packages/engine/test/integration/auth/ntlm`
  - Files: packages/engine/src/http/auth/{ntlm.ts,ntlm-transport.ts}, packages/engine/test/unit/http/auth/ntlm.test.ts, packages/engine/test/integration/auth/ntlm.test.ts, packages/engine/test/helpers/ntlm-server.ts

- [x] **36. Keystores (PKCS#12, PEM) + keystore UI**
  - `wss/keystore/{pkcs12.ts (node-forge, Q1), pem.ts, index.ts}` (`loadKeystore(def, password) → Keystore {type, aliases: [{alias, certPem, keyPem?, chainPem[]}]}`), `wss/keystores.yaml` schema `{id, path, type, passwordSecretRef, defaultAlias}`; test keystores from `test-certs.ts`; UI: sidebar WS-Security → Keystores (add dialog: path, password → secretRef; status; aliases).
  - Acceptance: P12 + PEM load, aliases listed, wrong password → `WssError('keystore-bad-password')`; UI status.
  - Verify: `pnpm vitest run packages/engine/test/unit/wss/keystore`
  - Files: packages/engine/src/wss/keystore/{pkcs12.ts,pem.ts,index.ts}, packages/engine/test/unit/wss/keystore/keystore.test.ts, apps/desktop/src/renderer/features/wss/{wss-section.tsx,keystores-view.tsx}

- [x] **37. WSS outgoing: Timestamp + UsernameToken + config plumbing**
  - `wss/model.ts` (`WssOutgoingConfig {id, name, defaultAlias, defaultPasswordRef, actor, mustUnderstand, entries: WssEntry[]}`, `WssEntry = timestamp | username-token | signature | encryption`, `WssIncomingConfig`, `WssContext {keystores, secrets, clock, nonce, uuid}`), `wss/outgoing/timestamp.ts` (TTL, ms precision), `wss/outgoing/username-token.ts` (PasswordText / PasswordDigest = Base64(SHA1(nonce+created+password)), nonce, created), `wss/apply.ts` (`applyOutgoingWss`: ordered entries into `wsse:Security` with actor/mustUnderstand); wired in `send.ts` via `request.wssOutgoingRef`; XML actions "Add WSS-Username Token…", "Add WS-Timestamp…", "Outgoing WSS → apply/remove"; Outgoing config editor + Auth inspector selectors.
  - Acceptance: digest vector; expires math with injected clock; header golden; e2e apply shows header in XML.
  - Verify: `pnpm vitest run packages/engine/test/unit/wss/outgoing`; e2e
  - Files: packages/engine/src/wss/{model.ts,apply.ts,outgoing/timestamp.ts,outgoing/username-token.ts}, packages/engine/test/unit/wss/outgoing/{timestamp,username-token}.test.ts, apps/desktop/src/renderer/features/wss/outgoing-config-editor.tsx

- [x] **38. WSS Signature + xmlsec1 cross-check**
  - `wss/outgoing/signature.ts` (xml-crypto `SignedXml`: exclusive c14n; RSA-SHA256 default / RSA-SHA1; digest SHA-256 / SHA-1; references by auto-assigned `wsu:Id`; parts selector `{name, namespace, encode: 'Content'|'Element'}` default Body + Timestamp; single-certificate option), `wss/key-identifiers.ts` (BinarySecurityToken direct reference, IssuerSerial, SKI, Thumbprint SHA-1, X509KeyIdentifier); `scripts/wss-xmlsec-check.ts` writes signed envelopes + runs `xmlsec1 --verify --id-attr:Id …`; CI job on ubuntu + macos (`apt xmlsec1` / `brew libxmlsec1`).
  - Acceptance: self-verify + xmlsec1 verify for every key identifier × algorithm; tampering fails.
  - Verify: `pnpm vitest run packages/engine/test/unit/wss/outgoing/signature`; `pnpm test:wss-xmlsec`
  - Files: packages/engine/src/wss/{outgoing/signature.ts,key-identifiers.ts}, packages/engine/test/unit/wss/outgoing/signature.test.ts, scripts/wss-xmlsec-check.ts, .github/workflows/ci.yml

- [x] **39. WSS Encryption**
  - `wss/outgoing/encryption.ts` (xml-encryption: AES-128/256-CBC, AES-128/256-GCM; RSA-OAEP default / RSA-1.5; Content|Element; `xenc:EncryptedKey` + `DataReference`s in header; embed-key option; key identifiers from T38); xmlsec1 `--decrypt` added to the script.
  - Acceptance: encrypt Body → xmlsec1 decrypts to original; sign-then-encrypt and encrypt-then-sign (entry order) both verifiable.
  - Verify: `pnpm vitest run packages/engine/test/unit/wss/outgoing/encryption`; `pnpm test:wss-xmlsec`
  - Files: packages/engine/src/wss/outgoing/encryption.ts, packages/engine/test/unit/wss/outgoing/encryption.test.ts, scripts/wss-xmlsec-check.ts

- [x] **40. WSS incoming + WSS inspector**
  - `wss/incoming/verify.ts` (truststore chain trust, signature validity, timestamp freshness), `decrypt.ts` (keystore → EncryptedKey + data refs), `index.ts` (`processIncomingWss → WssResult {actions: [{kind, ok, detail}], decryptedXml?, errors[]}`), wired post-receive via `request.wssIncomingRef`; test server `wss` route signs/encrypts responses with test keys; response WSS inspector; Incoming config editor (decrypt keystore, signature truststore).
  - Acceptance: signed+encrypted response verifies/decrypts; tampered → flagged; untrusted cert → flagged; plain response → empty result.
  - Verify: `pnpm vitest run packages/engine/test/integration/wss`
  - Files: packages/engine/src/wss/incoming/{verify.ts,decrypt.ts,index.ts}, packages/engine/test/integration/wss.test.ts, apps/desktop/src/renderer/features/request-editor/inspectors/wss-inspector.tsx, apps/desktop/src/renderer/features/wss/incoming-config-editor.tsx

- [x] **41. WS-Addressing**
  - `wsa/headers.ts` (`WsaConfig {enabled, version: '2005/08'|'2004/08', action, to, messageId: 'auto'|string, replyTo, from, faultTo, relatesTo, mustUnderstand}`, `buildWsaHeaders`, `stripWsaHeaders`), `wsa/policy-detect.ts` (`wsaw:UsingAddressing`, `wsam:Action`, `wsp:Policy` Addressing → interface `wsa` defaults; default Action from `wsam:Action` → `soapAction` → `tns/portType/opRequest`); WS-A inspector; "WS-A Headers" editor action; fixture `crafted/ws-addressing`.
  - Acceptance: golden headers both versions; auto-enable on fixture; MessageID unique per send unless fixed; e2e raw view shows headers.
  - Verify: `pnpm vitest run packages/engine/test/unit/wsa`; e2e
  - Files: packages/engine/src/wsa/{headers.ts,policy-detect.ts}, packages/engine/test/unit/wsa/{headers,policy-detect}.test.ts, fixtures/wsdl/crafted/ws-addressing/**, apps/desktop/src/renderer/features/request-editor/inspectors/wsa-inspector.tsx

**Checkpoint 4:** SC5 (attachments), SC6 (Basic/NTLM), SC7 (WSS, xmlsec1-verified, no secrets on disk), SC8 (WS-A).

### M5 — Validation, WS-I, interface editor, definition lifecycle

- [x] **42. Schema validation + SOAP structure checks + Problems panel**
  - `validate/schema-validator.ts` (xmllint-wasm: schema set as in-memory files with rewritten `schemaLocation`s + wrapper schema importing every namespace; libxml2 line/col → ranges), `validate/soap-structure.ts` (envelope NS/version vs binding, Header before Body, single Body, fault shape, SOAPAction/Content-Type consistency), `validate/index.ts` (`validateMessage`); Problems tab (click → range), Monaco markers, ⌘⇧V, "auto-validate on send" preference.
  - Acceptance: string in `intA` flagged at right line; missing required element; 1.2 envelope on 1.1 binding flagged; valid Calculator clean.
  - Verify: `pnpm vitest run packages/engine/test/unit/validate`; e2e markers
  - Files: packages/engine/src/validate/{schema-validator.ts,soap-structure.ts,index.ts}, packages/engine/test/unit/validate/{schema-validator,soap-structure}.test.ts, apps/desktop/src/renderer/features/problems/problems-view.tsx, apps/desktop/src/renderer/editor/markers.ts

- [x] **43. WS-I BP 1.1 WSDL assertions**
  - `validate/wsi/types.ts` (`WsiReport {target, assertions: [{id, level, result: 'passed'|'failed'|'warning'|'notApplicable', findings: [{message, location?}]}]}`), `run-wsdl.ts`, `assertions/R*.ts` one per assertion (id, BP text, level, `check(bundle, model)`); initial catalogue ≥ 30 across imports (R2001–R2005), schema (R2101–R2114), style/parts (R2201–R2211), ordering/names (R2301–R2305), soap:address (R2401), binding/transport/soapAction (R2701–R2724), namespaces (R2801–R2803); exact list + status in `docs/ws-i-assertions.md`; fixtures `crafted/wsi-compliant`, `crafted/wsi-violations`.
  - Acceptance: compliant → all pass; violations fixture fails each implemented assertion exactly once (table keyed by id).
  - Verify: `pnpm vitest run packages/engine/test/unit/validate/wsi/wsdl`
  - Files: packages/engine/src/validate/wsi/{types.ts,run-wsdl.ts,assertions/*.ts}, packages/engine/test/unit/validate/wsi/wsdl.test.ts, fixtures/wsdl/crafted/{wsi-compliant,wsi-violations}/**, docs/ws-i-assertions.md

- [x] **44. WS-I message assertions + report UI + HTML export**
  - `validate/wsi/run-message.ts` (BP §4 subset: envelope/encodingStyle/mustUnderstand R1001–R1033, faults R1100s, HTTP/Content-Type/SOAPAction R1140s) over a `SoapExchange`; `report-html.ts`; Interface editor WS-I tab (run, table, filter failed, Export HTML via `dialogs.saveFile`); console "WS-I Report" tab; request action "Check WS-I compliance" on last exchange.
  - Acceptance: echo exchange passes; bad exchange (no charset, encodingStyle in doc/lit) fails expected ids; HTML snapshot.
  - Verify: `pnpm vitest run packages/engine/test/unit/validate/wsi/message`; e2e export
  - Files: packages/engine/src/validate/wsi/{run-message.ts,report-html.ts}, packages/engine/test/unit/validate/wsi/message.test.ts, apps/desktop/src/renderer/features/interface-editor/wsi-tab.tsx, apps/desktop/src/renderer/features/console/wsi-report.tsx

- [x] **45. Interface editor + schema browser + go-to-definition**
  - `features/interface-editor/{interface-editor.tsx, overview-tab.tsx, endpoints-tab.tsx (add/edit/remove, default auth + mode), wsdl-content-tab.tsx (documents list, read-only Monaco, prev/next), schema-tab.tsx (namespace → elements/types/groups, detail panel)}`; ⌘-click in XML editor → `declarationOf` → Schema tab; explorer "Show Interface Viewer".
  - Acceptance: CountryInfo: 24 ops, 2 endpoints, 1 doc; nested-imports: 4 docs; ⌘-click `intA` lands on declaration (e2e).
  - Verify: `pnpm test:e2e -- --grep interface`
  - Files: apps/desktop/src/renderer/features/interface-editor/{interface-editor.tsx,overview-tab.tsx,endpoints-tab.tsx,wsdl-content-tab.tsx,schema-tab.tsx}, e2e/specs/interface-editor.spec.ts

- [x] **46. Update Definition + Export + Documentation**
  - `wsdl/update-definition.ts` (`planUpdate(old, new) → {newOps, removedOps, changedOps}`, `applyUpdate(project, plan, opts: {createNewRequests, recreateRequests, recreateOptional, keepExisting (T29 merge), keepSoapHeaders, createBackups (*.bak), updateTestRequests: false})`), `wsdl/docs-generator.ts` (HTML + Markdown: services, operations, messages, types; inline CSS); dialogs: Update Definition (full option set), Export Definition (folder), Generate Documentation (save); explorer context menu entries.
  - Acceptance: `crafted/versioned/v1→v2` adds an op → request created, edits kept, backups written; docs golden; export → re-import equality.
  - Verify: `pnpm vitest run packages/engine/test/unit/wsdl/update packages/engine/test/unit/wsdl/docs`; e2e dialog
  - Files: packages/engine/src/wsdl/{update-definition.ts,docs-generator.ts}, packages/engine/test/unit/wsdl/{update,docs}.test.ts, fixtures/wsdl/crafted/versioned/**, apps/desktop/src/renderer/features/interface-editor/update-definition-dialog.tsx

**Checkpoint 5:** SC1 complete (update keeps values), SC2 complete, SC9 (validation + WS-I report + export).

### M6 — IDE polish, network options, performance, packaging, release

- [x] **47. Command registry completeness + shortcuts + menus**
  - Every action in §5/§6 registered (`CommandId` audit list); app menu + context menus generated from the registry (`main/menu.ts` receives command list, dispatches back); ⌘P quick-open (operations/requests fuzzy); ⌥←/→ next/prev element value; ⇧Tab request↔response focus; Preferences → Shortcuts editor (rebind, conflict warning, reset); activity-bar Search view (`features/search/search-view.tsx`: text/regex across request bodies, headers, cached definitions; results open at range).
  - Acceptance: test: every `CommandId` has a handler; rebinding persists; e2e keyboard-only import → send.
  - Verify: `pnpm --filter @wirebench/desktop test`; `pnpm test:e2e -- --grep keyboard`
  - Files: apps/desktop/src/shared/commands.ts, apps/desktop/src/main/menu.ts, apps/desktop/src/renderer/lib/keybindings.ts, apps/desktop/src/renderer/features/preferences/shortcuts-editor.tsx, apps/desktop/src/renderer/features/search/search-view.tsx, e2e/specs/keyboard.spec.ts

- [x] **48. Light theme + accessibility pass**
  - Light tokens; follow-OS via `nativeTheme` + `theme.changed` event; theme command; focus-visible rings; ARIA on tree/tabs/tables; reduced-motion; `scripts/contrast-check.ts` (text tokens ≥ 4.5:1); axe scan in e2e (`@axe-core/playwright`, Q1).
  - Acceptance: both themes screenshot-snapshotted; axe: no serious violations on welcome, editor, interface editor.
  - Verify: `pnpm test:e2e -- --grep "theme|a11y"`; `pnpm tsx scripts/contrast-check.ts`
  - Files: apps/desktop/src/renderer/styles/tokens.css, apps/desktop/src/renderer/lib/theme.ts, apps/desktop/src/main/ipc/theme.ts, e2e/specs/a11y.spec.ts, scripts/contrast-check.ts

- [x] **49. Proxy + TLS options**
  - `http/proxy.ts` (none / system (resolved in main via `session.resolveProxy(url)`) / manual host:port + auth + excludes), `http/tls.ts` extended (min TLS 1.2/1.3, custom CA bundle, client cert global or per endpoint from a keystore, `trustInvalid` per endpoint → `rejectUnauthorized: false` + persistent red badge on endpoint + status bar); HTTP/2 toggle (undici `allowH2`, off by default; raw view labels the protocol); Preferences HTTP/Proxy/SSL sections; endpoint TLS fields; `test/helpers/test-proxy.ts` (CONNECT proxy).
  - Acceptance: proxied request observed; excludes bypass; self-signed fails by default, passes with trustInvalid or custom CA; client-cert route enforces cert.
  - Verify: `pnpm vitest run packages/engine/test/integration/http/proxy packages/engine/test/integration/http/tls`
  - Files: packages/engine/src/http/{proxy.ts,tls.ts}, packages/engine/test/helpers/test-proxy.ts, packages/engine/test/integration/http/{proxy,tls}.test.ts, apps/desktop/src/renderer/features/preferences/network-section.tsx

- [x] **50. Performance budgets**
  - `test/bench/*.bench.ts` (CountryInfo import+generate < 300 ms; `crafted/large-schema` (5 MB) < 3 s; send overhead < 20 ms; fail CI at > 1.5× budget); `React.lazy` per editor view + Monaco chunk; e2e startup (`firstWindow` → ready mark) < 2 s on CI macOS; 1 MB XML scroll trace ≥ 50 fps; fix regressions found.
  - Acceptance: benches + startup budget green in CI.
  - Verify: `pnpm vitest bench --run`; `pnpm test:e2e -- --grep perf`
  - Files: packages/engine/test/bench/{import.bench.ts,send.bench.ts}, fixtures/wsdl/crafted/large-schema/**, apps/desktop/src/renderer/features/request-editor/request-editor.tsx, e2e/specs/perf.spec.ts

- [x] **51. Packaging + auto-update**
  - `electron-builder.yml` (appId `io.wirebench.desktop`; mac dmg+zip universal; win nsis; linux AppImage+deb+rpm; icons), Electron Fuses via `@electron/fuses` (Q1: `runAsNode` off, `enableCookieEncryption` on, `onlyLoadAppFromAsar` on), `main/updater.ts` (electron-updater, GitHub Releases provider, opt-in "check on launch", `app.checkForUpdates` command, consent before download/install), `.github/workflows/release.yml` on `v*` tags (3 OS artifacts; signing/notarization steps gated on secrets).
  - Acceptance: CI artifacts install on each OS; offline update check fails gracefully.
  - Verify: `pnpm package`; tag `v0.1.0-rc.1` → artifacts
  - Files: apps/desktop/electron-builder.yml, apps/desktop/src/main/updater.ts, apps/desktop/resources/**, scripts/fuses.ts, .github/workflows/release.yml

- [x] **52. Docs, ADRs, interop suite, release**
  - README (quick start ≤ 5 min with screenshots), CONTRIBUTING, CHANGELOG (keep-a-changelog), `docs/adr/0001-electron-stack.md`, `0002-engine-in-main-process.md`, `0003-project-folder-format.md`, `docs/architecture/overview.md`; `test/interop/*.test.ts` (5 public services) + `.github/workflows/nightly.yml` (`WIREBENCH_NETWORK_TESTS=1`); §13 evidence table (criterion → test/CI link); tag `v1.0.0`.
  - Acceptance: every §13 criterion linked to evidence; nightly interop green.
  - Verify: `pnpm check && pnpm test:e2e && pnpm test:interop`
  - Files: README.md, CONTRIBUTING.md, CHANGELOG.md, docs/adr/*.md, docs/architecture/overview.md, packages/engine/test/interop/*.test.ts, .github/workflows/nightly.yml

**Checkpoint 6 (v1 done):** SC12 (IDE shell, palette, shortcuts, themes, keyboard-only flow), SC13 (CI 3 OS, coverage ≥ 85 %, budgets, installers, docs); all SC1–SC13 re-verified.

## Risks

- Sample generation edge cases (substitution groups, recursion, rpc/encoded arrays, `xs:any`) — T7/T8 are the earliest engine tasks; golden per construct; side-by-side with reference output where available (Q3).
- WS-Security interop — xmlsec1 cross-check from T38 on; key-identifier × algorithm matrix; legacy SHA-1/CBC kept.
- NTLMv2 in-house (T35) — MS-NLMP vectors + simulated server; fallback native SSPI in 1.1 if field reports fail.
- xmllint-wasm with multi-namespace schema sets — wrapper-schema approach validated early in T42 spike (first hour); fallback: pre-merge into one schema per namespace.
- Monaco under strict CSP — local loader only (T15); `style-src 'unsafe-inline'` required, never `script-src`.
- TypeScript 7 toolchain lag (typescript-eslint, electron-vite) — pin; fall back to 5.9 at T1 if `pnpm check` cannot pass.
- Playwright Electron on Windows CI — flaky-retry 2, per-test userData dir, headless xvfb on Linux.
- Engine in main process — CPU-heavy import of 5 MB schemas may stall menus; measured in T50; `utilityProcess` move behind `EngineService` if > 250 ms.
- Scope creep (testing/mocks/load) — refuse in review; parity matrix marks phases.

## Unresolved questions

1. New deps (spec §12 "ask first") to approve before their tasks: `ulidx` (MIT, ULIDs — T17; or switch §7 to `crypto.randomUUID()`), `node-forge` (BSD-3, PKCS#12 + test cert generation — T31/T36), `jsdom` dev (T12), `@electron/fuses` dev (T51), `@axe-core/playwright` dev (T48). Default if silent: approve all.
2. Execution mode: subagent-driven (fresh subagent per task, review between) vs inline in-session? Default: subagent-driven.
3. Is reference output available on this Mac for side-by-side sample-generation comparison during T8? Default: docs + fixtures only.
4. GitHub org/repo `wirebench` must exist before T4 (CI) — user action. Until then CI config is committed but unverified.
5. Test-time cert/keystore generation (node-forge) vs committing pre-generated test-only certs (expire; conflicts with "never commit keystores"). Default: generate at test time.
