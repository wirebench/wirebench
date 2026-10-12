# Run control from scripts — design

Issue: #335. Builds on typed scripting (#63, `docs/specs/2026-09-28-typed-scripting-design.md`) and level scripts
(#334, `docs/specs/2026-10-11-level-scripts-design.md`). Amends ADR-0016.

## Goal

Imported scripts most often fail on three calls: `pm.sendRequest`, `pm.execution.setNextRequest` (and the older
`postman.setNextRequest`), and `pm.execution.skipRequest`. Two of these need no capability at all. They only say which
request a run sends next, or that the run should not send this one. A run can honour that from data the script hands
back, the way it honours `vars.set`, without the sandbox reaching anything new.

## Owner decision (2026-10-11)

The issue offered two options. The owner chose a third, combined one:

- (a) Allowing all three behind a permission prompt for each project was not chosen. It gives the sandbox network
  access.
- (b) Mapping the calls onto sequence steps at import time was not chosen. Scripts mostly decide in code, so most calls
  could not be mapped.
- Chosen: **run control only.** `setNextRequest` and `skipRequest` become directives that a script hands back and an
  API or folder run obeys. `sendRequest` stays refused, and the import report says so more clearly.
- Where it acts: **API and folder runs only** (`wirebench run`, the app's runs, data-driven runs). A single send and
  a sequence step ignore a directive and log a line saying so. A sequence's order belongs to the sequence (#347).

## Scope

In:

- A typed `execution` global with `setNextRequest(name | null)` and `skipRequest()`. The Postman layer's
  `pm.execution.setNextRequest`, `pm.execution.skipRequest` and `postman.setNextRequest` are built on it.
- The script output gains `control`, which the host checks like the rest of the output.
- The script session carries the directives. `runRequests` obeys them, under a jump limit that cannot be turned off.
- `RequestResult.control` and the reporters show the path the run took.
- The importer stops listing the run-control calls as unsupported, notes the scripts that use them, and words the
  `pm.sendRequest` warning to point at sequences and OAuth2.
- The ADR-0016 amendment, the scripts guide, the switching page and the regenerated API reference.

Out:

- `pm.sendRequest`, the cookie jar, `pm.visualizer`, `require` and `pm.vault` are unchanged.
- Directives inside a sequence. #347 adds the sequence's own branching.
- Mapping at import time.

## API

```ts
/** Steers an API or folder run. Ignored, with a log line, in a single send and in a sequence. */
declare const execution: {
  /** After this request, the run goes on at the first selected request with this name; `null` ends the run. The last call wins. */
  setNextRequest(name: string | null): void;
  /** Pre-request only: this request is not sent and is reported as skipped. The rest of its pre-request chain does not run. */
  skipRequest(): void;
};
```

- `name` is a string of at most 256 UTF-16 code units. Anything else throws `ScriptValueInvalid`.
- `skipRequest()` in a post-response script throws `ScriptUnsupported`.
- A script that fails hands back no directive. Its failure stands, and the run goes on as it would without the
  directive.
- Where the Postman layer stands: `pm.execution.setNextRequest`, `pm.execution.skipRequest` and
  `postman.setNextRequest` call these functions. The layer still does nothing a typed script cannot.

## Sandbox boundary

The script hands back `control: { next?: string | null, skip?: boolean }` through `__finish()`, beside `tests` and
`values`. The host validates it with zod: `next` is a string of at most 256 code units or `null`, `skip` is a boolean,
and no other key is allowed. Output the host cannot read fails the script with `script-error`, as it does today.

No host function is added. The directive is only data. The runner uses `next` to look up a request in the run's own
selection by exact name. It cannot name a request outside the run, a file, a URL or another API. The new calls give a
script no reach beyond choosing an order among requests that were already going to be sent.

## Running

The session (`run/script-support.ts`) gets `runControl: boolean` in its options. It is false by default. It is set
only by `runRequests` called with `RunOptions.runControl`, which `wirebench run` passes. `wirebench send` also sends
through `runRequests`, one request at a time, and does not pass it: a single send must not loop on itself.

- Pre-request chain: the levels run outermost first. A level's `next` is kept, and the last one set wins. When a level
  calls skip:
  - `runControl` true: the chain stops and the session throws `ScriptSkipped`, carrying `next`, the tests and the log
    so far. Nothing is connected or sent.
  - `runControl` false: the directive is ignored, a log line says so, and the chain goes on.
- Post-response chain: each level's `next` is kept, last one wins, across pre and post. `SentScripts.control` carries
  it when `runControl` is true. Otherwise there is one log line per send:
  `execution.setNextRequest is obeyed only in an API or folder run; ignored here`.
- `runRequests` walks `selected` by index:
  - `ScriptSkipped`: the result is `skipped`, with the script's log and `control: { skipped: true }`.
  - With no directive, the run goes on at the next index.
  - `next === null`: every request not yet reached is reported `skipped`, and the run ends.
  - `next` is a name: the run looks up the first selected request with that name.
    - A forward jump reports the requests it passes over as `skipped`.
    - A backward jump runs requests again, and each run is its own result.
    - A name not in the selection errors the current request with `script-next-unknown`. The rest is skipped, and
      nothing more is sent.
  - Each jump counts against `RUN_CONTROL_LIMITS.jumps` (1 000 per run). The jump past the limit errors the request
    that asked for it with `script-jump-limit`, and the rest is skipped. The limit has no option to raise or remove it.
  - `bail`, the abort signal and `requireAssertions` work as before. A loop can always be aborted.
- Data-driven runs (#336) call `runRequests` once per iteration, so the limit is per iteration.

`RequestResult.control?: { skipped?: true; next?: string | null }` records what the script asked for.

- CLI reporter: after the request line, `↳ skipped by its script`, `↳ next: "Login"` or `↳ ended the run`.
- JSON reporter: carries `control`.
- JUnit reporter: the same line in the case's `<system-out>`. The schema JUnit consumers read gives `<skipped/>` no
  attributes.
- HTML reporter: shows the same line as the CLI reporter.

## Errors

| Code                  | Where | Meaning                                                    |
| --------------------- | ----- | ---------------------------------------------------------- |
| `script-next-unknown` | run   | `setNextRequest` named no request in the run's selection   |
| `script-jump-limit`   | run   | A run made more than 1 000 jumps                           |

## Import

- `unsupportedCalls` no longer lists `pm.execution.setNextRequest` and `postman.setNextRequest`.
- New `runControlCalls` finds `setNextRequest` and `skipRequest`. The report gets a note: `The scripts of "<path>"
  steer the run (<calls>): obeyed in API and folder runs only`.
- The `pm.sendRequest` warning is worded on its own:
  `The scripts of "<path>" call pm.sendRequest, which a script cannot do: send that request as a sequence step, or use OAuth2 auth for a token`.
  Other unsupported calls keep today's warning.

## Security

- A directive is checked data. It holds no capability, reaches no host function, and names only requests the run
  already selected.
- A run cannot be made endless. Jumps are capped at 1 000, and an abort stops any loop.
- A skip happens before the connection is made. Secrets for the request were already read, as they are today for a
  pre-request script that fails, so no new read is added.
- Tests prove these points (plan task 1 and task 3). A forged `__finish` output is refused. A name outside the
  selection sends nothing. The cap holds for a loop of skips that sends nothing. An abort stops a loop.

## Testing

- Unit tests:
  - prelude: the `execution` globals, validation, and post-phase skip;
  - `runScript`: `control` and refused output;
  - session: chain rules, and logging when ignored;
  - `runRequests`: skip, forward and backward jumps, null, unknown, cap, abort and bail;
  - reporters;
  - importer warnings and notes.
- An engine integration test runs a Postman-layer polling loop against a local server, with `setNextRequest` on
  itself until a counter is reached.
