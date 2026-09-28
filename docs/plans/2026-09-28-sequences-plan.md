# Sequences — plan

- **Spec:** `docs/specs/2026-09-28-sequences-design.md` (issue #62). **ADR:** `docs/adr/0015-response-values-are-data.md`.
- **Gate before every commit:** `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`.
  `pnpm test:perf` runs unskipped before a push.
- **Commits:** one per task, authored by Mohammed Naami <m.naami@outlook.com>, with no trailers.
- **Order:** the security tasks (1–3) land first, and on their own. Task 1 fixes the runner today. Tasks 2 and 3
  are the invariants everything after them relies on.

## Task 1 — Engine: regex on the worker, with a budget (Rule 8)

**Files**
- `packages/engine/src/xpath/worker.ts` and `evaluate-async.ts`: a `regex` job, `{ pattern, text }` →
  `{ matched } | { error }`, sharing the worker, the 5-second budget and the termination path.
- `packages/engine/src/assert/match.ts`: `matches:` goes through the new `matchRegexWithTimeout`. A timeout becomes
  `errored` with a timeout message (`regex-timeout` from the helper); an invalid pattern becomes `errored` with the
  syntax message.
- Test: `packages/engine/test/unit/assert/match-regex.test.ts`.

**Tests**
- `(a+)+$` against 40 `a`s and a `!` errors within the budget.
- A `setTimeout(…, 50)` set before the evaluation still fires before the result arrives, which proves the thread is
  not blocked.
- A valid pattern still passes and fails as before.
- An invalid pattern is `errored`.

## Task 2 — Engine: the Sequence scope (Rule 1)

**Files**
- `packages/engine/src/project/properties.ts`:
  - `PropertyScopes.sequence?: PropertyMap`;
  - `Sequence` in `SCOPE_NAMES` and `lookupInScope`;
  - **never** in `lookupShorthand`;
  - in `expandAt`, a Sequence value is substituted without recursing into it: no `expandAt(value, …)` and no
    tokenising;
  - `secretNamesIn` does not descend into Sequence values;
  - a reference whose name was built from a Sequence value is refused with the new unresolved code
    `name-from-response`, which `apps/desktop/src/shared/wire-types.ts` also learns.
- Test: `packages/engine/test/unit/project/sequence-scope.test.ts`.

**Tests**
- `${#Sequence#x}` resolves when set and is `missing` when not.
- `${x}` with only `sequence.x` set is `missing`.
- The values `${secret:k}`, `${#System#HOME}`, `${#Env#baseUrl}` and `$${y}` are substituted verbatim:
  - directly;
  - through `${#Env#chain}`, where `env.chain = '${#Sequence#x}'`.
- `${${#Sequence#n}}`, `${#Env#${#Sequence#n}}` and `${secret:${#Sequence#n}}` are refused as
  `name-from-response`, directly and inside a chained Env value; a typed name may still pick a Sequence value.
- `used` reports `Sequence#x`.
- `secretNamesIn('${#Sequence#x}', scopes)`, with `x` holding `${secret:k}`, is `[]`.

## Task 3 — Engine: escaping and guards in the expanders (Rules 2–4)

**Files**
- A new helper module, `packages/engine/src/project/sequence-guards.ts`:
  - `assertOriginIndependent(place, resolve, scopes, originOf = urlOrigin)`: the two-expansion check, with the
    marker `wbseq`;
  - `assertNoControlCharacters(place, result, scopes)`: throws `sequence-value-invalid` when a Sequence value with
    CR, LF or NUL was substituted, directly or through a chained property;
  - `expandWithSequenceEscaped(expandText, scopes, escape)`: the placeholder mechanism that escapes each Sequence
    value exactly once;
  - `escapeXmlValue`, which escapes all five entities.
- `errors.ts`: `SequenceError`, exported from the engine.
- `project/properties.ts` `expandSendInput`:
  - the envelope always escapes Sequence values, quotes included;
  - the endpoint gets the origin guard;
  - the endpoint, `soapAction`, headers and WS-A fields get the control-character guard.
- `rest/expand.ts`:
  - a JSON, XML or HTML body always escapes Sequence values; the user's own values are escaped only when the request
    asks, as today;
  - the URL as `composeUrl` builds it (base, URL, path parameters) gets the origin guard;
  - the URL, base URL, path, query and header rows get the control-character guard.
- `grpc/expand.ts`:
  - the target may hold no Sequence value at all;
  - metadata gets the control-character guard;
  - the JSON message always escapes Sequence values.
- `ws/expand.ts` is unchanged. A WebSocket request is refused as a step (`sequence-step-unsupported`), so no
  WebSocket send is ever given a Sequence scope.
- Test: `packages/engine/test/unit/project/sequence-guards.test.ts`.

**Tests**
- `x", "admin": true, "y": "` in a JSON body and a gRPC message gives one string field, with the request's escaping
  off and on.
- A chained Env value's Sequence part is escaped exactly once, with escaping off and on.
- An XML body and a SOAP envelope escape `</Note><Admin>` and quotes, with `entitize` off and on; a text body is not
  escaped.
- Host, port and scheme from a Sequence value are refused for SOAP, REST (including a path parameter placed in the
  host) and gRPC.
- Path, query and fragment are allowed.
- An Env base URL that *contains* `${#Sequence#h}` in the host is refused.
- CR/LF/NUL in a header name or value, a URL, a query row, a SOAP action and gRPC metadata is refused, directly and
  through a chained Env value. The same value in a body is allowed.
- Placeholder 1 followed by a digit is never read as placeholder 15.

## Task 4 — Engine: sequence model, schema, load and save

**Files**
- Add `packages/engine/src/sequence/{model,file,load,index}.ts`, exported from the engine root. Not a subpath:
  every subpath is a browser-safe entry for the renderer, which reads sequences through the IPC wire types, and
  `load.ts` needs `node:path`.
- `project/model.ts`: `Project.sequences`, which `createProject` defaults to `[]`.
- `sequence/file.ts`: `SEQUENCES_DIR`, `SEQUENCE_SUFFIX`, `parseSequenceFile`, `sequenceDocument`.
  - The 256 KiB check comes before parsing.
  - zod validation and the limits.
  - `kind` other than `sequence`, and `version` above 1, are refused per file.
  - Only an assertion's own fields are kept, so an unknown key is never written back.
- `sequence/load.ts`: `readSequences`, shared by the loader and by save. A duplicate id loads the first by file name.
- `project/load.ts`: sequences sorted by `order`; each refused file becomes a problem.
- `project/serialize.ts`: write `sequences/<slug>.sequence.yaml`, with deterministic keys and defaults omitted.
- `project/save.ts`:
  - `listManagedFiles` treats a sequence file as managed, and so deletable, only if this build loaded it. A file
    that is too new, malformed (say, mid-merge) or a duplicate is foreign and never deleted.
  - Writing over such a file is refused with `sequence-file-conflict`.
- `apps/desktop/src/main/project-watch.ts`: add `sequences` to `MANAGED_TOP_DIRS` and `isManagedPath`, with a test.
- `packages/engine/src/assert/{model,schema,index,header}.ts`:
  - the `header` assertion, allowed in `stepAssertionsSchema` only, so request files are unchanged;
  - `AssertionSubject.headers`, filled by the runner's `soapSubject`, `restSubject` and `grpcSubject`.
- Tests:
  - `packages/engine/test/unit/sequence/{file,load-save}.test.ts`;
  - `formatVersion` stays `5` after a save;
  - a `version: 2` file, a malformed file and a duplicate-id file all survive a save that drops every sequence;
  - overwriting a foreign file is refused;
  - `assert/header.test.ts`.

That an older build leaves `sequences/` alone is a property of the older build's code, not of this one, so it is
established by reading that code (ADR-0003, update of 2026-09-28) rather than by a test here.

## Task 5 — Engine: transfers and `runSequence`

**Files**
- `packages/engine/src/sequence/{transfer,run}.ts`, exported from the engine root.
- `run/select.ts`: `findStepRequest(project, requestId)` returns one of:
  - `found`, with the `SelectedRequest`;
  - `missing`;
  - `unsupported`, with a reason (WebSocket, a streaming gRPC call, orphaned).
- `assert/match.ts`: `firstText` is exported and shared with transfers.
- Tests: `packages/engine/test/unit/sequence/{transfer,run}.test.ts`, with a fake `SequenceStepSender`.

**Interfaces:** exactly as in the spec's "Engine surface".

**Tests**
- Each transfer source.
- XML with default namespaces; JSON read with XPath.
- `optional`, and missing → `sequence-transfer-missing`.
- A wrong body kind or an expression that does not compile → `sequence-transfer-failed`.
- The 64 KiB cap.
- A secret value, and one for which `containsKnownSecret` answers true:
  - is passed to `onSecretValue`;
  - is absent from the whole result;
  - still reaches the next step.
- Outcomes:
  - the request's own assertions first, then `requestAssertions: false`;
  - stop-on-failure on and off;
  - a disabled step;
  - a missing, a WebSocket and a streaming step;
  - a throwing sender;
  - abort mid-run → the rest `skipped` as `cancelled`.
- The step timeout reaches the sender.
- A transfer named `__proto__`.
- The scope passed to step *n* holds exactly the values set by steps before it.

## Task 6 — CLI: `--sequence`

**Files**
- `packages/engine/src/run/run.ts`: `createRunSender` (prepare, send, describe, with the run's caches and token
  source), shared by `runRequests` and sequences; `RequestResult` gains optional `sequence`, `transfers` and
  `origin`. `run/prepare.ts`: `RunContext.sequence`, merged into the scopes.
- The engine's model type is `SequenceDef`, since the root already exports the XML Schema `Sequence`.
- `packages/cli/src/args.ts`: a repeatable `--sequence` for `run` and `secrets list`; combining it with selectors is
  a `UsageError`.
- `packages/cli/src/commands/sequence.ts`:
  - `selectSequences`;
  - `resolveSteps`, which refuses a missing or unsupported step before any send;
  - `withDefaultSla`;
  - `runSequences`, which sends through `createRunSender` and maps each step to a `RequestResult`.
- `commands/run.ts`: `loadSelection` returns the sequences, and `runCommand` branches on them.
  `containsKnownSecret` answers from the env-secret values and the tokens obtained so far. There is no cookie jar: a
  cookie travels only by a `cookie` transfer.
- Reporters:
  - `cli`: transfers;
  - `html`: a transfers table;
  - `json`: the optional fields;
  - `mask`: transfer values and messages.
- `docs/cli.md`.
- Tests:
  - `packages/cli/test/integration/sequence.test.ts`, against the demo server's new `/login` and `/carts`;
  - `packages/cli/test/unit/{args,reporters/mask}.test.ts`.

## Task 7 — Desktop main: model, mutations and runner

**Files**
- `shared/wire-types.ts`:
  - the sequence, step, transfer and step-assertion wire schemas, and `projectWireSchema.sequences`;
  - the change kinds `add-sequence`, `update-sequence`, `remove-sequence` and `duplicate-sequence`;
  - the run request and result, and the progress event.
- `shared/ipc.ts`: `sequence.run` and `sequence.cancel`, and the event `sequence.progress`.
- `main/project-sequence-mutations.ts`:
  - every edit is round-tripped through `parseSequenceFile`, and refused as `sequence-invalid`;
  - new slugs avoid the files the load refused (`refusedSequenceSlugs`, passed as
    `MutationDeps.reservedSequenceSlugs`);
  - `toSequenceWire`.
- `project-mutations.ts`: the dispatch. `project-wire.ts`: the snapshot. `workspace-service.ts`: `reindex`.
- `main/engine-service.ts`: `observe(sendId, observer)`, awaited before any summary is built.
- `main/project-host.ts`:
  - `restSend` and `grpcSend` take the Sequence values;
  - the three `*Meta` results may carry `tags`;
  - the three History recorders pass the tags through.
- `main/redact.ts`: `containsRecordedSecret`.
- `main/sequence-runner.ts`: the `SequenceRunner` and the per-step `Proxy`.
- `main/ipc/sequence.ts`, registered in `main/index.ts`.
- `test/mocks/wirebench-api.ts` and `test/helpers/wire-defaults.ts`.
- Tests:
  - `apps/desktop/test/sequence-mutations.test.ts`;
  - `apps/desktop/test/sequence-runner.test.ts`, against a real engine service, a real History and a local server:
    - the secret reaches the next step;
    - its own step's History line and raw log response are masked;
    - tags;
    - nothing reaches the renderer;
    - cancel mid-step;
    - already-running;
    - unknown sequence.

## Task 8 — Renderer: explorer, tab and run panel

**Files**
- `state/project.ts`:
  - `sequences` and `sequenceLists` indexes;
  - `addSequence`, `updateSequence`, `removeSequence` and `duplicateSequence`.
- `state/sequence-runs.ts`: the latest run per sequence, and `subscribeToSequenceProgress`, mounted in
  `shell/app-shell.tsx`.
- `features/sequence/`:
  - `sequence-actions.ts`;
  - `sequence-tab.tsx`;
  - `step-requests.ts`, which mirrors `findStepRequest` for labels;
  - `add-step-dialog.tsx`;
  - `transfer-table.tsx` and `assertion-table.tsx`;
  - `step-fields.tsx`;
  - `run-panel.tsx`.
- Explorer:
  - `tree-nodes.ts`: the `sequences` group and `sequence` rows;
  - `context-menu.tsx`, `explorer-actions.ts` and `explorer-api.ts`;
  - `explorer-view.tsx`: the icon, test ids, activation, rename, delete and the confirmation;
  - `state/ui.ts`: the pending deletion kind.
- Tabs:
  - `state/editors.ts`;
  - `shell/editor-area.tsx`;
  - `state/ui-state.ts` and `state/workspace-tabs.ts`, which persist the tab.
- Commands:
  - `shared/commands.ts`: `sequence.new`, `sequence.run` and `sequence.cancel`, and the `editor.sequence` scope;
  - `shared/command-catalog.ts`;
  - `renderer/commands/register-{explorer,request}-commands.ts`;
  - `command-helpers.ts`: `activeSequenceId`;
  - then `pnpm docs:commands`.
- Tests:
  - `apps/desktop/test/renderer/sequence-tab.test.tsx`;
  - `tree-nodes.test.ts`;
  - the pinned lists in `explorer-context-menu.test.ts` and `keymap.test.ts`;
  - `test/helpers/wire-defaults.ts`: `sequenceWire`.

## Task 9 — e2e, docs and changelog

- `e2e/specs/sequences.spec.ts`: a two-step REST sequence (log in → bearer from `${#Sequence#token}`) against the e2e
  mock. Both steps pass, and the token shows `<redacted>` in the run panel. Run with
  `pnpm build && xvfb-run -a pnpm test:e2e -- sequences.spec.ts`.
- Docs:
  - `docs-site/src/content/docs/guides/sequences.mdx`, with an entry in the `astro.config.mjs` sidebar;
  - `reference/project-format.md`, including the version line fix;
  - the `docs/security.md` section;
  - `docs/success-criteria.md` SC-Q1…;
  - `docs/roadmap.md` item 12 status;
  - `CHANGELOG.md` under Unreleased/Added.
- `pnpm check`, which includes banned terms and doc paths.
