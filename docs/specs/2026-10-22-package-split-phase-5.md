# Wirebench: the package split — design

Date: 2026-10-22 · Status: draft, awaiting the owner's review · Issue #750 (phase 5 of #184).
Phases 1 to 4 are merged (#742 last, 2026-10-22): every protocol is a `ProtocolModule`,
`packages/engine/src/protocols.ts` composes them, the desktop sends through them and has its own
kind modules, and the feature switches are user-facing.

- Builds on:
  - ADR-0017 (a protocol is a module behind one interface) and the phase 1 spec
    (`docs/specs/2026-09-30-wirebench-protocol-modules-design.md`, §7: the dependency rules and the
    groups), which this phase turns from a script's opinion into package boundaries.
  - `scripts/engine-import-graph.mjs`, the gate `pnpm check:engine-layers` runs today.
  - #460 / PR #489: `@wirebench/ssh` stays private and is copied into the CLI tarball at prepack,
    reached through a `#ssh` import map. The same route is open to the new packages.
  - ADR-0030 (package boundaries are checked at the boundary), written with this phase.
- Decisions this spec leaves to the owner, asked before PR B (§6.4): whether the new packages
  publish to npm or stay private and vendored into `@wirebench/engine`, and whether `core` is a
  published name.

## 1. Goal

Move the engine's folders into workspace packages that match the epic's target shape, so that the
three dependency rules are enforced by the package graph and the compiler, not only by a script
run from `pnpm check`; a protocol written against the interface (phase 6) can then be a package
of its own. `@wirebench/engine` keeps its name, its public exports and its browser-safe subpaths:
the CLI, the server, the desktop and npm users change no import.

### 1.1 In scope

- The last cycles inside `packages/engine/src` (§3), so the gate reports zero violations with no
  exception list.
- The gate, extended to the package boundary (§4).
- The packages `core`, `protocol-soap`, `protocol-rest`, `protocol-grpc`, `protocol-ws`,
  `protocol-mcp` and the composing `engine` (§5, §6), with the build, the tests, the release
  pipeline, `pnpm pack:check` and the third-party licence report covering them (§7).
- The docs: this spec, ADR-0030, `docs/architecture/overview.md`, the engine README.

### 1.2 Out of scope

- Any change to what `@wirebench/engine` exports, beyond what §3 names. Deciding which exports
  are library API is phase 7's.
- Moving the engine's tests out of `packages/engine/test` (§6.3): they test the composition and
  stay there in this phase.
- The desktop's per-kind folders (ADR-0023) and the CLI: untouched.
- GraphQL as `protocol-graphql` (phase 6, #77).

## 2. Measured state (2026-10-22, main at 3a9b6be18)

`packages/engine/src` holds 695 source files in 36 folders; `test/` holds 619 test files.
`node scripts/engine-import-graph.mjs` reports 418 imports that leave their group for a protocol
group, all of them allowed by its exception list, in these files:

| Core file | Imports from protocol groups | Status |
| --- | --- | --- |
| `index.ts` | 313 re-exports | the public exports: becomes `engine`'s |
| `protocols.ts` | 28 | the composition file: becomes `engine`'s |
| `project-files.ts` | 6 | lists every protocol's files: `engine` |
| `import-detect.ts` | 3 | format detection: `engine` |
| `export/tree.ts` | 10 | the collection exporters read every protocol's containers: `engine` |
| `import/collection-v3/map.ts`, `insomnia/map.ts`, `http-file/map.ts`, `http-file/import.ts`, `opencollection/map.ts`, `hoppscotch/convert.ts`, `thunder/convert.ts` | 42 | one file or collection becomes several protocols' APIs: `engine` |
| `project/attachments-cache.ts` | `Attachment`, type-only | SOAP's: moves (§3.2) |
| `project/environments.ts`, `workspace/environments.ts` | `Endpoint`, `Interface`, `SoapRequestDef`, type-only | SOAP's: moves (§3.2) |

The script does not see three more dependencies, because it counts `protocols.ts` as core:

- 19 core files import `defaultRegistry()` from `protocols.ts` as the fallback for a registry the
  caller did not pass (`project/load.ts`, `save.ts`, `serialize.ts`, `container-slugs.ts`,
  `request-location.ts`, `run/run.ts`, `select.ts`, `open.ts`, `secret-needs.ts`,
  `sequence/run.ts`, `script/lookup.ts`, `script/types/api.ts`, `secrets/scan/apply.ts`,
  `walk.ts`, `mock/record.ts`, `generate.ts`, `server.ts`, `stub-check.ts`,
  `workspace/reidentify.ts`).
- `run/run.ts`, `run/select.ts`, `run/open.ts`, `run/secret-needs.ts` and `script/run.ts` import
  the built-in unions `SelectedRequest`, `SentExchange`, `LiveEvent` and `ResponseSnapshot`, which
  `protocols.ts` builds from every protocol's types.
- `run/context.ts` imports `HeldSoapDefinition` and declares two SOAP-only host hooks on
  `RunContext`: `defaultWsaActionFor` and `loadedDefinitionFor`.

Protocol folders import core 808 times, from 112 distinct core files (`http/` 31, `project/` 23,
`xml/` 10, `import/` 8, `run/` 7, `json/` 6, `script/` 6, the rest fewer). No protocol folder
imports another: rule 1 holds with no exception, as it has since phase 1.

Outside the engine, nothing imports `packages/engine/src` by path except three scripts
(`project-schemas.ts`, `docs-script-api.ts`, `wsi-docs.test.ts`), two desktop tests
(`engine-detect-browser-bundle.test.ts`, `send-exchange-soap.test.ts`), one site test and
`vitest.config.ts`'s coverage filter. Hosts import `@wirebench/engine` (328 imports) and the seven
subpaths `/xml`, `/rest`, `/grpc`, `/ws`, `/json`, `/detect`, `/snapshot`.

Third-party dependencies by group (the manifests of §5.2): core uses `zod`, `yaml`, `undici`,
`jose`, `node-forge`, `ulidx`, `typescript`, `quickjs-emscripten-core`,
`@jitl/quickjs-wasmfile-release-sync`, `@xmldom/xmldom`, `fontoxpath`, `jsonpath-plus` and the
optional `kerberos`; SOAP uses `@xmldom/xmldom`, `xml-crypto`, `xmllint-wasm`, `node-forge`,
`undici`, `zod`; REST uses `graphql`, `yaml`, `zod`, the three `@stoplight/spectral-*`; gRPC uses
`protobufjs`, `zod`; WebSocket uses `undici`, `zod`; MCP uses `@modelcontextprotocol/sdk`,
`undici`, `zod`.

## 3. Breaking the last cycles (PR A)

PR A changes no package: it makes the engine's own tree obey the rules the packages will enforce,
so PR B is a move of folders with import paths rewritten.

### 3.1 The composition is its own group

The gate gets a fourth group, **compose**: `index.ts`, `protocols.ts`, `project-files.ts`,
`import-detect.ts`, `export/`, and the client importers under `import/` (`bruno/`,
`collection-v3/`, `hoppscotch/`, `http-file/`, `insomnia/`, `opencollection/`, `thunder/`,
`client-import.ts`, `read-folder.ts`, `index.ts`). What the protocols share of `import/`
(`credential-values.ts`, `credentials.ts`, `examples.ts`, `report.ts`, `scripts.ts`,
`template-dialects.ts`, `templates.ts`, `values.ts`, `variables.ts`) stays core; nothing in it
imports a protocol today.

The rules become:

1. a protocol group imports core and itself;
2. core imports core;
3. compose imports anything, and nothing imports compose.

The exception list goes. Every violation PR A removes is one §2 names.

### 3.2 SOAP's types leave core

- `resolveEndpoint` and `resolveAuthEndpoint` move from `project/environments.ts` to
  `soap/endpoints.ts`; `resolveWorkspaceEndpoint` moves from `workspace/environments.ts` to
  `soap/workspace-endpoint.ts`. `EndpointSource` and `BaseUrlSource`, which REST's
  `resolveApiBaseUrl` shares, stay where they are. `index.ts` re-exports the moved functions
  under their names, so the desktop's four callers change nothing.
- `createFileAttachmentResolver` and `AttachmentResolver` move from `project/attachments-cache.ts`
  to `soap/attachments.ts`; the byte cache (`putAttachment`, `readAttachment`) stays core, keyed
  by hash, and knows no `Attachment`.

### 3.3 The default registry is a slot the composition fills

`protocol/default-registry.ts` (core) holds `defaultRegistry()` and `installDefaultRegistry(factory)`.
`protocols.ts` installs `createBuiltinRegistry` when it is loaded; `defaultRegistry()` throws
`WirebenchError('registry-missing', …)` when nothing composed. The 19 fallbacks keep their lines,
with the import changed. Every host loads `@wirebench/engine`, whose `index.ts` imports
`protocols.ts`. The engine's own tests, which import source files directly, get a vitest
`setupFiles` entry that imports `protocols.ts`; `scripts/docs-script-api.ts` passes
`createBuiltinRegistry()` explicitly.

This replaces the phase 1 spec's sentence that "the fallback moves to the composing package and
core's parameter becomes required": a required parameter would have meant a wrapper in `engine`
for each of the 19 entry points to keep the public signatures, which is more code to the same
effect.

### 3.4 The unions are open interfaces

`protocol/unions.ts` (core) declares `SelectedRequests`, `SentExchanges`, `LiveEvents`,
`RequestSnapshots` and `ResponseSnapshots` as empty interfaces, and the unions as
`SelectedRequests[keyof SelectedRequests]` and so on. Each protocol adds its member by module augmentation in the file that defines the member
(`run.ts` for the selected request and the exchange, `scripting.ts` for the snapshots, `events.ts`
for the live event, `model.ts` for the request): `declare module '../protocol/unions.js' { interface
SentExchanges { soap: { … } } }`. Beside the member, not in `module.ts`, so that any program which
holds the file that builds the literal also holds the augmentation; the desktop's tests, which
import engine source files directly, found the gap when the augmentations sat in `module.ts`. In a compile that holds every module, which is every
compile of `engine` and of its hosts, the unions are what `protocols.ts` builds today; `protocols.ts`
keeps exporting them under the same names, and re-exports one type from each augmenting file: a
value import of a module leaves no trace in a `.d.ts`, so a host compiling against `dist` would
otherwise see a union missing the members of every file its own imports do not reach (the CLI and
the desktop both did, for different members). In a compile of core alone each union is `never`, which
is the point: core never looks inside one. Core's run loop and selector work on `SelectedBase`
(`run/select.ts` already casts every item through it) and store an exchange or event as the
module's `send` returned it; the five places that hand an item or an exchange to a host callback
typed with a union cast once, with a comment naming this section.

`RunContext`'s two SOAP hooks and `HeldSoapDefinition` move to `soap/run.ts` by the same means:
`declare module '../run/context.js' { interface RunContext { defaultWsaActionFor?; loadedDefinitionFor? } }`.
The desktop's `send/exchange.ts` keeps setting them.

ADR-0017 rejected declaration merging for the container lists because a typed `project.containers.grpc`
would depend on which modules a file imports. That objection does not reach the unions: nothing in
core reads a union member, and every file outside core is compiled with every module. ADR-0030
records the pattern and its limit: a module's member is in the union only where that module is
compiled, so a fifth protocol a host composes without `@wirebench/engine` must be imported by the
host for its types to appear.

### 3.5 What else PR A checks

- `script/run.ts` types `response` as `ResponseSnapshotBase`; the union there only served
  literals in tests.
- The gate also refuses `electron`, `react`, `react-dom` and `@wirebench/desktop` in any engine
  package, because `eslint.config.js` names `packages/engine/**` only and the file is protected
  from edits; the `packages/ssh layering` test in `scripts/engine-layers.test.ts` already does
  this for ssh and is extended.

## 4. The gate at the boundary (PR B)

`scripts/engine-import-graph.mjs` reads the packages instead of folders. A package is a group:
`packages/core` is core, `packages/protocol-*` are protocols, `packages/engine` is compose. It
checks three things and fails on any:

1. **Relative imports stay inside their package.** A `../../core/src/…` import compiles under
   `tsc -b` only by accident and never from `dist`; the gate refuses it.
2. **Bare imports follow the rules.** `@wirebench/core/*` is allowed from a protocol and from
   `engine`; `@wirebench/protocol-*` is allowed from `engine` only; nothing imports
   `@wirebench/engine` from inside these packages. The same rules apply to `package.json`
   `dependencies`: a protocol lists `@wirebench/core` and its third-party packages, `core` lists no
   `@wirebench/*`, `engine` lists them all.
3. **Nothing in these packages imports `electron`, `react`, `react-dom` or `@wirebench/desktop`.**

The report keeps its shape (`[rest->soap] file -> file : names`), `--json` stays, and the fixture
test in `scripts/engine-layers.test.ts` gets one package tree per rule.

## 5. The packages

### 5.1 Which folder goes where

| Package | Folders of today's `packages/engine/src` |
| --- | --- |
| `packages/core` | `account/`, `assert/`, `contract-diff/`, `http/`, `import/` (the shared files of §3.1), `json/`, `keystore/`, `mock/`, `project/`, `protocol/`, `redact/`, `run/`, `script/`, `secrets/`, `sequence/`, `server-api/`, `snapshot/`, `sync/`, `team-secrets/`, `workspace/`, `xml/`, `xpath/`, `errors.ts`, `fs.ts`, `worker-output.ts` |
| `packages/protocol-soap` | `soap/`, `wsdl/`, `xsd/`, `wss/`, `wsa/`, `validate/` |
| `packages/protocol-rest` | `rest/`, `webhooks/` |
| `packages/protocol-grpc` | `grpc/` |
| `packages/protocol-ws` | `ws/`, `asyncapi/` |
| `packages/protocol-mcp` | `mcp/` |
| `packages/engine` | `index.ts`, `protocols.ts`, `project-files.ts`, `import-detect.ts`, `export/`, the client importers of `import/`, and the subpath entries (§6.2) |

Each folder keeps its name under `src/` of its package (`packages/protocol-soap/src/soap/…`), so
a blame, a doc path and a grep still find the file by the name it has today, and `validate/` keeps
its place beside `wsdl/` and `xsd/`. Files move with `git mv`; only import paths change.

`mcp/` is the MCP request kind (#79). The epic names it as its own protocol package, so it gets
one; `protocol-mcp` lists `@modelcontextprotocol/sdk`, which no other package needs.

### 5.2 Manifests

Every package: `"type": "module"`, `engines.node >= 24`, `tsc -b` for `build` and `typecheck`,
`"license": "Apache-2.0"`, and the `development` export condition on `./src` so the desktop's
bundler, vitest and the site build read source. The third-party `dependencies` are the §2 lists;
`@wirebench/core` is a `workspace:*` dependency of every protocol package, and `engine` depends
on all six.

`core` and the protocol packages export their files by subpath, not through a barrel:

```json
"exports": {
  ".": { "development": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./*": { "development": "./src/*.ts", "types": "./dist/*.d.ts", "default": "./dist/*.js" }
}
```

A protocol imports `@wirebench/core/http/entries`, extensionless, which Node, TypeScript
(`NodeNext`) and Vite resolve alike. The 112 core files protocols reach and the 313 re-exports of
`engine`'s `index.ts` would otherwise need a curated barrel per package, which this phase has no
reason to design: the packages are reached only by each other and by `engine`, and §6.4 says what
is and is not promised to npm users. The `.` entry of a protocol package exports its module and
what `engine`'s `index.ts` re-exports from it; `core`'s `.` exports the interface, the registry,
the feature set, the unions and the errors.

### 5.3 TypeScript and the build

Root `tsconfig.json` references the new packages; `engine` references the six, each protocol
references `core`, the CLI and the server keep referencing `engine`. `tsc -b` builds them in
order. `rootDir: src` in each package is what makes rule 1 of §4 a compiler error as well.

### 5.4 The engine's subpaths

`@wirebench/engine/rest` resolves today to `src/rest/browser.ts`. It becomes `src/subpaths/rest.ts`
with `export * from '@wirebench/protocol-rest/browser'`, and likewise `/grpc`, `/ws`, `/asyncapi`,
`/xml`, `/json`, `/snapshot`, `/detect`. The renderer's bundler follows the `development`
condition into the protocol package's source, as it follows it into the engine's today; the
browser-bundle test (`apps/desktop/test/engine-detect-browser-bundle.test.ts`) keeps guarding
that no Node import reaches the renderer.

## 6. What stays the same, and what the owner decides

### 6.1 `@wirebench/engine`

The npm name, `publishConfig`, every export of `index.ts` (guarded by `public-exports.test.ts`
and `public-exports.types.ts`) and the subpaths. `index.ts` re-exports from the packages instead
of from folders.

### 6.2 Hosts

The CLI, the server, the desktop, e2e and the site import `@wirebench/engine` and its subpaths.
The desktop's `electron-builder.yml` excludes `src`, `test`, `coverage` and `node_modules` of
each new package as it does for `engine` and `ssh`, and `scripts/check-desktop-asar.ts` asserts
they ship.

### 6.3 Tests

The engine's 619 test files stay in `packages/engine/test` and import the packages
(`@wirebench/core/project/load` for `../../src/project/load.js`), since `engine` depends on all
of them and the suite exercises the composition. `vitest.config.ts`'s coverage filter widens to
the seven packages' `src`. Moving tests beside their sources is a follow-up, filed when PR B
opens.

### 6.4 Published or vendored (owner's call)

Two ways to ship `engine` with code in six packages:

- **Publish all seven.** `@wirebench/core`, `@wirebench/protocol-soap`, … become npm packages
  with trusted publishing; `release.yml` publishes them before `engine`, `pack:check` packs
  seven tarballs, each package carries a README and `publishConfig.exports` without the
  `development` condition. A host could compose its own engine. The cost is seven version
  bumps a release and seven names to keep. `@wirebench/core` is a name the registry shows under
  the scope; nothing else claims it.
- **Vendor into `engine` at prepack**, the `@wirebench/ssh` route of #460: the six packages stay
  `private`, `engine` reaches them through import maps (`#core/*`, `#protocol-soap/*`, …),
  `publishConfig.imports` points the maps at `dist/vendor/<package>/`, and a
  `scripts/vendor-packages.mjs` copies the six `dist` folders in. The engine tarball is one
  package as today; `release.yml` and `pack:check` change nothing. Its declarations reference the
  vendored copies by the same maps, which TypeScript resolves through `imports`. A host cannot
  compose its own engine from npm, which phase 7 may want and can add then.

Recommendation: vendor. It is the shape the CLI already has, keeps the release to two packages,
and promises nothing phase 7 has not decided yet. The question to the owner is asked once, before
PR B, together with whether `core` is a name they want published should they choose the first.

**Ruled 2026-10-22, before PR B:** vendor into `engine`; the package is named `@wirebench/core`;
MCP is its own package, `@wirebench/protocol-mcp`. PR B does what the second option says:
`packages/engine/scripts/vendor-packages.mjs` runs at prepack (and, with a directory argument, on
the engine `pnpm deploy` copies into the CLI's and the server's container images, since `deploy`
applies neither `prepack` nor `publishConfig`), the six manifests stay `private`, and the pack check
asserts the tarball holds each package's `index.js` and `index.d.ts` under `dist/vendor/` with the
import maps pointing there. The declarations are vendored too, with the JavaScript: a host's
compiler follows the engine's `.d.ts` through the same maps.

## 7. Release pipeline and the licence report

- `release.yml`: the `npm` job builds `engine` with `pnpm --filter @wirebench/engine... build`
  (the `...` pulls its workspace dependencies), and either publishes the six packages first (§6.4,
  published) or nothing more (vendored). The CLI's Dockerfile copies the new manifests before
  `pnpm install`, and `pnpm deploy` carries the engine's workspace dependencies into `/out` as it
  carries `engine` itself today.
- `scripts/third-party-licenses.ts`: reads the `dependencies` and `optionalDependencies` of the
  six packages beside `engine`'s, and adds their names to `OWN_PACKAGES`. The generated
  `THIRD-PARTY-LICENSES.md` must not change: every third-party package is already listed through
  `engine`'s manifest today, and a diff in that file after the move is a package that was
  forgotten or duplicated.
- `scripts/pack-check.ts` and its test: assert the engine tarball holds what the owner chose in
  §6.4, and that no `workspace:` literal survives.

## 8. Docs

- `docs/architecture/overview.md`: the engine section names the packages; the component table's
  paths change from `packages/engine/src/<folder>` to the package.
- `packages/engine/README.md`: a "Packages" section; a migration note for `RunContext` only if
  §3.4 changes a host-visible type, which it does not plan to.
- ADR-0030.
- `scripts/check-banned-terms.ts`, `check-doc-paths.ts`: path lists updated; `pnpm check:doc-paths`
  is what finds a doc that still names an old path.

## 9. Tests

- `scripts/engine-layers.test.ts`: the fixture gains one tree per rule of §4 (a relative import
  leaving a package, a protocol importing a protocol, core importing a protocol, a package
  importing `electron`, a manifest listing a package the rules forbid), plus the real tree with
  zero violations.
- `public-exports.test.ts` and `public-exports.types.ts`: unchanged and green, which is the
  claim of §6.1.
- The echo protocol (`test/helpers/echo-protocol.ts`): still loads, selects, runs and saves
  without a core file knowing it, now with a registry built outside `protocols.ts`, which also
  tests §3.3's slot.
- A test that `@wirebench/engine/rest`, `/grpc`, `/ws`, `/xml`, `/json`, `/detect`, `/snapshot`
  bundle for the browser (the existing desktop test, now reaching through the subpath files).
- `pnpm pack:check` in CI, as today.

## 10. Risks

- **Vite and the `development` condition across packages.** The renderer reaches
  `@wirebench/protocol-rest/browser` through `engine`'s `node_modules`; pnpm's isolated layout
  symlinks it there, and Vite follows symlinks to the real path. Checked by the desktop build in
  PR B, which `pnpm check` does not run (a main-bundle string ending in `import` truncates the
  build silently; the build is run once by hand before the PR opens).
- **Module augmentation with a relative specifier** (§3.4, PR A) and with a bare one (PR B):
  TypeScript requires the augmenting file to import the module it augments; each augmentation sits
  beside such an import.
- **Rename noise.** PR B moves ~600 files and rewrites every import among them. The commit that
  moves is separate from the commits that change code, so the diff of the latter is readable.
- **Two sessions edit `apps/desktop` in parallel.** PR B's desktop changes are confined to
  `electron-builder.yml`, two tests and `send/exchange.ts` if §3.4 needs it; main is merged often.

## 11. Slices

PR A, `feat/engine-layers-zero` (one commit per task):

1. The compose group in the gate; the exception list removed; the test fixture updated. Violations
   are now the §2 list.
2. SOAP's endpoint resolvers and the attachment resolver move under `soap/` (§3.2).
3. The default-registry slot (§3.3); vitest setup file; `docs-script-api.ts`.
4. The open unions and the `RunContext` hooks (§3.4, §3.5); zero violations.
5. The gate refuses Electron and React in any engine package; ADR-0030 and this spec committed
   with the slice they describe.

PR B, `feat/package-split`, after the owner's answer to §6.4:

1. The six packages' manifests and tsconfigs; folders moved with `git mv`; imports rewritten by a
   script kept in the PR (`scripts/split-engine.mjs`, deleted in the last commit).
2. `engine` composes: `index.ts`, the subpath files, `protocols.ts`.
3. The gate reads packages (§4); the fixture tests.
4. Tests import the packages; coverage filter; the desktop's asar exclusions and test paths.
5. Release pipeline, Dockerfile, licence report, `pack:check` (§7), per the owner's choice.
6. Docs (§8); the epic's Phase 5 boxes ticked.
