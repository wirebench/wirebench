# Typed scripting — plan

- **Spec:** `docs/specs/2026-09-28-typed-scripting-design.md` (issue #63). **ADR:**
  `docs/adr/0016-scripts-run-with-no-capabilities.md`, which extends ADR-0015.
- **Gate before every commit:** `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`.
  `pnpm test:perf` runs unskipped before a push.
- **Commits:** one per task, authored by Mohammed Naami <m.naami@outlook.com>, with no trailers.
- **Order:** the sandbox (Task 1) and its security rules (Task 2) land first, then the format, then types and the
  checker. Nothing runs a script from a project until Task 7, and by then every rule in ADR-0016 has its test.

## Task 1 — Engine: the sandbox

**Files**
- `packages/engine/package.json`: runtime dependencies `quickjs-emscripten-core` and
  `@jitl/quickjs-wasmfile-release-sync`, pinned. Regenerate `THIRD-PARTY-LICENSES.md` with
  `pnpm licenses:third-party`.
- `packages/engine/src/script/sandbox/worker.ts`:
  - loads the WASM module once per worker;
  - per job, creates a fresh runtime and context with `setMemoryLimit(64 MiB)`, `setMaxStackSize(1 MiB)`, and an
    interrupt handler with the job's deadline;
  - installs only the globals the job lists, as functions of strings and JSON;
  - evaluates the code and returns `{ ok, result, logs, tests, values }` or `{ error: { code, message, line,
    column } }`.
- `packages/engine/src/script/sandbox/host.ts` (`createScriptSandbox`), after `rest/contract-check-worker-host.ts`:
  - one long-lived worker;
  - one job at a time, with a queue of 16;
  - it terminates and replaces the worker at `deadline + 1000 ms`, and the job's result is then `script-timeout`;
  - a worker that exits unexpectedly is replaced, and the job fails with `script-error`.
- `packages/engine/src/script/sandbox/host-api.ts`: `crypto.hash`, `crypto.hmac`, `crypto.randomUUID`, `encoding.*`,
  and the log, test and value collectors, with the caps from the spec (64 KiB and 1000 lines of log, 1000 tests, 100
  values of 64 KiB).
- `packages/engine/src/script/strip.ts`: `stripTypes(source)`. It calls `module.stripTypeScriptTypes` in `strip`
  mode and silences only that call's `ExperimentalWarning`.
- Test: `packages/engine/test/unit/script/sandbox.test.ts`, `strip.test.ts`.

**Tests**
- `while (true) {}` ends as `script-timeout` within the deadline, and the next job on the same host runs.
- An array grown without bound ends as `script-memory`, and deep recursion ends as `script-error` naming a stack
  overflow.
- `typeof process`, `require`, `fetch`, `setTimeout`, `globalThis.constructor.constructor('return process')()` and
  `import('fs')` are all undefined or throw, and nothing reaches the host.
- `crypto.hmac('sha256', 'k', 'd')` matches Node's result. `log` beyond its caps is cut off with a marker.
- An error's line and column match the source. The stripped output of a fixture is pinned, and stripping keeps
  positions.
- A job's globals do not survive into the next job.

## Task 2 — Engine: the script API and its rules

**Files**
- `packages/engine/src/script/model.ts`: the request and response snapshots per protocol, `ScriptTest`,
  `ScriptValue`, `ScriptFailure` and `ScriptOutcome`, and the output caps.
- `packages/engine/src/script/api/prelude.ts`: `buildPrelude(protocol, phase, api, layer)`, the API as JavaScript
  that runs inside the sandbox over `__host`:
  - `vars`, `props`, `secrets`, `crypto`, `encoding`, `log`/`console`, `test` and `expect`;
  - the protocol's `request` (writable before the send) and `response`.
  - A rule's error is raised by name (`ScriptSecretDenied`, `ScriptValueInvalid`, `ScriptUnsupported`), and
    `run.ts` maps the name to its code.
- `packages/engine/src/script/apply.ts`: `applyRequestChanges(before, returned)` and `secretReferencesIn`.
  - What the sandbox hands back is parsed against a schema first, since a script can forge `__finish`.
  - A different scheme, host or port (a URL, SOAP endpoint or gRPC target) is `script-origin-change`, and so is a
    changed relative destination.
  - CR, LF or NUL in a URL, header, metadata value or SOAPAction is `script-value-invalid`, and so is a method
    that is not a token.
  - A body the script cannot edit must come back unchanged.
  - A `${secret:name}` reference the request did not already hold is `script-secret-denied`.
- `packages/engine/src/script/run.ts`: `runScript(input)` strips the types, reports the listed secrets to
  `onSecretValue` before the script runs, runs the job, checks the output, and returns a `ScriptOutcome`.
- Tests: `packages/engine/test/unit/script/{api,apply}.test.ts`.

**Tests**
- A REST pre-request script sets a header, a query parameter and `body.json`, and the applied request has them.
- Changing `url` to another host, to `http:` from `https:`, or to another port is `script-origin-change`, for REST,
  a SOAP endpoint and a gRPC target.
- A header value with `\r\n` is `script-value-invalid`.
- A script that writes `${secret:other}` into a header is `script-secret-denied`. Moving a reference the request
  already had is allowed.
- `secrets.get` for an unlisted name throws `script-secret-denied`, and a listed value is reported for masking.
- `test` records passing and failing tests, and each `expect` matcher passes and fails, with `.not`.
- A `vars.set` value such as `${secret:k}`, `a\r\nb`, `http://evil/` or `</x><y>` is returned verbatim, since
  ADR-0015 applies where the value lands.

## Task 3 — Engine: `formatVersion` 6 and script files

**Files**
- `packages/engine/src/project/model.ts`: `FORMAT_VERSION = 6`, and `ScriptsDef` (`pre?`, `post?`, `api`,
  `enabled`, `secrets`, `timeoutMs`) on SOAP, REST and gRPC request definitions, with the script text loaded.
- `packages/engine/src/project/schema.ts`: `scriptsSchema`, a `scripts` key on the three request file schemas.
- `packages/engine/src/project/migrate.ts`: 5 → 6 is a stamp.
- `project/load.ts`, `serialize.ts` and `save.ts`:
  - the sidecar files, and the file names derived from the request;
  - `script-file-missing` and `script-too-large` problems;
  - renaming and moving a request move its scripts;
  - a script file is written only when its text changed.
- `apps/desktop/src/main/project-watch.ts`: `isManagedPath` includes `*.pre.ts`, `*.post.ts`, `*.pre.js` and
  `*.post.js` beside a request.
- `docs/adr/0003-project-folder-format.md`: an update for version 6.
- Fixtures: a version-5 project, and a version-6 project with scripts.
- Tests: `packages/engine/test/unit/project/{scripts-format,migrate-6}.test.ts`.

**Tests**
- A version-5 fixture saves with only its `formatVersion` line changed.
- A project with scripts round-trips byte for byte.
- Renaming a request renames `X.pre.ts` to `Y.pre.ts`.
- A missing script file is a problem on the request.
- An unnamed `.pre.ts` beside a request is never loaded, and is reported as an orphan.
- A hand-edited script name in the request file (`../../outside.ts`) is ignored, and the slug's file is read.

## Task 4 — Engine: types from JSON Schema and proto

**Files**
- `packages/engine/src/script/types/api.ts`:
  - `apiDeclarations(protocol, phase)`, the static API as ambient declarations;
  - `secretNameType(secrets)`;
  - `WbStatus` and the `WbRange1`–`WbRange5` literal unions a REST response's arms are built from.
- `packages/engine/src/script/types/json-schema.ts`: `JsonSchemaTypes`, JSON Schema to TypeScript.
  - Resolved `$ref`s are shared, possibly cyclic, objects, so a node reached twice or reaching itself becomes an
    alias by identity.
  - Unknown keywords widen to `unknown`, and depth, alias count and output size are bounded.
- `packages/engine/src/script/types/rest.ts`: `restScriptTypes(operation | undefined)` gives `WbRequestBody` and
  `WbResponse`, one arm per exact status, range and `default`, plus a last arm for the rest.
- `packages/engine/src/script/types/grpc.ts`: `grpcScriptTypes(protoSet, inputType, outputType)`.
  - The types match the JSON form the codec uses: declared names, 64-bit integers and bytes as strings, enum names,
    every field optional, one alias per message, and the well-known types.
- Tests: `packages/engine/test/unit/script/types-{rest,grpc}.test.ts`.
  - They compile the output with a script through the dev-dependency TypeScript (`ts-check.ts`), including a wrong
    path that must fail and narrowing by status.

## Task 5 — Engine: types from XSD, and the XML projection

**Files**
- `packages/engine/src/script/types/xsd.ts`: a single walk over the schema set serves three functions.
  - `elementSlots`: the child elements a content model allows, in schema order, with `many` and `optional`.
  - `soapScriptTypes(schemas, input, output)` gives `WbSoapRequestBody` and `WbSoapResponseBody`, with an alias per
    named complex type.
  - `projectSoapBody` and `projectElement` read the envelope's body element through the tolerant scanner
    (`xsd/xml-scan.ts`) as the object the types describe.
  - `replaceSoapBody` and `serializeElement` write it back in schema order. They declare a default namespace where it
    changes and splice only the body element's range, so the rest of the envelope is byte for byte.
  - A clash of local names is keyed `{namespace}local`, `xs:any` and mixed content are not projected, and depth and
    aliases are bounded.
- The API: `request.body` (writable before the send) and `response.body` on SOAP, plus `response.select(xpath,
  namespaces)` through a new `__host.xpath`, which runs the engine's evaluator on the sandbox worker.
- `packages/engine/src/script/run.ts`: `soap: { schemas, input, output }` projects both bodies before the script runs
  and writes a changed `request.body` into the envelope after it.
  - An untouched body leaves the envelope unchanged, and a value the schema cannot hold is a `script-error`.
- Tests: `packages/engine/test/unit/script/types-xsd.test.ts`:
  - types compile with a script, and a wrong path fails;
  - projection of arrays, attributes, simple content, nil, enumerations and 64-bit numbers;
  - a round trip that keeps the envelope outside the body;
  - scripts using `request.body`, `response.body` and `select`.

## Task 6 — Engine: the checker

**Files**
- `packages/engine/package.json`: `typescript` `~5.9.3` as a runtime dependency, and the licences regenerated.
  TypeScript 7 ships a native binary per platform, so it cannot be used here (ADR-0001).
- `packages/engine/src/script/check/service.ts`: one language service per script model, over two virtual files, the
  declarations and the script.
  - The services share a document registry, so the standard library is parsed once.
  - At most 32 models are kept, least recently used dropped first, and an unchanged model is not re-parsed.
  - Options are `strict`, no emit, ES2023 with no DOM, no `@types`, and `erasableSyntaxOnly`.
  - It serves `diagnosticsOf`, `completionsAt`, `quickInfoAt`, `signatureHelpAt` and `checkOnce`.
  - A Postman script (`api: postman`, JavaScript) gets syntax errors only.
  - Nothing on disk is read but the standard library.
- `packages/engine/src/script/check/worker.ts` and `host.ts`: `createScriptChecker`, one persistent worker with a
  deadline per request.
  - Each request carries its model, so a replaced worker loses nothing.
- `packages/engine/src/script/types/api.ts`: `scriptDeclarations(protocol, phase, secrets, generated)`.
- Tests: `packages/engine/test/unit/script/check.test.ts`, covering the service in-process and the host on the
  worker:
  - a wrong path with its position;
  - `enum` refused;
  - Postman syntax only;
  - completion of a response's fields;
  - hover and signature help;
  - the model cap;
  - the deadline.
- To confirm in Task 10: the language service reads TypeScript's `lib/*.d.ts` from inside the asar on the worker. If
  a packaged smoke test shows it cannot, `typescript/lib` joins `asarUnpack`.

## Task 7 — Engine: scripts in a send

**Files**
- `packages/engine/src/script/send.ts`, the secret placeholders and the snapshot converters:
  - `SecretPlaceholders`: one nonce per send. It maps a secret name to `wbsec<nonce>n<i>z` and puts each back
    afterwards (`restore`).
  - `restRequestSnapshot` / `applyRestSnapshot`: the URL is rebuilt only when the script changed it, and then sent
    exactly as written.
  - The same for SOAP (on the expanded envelope, sent without scopes so nothing is expanded again) and for gRPC.
  - The response snapshots.
- `packages/engine/src/script/contracts.ts`: `soapOperationElements`, `restOperationFor`, `loadOpenApiDocument`,
  `grpcMessageTypes`.
- `packages/engine/src/script/props.ts`: `scriptProperties(scopes)`, the shorthand-reachable properties resolved
  without secrets.
- `packages/engine/src/script/request-scripts.ts`: `RequestScripting`, shared by the run and the app.
  - `check` is cached by script and types.
  - `pre` throws a failure, while `post` returns one.
  - `activeScripts`, `assertScriptsUsable` (`script-file-missing`, `script-too-large`), `scriptError` and
    `typeCheckError`.
- `packages/engine/src/run/prepare.ts`: `RunContext.secretPlaceholders`, `scripting` and `containsKnownSecret`, and
  `scopesFor` exported.
- `packages/engine/src/run/run.ts`: `createRunSender` sends a request with active scripts through `sendScripted`.
  1. Check.
  2. Prepare with placeholders.
  3. Run the pre-request script.
  4. Apply its changes.
  5. Restore the secrets.
  6. Send.
  7. Run the post-response script against the request as the script left it.
  - A request with switched-off scripts is sent as before, with `scriptsOff`.
  - `runRequests` keeps one value scope for the whole run, and a request whose only checks are script tests still
    counts as asserted.
- `packages/engine/src/run/script-support.ts`: `scriptTypesFor`, `listedSecrets`, `scriptAssertions` and
  `mergeScriptValues`.
- `packages/engine/src/sequence/run.ts`: a step's script values join the run's before its transfers, its tests are
  assertions, and a post-response failure errors the step. `scriptLog` and `scriptsOff` are on the step result.
- `AssertionResult.type` gains `script`. `RequestResult` gains `scriptLog` and `scriptsOff`. `scripts.secrets` is
  validated as secret names.
- Tests:
  - `packages/engine/test/integration/run/scripts.test.ts`, against local servers:
    - a log-in script's token used by the next request;
    - an HMAC over the body with a listed secret, checked on the wire, while the script sees only a placeholder for
      the request's own secret;
    - a type error, a pre-request failure and a post-response failure;
    - switched-off scripts;
    - a missing script file;
    - a SOAP envelope change, with a `${…}` the script wrote sent literally.
  - `packages/engine/test/unit/sequence/run.test.ts`: the merge.

## Task 8 — CLI

**Files**
- `packages/engine/src/run/run.ts`: `checkRunScripts(selected, context)` checks every active script of a selection
  against its types, with the run's own loaders, and returns one error per failing request.
- `packages/engine/src/run/secret-needs.ts`: a script's text is no longer scanned for `${secret:…}` (it is code),
  and the names in `scripts.secrets` are needs, so `WIREBENCH_SECRET_<NAME>` is read for them.
- `packages/engine/src/script/index.ts`: the scripting API exported from the engine.
- `packages/cli/src/commands/run.ts`:
  - one sandbox and one checker per run, disposed at the end;
  - `RunContext.scripting` and `containsKnownSecret`;
  - every script checked before any send, and any error written to stderr with exit 2.
- `packages/cli/src/commands/sequence.ts`: a step's script results pass through, and a step whose only checks are a
  post-response script's tests counts as asserted.
- Reporters:
  - `mask.ts` masks `scriptLog`;
  - `cli.ts` prints `log:` lines with `-v` or for a request that did not pass, and marks `(scripts off)`;
  - `json.ts` adds `scriptLog` and `scriptsOff` within `formatVersion` 1;
  - `html.ts` shows the log.
- `docs/cli.md`: a Scripts section, and the JSON report fields.
- Tests: `packages/cli/test/integration/scripts.test.ts`, against the built binary and the demo server:
  - a log-in script's token and cookie reach the next request, and the token is never printed;
  - script tests and the masked log in the JSON report;
  - a type error exits 2 before any send, naming file, line and column;
  - a missing script file exits 2.

## Task 9 — Postman

**Files**
- `packages/engine/src/rest/postman/parse.ts` and `map.ts`:
  - read `event` scripts at the collection, folder and request levels;
  - concatenate them per request with part markers;
  - write `.pre.js` and `.post.js` with `api: postman` and `enabled: false`;
  - the summary counts requests with scripts, and lists the unsupported calls from a static scan.
- `packages/engine/src/script/api/postman.ts`: the `pm` layer, written as JavaScript that runs inside the sandbox over
  the common API:
  - `pm.test`;
  - an `expect` chain subset;
  - `pm.response`, `pm.request` and `pm.info`;
  - variable get and set mapped to `vars` and `props`;
  - `CryptoJS`, `btoa` and `atob`;
  - `script-unsupported` stubs for everything else the spec names.
- Tests: `packages/engine/test/unit/rest/postman-scripts.test.ts` and
  `packages/engine/test/unit/script/postman-layer.test.ts`:
  - a fixture collection with root, folder and request scripts, concatenated in order;
  - `enabled: false`;
  - the layer runs typical test scripts;
  - `pm.sendRequest` is `script-unsupported`.

## Task 10 — Desktop main

**Files**
- `apps/desktop/src/main/ipc/request.ts`: the SOAP, REST and gRPC send paths run the scripts through the engine's
  helpers from Task 7.
  - The pre-request script runs after `restSend`/`grpcSend` resolve, and before OAuth2 and TLS.
  - SOAP goes through the `send.ts` hook.
  - The post-response script runs from `EngineService.observe`, before the History entry and log row are built, so
    secrets read by a script are masked in both.
- `apps/desktop/src/main/session-values.ts`: per project, in memory:
  - `set`, `get`, `list` and `clear`;
  - it feeds single sends as `RunContext.sequence`;
  - the sequence runner still uses its own run scope.
- `apps/desktop/src/main/script-service.ts`: the checker host from Task 6.
  - It builds types per request from `openApiDocumentFor`, `schemaSetFor` and `grpcProtoSetFor`.
  - It caches them, and invalidates them on Update Definition.
- IPC:
  - `script.diagnostics`, `script.completions`, `script.quickInfo`, `script.signatureHelp`;
  - `script.values.list`, `script.values.clear`, and the `script.values.changed` event;
  - mutations `update-request-scripts` (text, enabled, secrets, timeout) and `enable-scripts` (bulk), validated by the
    engine schema.
- Wire types in `apps/desktop/src/shared/wire-types.ts`.
- `apps/desktop/electron-builder.yml`: `asarUnpack` for the QuickJS WASM file, only if loading it from the asar fails
  in the packaged smoke test.
- Tests:
  - `apps/desktop/test/{script-send,session-values,script-mutations}.test.ts`;
  - `script-send` covers the ordering, masking in History and the log, `script-origin-change`, and `scriptsOff`.

## Task 11 — Renderer

**Files**
- `apps/desktop/src/renderer/editor/monaco-core.ts`: register the `typescript` and `javascript` basic-language
  definitions (Monarch only).
- `apps/desktop/src/renderer/editor/script-language.ts`: completion, hover, signature help and marker providers that
  call the IPC from Task 10, keyed by model URI, like `json-completion.ts`.
- `apps/desktop/src/renderer/features/scripts/`:
  - `scripts-tab.tsx`, with pre and post editors, a secrets list, a timeout, and the off banner with **Switch on**;
  - `enable-scripts-dialog.tsx`;
  - `script-results.tsx`, the response **Script** tab.
- The SOAP, REST and gRPC request editors get the **Scripts** tab, with a dot when scripts are set.
- The explorer gets a **Values** node with **Clear**, and **Switch on scripts…** on an API or folder.
- Commands: `script.clearValues`. Regenerate `docs-site` `reference/commands.md`.
- Tests:
  - `apps/desktop/test/renderer/{scripts-tab,script-language,enable-scripts-dialog}.test.tsx`;
  - `build-output.test.ts` must still pass unchanged, with no `ts.worker` and under budget.

## Task 12 — e2e, docs and changelog

- `e2e/specs/scripts.spec.ts`:
  - a log-in request's post-response script sets `token` as secret, and the next single send uses
    `${#Sequence#token}` and passes, with the token shown only masked;
  - a type error in a pre-request script shows in the editor and blocks the send.
- Docs:
  - `docs-site/src/content/docs/guides/scripts.mdx`, with a sidebar entry;
  - a `reference/script-api.md` generated from the API declarations, with a `--check` in `pnpm check`;
  - `reference/project-format.md` (version 6);
  - `reference/property-syntax.mdx` (session values);
  - `guides/sequences.mdx` (a single send's values);
  - `switching/postman.mdx` (scripts row);
  - `docs/security.md` ("A script runs with no capabilities");
  - `docs/success-criteria.md` SC-S1 onwards;
  - `docs/roadmap.md` item 13;
  - `CHANGELOG.md`.
- `pnpm check`, then `pnpm build && xvfb-run -a pnpm test:e2e -- scripts.spec.ts`.
