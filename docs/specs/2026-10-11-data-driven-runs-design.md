# Data-driven runs — design

Issue: #336 (milestone 5.1, the data-driven part of #73). Builds on the CLI runner (`docs/specs/2026-09-18-cli-runner-design.md`),
sequences (`docs/specs/2026-09-28-sequences-design.md`) and typed scripting (`docs/specs/2026-09-28-typed-scripting-design.md`).

## Goal

Run a folder, an API, a whole project or a sequence many times over, once per row of a CSV or JSON data file, from
the app and from `wirebench run`, with the same iterations, the same values and the same reports in both.

## Decisions (owner, 2026-10-11)

- **D1 — Data values are explicit and literal.** A column is read only as `${#Data#column}`; the `${column}` shorthand
  never reaches it. *Amended by #560: the shorthand now reaches a column last, after Global, so the app teaches one
  `${…}` form; a column still never shadows a property, and the value stays literal.* The value is substituted as it is: a `${…}` inside a cell is not expanded, and a `${secret:…}`
  inside one is never resolved (the Sequence rule of ADR-0015, without the origin guard: the file is the user's own,
  so a row may choose a host).
- **D2 — Over-run defaults to stop.** With more iterations asked for than there are rows, the run stops after the
  last row. `wrap` starts again at row 1; `repeat-last` reuses the last row. With no iteration count given, a run
  with a data file runs once per row; without a data file, once.
- **D3 — Sequences take data too,** in the CLI and the app: one sequence run per iteration, the row laid over every
  step.
- **D4 — The app keeps runner settings per target in its own storage,** next to the run history. Project files do
  not change; the CLI takes flags.

## Scope

- Data files: CSV (RFC 4180, a header row naming the columns) and JSON (an array of flat objects).
- `${#Data#column}` in every protocol's request text, and `iteration.data.get(column)` in scripts.
- An iteration driver in the engine shared by request runs and sequence runs: iterations, delay between requests,
  over-run, bail across iterations, results tagged by iteration.
- CLI: `--data <file>`, `--iterations <n>`, `--delay <ms>`, `--data-overrun stop|wrap|repeat-last`, with `--bail`
  stopping every later iteration; all four reporters show the iteration.
- Desktop: **Run…** on a folder, an API, a project or a sequence opens a runner tab: iterations, delay, run order
  (reorder, exclude), environment, data file, over-run, stop on first failure; results per iteration and request; a
  run history kept outside the project.

**Not in scope:** suites and the callback listener (#73); branching in sequences (#347); parallel iterations; data
from a database or a URL; writing results back into the data file; `--data` with `--baseline`/`--update-baseline`
(a golden is per request, not per row: refused, exit 2).

## 1. Data files (engine `run/data-file.ts`)

`parseDataFile(text, format) → DataTable { columns: string[]; rows: Record<string, string>[] }`. The format comes
from the extension (`.csv`, `.json`); any other extension is refused (`data-file-format`).

- **CSV.** A leading BOM is dropped. The first record is the header; every column name is trimmed and must be
  non-empty and unique. Fields follow RFC 4180: `"…"` quoting, `""` for a quote, commas and line breaks inside
  quotes; `\r\n` and `\n` both end a record. A blank line (a record of one empty field) is skipped. A record with
  more fields than the header is refused naming its line; one with fewer gets `''` for the missing columns.
- **JSON.** An array whose items are objects. A string value is kept as it is; a number or boolean becomes its JSON
  text; `null` becomes `''`; an object or array becomes its compact JSON text. Columns are the union of the items'
  keys, first seen first.
- **Limits.** At most 10 MiB of text, 100 000 rows and 1 000 columns (`data-file-too-large`). A file with no rows
  is refused (`data-file-empty`): a data-driven run that tested nothing must not pass.
- Every refusal is a `WirebenchError` with code `data-file-invalid` (or the ones above) and a message naming the
  line (CSV) or item index (JSON). Values are never put in a message.

## 2. Iteration plan (engine `run/iterations.ts`)

`planIterations({ rows?, iterations?, overrun }) → Iteration[]`, where `Iteration = { index, count, row?: { index,
values } }` (0-based indexes; `count` is the plan's length).

- No data: `iterations ?? 1` iterations, none with a row.
- Data: `n = iterations ?? rows.length`. `stop` plans `min(n, rows.length)`; `wrap` takes row `i % rows.length`;
  `repeat-last` takes row `min(i, rows.length - 1)`.
- `iterations` is an integer 1–10 000 (`--iterations 0` is a usage error).

## 3. The Data scope

- `PropertyScopes.data?: PropertyMap`; `SCOPE_NAMES` gains `Data`. `lookupInScope` reads it with `Object.hasOwn`
  (a column may be named `__proto__`). The value is substituted literally (as `Sequence`), still XML-escaped when the
  expansion entitizes. `secretNamesIn` does not follow it.
- `RunContext.data?: PropertyMap` and `RunContext.iteration?: { index; count }`; `scopesFor` passes `data` on.
- `${#Data#x}` outside a data-driven run is `missing`, as `${#Sequence#x}` is outside a sequence. A single send's
  unresolved-reference warning names it like any other: outside a run there is no row, so the warning is true.

## 4. Scripts

- `ScriptRunValues` gains `data` (the row) and `iteration` (`{ index, count }`), both optional.
- One new global, declared `declare const iteration: { readonly index: number; readonly count: number; readonly
  data: { get(column: string): string | undefined } }` (index 0-based). Not a `data` global: scripts are checked as
  global scripts, so a global `data` would break every script that declares `const data = response.json()`.
- The compatibility API's `pm.iterationData.get/has/toObject` read the same row, and `pm.info.iteration` /
  `pm.info.iterationCount` the same numbers (they were a stub answering 0 and 1).
- A send outside a data-driven run sees an empty row and `{ index: 0, count: 1 }`.

## 5. The iteration driver (engine `run/iterate.ts`)

```ts
runIterations(plan, once: (iteration) => Promise<RunResult>, { bail?, signal? }) → RunResult
```

- Calls `once` per planned iteration, in order. Each request result is tagged `iteration: { index, count, row? }`
  (`row` is the 0-based data row). The merged summary sums the counts and adds `iterations: { planned, run }`.
- Under `bail`, an iteration whose result has a failed or errored request is the last: the rest of that iteration
  is skipped by the loop inside it (as today), and later iterations are not run and not reported. An abort does the
  same. `iterations.run` says how far it got.
- A run without a data file and with one iteration produces exactly today's result (no `iteration` tags, no
  `summary.iterations`), so every existing report and test stays byte-identical.
- **Delay.** `createPacer(delayMs, signal)` returns `wait()`: nothing before the first send of the run, then
  `delayMs` before every later send, across iterations, cut short by the signal. `runRequests` takes it as
  `RunOptions.pace`, a sequence run through its sender.
- **Values per iteration.** Script values (`vars.set`) and sequence transfers start empty in every iteration;
  the cookie jar and OAuth2 tokens are the run's, shared by all iterations.
- `runRequests` gains `RunOptions.send?: RunRequestSender`, so a host with its own send path (the desktop) runs the
  same loop.

## 6. CLI

```text
    --data <file>            CSV or JSON rows; one iteration per row. Read relative to the working directory.
    --iterations <n>         Iterations to run (1–10000). Default: the data file's row count, else 1.
    --data-overrun <mode>    stop | wrap | repeat-last: when --iterations exceeds the rows. Default: stop.
    --delay <ms>             Wait between requests (and steps), across iterations.
```

- Works with selectors and with `--sequence` (D3). `--data-overrun` without `--data` is a usage error; so is
  `--data` or `--iterations` with `--baseline` or `--update-baseline`.
- The data file is read and parsed before anything is sent; a bad file exits 2 with its error on stderr.
- `secrets list` takes no data flags: a data value is never a secret reference (D1).
- **Reports.** `cli`: an `Iteration 2/5 (row 2)` heading before each iteration's requests and the iteration count in
  the summary. `junit`: one test suite per group and iteration, named `<group> [iteration 2]`. `json`: each request
  carries `iteration`, and `summary.iterations`. `html`: an Iteration column. A run of one iteration without data is
  rendered as today.

## 7. Desktop

Shell code (it spans every protocol): `main/runner/`, `shared/runner-wire.ts`, `renderer/features/runner/`.

- **Run…** on a folder, an API (any kind), a project or a sequence, and the palette command `runner.open`, opens a
  **Runner** tab for that target. One tab per target.
- **Configure.** Iterations, delay (ms), environment (the active one), data file (**Choose…** opens main's file
  dialog; the renderer only ever sees the file's name, its column names and row count, ADR-0005), over-run, stop on
  first failure. For a folder, API or project, the requests in run order with a checkbox to exclude one and up/down
  buttons to reorder; a sequence's steps run in the sequence's own order (edit the sequence to change it).
- **Settings** per target live in main's `runner-settings.json` under the app's user data (D4): the data file's path
  stays in main. A request id that no longer exists is dropped; a new request joins at the end, included.
- **Run.** Main runs the target through `runIterations` with the desktop's sender (the path a single send takes, so
  auth, TLS, proxy, scripts, the HTTP Log and History all apply; History entries carry `run:<runId>`). Progress
  streams per request on `runner.progress`; **Stop** cancels the request in flight and ends the run.
- **Results.** A summary line (passed / failed / errored / skipped, iterations run of planned, time) and a list
  grouped by iteration, each request with its outcome, status, time, then on expand its assertions (failed and
  errored apart), its error, and its script log. **Show in History** searches the run's tag.
- **History.** The last 20 runs of each target, kept masked in `runner-history/<hash of targetId>.json` under user data,
  never in the project. A past run opens read-only in the same results view.
- Every string crossing to the renderer is masked first, as a sequence run's are.

## Security

- A data value is never treated as a secret and is never put in an error message. It is masked in reports only if
  it happens to hold a value the run already masks.
- D1 keeps a cell from reaching a secret: `${secret:x}` inside a cell stays literal.
- The renderer never sends a file path (ADR-0005): main picks the data file and keeps its path.
