# Wirebench: the first extension points — design

Date: 2026-10-23 · Status: proposed, owner rulings below · Issue #765 (phase 7 of #184, feeds #82).

- Builds on: ADR-0016 (a script runs with no capabilities), ADR-0017 (a protocol is a module behind
  one interface), ADR-0029 (team policy only restricts), ADR-0030 (package boundaries), the phase 4
  spec (feature switches), the phase 5 spec (package split, §5.4 subpaths) and the phase 6 spec
  (the slot pattern).
- Decides: ADR-0031, the plugin trust model.
- Owner rulings (2026-10-23, one popup):
  1. Installed plugins live in **one per-user folder**, `<userData>/plugins/<id>/`, shared by the
     desktop and the CLI.
  2. A team policy can forbid plugins **wholesale and one by one**: a `plugins` feature id and a
     `plugin:<id>` id per plugin, both restrict-only.
  3. The manifest declares network access as **a list of origins**; the broker refuses every
     other origin. The security review then narrowed it: only importers may hold network (§8),
     because reporters and code generators are handed data an origin list cannot keep in.
  4. The built-in importers, reporters and code generators **go through the new registry** in this
     phase, as trusted in-process entries; plugins add sandboxed entries beside them.

## 1. Goal

Let a person add an importer, a report format or a code generator to their own Wirebench without
forking it, and prove the trust model #82 will build on, on the narrowest surface that is useful.
The three points are data in, data out: none needs UI, none touches a request on the wire, so a
contribution can run in a sandbox like the one scripts use.

## 2. Measured state (main at 2b36cfd1f)

| Point | Where | Closed by |
| --- | --- | --- |
| Importers | `packages/engine/src/import-detect.ts` (also the browser-safe `@wirebench/engine/detect` subpath); import functions spread over `protocol-soap`, `protocol-rest`, `protocol-grpc`, `protocol-ws` and `engine/src/import/*` | `ImportFormatKind`, a union of 20 kinds plus `unknown`; one if-chain in `detectFromText`; `ImportOutput.format` in `cli/src/ops/import.ts`; one IPC channel per format in `apps/desktop/src/main/ipc/api.ts`; `IMPORT_FORMATS` in `renderer/features/explorer/import-formats.ts` |
| Reporters | `packages/cli/src/reporters/` (`junit.ts`, `html.ts`, `json.ts` over `core/src/run/report.ts`, `cli.ts`); masked by `mask.ts` | `REPORTER_KINDS` in `cli/src/args.ts`; the if-chain `buildReporters` in `cli/src/commands/run.ts` |
| Code generators | `packages/core/src/http/codegen/`: `Target = (CodeRequest, Layout) => GeneratedCode`, 11 targets | the private `TARGETS` record in `codegen/index.ts`; `CODE_TARGETS` in `model.ts`; the duplicated `GENERATED_CODE_TARGETS` in `apps/desktop/src/shared/code-targets.ts` |

What is already right and is kept:

- `MappedClientImport` with `placeMappedImport` (desktop) and `addMappedCollections` (CLI) is a
  "the importer returns data, the host places it" contract four importers share.
- Every CLI reporter already sees only masked results (`createMaskedReporters`).
- A code target is a pure function, and secrets reach it only as environment-read markers.
- The sandbox (`core/src/script/sandbox/`) is QuickJS on a worker thread, fresh runtime per job,
  bounded in time and memory. Its host functions are synchronous and do no I/O.
- The desktop never uses the CLI reporters; only the main process calls `generateCode`.

## 3. The three contribution points

Every contribution has an `id`, a `title` and an `origin`: `builtin` or `{ plugin: <id> }`. A
plugin's contribution ids are namespaced as `<plugin-id>/<contribution-id>` everywhere a person
types one (`--reporter acme/summary=out.txt`), so a plugin can never shadow a built-in.

### 3.1 Importer

```ts
interface Importer {
  detect(input: ImportInput): 'definite' | 'probable' | null
  import(input: ImportInput, context: ImportContext): Promise<ImportResult> | ImportResult
}
interface ImportInput { filename: string; text: string }
```

- **Built-ins keep their order.** Detection runs the built-in detectors exactly as today. Plugin
  detectors run only when every built-in says `unknown`, so a plugin can never take a WSDL, an
  OpenAPI document or a Postman collection away from the importer people expect. Between plugins,
  `definite` beats `probable`; a tie is not guessed, the person picks.
- **The browser-safe subpath stays built-in only.** `@wirebench/engine/detect` keeps working in the
  renderer as it does; plugin detection runs in main and reaches the import dialog through the
  existing `api.detectImportSource` channel.
- **What a plugin importer returns is data the host already places.** `ImportResult` is a narrowed
  `MappedClientImport`: REST, gRPC and WebSocket API documents in the project-file shape, plain
  variables and environments, and an `ImportReport`. The host validates it with the project's zod
  schemas and places it through `placeMappedImport` / `addMappedCollections`. Scripts are not
  accepted in this phase; a result that carries them fails validation. Secrets are reported, never
  written, as today. URLs, names and descriptions go through the same checks as a built-in
  import's: no `file:` or `javascript:` links.
- `detect` sees at most the first 1 MiB of the file and gets 1 s, since every plugin's `detect`
  runs on an import no built-in claims.
- `ImportFormatKind` becomes `BuiltinImportFormatKind | \`plugin:${string}\``; the built-in union is
  unchanged.

### 3.2 Reporter

```ts
interface Reporter { extension: string; render(report: RunReport): string }
```

- `RunReport` is the masked JSON report (`JsonReport`, `formatVersion: 1`), the shape the JSON
  reporter and the server's schedules already write. A reporter turns it into one text file; the
  host writes the file the person named. The JUnit, JSON and HTML reporters become built-in
  entries; the console reporter stays outside the registry, since it streams.
- Wirebench never opens or serves a plugin's report; it only writes the file. A plugin HTML report
  opened in a browser is the reader's choice, and `docs/security.md` says so.
- CLI: `--reporter <id>=<file>` accepts any registered id. The desktop runner gains no export in
  this phase (follow-up).

### 3.3 Code generator

```ts
interface CodeGenerator { language: string; generate(request: CodeRequest, layout: Layout): GeneratedCode }
```

- `language` is an editor language id, used only to highlight the output.
- A plugin receives `CodeRequest` with every string that may read the environment as
  `TextPart[]` (`{ text } | { env }`) instead of the internal marker text, so an author never parses
  markers. Built-in targets keep their internal form.
- Credential-bearing values reach a plugin generator as `{ env }` parts, never as text, even when
  they came from a plain variable: `Authorization`, `Proxy-Authorization`, `Cookie`, the header
  names configured auth writes, and the basic-auth password.
- The output passes through `redactSecretText`, as today. The desktop's code panel lists the
  generators main reports; `GENERATED_CODE_TARGETS` is deleted.

## 4. The registry

- `packages/core/src/extension/` holds `ExtensionRegistry { importers, reporters, codeGenerators }`,
  each a list of entries with `feature` (a feature id) and `origin`. The registry is immutable
  once built, like the protocol registry.
- `packages/engine/src/extensions.ts` composes the built-ins, as `protocols.ts` composes the
  protocols; the built-in importers keep their homes and are wrapped there. `createBuiltinRegistry`
  gains the extension registry beside the protocol one.
- **Feature switches.** Built-in entries name an existing descriptor (an importer of a kind
  requires that kind's switch; `asyncapi` keeps requiring `websocket`). Two descriptors are new:
  `plugins` (`default: true`, `stable`) and, per installed plugin, `plugin:<id>` (`default: true`,
  `stable`, `requires: ['plugins']`). Every contribution of a plugin is behind its plugin's id.
  Settings → Features, the CLI `--features` flag, the MCP tool list and team policy pick them up
  with no new code: a disabled contribution is absent from every list and refuses with
  `feature-disabled` when named.

## 5. The `@wirebench/engine/plugin` subpath

- `packages/engine/src/plugin.ts` declares, self-contained, the types a plugin author needs: the
  three contribution interfaces, `ImportInput`, `ImportResult` and the document shapes it carries,
  `RunReport`, `CodeRequest`, `Layout`, `GeneratedCode`, `TextPart`, the manifest type, the host
  API (`log`, `crypto`, `encoding`, `net`) and `PLUGIN_API_VERSION`.
- **Self-contained** means it imports nothing. A type-level test asserts each plugin type and its
  internal counterpart are assignable both ways, so they cannot drift, and the internal types stay
  free to change shape behind a mapping.
- **Versioned on its own.** `PLUGIN_API_VERSION` is semver, independent of the engine's version.
  A manifest names the major it was written for (`"api": 1`); a plugin for another major refuses
  to load with `plugin-api-mismatch`.
- **API report.** `packages/engine/api/plugin.api.d.ts` is the emitted declaration of the subpath,
  committed. `pnpm check:plugin-api` (in `pnpm check`) emits it again and fails when it differs, or
  when it changed without `PLUGIN_API_VERSION` changing; the report's header records the version it
  was made for. No new dependency: the TypeScript compiler the repo already has emits it.

## 6. A plugin on disk

```
<userData>/plugins/<id>/
  wirebench-plugin.json   the manifest
  main.js                 one ES module, bundled, importing nothing
  README, LICENSE         optional; nothing else is accepted
<userData>/plugins.lock.json   written by the installer: per id, the hashes and the install time
```

```json
{
  "manifestVersion": 1,
  "id": "acme",
  "name": "Acme formats",
  "version": "1.2.0",
  "api": 1,
  "main": "main.js",
  "contributes": {
    "importers": [{ "id": "acme-collection", "title": "Acme collection", "extensions": [".acme"] }],
    "reporters": [{ "id": "summary", "title": "Acme summary", "extension": ".txt" }],
    "codeGenerators": [{ "id": "kotlin-ktor", "title": "Kotlin (Ktor)", "language": "kotlin" }]
  },
  "capabilities": { "network": ["https://schemas.acme.example"] }
}
```

- `id` matches `^[a-z0-9][a-z0-9-]{1,62}$`. `main.js` exports `importers`, `reporters` and
  `codeGenerators` objects keyed by contribution id; a key the manifest does not declare, or a
  declared key `main.js` does not export, fails the load (`plugin-manifest-invalid`).
- `<userData>` is the desktop's (`~/Library/Application Support/Wirebench`, `%APPDATA%\Wirebench`,
  `$XDG_CONFIG_HOME/Wirebench`); the CLI already resolves it in `cli/src/ops/paths.ts`.
  **No environment variable or flag points either at another plugins folder**: a CI job, a
  project's `.env` or an npm script could otherwise name a folder of code nobody installed. Tests
  use the desktop's existing unpackaged-only `WIREBENCH_USER_DATA_DIR` and, in the CLI, a
  programmatic option. Turning plugins off is always allowed: `--no-plugins` or
  `WIREBENCH_PLUGINS=off`.
- **Installing** is done by `wirebench plugin install <path>` (with `list`, `remove`) or by Settings
  → Plugins → Install from folder…; both show the contributions and the network origins and ask
  before writing. A reinstall over an existing id shows the old and new origins and asks again.
  - The target folder name is the validated manifest `id`, never the archive's or folder's name.
  - A `.tgz` is extracted into a temporary folder; an absolute entry, an entry with `..`, a
    symlink, a hard link or a device file refuses the install, as does more than 16 files or
    64 MiB. Only the files listed above are accepted. The result moves into place with one rename.
  - The installer writes the SHA-256 of the manifest and `main.js` to `plugins.lock.json`,
    outside the plugin folders, so a hand-edited folder cannot vouch for itself.
- **Loading** happens at start-up: the desktop reads the folder once per launch, the CLI once per
  process. There is no hot loading; an install takes effect at the next start.
  - A plugin folder that is a symlink, or a plugin with no lock entry, is skipped.
  - `main.js` is read once with `O_NOFOLLOW` into memory; that buffer is hashed and that buffer is
    evaluated, so nothing can swap the file between the check and the run. A mismatch is
    `plugin-modified` until the plugin is installed again.
  - The CLI prints the plugins it loaded and their origins to stderr, once per process.

## 7. The plugin sandbox

- Same design as scripts (ADR-0016): QuickJS in WebAssembly, on a worker thread, a fresh runtime
  per call, no host object reachable, plain functions passing strings and JSON across.
- It uses the **asyncify** build of the same QuickJS release
  (`@jitl/quickjs-wasmfile-release-asyncify@0.32.0`, MIT), because `net.fetch` must wait on the
  host. Scripts keep the sync build. One new runtime dependency.
- `main.js` is evaluated as a module; the module loader refuses every import.
- Limits per call: 60 s wall clock, network included; 128 MiB memory; 32 MiB input and output;
  the script limits for stack and log; at most 16 calls queued. A breach is `plugin-error` with the
  cause (`timeout`, `memory`, `error`), naming the plugin and contribution.
- The host API is `log`, the pure `crypto` and `encoding` functions scripts have, and, in an
  importer's `import` only, `net` when the manifest lists origins. No files, no environment, no
  timers, no secrets, no project access beyond the input the call was given.
- Every result is validated at the boundary with zod before the host uses it.

## 8. Brokered network

`net.fetch({ method, url, headers?, body? })` resolves to `{ status, headers, body }` (text).

- **Only importers have network.** A reporter is handed run results and a code generator a request;
  both hold values no mask catches (tokens from plain variables, cookies, response text). An origin
  list limits where data goes, not what goes, so a contribution that is handed that data gets no
  network at all. The manifest refuses `capabilities.network` on a plugin with no importer, and
  the broker exists only inside an importer's `import` call.
- The origin (scheme, host, port) must equal one the manifest lists; no wildcards in this phase.
  Anything else is `plugin-network-denied`.
- **The address is checked, not only the name.** The broker resolves the host once and refuses
  loopback, link-local, private, CGNAT, unique-local and metadata addresses unless the listed
  origin is itself such a literal address; it connects to the address it checked (a pinned
  `lookup` on the dispatcher), so a DNS answer that changes between check and connect cannot move
  it. With a proxy configured, the same check runs on the name before the request leaves.
- **The broker follows redirects itself.** It calls `sendHttp` with redirects and the HTTPS upgrade
  off, follows at most 5 hops, and checks the origin and address of each.
- The request goes through `sendHttp` with the dispatcher the host builds for that URL
  (`mainHttpOptions` on the desktop, `proxyFromEnv` in the CLI), so proxy, trusted CAs and the TLS
  floor apply.
- No configured auth, cookie or secret is ever attached. A plugin can send only what it knows.
- Each exchange is redacted like a send and appended to `history/plugin-<id>.jsonl` in the history
  folder, on the desktop and in the CLI: method, URL, status, headers, sizes and timings, no bodies.
  The file is capped at 10 MiB, oldest entries first out.
- Caps per call: 32 requests, 16 MiB per response, inside the 60 s call budget.

## 9. Declarative UI

No plugin code reaches the renderer. The renderer sees manifest data only, over IPC: the import
dialog lists plugin formats by title and extension, the code panel lists generators by title,
Settings → Plugins lists each plugin with its contributions, origins, version and switch. Their
switches also appear in Settings → Features under a Plugins group.

## 10. Errors

New stable codes: `plugin-manifest-invalid`, `plugin-api-mismatch`, `plugin-modified`,
`plugin-missing` (a named contribution whose plugin is not installed), `plugin-network-denied`,
`plugin-error`. Disabled stays `feature-disabled`.

## 11. Gate

`pnpm check:engine-layers` gains: `core/src/extension/**` is core; `engine/src/plugin.ts` imports
nothing; `engine/src/extensions.ts` is composition.

## 12. Slices (one PR each)

1. **Registry.** `core/src/extension`, `engine/src/extensions.ts`; built-in importers (detection
   order unchanged), JUnit/JSON/HTML reporters and the 11 code targets registered through it; CLI
   `--reporter` and import, the desktop code panel's list, read the registry. No behaviour change.
2. **Plugin subpath.** `@wirebench/engine/plugin`, `PLUGIN_API_VERSION`, the two-way type test,
   the API report and `pnpm check:plugin-api`.
3. **Loading in the engine and CLI.** Manifest schema, installer, `installed.json` hashes, the
   asyncify sandbox, the network broker, the `plugins` and `plugin:<id>` descriptors,
   `wirebench plugin install|list|remove`, plugin importers in `import`, plugin reporters in `run`.
4. **Desktop.** Plugins loaded at start-up in main; Settings → Plugins; plugin formats in the
   import dialog; plugin generators in the code panel; guide page and `docs/security.md`.

## 13. Out of scope

A plugin API for protocols, a marketplace, hot loading, plugin UI code, plugin scripts in imports,
wildcard origins, and a desktop report export. Those stay in #82 or follow-ups.

Known limits, filed as follow-ups rather than solved here:

- A policy names a plugin by its self-declared id, so an administrator cannot block one plugin
  ahead of its install, and a hostile plugin can pick an unused id. The `plugins` switch covers
  that case. Matching on the content hash, or an "only these plugins" entry, both still
  restrict-only, are follow-ups.
- The CLI has no policy level today (phase 4): a CI run against a synced workspace does not apply
  its `disabledFeatures`. `--no-plugins` is the CI answer until it does.
- A CLI run as another user, or in a container with the home folder mounted, loads that home
  folder's plugins; the stderr line makes it visible.
