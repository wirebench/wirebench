# MCP: compare a request's response with its golden — design

Date: 2026-10-03 · Status: decisions approved by the owner in conversation 2026-10-03 · Issue #218
(follow-up of #36; milestone 2.3)

- Builds on:
  - `docs/specs/2026-10-03-wirebench-runner-baseline-design.md` (#36): `readGoldenFile`,
    `checkBaseline`, `RunOptions.baseline`, the `baseline` field on `RequestResult` and the synthetic
    `baseline` assertion. That spec's §2 table is the behaviour here; its §7 names this issue.
  - `docs/specs/2026-09-29-wirebench-mcp-server-design.md` (#32): the ops layer, the `send` op, its
    gates and redaction.
- Decisions (owner, 2026-10-03):
  1. **A flag on `send`, not a new tool.** `send` gains `baseline: true`. The send, its gates, its
     scripts, assertions and History entry are unchanged; the result gains a `baseline` field.
  2. **The body override may be combined with it.** The golden is the saved request's; an agent can
     change the body and check that the response still matches.
  3. **CLI parity.** `wirebench send <item> --baseline` runs the same op.
  4. **A difference fails the send,** as it fails a run: one failed `baseline` assertion, outcome
     `failed`. It is a normal result, not an `isError`.

## 1. Goal

An agent driving Wirebench over MCP can send a saved request and learn, in the same call, whether the
response still matches the golden committed beside it: which paths changed, were added or removed,
with expected and actual values, and how many differences the golden's ignore rules hid.

### 1.1 In scope

- `send`'s `baseline` input, and passing a `BaselineSource` from the op to `runRequests`.
- The `baseline` field on `SendResult`, masked.
- `wirebench send --baseline`, its human output and exit codes.
- Docs: `docs/cli.md`, the "Agents (MCP)" and "Snapshot regression" guides, `CHANGELOG.md`.

### 1.2 Not in scope

- Writing or updating a golden (#217 covers `run --update-baseline`; an MCP write is a later issue).
- A "missing golden is an error" option. `run --require-baseline` exists for CI; an agent reads
  `status: 'missing'`.
- Comparing a History entry, or a contract tool's (`call`) response, with a golden. A contract tool
  call has no saved request and so no golden.
- The two hardening gaps of #219. They live in the engine and are fixed there for `run` and `send`
  alike.
- Any desktop change. History entries do not store assertion results, so the synthetic assertion
  never reaches the desktop.

## 2. Input

```ts
baseline: z
  .boolean()
  .optional()
  .describe(
    'Also compare the response body with the golden saved beside the request (<slug>.golden.yaml), ' +
      "by meaning, honouring the golden's ignore rules. A difference fails the send.",
  ),
```

- Default `false`: `send` behaves exactly as today and the result has no `baseline` field.
- `send`'s description gains one sentence naming the flag.
- `--allow-send` and `--env` gate the call as before. The flag reads one file inside the project and
  needs no other gate.

## 3. Comparing

- `SendAndRecordInput` gains `baseline?: RunOptions['baseline']`, passed to `runRequests` beside
  `captures`. The contract tools' `call` does not set it.
- `send` builds the source as `wirebench run` does:
  `{ source: (item) => readGoldenFile(context.projectDir, opened.project, item.request.id), require: false }`.
- With a body override, the item keeps the saved request's id, so the saved request's golden is
  read. The override never changes which golden applies.
- Everything else is the engine's, unchanged from #36 §2:

| Case | `baseline.status` | Assertion added | `outcome` |
|---|---|---|---|
| Golden matches | `matched` | `baseline` passed: "matches the baseline" (+ "N ignored") | unchanged |
| Golden differs | `differs` | `baseline` failed: "N differences from the baseline" | `failed`, unless already `errored` |
| No golden | `missing` | none | unchanged |
| Sidecar unreadable | `unreadable` | `baseline` errored, with the reason | `errored` |
| Either body over 2 MB | `too-large` | `baseline` errored | `errored` |
| WebSocket request | `unsupported` | none | unchanged |

- A send that gets no exchange is refused as today (`send-failed` and the rest); it carries no
  `baseline`.

## 4. Result

`SendResult` gains the engine's `BaselineReport`, masked:

```ts
/** `baseline: true` only: the comparison with the golden. */
readonly baseline?: {
  readonly status: 'matched' | 'differs' | 'missing' | 'unreadable' | 'too-large' | 'unsupported';
  readonly format?: SnapshotFormat;
  readonly changes?: readonly SnapshotChange[]; // kind, path, expected?, actual?; the first 100
  readonly ignored?: number;
  readonly truncated?: boolean; // more than 100 changes
  readonly error?: string; // compared as text, and why
};
```

- Each change value is already capped at 200 characters by `diffSnapshot`.
- `missing` is the "no baseline saved" answer the issue asks for. The field says so on its own; no
  assertion and no error are added.

**Redaction.** A response can echo a secret. Every op result already passes through the op layer's
literal mask (`runOp`'s `redactResult` over every secret value the send revealed), so the comparison's
`changes`, `error` and the `baseline` assertion's text are masked with the rest of the result; a test
checks it end to end. The comparison also goes through the same pattern redaction as the body and
the `match` assertions (`redactBaseline` in the op layer), since a server-issued token is no revealed
secret: a change under a secret key shows the marker on both sides, other values pass through the
body redactors, and the `baseline` assertion's change lines are rebuilt from the redacted changes.

`redactAssertions` pairs a result with a saved assertion by position. The `baseline` result is
skipped there, as `script` is, so it never takes a saved assertion's slot. A failed one's message is
rebuilt from the redacted changes, keeping the engine's `compared as text:` line (URLs redacted) and
its `… and N more` line; any other gets the URL redaction every message gets.

## 5. CLI

```text
wirebench send <item> [-e <env>] [--body <text> | --body-file <file>] [--baseline] [--project <dir>] [--json]
```

- `--baseline` sets the op's `baseline` input. It is allowed with `--body` and `--body-file`.
- Human output: the `baseline` assertion prints with the others — `ok   matches the baseline (N
  ignored)`, or an errored line for an unreadable or oversize golden. A failed one prints its label,
  then one change per line, indented, in the `run` reporter's form (`changed <path>: <expected> →
  <actual>`, `added <path>: <actual>`, `removed <path>: <expected>`), the first 20, then `… and N
  more`. A case with no assertion adds one line: `baseline: no baseline saved` or
  `baseline: not compared (websocket)`.
- `--json` prints the `SendResult` with its `baseline` field.
- Exit codes follow `outcome`, as today: 0 passed (a missing golden included), 1 a difference or
  another failed assertion, 3 errored.

## 6. Testing

- **Op, unit** (fixture project, local HTTP stub, golden sidecars written by the test):
  - matched, with and without an ignored path, and `ignored` counted;
  - differs: outcome `failed`, `changes` with kind, path, expected and actual, the failed assertion;
  - more than 100 changes: `truncated`;
  - missing: `status: 'missing'`, outcome from the request's own assertions;
  - unreadable (a symlinked sidecar) and too large: outcome `errored`;
  - a WebSocket request: `unsupported`;
  - with a body override: the saved request's golden is used;
  - a secret echoed in the response is masked in `changes` and in the assertion message;
  - a request with saved assertions: theirs keep their redaction, and the `baseline` result does not
    shift them;
  - without the flag: no `baseline` field and no golden read.
- **MCP:** an in-memory client calls `send` with `baseline: true` against a differing golden and gets
  a normal result (not `isError`) with the changes.
- **CLI:** `send --baseline` human and `--json` output; exit 0 matched, 1 differs, 0 missing, 3
  unreadable; `--baseline` with `--body`.
- No e2e: the desktop does not change.

## 7. Docs

- `docs/cli.md`: `--baseline` on `send`.
- `guides/agents-mcp.mdx`: "Check a response against its golden": the flag, the result, a worked
  difference.
- `guides/snapshot-regression.mdx`: one line pointing agents at `send` with `baseline`.
- `CHANGELOG.md`, Unreleased/Added.
