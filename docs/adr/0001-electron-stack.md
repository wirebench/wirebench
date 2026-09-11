# ADR-0001: Electron + TypeScript + React, with the protocol engine as a separate package

- Status: accepted
- Date: 2026-09-09
- Context: spec §3 (tech stack), §4 (architecture), §17 (decision log)

## Context

Wirebench is a desktop workbench for SOAP/WSDL: it has to parse and edit large XML documents,
speak HTTP with fine-grained control over headers, TLS, proxies and connection affinity, do
XML-DSig and XML-Enc, and present all of that in an IDE-shaped UI on macOS, Windows and Linux.
The reference point for the UI is Claude Code's desktop shell; the feature set is the one
classic SOAP workbenches established, reimplemented clean-room — no code from other SOAP tools
is copied (many are copyleft, incompatible with Apache-2.0).

Two questions had to be answered together: what the app is built on, and where the protocol
work lives.

## Decision

**Electron 44 + TypeScript (strict) + React 19 + Monaco**, built with electron-vite, packaged
with electron-builder. Everything protocol-related lives in `packages/engine`
(`@wirebench/engine`), a plain Node library with zero Electron, DOM or React imports —
lint-enforced, not merely intended.

The supporting choices follow from that split: `@xmldom/xmldom` as the namespace-aware DOM
shared with `xml-crypto`/`xml-encryption`, `fontoxpath` for XPath/XQuery 3.1, `xmllint-wasm`
for XSD validation, `undici` for HTTP, `zod` for every IPC and file schema.

## Rationale

- **The XML/crypto ecosystem decides the runtime.** XML-DSig and XML-Enc against real WSS4J
  and WCF services need mature, namespace-correct libraries. Node has them; Rust (Tauri) does
  not, at the level of fidelity a signature that must verify elsewhere requires.
- **Monaco is the IDE feel.** Find/replace, folding, markers, a minimap and the VS Code
  keymap arrive for free. CodeMirror would have meant rebuilding that.
- **No native modules.** `xmllint-wasm` rather than `libxmljs2`, pure-JS XPath rather than
  `saxon-js`: the three-OS build matrix stays a plain `pnpm install`.
- **One runtime, not two.** A JVM sidecar (to reuse Java's WS stack) would have doubled what
  the installer ships and what the user has to trust.
- **The engine is where the value compounds.** As a library it is unit-testable without
  Electron, and it powers the planned v2 `wirebench run` CLI unchanged (spec §14). Keeping it
  Electron-free is the constraint that makes that true later instead of aspirational.

## Consequences

- Electron's footprint (~100 MB installed) and its security model are ours to manage; see
  ADR-0004, ADR-0005 and [`../security.md`](../security.md).
- TypeScript's strictest settings (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, no `any`) apply everywhere, which costs typing effort at the
  boundaries — XML parsing especially — and pays for it in the engine's test suite.
- The engine's "no Electron/DOM" rule is a real constraint on design: anything needing a file
  dialog, a keychain or a window is main-process code that *calls* the engine, never engine
  code.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| Tauri (Rust) | XML-DSig/XML-Enc immaturity; the exact area we cannot afford to get wrong |
| Java desktop (Swing/JavaFX/SWT) | The UI would not feel like a modern IDE shell |
| JVM sidecar behind an Electron UI | Two runtimes to ship, install, update and debug |
| CodeMirror instead of Monaco | Rebuilding the VS Code editing experience by hand |
| `fast-xml-parser` as the primary DOM | Lossy namespace handling — fatal for WSS |
| `saxon-js` | No XQuery in the open build; non-OSS license |
| `libxmljs2` | Native module on three OSes and two architectures |
