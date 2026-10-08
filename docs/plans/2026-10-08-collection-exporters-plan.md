# Plan: Exporters — Postman Collection v2.1 and OpenCollection YAML

Spec: [`docs/specs/2026-10-08-collection-exporters-design.md`](../specs/2026-10-08-collection-exporters-design.md)
Issue: [#65](https://github.com/wirebench/wirebench/issues/65)

**Goal:** Export a project, an API or a SOAP interface to Postman Collection v2.1 (plus environment files)
or OpenCollection 1.0 YAML, with a report of what did not fit, from the desktop and the CLI.

**Architecture:** engine `export/` (pure: project in, files and report out) with `shared.ts` (variables,
URLs, SOAP → HTTP, auth, report), `postman.ts`, `opencollection.ts` and `index.ts`
(`exportCollection`). The CLI verb and the desktop channel only build the input and write the files.

## Global constraints

- Gate before every commit: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check`;
  `pnpm test:perf` before the push.
- One commit per task, as Mohammed Naami <m.naami@outlook.com>, no trailers.
- No local Electron windows; CI runs e2e.
- Never name a product a feature is modelled on (`pnpm check:banned-terms`).

## Tasks

### Task 1 — Spec and plan

This file and the spec.

### Task 2 — Shared export core

- `packages/engine/src/export/model.ts`: `ExportFormat`, `ExportInput`, `ExportEnvironment`,
  `ExportedFile`, `ExportResult`.
- `packages/engine/src/errors.ts`: `ExportError` (`export-target-not-found`, `export-nothing`).
- `packages/engine/src/export/shared.ts`: `toMustache(text, ctx)` (§3.1 table), `absoluteUrl(base, url)`,
  `colonPath(url)`, `soapAsHttp(iface, request, ctx)`, `credentialWarnings(auth, owner, ctx)`,
  lost settings, script notes, unique file names, the export context (report, secret names).
- Tests: `packages/engine/test/unit/export/shared.test.ts`.

**Done:** every row of the §3.1 table and the SOAP rules is tested.

### Task 3 — Postman exporter

- `packages/engine/src/export/postman.ts`: collection and environment files (§3.2).
- `packages/engine/src/export/index.ts`: `exportCollection(format, input)`; exported from the engine entry.
- Tests: `packages/engine/test/unit/export/postman.test.ts` (mapping, report, and the round trip:
  export → `parsePostmanCollectionText` + `apiFromPostmanCollection`, environment files →
  the Postman variables importer).

**Done:** round trip matches; no credential or secret value in any file.

### Task 4 — OpenCollection exporter

- `packages/engine/src/export/opencollection.ts` (§3.3).
- Tests: `opencollection.test.ts` (mapping, report, and the round trip: export → `parseOpenCollection` +
  `mapOpenCollection`, REST + gRPC + WebSocket + environments + assertions + examples + scripts).

**Done:** round trip matches.

### Task 5 — CLI `wirebench export`

- `packages/cli/src/commands/export.ts`, wired in `args.ts` / `main.ts`; usage and help text.
- Workspace environments and properties through `workspace-lookup.ts`.
- Tests: `packages/cli/test/unit/export.test.ts` against a temp project.
- Docs: the CLI reference page.

**Done:** both formats write files; `--api`, `--json`, errors and exit codes tested.

### Task 6 — Desktop

- `shared/wire-types.ts`: request/response schemas; `shared/ipc.ts`: `project.exportCollection`.
- Main: the project host builds the input, routed through the workspace service (adds the workspace's
  environments and properties); the handler picks a folder and writes atomically.
- Renderer: an export action (call + report dialog), context menu entries on project, API and interface
  nodes; commands `workspace.exportPostman` / `workspace.exportOpenCollection` in the catalogue.
- Tests: main handler unit test; renderer action unit test; command catalogue test updated.

**Done:** export from each menu writes the files and shows the report.

### Task 7 — Docs

- `docs-site` guide section on exporting, linked where the features page requires; roadmap line for #65.

**Done:** docs build and the features-coverage test pass.
