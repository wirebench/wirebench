# Runner baseline mode — design

Issue: [#36](https://github.com/wirebench/wirebench/issues/36). Roadmap items 3 and 5.
Builds on: `2026-09-18-cli-runner-design.md` (#30), `2026-09-22-snapshot-regression-design.md` (#34).

## Goal

`wirebench run --baseline` compares each response with the golden response committed beside its
request, by meaning, honouring the request's ignore rules. A semantic difference fails the run, and
the differences appear in every report.

## Decisions (owner, 2026-10-03)

1. **A request with no golden is noted, not failed.** It is judged on its other assertions and
   reported "no baseline". `--require-baseline` turns it into an error, as `--require-assertions`
   does for a request without assertions.
2. **The runner stays read-only** (runner spec, assumption 9). Goldens are saved and updated in the
   desktop's Snapshot tab. `--update-baseline` is a follow-up issue.
3. **One synthetic assertion per request.** A difference is one failed `baseline` assertion that
   lists every changed path, not one failure per path.
4. **CLI only.** The MCP server has no run tool to carry the check; MCP parity is a follow-up issue.

## Scope

- SOAP and REST requests run by `wirebench run`, the same bodies snapshot regression covers.
- The response body only. Status and headers are not compared, as in #34.

Not in scope: writing or updating goldens, sequence steps (their responses depend on the flow that
ran before them), gRPC and WebSocket (they have no golden), MCP.

## 1. Engine: one golden reader

Today only the desktop reads `<slug>.golden.yaml` (`apps/desktop/src/main/snapshot-store.ts`). The
reader moves into the engine, `packages/engine/src/snapshot/golden-file.ts`, exported from the main
`@wirebench/engine` entry so the CLI and the desktop read the file one way. It is **not** exported
from the `@wirebench/engine/snapshot` subpath: the renderer imports that subpath, and it must stay
free of `node:fs`.

```ts
interface GoldenFile { contentType?: string; savedAt: string; ignore: readonly string[]; body: string }
type GoldenRead =
  | { status: 'none' }
  | { status: 'present'; golden: GoldenFile }
  | { status: 'unreadable'; reason: 'not-a-file' | 'malformed' };

function readGoldenFile(projectDir: string, project: Project, requestId: string): Promise<GoldenRead>;
```

- The path comes from the existing `requestFileLocation`.
- It keeps every check the store makes today:
  - the request's folder, symlinks resolved, stays inside the project folder;
  - the request's `*.request.yaml` exists on disk (`none` otherwise);
  - the sidecar is checked with `lstat` and never followed when it is a symlink or anything but a
    regular file (`unreadable`, `not-a-file`);
  - the content is validated with zod (`unreadable`, `malformed`).
- A request with no file location reads as `none`.
- `SnapshotStore.read` calls it and maps `unreadable` to its current `none` plus a warning, so the
  desktop's behaviour does not change. Writing, ignore updates and removal stay in the desktop.
- `apps/desktop/src/shared/wire-types.ts` keeps its own `snapshotSchema`. The renderer must not gain
  an eager value import from the engine (the wire-types CSP trap).

## 2. Engine: the baseline check in a run

`RunOptions` gains one optional source, built by the host the way `captures` is:

```ts
type BaselineSource = (item: SelectedRequest) => Promise<GoldenRead>;

interface RunOptions {
  // …
  readonly baseline?: { readonly source: BaselineSource; readonly require: boolean };
}
```

`AssertionResult.type` gains `'baseline'`, beside `'script'`. It is a result type only; a request
file cannot declare it.

When `baseline` is set, `runRequests` checks each request that got a response, after its own
assertions:

| Case | `baseline.status` | Assertion added | Request outcome |
|---|---|---|---|
| Golden matches | `matched` | `baseline` passed: "matches the baseline" (+ "N ignored") | unchanged |
| Golden differs | `differs` | `baseline` failed: "N differences from the baseline" | failed, unless already errored |
| No golden | `missing` | none, unless `require` | unchanged; with `require`: errored, `baseline-missing` |
| Sidecar unreadable | `unreadable` | `baseline` errored, with the reason | errored |
| Either body over 2 MB (UTF-8) | `too-large` | `baseline` errored: "too large to compare semantically" | errored |
| gRPC / WebSocket request | `unsupported` | none | unchanged |
| Sequence step | — | none; the check does not run | unchanged |

A request that errored before or during the send gets no baseline entry.

**Comparing.**
- The full response body is decoded as UTF-8. The engine keeps a capped exchange for reports, but
  the comparison never uses it.
- The format is `detectSnapshotFormat(golden.body, golden.contentType ?? <response content-type>)`,
  the same call the Snapshot tab makes.
- `diffSnapshot(golden.body, body, { format, ignore: parseIgnoreRules(golden.ignore.join('\n')) })`,
  again as the tab does. A parse failure falls back
  to text and sets `error`, as in #34; the run reports it with the differences.

**Result.** `RequestResult` gains:

```ts
readonly baseline?: {
  readonly status: 'matched' | 'differs' | 'missing' | 'unreadable' | 'too-large' | 'unsupported';
  readonly format?: SnapshotFormat;
  readonly changes?: readonly SnapshotChange[]; // the first 100
  readonly ignored?: number;
  readonly truncated?: boolean;                  // more than 100 changes
  readonly error?: string;                       // diffSnapshot's parse-failure note
};
```

The assertion carries no `expected` or `actual`. A failed one's `message` lists the first 20
changes, one per line: `changed <path>: <expected> → <actual>`, `added <path>: <actual>` or
`removed <path>: <expected>`; each value is already capped at 200 characters by `diffSnapshot`. An
errored one's `message` says why. The same text appears in every reporter.

**Secrets.** Golden bodies are committed and hold no secret, but a response can echo one. The
`baseline` field and the assertion text go through the existing masker (`reporters/mask.ts`) like
every other value from the response.

## 3. CLI

```text
wirebench run <path> [selector…] [options]
    --baseline           Compare each response with its committed golden (<slug>.golden.yaml).
    --require-baseline   With --baseline: a request without a golden is an error.
```

- `--require-baseline` without `--baseline` is a usage error (exit 2), and so is `--baseline` with
  `--sequence` (sequence steps are not compared).
- `commands/run.ts` builds the `BaselineSource` from the project folder and `readGoldenFile`.
- Exit codes keep their meaning: a difference is a failed assertion (1); a missing golden under
  `--require-baseline`, an unreadable sidecar and an oversize body are errors (3), which take
  precedence over 1.
- `wirebench sequence` gains neither flag (scope).

## 4. Reports

- **cli.** The request line gains `baseline: matches`, `(no baseline)` or
  `(baseline not compared: grpc)`. A difference is listed under the request like other failures:
  the label, then one change per line. When the run compared baselines, a second summary line reads
  `baseline: N matched, N differ, N missing`.
- **junit.** No new element. A difference is the `<failure>` of the `baseline` assertion: the
  message is "N differences from the baseline" and the body is the change list. An errored check is
  an `<error>`. A missing golden adds `<system-out>no baseline saved</system-out>`.
- **json.** Each request gains the `baseline` field of §2. The field is additive and optional, so
  the report's `formatVersion` stays 1. The summary gains `baseline: { matched, differs, missing }`
  when the run used `--baseline`.
- **html.** The baseline line and, on a difference, a table of kind, path and expected → actual.

## 5. Testing

- **Engine, reader:** none (no sidecar, no request file, unknown request), present, malformed YAML,
  a sidecar that is a symlink, a folder that escapes the project. The desktop's existing
  `snapshot-store` tests keep passing unchanged.
- **Engine, run:** matched, differs, a difference under an ignore rule, missing with and without
  `require`, unreadable, oversize, a gRPC request, a sequence step, a request that errored on send,
  and an outcome that was already errored staying errored.
- **CLI:** against a fixture project and a local HTTP server — a matching golden (exit 0), a changed
  response (exit 1, the JUnit `<failure>` and the JSON `baseline` field checked), a missing golden
  with `--require-baseline` (exit 3), and `--require-baseline` alone (exit 2).
- **Reporters:** snapshot tests of the four reporters for a run with each status.

## 6. Documentation

- `guides/snapshot-regression.mdx`: a new "In CI" section — commit the goldens, add `--baseline`.
- `guides/run-in-ci.mdx`: the flag in the pipeline examples.
- `reference/commands.md`: both flags and their exit codes.
- CHANGELOG, Unreleased/Added.
- `docs/roadmap.md` item 3: `--baseline` shipped.

## 7. Follow-up issues

- `wirebench run --update-baseline`: write the response as the new golden, keeping its ignore rules.
- MCP parity: compare a request's response with its golden from the MCP server.
