# API- and folder-level scripts — plan

Spec: `docs/specs/2026-10-11-level-scripts-design.md`. Issue #334.

Each task is test-first and ends in one commit, made after
`NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check` is green.

## 1. Format 9: `scripts` on APIs, interfaces and folders

- Model: optional `scripts?: RequestScripts` on `RestApi`, `GrpcApi`, `Interface`, `RestFolder`, `GrpcFolder`
  (`FolderNode`).
- Schemas: `scripts: scriptsSchema.optional()` on the REST and gRPC `api.yaml`, `interface.yaml`, and
  `restFolderFileSchema`.
- `loadScripts` and `scriptsDocument` take the file stem (a request's slug, `api`, `interface` or `folder`). A
  folder claims `folder.pre.ts` before its requests do. A scripted request slugged `folder` under a scripted folder
  is the `script-file-clash` problem on load, and a save refuses it with `duplicate-slug`.
- `FORMAT_VERSION` 9, the migration stamp, `pnpm schemas:project` (writes `v9/`), and fixture version bumps.
- Tests: a round trip per level and protocol, the clash on load and on save, a missing level file as a problem.

## 2. Engine: the script chain

- `ScriptLevel` (`level`, `name`, `stem`, `scripts`) and `ScriptedRequest.outer`. The request's own `scripts`
  become optional.
- `ProtocolScripting.levelTypes()` for SOAP, REST, gRPC and the echo test protocol.
- `RequestScripting.check` checks every level. Outer levels use generic declarations, and their file is
  `<stem>.<phase>.<ext>`.
- `scriptSession` runs the levels: pre in order and stops at the first failure; post in order, keeps running, and
  reports the first failure. Values carry forward, and each level gets only its own secrets.
- `SentScripts.levels`.
- Tests: order, failure rules, values, secrets, the generic check, the file names in errors.

## 3. Engine and CLI: a run uses the levels

- `ProtocolRun.scriptLevels(selected)` for REST and gRPC (API, then the chain) and SOAP (the interface).
- `createRunSender`, `checkRunScripts`, `deferredSession` (the union of secrets), `secret-needs` and
  `scriptsOff` handle a request whose levels have scripts even when it has none of its own.
- CLI `sequence` counts levels' post-response scripts.
- Tests: an integration run with API, folder and request scripts (REST, SOAP, gRPC), and the pre-run check failing
  on a level.

## 4. Postman import places scripts at their level

- `map.ts`: collection events go on the API and folder events on the folder, switched off on the `postman` layer.
  The warning counts levels and requests together.
- The exporter writes an API's and a folder's scripts as collection and folder events where the target has them, and
  warns where it does not.
- Tests: the import placement, and an export round trip.

## 5. Desktop main: levels in lookup, editor and mutation

- Wire: `scripts` on the API, gRPC API, interface and folder wire types. `ScriptResultWire.levels`.
- `update-request-scripts` and `enable-scripts` reach folders, APIs and interfaces by id. Enable on a folder or
  API switches on every level inside it.
- `ScriptHost.lookup` builds `outer` from the project. The editor model for a level's id uses generic declarations.
- Tests: the mutation per owner kind, lookup with levels, the editor model, the result wire.

## 6. Desktop renderer: editing and results

- `ScriptsTab` takes an owner id. Mount it in the REST and gRPC API tabs and as a SOAP interface editor tab. Add a
  folder **Scripts…** dialog and its explorer menu entry for REST and gRPC.
- The **Script** tab groups results by level.
- Tests: renderer unit tests for the dialog, the tabs and the level headings, and an e2e spec (CI runs it).

## 7. Docs and CHANGELOG

- `project-format.md`, the Scripts guide, `script-api` if needed, and CHANGELOG under [Unreleased].
