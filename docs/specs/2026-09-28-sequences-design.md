# Sequences — design

Issue: #62. Roadmap item 12. Builds on the CLI runner (#30, `docs/specs/2026-09-18-cli-runner-design.md`), whose
`assert/` module was written to be reused here (runner spec §3.2).

## Goal

Chain saved requests into a named, ordered **sequence**. Each step can lift values out of its response — by XPath,
XQuery, JSONPath, a header or the status — and later steps use them as `${#Sequence#name}`. Each step can also
declare assertions in YAML. A sequence runs from the desktop and from `wirebench run`, with the same semantics and
the same results in both.

This is the first slice of functional testing, and it runs no code. Scripting is item 13 (#63) and has its own design.

## Scope

- SOAP, REST and unary gRPC requests as steps, because those are what the runner can already send.
- A linear chain: steps run in order, once each.
- Property transfers from the response body (XPath 3.1, XQuery 3.1, JSONPath), a response header, or the status.
- Step assertions, drawn from the runner's catalogue plus a new `header` assertion. The request's own assertions
  also run by default.
- Desktop: a Sequences group in the explorer, a sequence editor tab, and a run panel. Every step's send goes to
  History and the HTTP Log.
- CLI: `wirebench run --sequence <name>`, with every reporter.

**Not in scope:** loops, branches, conditions, retries, data-driven runs (item 14), scripts (item 13), WebSocket and
streaming gRPC steps, parallel steps, cross-project steps, transfers into a saved property, and a step that sends a
request other than the saved one (no per-step body or header overrides). Every one of these can be added later
without changing the v1 file shape.

## Storage

Each sequence is one file in a new top-level folder:

```
my-service/
  wirebench.yaml
  interfaces/…
  apis/…
  sequences/
    checkout-flow.sequence.yaml
```

```yaml
kind: sequence
version: 1
id: 01JAYC5S3Q0V9R6Z4XKM7N2B8D
name: Checkout flow
order: 0
description: Log in, create a cart, pay.
settings:
  stopOnFailure: true
steps:
  - id: 01JAYC5T0000000000000000A1
    name: Log in
    request: 01J9ZZ…            # a saved request's id: SOAP, REST or unary gRPC
    transfers:
      - name: token
        from: body
        language: jsonpath
        expression: $.access_token
        secret: true
      - name: session
        from: header
        header: X-Session-Id
    assertions:
      - type: status
        equals: 200
  - id: 01JAYC5T0000000000000000A2
    name: Create cart
    request: 01J9ZY…
    assertions:
      - type: match
        language: jsonpath
        expression: $.cart.id
        exists: true
```

The file's fields:

| Field | Meaning |
|---|---|
| `kind` | Always `sequence`. Any other value is refused by name. |
| `version` | This file kind's own version, `1`. A higher one is refused with `sequence-version-too-new`, and that file only is skipped. |
| `id`, `name`, `order`, `description?` | As for every other entity. The ULID comes from `generateId`, and the slug from `uniqueSlug` over the other sequences' slugs. |
| `settings.stopOnFailure` | Default `true`. When a step fails or errors, the remaining steps are `skipped`. |
| `settings.stepTimeoutMs?` | Overrides the request's own timeout for every step. |
| `steps[].id` | A ULID, so a result, a History tag or a merge can name a step whatever its position. |
| `steps[].request` | The id of the request to send. Always an id, never a path, so renaming or moving a request does not break the step. |
| `steps[].name?` | Defaults to the request's name. |
| `steps[].enabled` | Default `true`, and omitted when `true`. A disabled step is reported as `skipped`. |
| `steps[].requestAssertions` | Default `true`, and omitted when `true`. When `false`, the request's own `assertions:` are not evaluated in this step. |
| `steps[].transfers` | See [Property transfers](#property-transfers). |
| `steps[].assertions` | The runner's `assertionsSchema`, plus `header`. |

**No `formatVersion` bump.** ADR-0003 bumps the version because an unknown *key* is dropped on load and lost on the
next save. A new top-level folder is different, and the code shows it: `loadProject` walks only `interfaces/`,
`apis/`, `environments/` and `wss/`; `listManagedFiles` in `save.ts` never lists a file under `sequences/`, so it is
never deleted; and `isManagedPath` in `project-watch.ts` ignores the folder. An older build therefore opens the
project, shows no sequences, and leaves `sequences/` byte for byte as it was. That is the same reasoning ADR-0014
used for `team-secrets/`. The per-file `version` is what future changes to the sequence shape bump instead. ADR-0003
gets an update saying so.

**Dangling steps.** A step whose request no longer exists (deleted, or deleted by an older build) loads normally.
It shows as "Missing request" and errors with `sequence-step-missing-request` when run. It is never removed silently.

**Load problems.** A malformed sequence file becomes a `sequence-file-invalid` project problem naming the file, and
only that file is skipped. So is an over-size file: over 256 KiB, over 100 steps, or over 50 transfers or 50
assertions in one step.

## Property transfers

```ts
type Transfer =
  | { name: string; from: 'body'; language: 'xpath' | 'xquery' | 'jsonpath'; expression: string;
      namespaces?: Record<string, string>; secret?: boolean; optional?: boolean }
  | { name: string; from: 'header'; header: string; secret?: boolean; optional?: boolean }
  | { name: string; from: 'status'; secret?: boolean; optional?: boolean };
```

- `name` matches `^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`. A later transfer with the same name overwrites the earlier value.
- `body` reuses the assertion path: `evaluateWithTimeout` on a worker, then the first item's text, as in
  `firstText()` in `assert/match.ts`, moved into a shared helper. If `namespaces` is omitted for XML, the
  response's own prefixes from `collectNamespaces` are used.
- `header` takes the first value of the named header (the name is case-insensitive). For gRPC, response metadata
  counts as headers and trailers are searched after them.
- `status` is the HTTP status for SOAP and REST, and the numeric gRPC status for gRPC.
- A transfer that finds nothing fails the step with `sequence-transfer-missing`, unless it is `optional`. An
  optional transfer that finds nothing leaves the name unset.
- Transfers run after the response arrives, whether the assertions pass or not. A value lifted from a failed
  response is still shown in the run panel, which is what debugging needs.

### The Sequence scope

Transferred values live in a new property scope, `${#Sequence#name}`, which exists only while a sequence runs:

- It is added to `SCOPE_NAMES`, `lookupInScope` and `secretNamesIn` in `project/properties.ts`, and to
  `PropertyScopes` as `sequence?: PropertyMap`.
- **It is explicit only.** The shorthand `${name}` never reads it. A request that depends on a sequence value then
  says so in its own text, and a value from a response can never shadow `${baseUrl}` or anything else a request
  already uses.
- Outside a run, `${#Sequence#x}` is an ordinary unresolved reference, with the existing preflight message.
- Values live in memory only. They are never written to the sequence file, the request, the project or a
  preference.

How a value is substituted is part of the [Security](#security) section below. In short: literally, escaped for
the body's language, and never into a URL's origin.

## Assertions

A step's assertions are the runner's `Assertion` union — `status`, `soap-fault`, `match`, `schema`, `sla` — with the
same schema and the same evaluator (`evaluateAssertions`). One new member is added, and the CLI gets it too:

```ts
interface HeaderAssertion { type: 'header'; name: string; equals?: string; matches?: string; exists?: boolean;
                            label?: string }
```

For this, `AssertionSubject` gains `headers: readonly (readonly [string, string])[]`. Transfers use it as well.

A step runs the request's own assertions first (unless `requestAssertions: false`), then its own. Every assertion is
evaluated even after one fails, as in the runner. A step with no assertions at all passes when a response arrives.

## Running a sequence

- Steps run one at a time, in file order.
- One environment for the whole run: the active one in the desktop, `--env` in the CLI.
- **Outcomes** are the runner's own: `passed | failed | errored | skipped`, with errored > failed > passed.
  - A step errors if the request is missing or unsupported, a property is unresolved, the send fails, a required
    transfer is missing, or a guard in [Security](#security) refuses the send.
  - A step fails if an assertion fails.
  - The run's outcome is the worst outcome among its steps.
- `stopOnFailure` (default on) skips the steps after the first failed or errored one.
- Every step send is bounded by the request's timeout, or by `settings.stepTimeoutMs` when set. The run has one
  `AbortSignal`: Cancel in the desktop and SIGINT in the CLI abort the step in flight and skip the rest.
- **Cookies.** The desktop uses its session jar, as a single send does. The CLI keeps one in-memory jar per
  sequence run, built with `rest/cookies.ts`, and discards it at the end, so a login step's cookie reaches the next
  step. The jar is never written anywhere.

### Engine surface

A new engine module, `@wirebench/engine/sequence`, holds the model, the schema, loading and serialising, and the loop.
Sending stays with the host, because the desktop and the CLI send differently: the desktop has the keychain, the
browser OAuth2 flow, its session cookie jar and History, while the CLI has environment-variable secrets and headless
OAuth2.

```ts
interface Sequence { id; name; slug; order; description?; settings: SequenceSettings; steps: SequenceStep[] }
interface SequenceStep { id; name?; requestId; enabled; requestAssertions; transfers: Transfer[]; assertions: Assertion[] }

/** What a host does for one step: send the request with `sequenceScope` added, and describe the response. */
type SequenceStepSender = (step: ResolvedStep, sequenceScope: PropertyMap, signal: AbortSignal)
  => Promise<{ subject: AssertionSubject; origin: string } | { error: { code: string; message: string } }>;

function runSequence(sequence: Sequence, project: Project, send: SequenceStepSender,
  options: { signal: AbortSignal; onStepDone?: (r: SequenceStepResult) => void;
             onSecretValue?: (value: string) => void;
             containsKnownSecret?: (value: string) => boolean }): Promise<SequenceRunResult>;

interface TransferResult { name; outcome: 'set' | 'missing' | 'errored'; secret: boolean; value?: string; message? }
interface SequenceStepResult { stepId; requestId; name; protocol?: 'soap' | 'rest' | 'grpc'; outcome; status?;
  durationMs?; assertions: AssertionResult[]; transfers: TransferResult[]; error?: { code; message } }
interface SequenceRunResult { sequenceId; name; startedAt; environment?; outcome; steps: SequenceStepResult[] }
```

- `ResolvedStep` is the runner's `SelectedRequest` for the step's request id. A new `findSelectedRequest(project, id)`
  in `run/select.ts` finds it by walking the same candidates `selectRequests` walks.
- `TransferResult.value` is left out when the value is secret. See [Masking](#masking).
- `Project` gains `sequences: Sequence[]`. `projectFiles()` writes `sequences/<slug>.sequence.yaml`,
  `listManagedFiles` lists `sequences/*.sequence.yaml` so a deleted sequence's file is removed, and
  `isManagedPath`/`MANAGED_TOP_DIRS` add the folder so an external edit prompts a reload.

## CLI

```
wirebench run <project> --sequence "Checkout flow" [--sequence …] [--env staging] [--reporter junit:out.xml]
```

- `--sequence` matches a sequence by name, or by its file path `sequences/<slug>.sequence.yaml`, and can be
  repeated. It cannot be combined with request selectors, which is a usage error (exit 2). An unmatched name is a
  usage error too.
- The CLI's sender reuses `prepareSend` and the send-and-subject half of `runOne`, factored out as `sendPrepared`,
  with `RunContext` gaining `sequence?: PropertyMap`.
- Reporters get one group per sequence and one entry per step, reusing the `RequestResult` shape with
  `group = sequence name`:
  - JUnit: one `<testsuite>` per sequence.
  - JSON: each step's entry gains optional `sequence: { id, name, stepId }` and `transfers` fields. That is additive,
    so the report's `formatVersion` stays `1`.
  - HTML: the steps grouped per sequence, with the transfers listed.
- Exit codes are unchanged: 0 all passed, 1 an assertion failed, 3 a step errored, 2 usage, 130 interrupted.
- As today, a CLI run writes nothing to the project or to History (runner spec, assumption 9).

## Desktop

- **Explorer.** Each project gets a **Sequences** group after its APIs, listing its sequences by `order`.
  - The project's menu gains *New Sequence…*.
  - A sequence's menu offers *Open*, *Run*, *Rename*, *Duplicate* and *Delete*, with the existing delete
    confirmation.
- **Sequence tab**, opened by a single click like an API tab:
  - A header with the name, **Run** / **Cancel**, the active environment's name (a run uses it), and *Stop on first
    failure*.
  - **Steps**: an ordered list you can drag or reorder from the keyboard. Each row shows a step number, the method or
    protocol badge, the request's path, and an enable checkbox. *Add step…* opens a quick-pick over the project's
    SOAP, REST and unary gRPC requests; WebSocket and streaming gRPC requests are shown disabled, with the reason. A
    step whose request is missing is marked *Missing request*.
  - The selected step shows two tables:
    - **Transfers**: name, source (body / header / status), expression or header name, a *Secret* checkbox and an
      *Optional* checkbox.
    - **Assertions**: type, expression or name, and expected value.
  - Edits are staged in drafts and saved with the project, with a dirty mark on the tab, like every other editor.
- **Run panel**, below the steps. It shows one row per step, filled in as each step completes: outcome, status,
  duration, then the assertions and transfers when the row is expanded.
  - A transferred value is shown, unless it is secret (see [Masking](#masking)).
  - *Open in History* goes to the step's entry.
  - A run's results stay in the tab for the session and are not persisted.
- **Sends are ordinary sends.** Each step goes through the protocol's existing main-process send path
  (`sendAndRecordHistory`, `sendRestRequest`, `sendGrpcRequest`), with the Sequence scope added. It therefore gets
  the same auth, cookies, TLS, proxy, HTTP Log row and History entry as a single send.
  - Its History entry is tagged `sequence:<sequenceId>` and `run:<runId>`, using the `tags` field every `record*`
    input already accepts. History search then finds a run's steps.
  - REST, gRPC and SOAP each resolve their scopes differently today, so each path gains an optional
    `sequence?: PropertyMap` merged into the scopes it resolves itself. The same shape as `multi-env-send.ts`
    passing `envId` through.
- **Commands:** `sequence.new`, `sequence.run`, `sequence.cancel` and `sequence.addStep`, scoped to `editor.sequence`
  or `selection.sequence`. `reference/commands.md` is regenerated from the catalogue.

### IPC

| Channel | Request | Response |
|---|---|---|
| `project.mutate` change kinds | `add-sequence {name}`, `update-sequence {sequenceId, patch}`, `remove-sequence {sequenceId}`, `duplicate-sequence {sequenceId}` | the usual `{ project, createdId? }` |
| `sequence.run` | `{ projectId, sequenceId, environmentId? }` | `SequenceRunResult` (wire form), when the run ends |
| `sequence.cancel` | `{ runId }` | `{ cancelled: boolean }` |
| event `sequence.progress` | — | `{ runId, sequenceId, step: SequenceStepResult }` |

`sequence.run` sends the run's id in its first progress event, so the tab can cancel before the run ends. One run per
sequence at a time: a second `sequence.run` for a sequence already running is refused with `sequence-already-running`.

## Security

A sequence adds no code execution. What it does add is three kinds of input the rest of Wirebench does not have to
trust in the same way:

- **Server-controlled values.** A transferred value comes from a response, so whoever controls the server controls
  what the next request carries.
- **Shared-file input.** A sequence file may come from a teammate over sync, or from a branch you just pulled.
- **Unattended sends.** One click, or one CI job, sends several requests with your credentials.

Each rule below names what it prevents.

### A value from a response is data, never a template

`expand()` expands recursively: every substituted value is itself scanned for `${…}`, up to depth 8
(`properties.ts`, `expandAt`). For a value from a response, that recursion would be a secret-exfiltration
primitive. A server answers `{"next": "${secret:prod-db-password}"}`, a step transfers `next`, and the next step sends
the keychain value back to that same server. `${#System#HOME}` and every environment value would be exposed the same
way.

**Rule 1:** a Sequence-scope value is substituted **literally**. `expandAt` appends it without recursing, in both the
explicit form and the chained form (an Env value that itself says `${#Sequence#x}`). Because the value is never
tokenised, `$${` in it is not an escape and `${` in it is not a reference. [ADR-0015](../adr/0015-response-values-are-data.md)
records this as a rule for every future feature that moves response data into a request, scripting (#63) included.

### Values are escaped where they land

A request's body only escapes substituted values when the request opts in (`escape`, `rest/expand.ts`), and SOAP
only entitizes when `entitize` is on. Both defaults were chosen for values the user typed. A response value
substituted into `{"note": "${#Sequence#note}"}` without escaping is JSON injection: a server that answers
`x", "admin": true, "y": "` adds a field to the next request.

**Rule 2:** Sequence-scope values are always escaped for the place they land, whatever the request's setting:
- JSON string escaping in a JSON raw body;
- XML entities in an XML raw body, a SOAP envelope, or a SOAP header field;
- form encoding in a form field.

Other scopes keep today's behaviour. A text, HTML or JavaScript raw body is not escaped, as today. Each expander gets
an always-on escape for the Sequence scope alone: `escapedScopes` in `rest/expand.ts`, `substituted` for the SOAP
envelope, and the equivalent in `grpc/expand.ts`.

### A response cannot choose where the next request goes

A step's request carries the user's configured auth. If a response value could decide the next request's scheme, host
or port, a server could send the next step's `Authorization`, API key, client certificate or NTLM handshake to a
host of its choosing.

**Rule 3:** a Sequence value may appear in a URL's path, query or fragment, but it must not change the step's
**origin**.
- The guard expands the step's URL twice: once with the real Sequence values, once with every Sequence value
  replaced by the fixed marker `wbseq`.
- The two must parse to the same origin: `new URL().origin` for SOAP endpoints and REST URLs, and `host:port` plus
  TLS for a gRPC target. Otherwise the step errors with `sequence-origin-from-response`, before anything is sent.
- The guard is one engine helper, called by the three expanders whenever `scopes.sequence` is set, so the desktop
  and the CLI both get it.
- Following a `Location` to another host is therefore refused in v1, deliberately.

### No header splitting

**Rule 4:** a Sequence value that contains CR, LF or NUL is refused with `sequence-value-invalid` when it is
substituted into a URL, a header name or value, gRPC metadata, or a SOAP action. It is allowed in a body. The HTTP
stack would probably refuse such a value anyway, but the guard makes that certain and gives a clear error.

### Values are bounded

**Rule 5:**
- A transferred value over 64 KiB errors the step with `sequence-value-too-large`.
- The evaluator returns at most 1000 items, and a transfer only ever takes the first.
- A run holds at most 100 steps × 50 transfers.

This bounds memory whatever a server returns.

### Masking

A transferred value can be a credential: a login step's token, or a server echoing the `Authorization` header it was
sent.

**Rule 6:**
- A transfer marked `secret: true` has its value registered with the masker as soon as it is extracted. That is
  `onSecretValue` in the engine: the session's credential set in the desktop, and `createSecretMasker` in the CLI.
  From then on it is masked by value everywhere a known credential already is: the HTTP Log (unless show-secrets is
  on), History (always), the run panel, every CLI reporter, and HAR export.
- A value that contains a credential the run already knows (a resolved `${secret:…}`, or an auth value the run
  resolved) is treated as secret whether or not it is marked. The host answers that through `containsKnownSecret`:
  the desktop's session credential set, and the CLI's resolved environment secrets and OAuth2 tokens.
- A secret value is never put in `TransferResult.value`, so it cannot reach the renderer or a report except as
  `<redacted>`.
- The literal-masking floor of 4 characters applies, as it does for every other value.

### Evaluators

**Rule 7:** transfers and assertions evaluate only through the existing hardened path:
- `fontoxpath`, which cannot call out to the host;
- `jsonpath-plus` with `eval: 'safe'`;
- both on a worker thread with a 5-second budget (`xpath/evaluate-async.ts`).

Nothing in a sequence file is evaluated any other way.

**Rule 8 (a fix that also covers the runner):** `assert/match.ts` runs a `matches:` regular expression with
`new RegExp(...).test(actual)` on the calling thread, with no time budget. A catastrophic pattern in a file from a
teammate, such as `(a+)+$` against a long `aaaa…!`, would block the thread. In the CLI that is one hung job; in
the desktop, where sequence assertions run in the main process, it would freeze the app. So:
- regex matching (`match`, and the new `header` assertion) moves onto the same worker, with the same budget;
- a timeout reports as an `errored` assertion whose message says the expression timed out (`matchRegexWithTimeout`
  returns `regex-timeout`; `AssertionResult` carries a message, not a code, so the report shape is unchanged);
- the pattern is compiled on the worker, so an invalid pattern is an `errored` assertion there too.

### Shared files

**Rule 9:**
- A sequence file is untrusted input.
- It is parsed with the project's YAML parser (the `yaml` library's default core schema: no custom tags, and aliases
  capped by the library) after the 256 KiB size check.
- It is validated with zod and every limit above.
- It names requests only by id, so it cannot name a path on disk. Steps are resolved inside the project that holds
  the file, so a sequence cannot reach a request in another project.
- Its slug comes from `uniqueSlug`, and every write goes through the ADR-0005 path rules, like every other file.

### What this does not change

- Running a sequence someone else wrote sends requests to the hosts its requests name, with your credentials. That
  is exactly the trust a shared *request* already asks for today: a shared request can already put
  `${secret:x}` into a URL of its choosing. Sequences add no new way for a teammate to reach a secret, and Rules 1–3
  make sure they add no new way for a *server* to.
- Each step row in the run panel shows the origin it was sent to, so what a run contacted is visible.
- `docs/security.md` gets a section, "A response value is data, never a template", with these rules and the tests
  that prove them.

## Error codes

- **Load problems:** `sequence-file-invalid` and `sequence-version-too-new`.
- **Step errors:**
  - `sequence-step-missing-request`
  - `sequence-step-unsupported` (a WebSocket or streaming gRPC request)
  - `sequence-transfer-missing`
  - `sequence-value-too-large`
  - `sequence-value-invalid`
  - `sequence-origin-from-response`
- **Assertion errors:** a regex timeout or an invalid pattern is an `errored` assertion with a message
  (`regex-timeout` / `regex-invalid` from `matchRegexWithTimeout`).
- **Desktop run error:** `sequence-already-running`.
- **Unchanged:** every existing send and prepare error (`unresolved-properties`, `secret-missing`, …) passes through
  as the step's error.

## Testing

- **Engine unit tests:**
  - **The sequence file:** schema round-trip, key order and determinism, every limit, `version` refusal, dangling
    steps, and slugging.
  - **Load, save and watch:** load, save and prune under `sequences/`; `isManagedPath`.
  - **A format-v5 fixture** with a `sequences/` folder, opened and saved with `formatVersion` unchanged and the
    folder untouched.
  - **Transfers:** each source (body in all three languages, header, status), optional, missing, overwrite, and
    default namespaces.
  - **The Sequence scope:** explicit only; never in shorthand; unresolved outside a run.
  - **Rule 1:** a value of `${secret:x}`, `${#System#HOME}` and `$${x}` is sent verbatim, directly and through a
    chained Env reference.
  - **Rule 2:** JSON, XML, SOAP envelope and form escaping of a hostile value, with the request's `escape` off.
  - **Rule 3:** a Sequence value in the host, port or scheme is refused for SOAP, REST and gRPC, and allowed in the
    path and query.
  - **Rules 4 and 5:** CR/LF/NUL in a header and in the URL; the 64 KiB cap.
  - **Rule 6:** a `secret` value and an echoed credential are masked and absent from `TransferResult.value`.
  - **Rule 8:** `(a+)+$` times out as `errored` without blocking the test's event loop, measured by a timer that must
    still fire.
  - **`runSequence` outcomes:** stop-on-failure, skipped steps, a disabled step, `requestAssertions: false`, and abort.
- **CLI tests:** `--sequence` selection and usage errors; reporters for a two-step run against the local mock server;
  exit codes; SIGINT.
- **Desktop main:**
  - the sequence runner against the mock server: History tags, progress events, cancel, one-run-per-sequence;
  - the mutations;
  - scopes reaching SOAP, REST and gRPC.
- **Renderer:** the explorer group and menus; the tab (add, reorder, disable step, transfer and assertion tables, the
  missing-request state); run-panel states; masked secret values.
- **e2e:** create a two-step REST sequence against the e2e mock (log in → use the token), run it, and see both steps
  pass and the token masked.

## Docs

- `docs-site/src/content/docs/guides/sequences.mdx` and a sidebar entry.
- `reference/project-format.md`: the `sequences/` folder and its file. The stale "currently version 3" line is
  corrected to 5 in the same edit.
- `docs/cli.md`: `--sequence`.
- `docs/security.md`: the new section.
- ADR-0003 update and the new ADR-0015.
- `docs/success-criteria.md`: rows SC-Q1 and on.
- `docs/roadmap.md` and `CHANGELOG.md`.

## Decisions for the owner

These are the calls this design makes that earlier specs marked ask-first:

1. **No `formatVersion` bump.** A per-file `version` is used instead, as argued under [Storage](#storage). The
   roadmap expected 3.0 to be a major release partly *because* Sequences are a new file kind. With this design
   they do not force one.
2. **The JSON report gains optional fields** without changing its `formatVersion`.
3. **Rule 3 refuses a response-chosen origin**, so following a cross-host redirect by transfer is not possible in v1.
4. **The Sequence scope is explicit only.** A request cannot pick up a sequence value through `${name}`, even when
   that would be convenient.
