# Wirebench: GraphQL as its own package — design

Date: 2026-10-22 · Status: approved cut, owner rulings below · Issue #760 (phase 6 of #184).
Phase 5 (#757, #758) split the engine into `core`, `protocol-soap`, `protocol-rest`,
`protocol-grpc`, `protocol-ws`, `protocol-mcp` and the composing `engine`, with
`pnpm check:engine-layers` enforcing the three dependency rules (ADR-0030).

- Builds on: the phase 5 spec (`docs/specs/2026-10-22-package-split-phase-5.md`, §3.3 for the slot
  pattern, §4 for the gate), ADR-0017, ADR-0030, the GraphQL client design
  (`docs/specs/2026-10-13-graphql-client-design.md`), the feature switches of phase 4.
- Owner rulings (2026-10-22, one popup): the cut is a **body extension** (§3); the `graphql` switch
  is **on by default**, `stage: 'experimental'`, `requires: ['rest']`, since GraphQL shipped switched
  on in 6.1.0 and a default of off would stop 6.1.0 projects from sending.

## 1. Goal

Prove the claim the package split was for: a protocol can live in a package of its own and reach
the rest of Wirebench through its registration alone. GraphQL is the epic's chosen proof.

## 2. Measured state (main at c712fd09e)

GraphQL is not a request kind. A GraphQL request is a REST request whose body is
`{ kind: 'graphql', query, variables, operationName? }`, stored with its query in a sibling
`<request>.body.graphql` file, and an API may record a schema (`graphqlSchema`) kept as SDL at
`apis/<slug>/graphql/schema.graphql`.

| Where | Files | What it does |
| --- | --- | --- |
| `packages/protocol-rest/src/rest/graphql/` | `body.ts`, `check.ts`, `schema.ts` | lowering to JSON, the response check, the schema store; the only users of the `graphql` npm package in the engine |
| `packages/protocol-rest/src/rest/` | `body.ts`, `expand.ts`, `curl.ts` | call the lowering |
| | `run.ts` | reads the schema, checks the response, adds the "GraphQL errors" check |
| | `model.ts`, `files.ts`, `storage.ts`, `secrets.ts`, `json-comments.ts`, `codegen.ts` | the body kind and the schema record as data: type, file schema, sibling file, secret scan, comments, code generation |
| `packages/engine/src/` | `index.ts`, `export/tree.ts` | re-export the GraphQL API; the exporter lowers saved bodies |
| | `import/*` (bruno, collection-v3, hoppscotch, http-file, insomnia, opencollection, thunder), `import-detect.ts`, `export/*` | build or write `graphql` bodies: composition, untouched |
| `packages/core/src/` | `assert/model.ts`, `run/run.ts`, `sequence/run.ts`, `project/*` | comments, and `'graphql'` as an assertion result type |
| `apps/desktop/src/main/` | `kinds/rest/graphql-assist.ts` | completion, diagnostics, hover (`graphql-language-service`) |
| | `kinds/rest/ipc.ts` | the `request.graphql*` handlers: introspect, diagnostics, complete, hover, schema file |
| | `kinds/rest/host.ts`, `router.ts` | the per-API schema cache and the store/clear routes |
| | `send/record.ts` | the check onto the wire |
| | `kinds/rest/mutations.ts`, `project-wire.ts`, `ipc/request.ts`, `ipc/api.ts`, `api-move.ts`, `send/exchange.ts`, `kinds/rest/send.ts` | the body and schema record as data |
| `apps/desktop/src/shared/kinds/rest/` | `channels.ts`, `wire.ts` | the `request.graphql*` channels and their wire schemas |
| `apps/desktop/src/renderer/` | `editor/graphql-language.ts`, `features/rest-editor/graphql-body.tsx`, `graphql-method.ts`, `response/graphql-chip.tsx`, `response/graphql.ts` | the editor, the method switch, the response chip and problems |
| | `editor/markers.ts` | the response markers |
| | `features/rest-editor/body-tab.tsx`, `headers-tab.tsx`, `tab-counts.ts`, `response/body-view.tsx`, `response/status-line.tsx`, `kinds/rest/explorer.tsx`, `explorer-tree.ts`, `activity.tsx`, `features/explorer/*`, `state/exchanges.ts`, `state/problems.ts`, `editor/code-editor.tsx`, `monaco-core.ts` | REST's editor and explorer naming the body kind |

GraphQL is inseparable from the REST request kind as built: the body is REST's, and the desktop's
per-kind registry is keyed by request kind, which GraphQL is not.

## 3. The cut: a body extension

The body stays a REST body kind **on disk**: `model.ts`, `files.ts`, `storage.ts`, `secrets.ts`,
`json-comments.ts` and `codegen.ts` keep it, so a project loads, saves and is scanned the same with
GraphQL off or absent ("disabling never touches data"). What the body **means** moves:

### 3.1 `packages/protocol-graphql`

A package that depends on `@wirebench/core` and `graphql` only.

| File | From |
| --- | --- |
| `src/graphql/body.ts` | `protocol-rest/src/rest/graphql/body.ts`; `GraphqlBody` written out structurally, since it may not import REST's `RestBody` |
| `src/graphql/check.ts` | `protocol-rest/src/rest/graphql/check.ts`, unchanged |
| `src/graphql/schema.ts` | `protocol-rest/src/rest/graphql/schema.ts`, unchanged |
| `src/graphql/support.ts` | new: `GRAPHQL_FEATURE` (the descriptor) and `graphqlSupport`, what REST is handed (§3.2): lowering, reading the API's built schema, checking a sent body's response, the "GraphQL errors" run check (moved from REST's `run.ts`) |
| `src/index.ts` | exports `graphqlSupport` and `GRAPHQL_FEATURE` |

The `graphql` dependency leaves `protocol-rest`'s manifest. The tests under
`packages/engine/test/unit/rest/graphql/` move to `test/unit/graphql/` and import the new package.

### 3.2 REST's one slot

`protocol-rest/src/rest/graphql-slot.ts` holds what REST needs of GraphQL, written out structurally
(REST imports no other protocol), and `installRestGraphql(support)` / `restGraphql()`, the pattern of
core's default-registry slot (phase 5 spec §3.3). `body.ts`, `expand.ts`, `curl.ts` and `run.ts`
call `restGraphql()` instead of importing `./graphql/*`. With nothing installed, a GraphQL body
refuses with `feature-disabled` (`details.feature: 'graphql'`). REST's run also refuses a GraphQL
send with `feature-disabled` when the run's registry has `graphql` off, before resolve, as a
prepare-stage failure; a preview, an export and code generation still lower the body.

### 3.3 The engine's registration

`packages/engine/src/protocols.ts` imports `graphqlSupport` and `GRAPHQL_FEATURE`, adds the
descriptor to `BUILTIN_FEATURES` and calls `installRestGraphql(graphqlSupport)`. Settings →
Features, `--features` / `WIREBENCH_FEATURES` and the MCP server read `builtinDescriptors()`, so they
list `graphql` with no code of their own. `index.ts` and `export/tree.ts` re-export the same names
from the new package: `public-exports.test.ts` stays green unchanged.

### 3.4 The desktop half

The GraphQL-only files move into one folder per process, beside the other kinds:

| New | From |
| --- | --- |
| `main/kinds/graphql/assist.ts` | `main/kinds/rest/graphql-assist.ts` |
| `main/kinds/graphql/ipc.ts` | the `request.graphql*` handlers of `main/kinds/rest/ipc.ts` |
| `main/kinds/graphql/check-wire.ts` | `toGraphqlCheckWire` of `main/send/record.ts` |
| `shared/kinds/graphql/channels.ts` | the `request.graphql*` channels of `shared/kinds/rest/channels.ts` |
| `shared/kinds/graphql/wire.ts` | the GraphQL-only schemas of `shared/kinds/rest/wire.ts` (check, assist, introspect, schema file) |
| `renderer/kinds/graphql/language.ts` | `renderer/editor/graphql-language.ts` |
| `renderer/kinds/graphql/body-editor.tsx` | `renderer/features/rest-editor/graphql-body.tsx` |
| `renderer/kinds/graphql/method.ts` | `renderer/features/rest-editor/graphql-method.ts` |
| `renderer/kinds/graphql/response-chip.tsx` | `renderer/features/rest-editor/response/graphql-chip.tsx` |
| `renderer/kinds/graphql/response-problems.ts` | `renderer/features/rest-editor/response/graphql.ts` |
| `renderer/kinds/graphql/response-markers.ts` | the GraphQL half of `renderer/editor/markers.ts` |

GraphQL is not a `KindId`, so it gets no entry in `KINDS` or `RENDERER_KINDS`. Its desktop
registration is: `shared/ipc.ts` spreads `graphqlChannels.request` and `graphqlChannels.api` beside
REST's; REST's channel registration (`main/kinds/rest/ipc.ts`), whose body kind GraphQL is, calls
`registerGraphqlRequestChannels` and `registerGraphqlApiChannels`; and the Features section lists
`graphql` under Protocols. Two desktop tests that list every kind folder learn of it: the
renderer's eager-import rule lists its wire and channels, and the kind-module rule skips a folder
with no `kind.ts`. REST keeps the
data paths (mutations, project wire, the schema cache in its host, the body in the editor) and asks
`featureOn('graphql')` before offering the GraphQL body option and **New GraphQL request**; a request
that already has a GraphQL body still shows it, and its send says the switch is off.

## 4. The gate

`scripts/engine-import-graph.mjs` gains `'protocol-graphql': 'graphql'`, so rule 1 refuses an import
of `@wirebench/protocol-graphql` or `#protocol-graphql/*` from any other protocol and from core, and a
`@wirebench/protocol-graphql` entry in their manifests; the fixture test gains that case.

## 5. Shared touches the cut allows

1. **Engine composition:** `protocols.ts` (registration), `index.ts` and `export/tree.ts` (re-export
   paths), `package.json` and `tsconfig.json` (the package beside the other six), `scripts/vendor-packages.mjs`.
2. **The REST seam, once:** `graphql-slot.ts` plus the call sites in `body.ts`, `expand.ts`, `curl.ts`,
   `run.ts`; `protocol-rest/package.json` drops `graphql`.
3. **Desktop registration:** `shared/ipc.ts`, REST's channel registration, the Features section's
   group list, and REST's editor, explorer, response view and wire importing from the GraphQL
   folders and asking `featureOn`.
4. **Workspace plumbing every package has:** root `tsconfig.json`, `apps/desktop/package.json` and
   `electron-builder.yml`, the CLI and server `Dockerfile`s, `scripts/third-party-licenses.ts`,
   `scripts/pack-check.test.ts`, the gate and its test.
5. **Docs:** this spec, ADR-0030's package list, `docs/architecture/overview.md`, the CLI's id list
   (`args.ts`, `docs/cli.md`), the feature-switch and GraphQL guides, the CHANGELOG.

No core file changes.

## 6. Tests

- Engine: the moved GraphQL unit tests; `run-graphql.test.ts` gains a send with `graphql` off
  (`feature-disabled`, nothing sent) and one with no support installed; the features tests list
  `graphql` with its `requires`.
- Gate: a protocol importing `protocol-graphql` is a rule 1 violation.
- Desktop: the moved tests import the new paths; the body tab hides the GraphQL option while the
  switch is off and keeps a GraphQL body visible.

## 7. Out of scope

- GraphQL as a request kind of its own, with its own containers: the project format stays as it is.
- Subscriptions (#99).
- Moving REST's schema cache out of its desktop host: it is per API, keyed by REST's own ids.
