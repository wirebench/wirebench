# Plan: data-driven runs (#336)

**Spec:** `docs/specs/2026-10-11-data-driven-runs-design.md`.

**Architecture:** two pull requests.

- **PR 1 — engine + CLI** ("Part of #336"): data files, the Data scope, scripts' `data`/`iteration`, the iteration
  driver and pacer, `wirebench run --data --iterations --delay --data-overrun`, iteration-aware reporters, docs.
- **PR 2 — desktop** ("Closes #336"): the runner service in main, runner settings and history under user data, the
  Runner tab, **Run…** in the explorer and the palette.

## Global constraints

- `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check` green before every commit; one commit
  per task, test first. `pnpm build` and `pnpm test:perf` before a push. No local Electron e2e; CI runs it.
- A run with one iteration and no data file is byte-identical to today's, in every reporter.
- Never name another product; `pnpm check:banned-terms`.
- Renderer: no eager value import of a zod-bearing shared module. Main: no string ending in "import" (build trap).
- The renderer never sends a path (ADR-0005).

## PR 1 — engine and CLI

1. **Data file parser.** `packages/engine/src/run/data-file.ts` + tests: CSV (BOM, quotes, CRLF, blank lines,
   ragged rows, header checks), JSON (value coercion, column union), limits, `dataFormatOf(path)`. Export from the
   engine index.
2. **Iteration plan.** `run/iterations.ts` + tests: no data, data with each over-run mode, bounds.
3. **Data scope.** `project/properties.ts` (`Data` scope: explicit, literal, entitized, not followed by
   `secretNamesIn`), `RunContext.data`/`iteration`, `scopesFor`. Tests in the properties and context suites,
   including a send through `runRequests` reading `${#Data#x}`.
4. **Scripts read the row.** `ScriptRunValues.data`/`iteration`, the sandbox prelude's `iteration` global (with `iteration.data`),
   declarations in `script/types/api.ts`, `pm.iterationData` and `pm.info.iteration*`; `deferredSession` passes
   them. Tests: a script reads `iteration.data.get`, a type check accepts it, the compatibility API reads the row.
5. **Iteration driver and pacer.** `run/iterate.ts` (`runIterations`, `createPacer`), `RequestResult.iteration`,
   `RunSummary.iterations`, `RunOptions.pace` and `RunOptions.send`. Tests: tagging, summary, bail across
   iterations, abort, delay between sends, single-iteration identity.
6. **CLI flags.** `args.ts`: `--data`, `--iterations`, `--delay`, `--data-overrun`, with the refusals; help text.
   Tests in the args suite.
7. **CLI wiring.** `commands/run.ts` and `commands/sequence.ts`: read and parse the file up front (exit 2), plan,
   run requests or sequences per iteration with the row, pacer across the run. Tests against a local server:
   rows reach requests and sequence steps, bail, over-run.
8. **Reporters.** `junit` and `html` show the iteration (`cli` and `json` land with task 7, whose test reads them); tests; existing ones unchanged.
9. **Docs and changelog.** `docs/cli.md` (flags, a "Data-driven runs" section), `CHANGELOG.md` under
   [Unreleased].

## PR 2 — desktop

10. **Wire and settings.** `shared/runner-wire.ts` (target, settings, progress, result, history entry types),
    `main/runner/settings-store.ts` (per-target settings in `runner-settings.json`, data path kept in main) + tests.
11. **Run history.** `main/runner/history-store.ts`: last 20 masked runs per target under `runner-history/` + tests.
12. **Runner service.** `main/runner/runner-service.ts`: resolve a target into requests or a sequence, read the
    data file, plan, run through `runIterations` with a sender over `sendThroughEngine` (`data`, `iteration`, run
    tags), mask, emit progress, save history, cancel. `SendOptions.data`/`iteration` in `send/exchange.ts`. Tests
    with a fake send.
13. **IPC.** Channels `runner.state`, `runner.settings.set`, `runner.data.choose/clear`, `runner.run`, `runner.cancel`,
    `runner.history.list/get`, event `runner.progress`; preload and handlers. Tests in the IPC suites.
14. **Renderer store and tab.** `state/runner.ts`, `features/runner/runner-tab.tsx` (configure, order list,
    results grouped by iteration, history), a `runner` tab kind. Renderer tests.
15. **Run… everywhere.** Explorer context menu on folder, API, project and sequence rows; command `runner.open` in
    `COMMAND_CATALOG`; `pnpm docs:commands`. Tests.
16. **e2e and docs.** One e2e: run a folder against the test server with a CSV, two iterations visible, history
    entry kept. User docs for the runner; changelog line.
