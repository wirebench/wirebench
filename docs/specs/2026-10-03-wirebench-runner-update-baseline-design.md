# Runner `--update-baseline` — design

Issue: [#217](https://github.com/wirebench/wirebench/issues/217). Follow-up of #36.
Builds on: `2026-10-03-wirebench-runner-baseline-design.md` (#36), `2026-09-22-snapshot-regression-design.md` (#34),
`2026-09-18-cli-runner-design.md` (#30).

## Goal

`wirebench run --update-baseline` sends the selected requests and saves each SOAP or REST response
that no longer matches its golden as the new `<slug>.golden.yaml`, keeping the golden's ignore
rules. A team that changed a service on purpose refreshes every golden in one command, reviews the
diff in git, and commits it.

## Decisions (owner, 2026-10-03)

1. **Only what changed is written.** Each response is compared with its golden first, as
   `--baseline` does. A golden that differs is replaced, a missing golden is created, and a golden
   that matches (ignore rules applied) is left untouched, so git shows no `savedAt` churn.
2. **Only passing requests are written.** A request whose own assertions failed is not written and
   is listed as "not written: failed". A request that errored is never written.
3. **A response holding a known secret is refused.** Goldens are committed. The golden is not
   written and the request errors, using the runner's existing known-secret check.
4. **A bad sidecar is refused, never overwritten.** A malformed sidecar, or a sidecar path that is a
   symlink or anything but a regular file, errors the request. Ignore rules are never lost silently
   and a symlink is never followed.

## Scope

- SOAP and REST requests run by `wirebench run`: the requests `--baseline` compares.
- The response body and its content type, as the Snapshot tab saves them.

Not in scope: sequence steps, gRPC and WebSocket (no golden), the MCP server (#218), changing
ignore rules (the Snapshot tab), removing goldens, a dry run (`--baseline` already shows what would
change).

## 1. The runner's one writing flag

The runner spec's assumption 9 ("the runner never writes to the project") gains one exception:
`--update-baseline` writes `<slug>.golden.yaml` sidecars, and nothing else. No history entry, no
`.wirebench/local.yaml`, no request or project file. Every other flag stays read-only.

## 2. Engine: one golden writer

The desktop's sidecar writer (`sidecarText`, `writeSidecar` and the path checks of `locate` in
`apps/desktop/src/main/snapshot-store.ts`) moves into the engine, beside the reader, in
`packages/engine/src/snapshot/golden-file.ts`. Like `readGoldenFile` it is exported from the main
`@wirebench/engine` entry only, never from the `@wirebench/engine/snapshot` subpath (the renderer
imports that subpath and must stay free of `node:fs`).

```ts
type GoldenWrite =
  | { status: 'written'; file: string }  // project-relative, '/'-separated
  | { status: 'refused'; reason: 'unsaved' | 'not-a-file' };

function writeGoldenFile(
  projectDir: string,
  project: Project,
  requestId: string,
  golden: GoldenFile,
): Promise<GoldenWrite>;
```

- Same containment as the reader: the request's folder, symlinks resolved, stays inside the
  project folder, and the request's `*.request.yaml` exists on disk (`unsaved` otherwise).
- The sidecar's own name is checked with `lstat`; anything but a regular file or nothing is
  refused (`not-a-file`).
- The text is the desktop's: keys sorted, the body a block scalar, double-quoted when a block scalar
  would not read back the same.
- The write is atomic: a uniquely named temp file in the same folder, then a rename over the
  sidecar. A failed write removes the temp file and throws.
- `SnapshotStore.write` and `setIgnore` call it and map `refused` to their current
  `snapshot-unsaved` and `snapshot-not-a-file` errors; the store keeps its per-request queue. The
  desktop's behaviour does not change.

## 3. Engine: update mode in a run

`RunOptions` gains a second, separate option beside #36's `baseline`, built by the host the way
`baseline.source` is. The two are never set together (§4), and `baseline` is untouched:

```ts
type BaselineSink = (item: SelectedRequest, golden: GoldenFile) => Promise<GoldenWrite>;

interface RunOptions {
  // …
  readonly baseline?: { readonly source: BaselineSource; readonly require: boolean }; // #36, unchanged
  readonly updateBaseline?: { readonly source: BaselineSource; readonly sink: BaselineSink };
}
```

With `updateBaseline` set, `runRequests` handles each request that got a response, after its own
assertions, as below. The response is never judged against the old golden: replacing it is the
point, so no `baseline` assertion fails.

| Case | `baseline.status` | Written | Assertion added | Request outcome |
|---|---|---|---|---|
| Golden matches | `matched` | no | none | unchanged |
| Golden differs | `updated` | yes, old ignore rules kept | `baseline` passed: "baseline updated" | unchanged |
| No golden | `created` | yes, no ignore rules | `baseline` passed: "baseline created" | unchanged |
| Own assertions failed | `skipped`, `reason: 'failed'` | no | none | failed (unchanged) |
| Body holds a known secret | `refused`, `reason: 'secret'` | no | `baseline` errored | errored |
| Sidecar malformed | `refused`, `reason: 'malformed'` | no | `baseline` errored | errored |
| Sidecar not a regular file | `refused`, `reason: 'not-a-file'` | no | `baseline` errored | errored |
| Request file not on disk | `refused`, `reason: 'unsaved'` | no | `baseline` errored | errored |
| Body has no text form | `skipped`, `reason: 'not-text'` | no | none | unchanged |
| Write failed (I/O error) | `refused`, `reason: 'write-failed'` | no | `baseline` errored, with the error | errored |
| gRPC / WebSocket request | `unsupported` | no | none | unchanged |

A request that errored before or during the send, or whose script errored, gets no baseline entry
and is not written. Sequence steps never run in update mode (§4).

**Order of checks.** The request's own assertions decide first: failed is `skipped`, errored gets no entry. Then the golden is read
(`malformed` and `not-a-file` come from the reader), then compared. Only a golden about to be
written is checked for a secret, then for text, then written. A matching golden is never refused.

**Comparing.** Exactly as `--baseline` compares: `detectSnapshotFormat` and `diffSnapshot` with the
golden's ignore rules, on the full response body decoded as UTF-8. A difference only under ignored
paths is `matched`. When either body is over 2 MB (UTF-8), the semantic diff is skipped as in #36,
and the bodies are compared as exact text instead: equal is `matched`, anything else is `updated`.

**What is written.**
- `body`: the full response body decoded as UTF-8, never the capped exchange kept for reports.
- `contentType`: the response's `Content-Type` header, omitted when there is none.
- `ignore`: the old golden's rules, unchanged and in order; `[]` for a new golden.
- `savedAt`: the time of the write, ISO 8601.

**No text form.** A body is not text when it holds a NUL character or U+FFFD (the decoder met bytes
that are not UTF-8). The Snapshot tab offers no snapshot for a binary body either.

**Secrets.** The check is the run context's `containsKnownSecret`, which `wirebench run` already
sets (`knownSecretIn` over the environment secrets and the OAuth2 tokens the run obtained). A body
for which it returns true is refused; a context without it refuses nothing. The message names no
value.

**Result.** `RequestResult.baseline` (the #36 `BaselineReport`) gains statuses and fields:

```ts
readonly status:
  | 'matched' | 'differs' | 'missing' | 'unreadable' | 'too-large' | 'unsupported' // compare
  | 'updated' | 'created' | 'skipped' | 'refused';                                  // update ('matched', 'unsupported' shared)
readonly reason?: 'failed' | 'not-text' | 'secret' | 'malformed' | 'not-a-file' | 'unsaved' | 'write-failed';
readonly file?: string;      // the sidecar written, project-relative
```

For `updated`, `changes`, `ignored` and `truncated` describe the replaced golden against the new
one, as in #36, so a report shows what moved. `RunSummary` gains `baselineUpdate:
{ updated, created, matched, skipped, refused }`, set only by an update run; #36's
`summary.baseline` is left to compare runs.

## 4. CLI

```text
wirebench run <path> [selector…] [options]
    --update-baseline    Save each changed response as its request's golden (<slug>.golden.yaml),
                         keeping its ignore rules. The only flag that writes to the project.
```

- Usage errors (exit 2): `--update-baseline` with `--baseline`, with `--require-baseline`, or with
  `--sequence`.
- `--bail` still applies: goldens written before the run stops stay written.
- An interrupt (SIGINT) leaves every golden either written whole or untouched, since each write is
  a rename.
- `commands/run.ts` builds the source from `readGoldenFile` and the sink from `writeGoldenFile`, both
  on the folder the project was loaded from.
- Exit codes keep their meaning. A written golden is a passed assertion. A request that failed its
  own assertions still fails the run (1). A refusal is an error (3), which takes precedence over 1.

## 5. Reports

- **cli.** The request line gains `baseline: updated`, `baseline: created`, `baseline: matches`,
  `(baseline not written: failed)` or `(baseline not written: not text)`; a refusal is listed under
  the request as an error with its reason. When the run updated baselines, the summary ends with:

  ```text
  baseline: 3 updated, 1 created, 12 matched, 1 not written, 0 refused
  written:
    orders/get-order.golden.yaml
    orders/list-orders.golden.yaml
  ```

- **junit.** A written golden adds `<system-out>baseline updated: orders/get-order.golden.yaml</system-out>`
  (or `created`). A refusal is the `<error>` of the `baseline` assertion.
- **json.** Each request's `baseline` field carries the §3 status, `reason` and `file`; the summary
  carries `baselineUpdate`. The fields are additive and optional, so `formatVersion` stays 1.
- **html.** The baseline line, the written file, and for `updated` the table of changes #36 already
  renders.
- Everything taken from the response goes through the existing masker, as in #36, so a body
  refused for a secret reaches a report only as its masked exchange.

## 6. Testing

- **Engine, writer:** a new golden, a replaced golden keeping its ignore rules, a body that needs
  double quoting, a sidecar that is a symlink (refused, target untouched), a folder that escapes the
  project, a request with no `*.request.yaml`, the temp file removed after a failed rename. The
  desktop's `snapshot-store` tests keep passing unchanged.
- **Engine, run:** every row of the §3 table, an ignore-only difference staying `matched`, an
  oversize body compared as text, a script error, a body holding a value `containsKnownSecret`
  knows (refused, file untouched), and the `--baseline` tests unchanged.
- **CLI:** against a fixture project copied to a temp folder and a local HTTP server — a changed
  response rewritten (exit 0; new body, old ignore rules, new `savedAt`), a matching golden left
  byte-for-byte unchanged, a missing golden created, a failing request not written (exit 1), each
  usage error (exit 2), and a `--baseline` run after the update passing. (The fixture's echoing
  endpoint answers 401, so the secret refusal is proven in the engine run tests.)
- **Reporters:** snapshot tests of the four reporters for an update run with each status.

## 7. Documentation

- `guides/snapshot-regression.mdx`, "In CI": refreshing goldens after an intended change, with the
  review-then-commit flow and the refusal cases.
- `reference/commands.md`: the flag, its conflicts and its exit codes.
- The runner spec's assumption 9 notes the exception (§1).
- CHANGELOG, Unreleased/Added.
- `docs/roadmap.md` item 3: `--update-baseline` shipped.
