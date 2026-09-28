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
  `errored` with `assert-regex-timeout`; an invalid pattern becomes `errored` with the syntax message.
- `packages/engine/src/errors.ts`: the code.
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
  - `secretNamesIn` does not descend into Sequence values.
- Test: `packages/engine/test/unit/project/sequence-scope.test.ts`.

**Tests**
- `${#Sequence#x}` resolves when set and is `missing` when not.
- `${x}` with only `sequence.x` set is `missing`.
- The values `${secret:k}`, `${#System#HOME}`, `${#Env#baseUrl}` and `$${y}` are substituted verbatim:
  - directly;
  - through `${#Env#chain}`, where `env.chain = '${#Sequence#x}'`.
- `used` reports `Sequence#x`.
- `secretNamesIn('${#Sequence#x}', scopes)`, with `x` holding `${secret:k}`, is `[]`.

## Task 3 — Engine: escaping and guards in the expanders (Rules 2–4)

**Files**
- A new helper module, `packages/engine/src/project/sequence-guards.ts`:
  - `assertOriginIndependent(resolve: (scopes: PropertyScopes) => string, scopes, kind: 'url' | 'grpc-target')`: the
    two-expansion check, using the marker `wbseq`;
  - `assertNoControlChars(text, used, scopes)`, which throws `sequence-value-invalid` when a Sequence value with
    CR, LF or NUL was substituted.
- `project/properties.ts` `expandSendInput`:
  - the envelope always entitizes Sequence values;
  - the endpoint gets the origin guard;
  - the endpoint, `soapAction`, headers and WS-A fields get the control-character guard.
- `rest/expand.ts`:
  - `escapedScopes` always escapes `sequence`, even when `options.escape` is off. Only the Sequence map is escaped
    when it is off; the other scopes behave as today;
  - the base URL plus URL get the origin guard;
  - the URL, path, query and header rows get the control-character guard.
- `grpc/expand.ts`:
  - the target gets the origin guard;
  - metadata gets the control-character guard;
  - the JSON message escapes Sequence values.
- `ws/expand.ts`: the same guards, for completeness, even though WebSocket steps are out of scope, so the scope is
  safe wherever it appears.
- `errors.ts`: `sequence-origin-from-response`, `sequence-value-invalid`.
- Tests: `packages/engine/test/unit/project/sequence-guards.test.ts` and additions to the REST, gRPC and SOAP expand
  tests.

**Tests**
- `x", "admin": true, "y": "` in a JSON body with `escape` off gives one string field.
- `</a><b>` in an XML body and in a SOAP envelope is entitized.
- Form encoding.
- Host, port and scheme from a Sequence value are refused for SOAP, REST and gRPC.
- Path, query and fragment are allowed.
- An Env base URL that *contains* `${#Sequence#h}` in the host is refused.
- CR/LF in a header and a query is refused; the same value in a body is allowed.

## Task 4 — Engine: sequence model, schema, load and save

**Files**
- Add `packages/engine/src/sequence/{model,schema,index}.ts`, and a `./sequence` subpath export in both blocks of
  `packages/engine/package.json`.
- `project/model.ts`: `Project.sequences`, and `createProject` defaults it to `[]`.
- `project/paths.ts`: `SEQUENCES_DIR`, `SEQUENCE_SUFFIX`.
- `project/load.ts`: `loadSequences`:
  - the 256 KiB check comes before parsing;
  - zod validation and the limits;
  - `kind`, and `version` above 1, are refused per file as problems;
  - sorted by `order`.
- `project/serialize.ts`: write `sequences/<slug>.sequence.yaml`, with deterministic keys and defaults omitted.
- `project/save.ts` `listManagedFiles`: list `sequences/*.sequence.yaml` only.
- `apps/desktop/src/main/project-watch.ts`: add `sequences` to `MANAGED_TOP_DIRS` and `isManagedPath`, with a test.
- `packages/engine/src/assert/{model,schema,index}.ts`:
  - the `header` assertion;
  - `AssertionSubject.headers`, filled by the runner's `soapSubject`, `restSubject` and `grpcSubject`.
- Fixture: `packages/engine/test/fixtures/format-v5-sequences/project`.
- Tests:
  - `packages/engine/test/unit/sequence/{schema,load-save}.test.ts`;
  - a format test proving that `formatVersion` stays `5` and that a project saved by the new build, then loaded
    through a loader without sequence support, has `sequences/` untouched;
  - `assert/header.test.ts`.

## Task 5 — Engine: transfers and `runSequence`

**Files**
- `packages/engine/src/sequence/{transfer,run}.ts`.
- `run/select.ts`: `findSelectedRequest(project, requestId)`.
- `assert/match.ts`: move `firstText` into a shared helper.
- Tests: `packages/engine/test/unit/sequence/{transfer,run}.test.ts`, with a fake `SequenceStepSender`.

**Interfaces:** exactly as in the spec's "Engine surface".

**Tests**
- Each transfer source.
- Default namespaces.
- `optional`, and missing → `sequence-transfer-missing`.
- The 64 KiB cap.
- Overwrite.
- A secret value is passed to `onSecretValue` and left out of `value`.
- A value for which `containsKnownSecret` answers true is treated as secret.
- Outcomes:
  - stop-on-failure on and off;
  - a disabled step;
  - `requestAssertions: false`;
  - a missing request;
  - a WebSocket or streaming step → `sequence-step-unsupported`;
  - abort mid-run → the rest `skipped`.
- The scope passed to step *n* holds exactly the values set by steps before it.

## Task 6 — CLI: `--sequence`

**Files**
- `packages/cli/src/args.ts`: a repeatable `--sequence`. Combining it with selectors is a `UsageError`.
- `commands/run.ts`: select the sequences, then build a sender from `prepareSend` plus a new `sendPrepared`,
  factored out of `run/run.ts` `runOne`. Each sequence run gets a fresh in-memory cookie jar.
  `containsKnownSecret` answers from the env-secret values and the OAuth2 tokens resolved so far.
- `run/prepare.ts`: `RunContext.sequence` is merged into the scopes as `sequence`.
- Reporters: steps as `RequestResult`s with `group = sequence name`, plus the optional `sequence` and `transfers`
  fields.
  - JUnit: a suite per sequence.
  - HTML: the steps grouped per sequence.
  - Masking: a secret transfer value goes through the masker.
- `docs/cli.md`.
- Tests: `packages/cli/test/{args,run-sequence,reporters-sequence}.test.ts`, against the local mock server that the
  runner tests already use.

## Task 7 — Desktop main: model, mutations and runner

**Files**
- `shared/wire-types.ts`:
  - `sequenceWireSchema`, and `projectWireSchema.sequences`;
  - the change kinds `add-sequence`, `update-sequence`, `remove-sequence`, `duplicate-sequence`;
  - `sequenceRunResultWireSchema`, and the progress event.
- `shared/ipc.ts`: `sequence.run` and `sequence.cancel`, and the event `sequence.progress`.
- `main/project-sequence-mutations.ts`, and the dispatch in `applyChange`.
- `project-wire.ts`, plus `workspace-service.ts` `reindex`, which must index the sequence ids.
- `main/sequence-runner.ts`:
  - builds a `SequenceStepSender` over `sendAndRecordHistory`, `sendRestRequest` and `sendGrpcRequest`, each gaining
    an optional `sequence?: PropertyMap` and `tags?`;
  - one run per sequence at a time;
  - the run id and `AbortController` are kept by `runId`;
  - secret values go into the session credential set, and `containsKnownSecret` reads that same set.
- `main/ipc/sequence.ts`, registered in `main/index.ts`.
- `test/mocks/wirebench-api.ts`, and the wire fixtures.
- Tests:
  - `apps/desktop/test/sequence-mutations.test.ts`;
  - `apps/desktop/test/sequence-runner.test.ts`: History tags, progress order, cancel, already-running, and a
    masked secret in History and in the HTTP Log.

## Task 8 — Renderer: explorer, tab and run panel

**Files**
- `features/explorer/{tree-nodes,context-menu,explorer-actions,explorer-view}.ts(x)`: the Sequences group and the
  menus.
- `features/sequence-editor/{sequence-tab,step-list,transfer-table,assertion-table,run-panel,add-step-picker}.tsx`.
- `state/{editors,project,drafts,workspace-tabs,ui-state}.ts`: the `sequence` tab kind, persisted.
- `shell/editor-area.tsx`: a lazy branch.
- `shared/commands.ts` and `shared/command-catalog.ts`, then `renderer/commands/register-sequence-commands.ts`.
  Afterwards run `pnpm docs:commands`.
- Tests: `apps/desktop/test/renderer/{sequence-tab,sequence-run-panel,explorer-sequences}.test.tsx`, plus the command
  registry audit.

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
