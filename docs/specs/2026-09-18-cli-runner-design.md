# Spec: CLI runner — `wirebench run` with assertions, reports and exit codes

- Status: **approved** (owner, 2026-09-18)
- Date: 2026-09-18
- Issue: [#30](https://github.com/wirebench/wirebench/issues/30) (roadmap item 3, milestone 2.3)
- Builds on: `docs/adr/0001-electron-stack.md` (the engine stays Electron-free so the CLI can run on
  it unchanged), `docs/adr/0004-secrets-outside-project-files.md` (files hold refs, never values),
  `docs/security.md` (no secret is ever written to a file the product produces).
- Unblocks: #31 (CI recipes), #32 (MCP server, CLI parity), #36 (`--baseline`).

## Assumptions I'm making

1. **No CLI exists today.** No package has a `bin`. This spec adds a new workspace package,
   `packages/cli` (`@wirebench/cli`, binary `wirebench`), built with `tsc -b` like the engine.
2. **Assertions are declarative and live in the request file**, as an optional `assertions:` list in
   `<Name>.request.yaml`. No script, no separate run file, no new file kind. Sequences (item 12) and
   typed scripting (item 13) stay separate work.
3. **The two new fields bump the project `formatVersion` from 3 to 4.** The format does not
   round-trip unknown keys — they are ignored on load and never written back — so the standing
   policy is that any additive field bumps the version (`packages/engine/src/project/schema.ts`
   header, ADR-0003). Without the bump, an older desktop would delete a teammate's assertions on its
   next save. The consequence is a one-way door: a project saved by 2.3 no longer opens in 2.2, which
   refuses it with `format-too-new`. The 3 → 4 migration is a version stamp only; no data moves.
4. **The desktop does not edit assertions in this issue.** They are written by hand in YAML; the
   desktop only preserves them. An assertions editor is a follow-up issue.
5. **CI names its secrets like people do.** A ref in a file is opaque (`passwordRef: sec_…`), so the
   file gains an optional human name beside it and CI sets `WIREBENCH_SECRET_<NAME>`. The ref-named
   variable stays as the fallback, so an unedited project can still run.
6. **What is pure and self-contained moves into the engine; the desktop's send glue stays.**
   `secret-resolver.ts` and `redact.ts` import nothing from the desktop and move to
   `@wirebench/engine` unchanged; the desktop imports them from there. The send assembly itself is
   not movable as it stands: it lives in `ProjectHost` and `EngineService`, bound to editor drafts,
   wire types, the user's preferences and the secret store. It is, though, only glue over functions
   the engine already exports (`toSendInput`, `resolveEndpoint`, `resolveScopes`, `effectiveAuth`,
   `toRestSendInput`, `expandRestSendInput`, `resolveAuthChain`, `toTlsClientIdentity`). The engine
   gains `run/`, which composes those same functions for a *saved* request with no draft. The
   desktop adopting `run/` is a follow-up, not this issue.
7. **The CLI has no user preferences.** Preferences belong to a desktop user, not to a pipeline, so
   a run uses the engine's defaults plus the project's own settings. The proxy comes from the
   conventional `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` variables; extra trust anchors from
   Node's own `NODE_EXTRA_CA_CERTS`. A client certificate comes from the request's keystore, its
   password through §3.3.
8. **First scope: SOAP and REST.** gRPC unary is slice S7, last and cuttable. OAuth2 runs headless
   with the client-credentials grant only; a request that needs the authorization-code grant fails
   with a clear run error rather than opening a browser.
9. **The runner never writes to the project.** No history entry, no `.wirebench/local.yaml`, no
   migration written back. It reads a project and writes only the report files it was asked for.
10. **One project per invocation** (owner, 2026-09-18). A pipeline that covers several projects calls
   the runner once per project; a workspace-wide run is out of scope.
11. **Offline and account-free.** No login, no telemetry, no network call other than the requests
   being run.

## 1. Objective

Let a team run the requests they already saved in Wirebench from a pipeline, against a chosen
environment, and get a pass or a fail that a CI system understands.

**Users:** the engineer who wires a smoke test into a pipeline, and the enterprise evaluator ticking
"runs in CI".

**Success looks like:** a repository holding a Wirebench project gains one pipeline step —

```bash
wirebench run ./project --env staging --reporter junit=reports/wirebench.xml
```

— with `WIREBENCH_SECRET_BILLING_PASSWORD` set from the CI secret store. The step goes red when the
service returns a SOAP fault, a wrong status, a body that breaks the schema, or an answer slower
than the SLA; the JUnit report names the request and the assertion that failed; the exit code tells
a broken service (1) from a broken pipeline (2, 3); and no report contains the password.

## 2. Concepts

- **Run.** One invocation: a set of selected requests, sent one after another against one
  environment.
- **Assertion.** One declarative check on one response. Evaluated after the send; every assertion of
  a request is evaluated, even after one fails, so a report shows all that is wrong.
- **Outcome of a request.** `passed` (sent, all assertions hold), `failed` (sent, an assertion does
  not hold), `errored` (could not be sent or evaluated: unresolved `${…}`, missing secret, network
  failure, malformed expression), `skipped` (after `--bail`).
- **A request with no assertions** passes when it was sent and an answer came back — any status. It
  is reported with a note, and `--require-assertions` turns it into an error for teams that want
  that strictness.

## 3. Functional scope

### 3.1 Command line

```text
wirebench run <path> [selector…] [options]

<path>                 One project directory (wirebench.yaml). A workspace directory is exit 2, with a
                       message listing its projects. When the project sits inside a workspace, the
                       workspace's environments and properties still apply (found by walking up to
                       workspace.yaml).
[selector…]            Paths below <path>: a request file, an operation, an interface, an API.
                       None = every request in the project.

-e, --env <name>       Environment by name or slug. Required when the target defines any.
    --var <k=v>        Override an environment property for this run. Repeatable.
    --reporter <spec>  cli | junit=<file> | json=<file> | html=<file>. Repeatable. Default: cli.
    --bail             Stop at the first failed or errored request; the rest are skipped.
    --timeout <ms>     Per-request timeout override.
    --sla <ms>         Default response-time ceiling for requests that declare none.
    --require-assertions  A request without assertions is an error.
    --insecure         Skip TLS verification (as the desktop's per-environment switch).
    --no-color
-q, --quiet | -v, --verbose

wirebench secrets list <path> [selector…] [-e <name>]
                       Prints every secret the selection needs: variable name, where it is used,
                       whether it is set. Exit 0 when all are set, 3 when one is missing. Never
                       prints a value.

wirebench --version | --help
```

Order of execution is the project's own order (`order` field, then name), so a run is
deterministic. Requests run sequentially; parallelism is out of scope.

### 3.2 Assertions

In `<Name>.request.yaml`:

```yaml
assertions:
  - type: status
    equals: [200, 201]            # a number, a list, or a class: "2xx"
  - type: soap-fault
    expect: none                  # none (default) | present
  - type: match
    language: xpath               # xpath | xquery | jsonpath
    expression: count(//m:Country) > 0
    namespaces: { m: 'http://example.org/countries' }
    equals: true                  # exactly one of: equals | matches (regex) | exists (boolean)
    name: at least one country    # optional label used in reports
  - type: schema                  # response validates against the contract (XSD; SOAP structure first)
  - type: sla
    maxMs: 800                    # compared with the exchange's durationMs
```

| Type | Holds when | Engine surface |
| --- | --- | --- |
| `status` | the HTTP status is in the set | `HttpExchange.status` |
| `soap-fault` | a fault is absent (or present, when asked) | `isSoapFault` / `parseFault` |
| `match` | the expression's result equals, matches or exists | `evaluateWithTimeout` (XPath 3.1, XQuery 3.1, JSONPath) |
| `schema` | `validateMessage` reports no problem against the interface's cached definition | `validateMessage` |
| `sla` | `durationMs <= maxMs` — every leg of the send, an auth challenge included | `SoapExchange.durationMs`, `RestExchange.durationMs` |

Rules: `soap-fault` and an XSD `schema` on a REST request are load errors, not silent passes.
`schema` for REST is out of scope until #45 (OpenAPI response validation) lands; the type is
reserved. `match` results are compared as strings unless `equals` is a boolean or a number. A failed
assertion reports expected, actual (truncated to 200 characters, redacted) and the label.

The Zod schema for the list lives with the rest of the project schema
(`packages/engine/src/project/schema.ts`); the evaluator is a new engine module,
`packages/engine/src/assert/`, so the MCP server (#32) and Sequences (#62) reuse it.

### 3.3 Secrets

A ref may carry a name; the name is not a secret and is committed:

```yaml
auth:
  type: basic
  username: svc-billing
  passwordRef: sec_01J8…
  passwordEnv: BILLING_PASSWORD      # optional; [A-Z0-9_]+
```

The same `…Env` sibling exists for `tokenRef`, `valueRef`, `clientSecretRef` and keystore passwords.
Resolution for a ref, in order: `WIREBENCH_SECRET_<NAME>` when a name is declared, then
`WIREBENCH_SECRET_<REF>` (ref upper-cased). Neither set → the request is `errored` with
`secret-missing`, naming the variable to set. The CLI never reads the desktop's `secrets.json` and
never touches a keychain.

Every value resolved from the environment is registered with the redactor and masked wherever it
appears — headers, URL, bodies, assertion "actual" text — in every reporter, the `cli` one included.

### 3.4 Reports

- **cli** — one line per request (outcome, status, time), failures expanded below, a summary line.
  Goes to stdout; diagnostics go to stderr.
- **junit** — one `<testsuite>` per operation or API folder, one `<testcase>` per request
  (`classname` = its path, `time` = seconds), one `<failure>` per failed assertion, `<error>` for an
  errored request, `<skipped/>` after a bail. Validates against the common JUnit XSD CI systems use.
- **json** — the full run: `{ formatVersion: 1, tool, startedAt, environment, summary, requests[] }`
  with each request's outcome, timings, status and assertion results. The stable machine interface;
  `formatVersion` governs it.
- **html** — one self-contained file (inline CSS, no script, no network fetch) with the summary and
  an expandable entry per request. Redacted request and response are included for failed and
  errored requests only.

A report file is written even when the run fails; its directory is created when missing. A report
that cannot be written is exit 2.

### 3.5 Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every selected request passed. |
| 1 | At least one assertion failed; nothing errored. |
| 2 | Usage or load problem: bad flag, path is no project, unknown environment or selector, invalid `assertions:`, project format too new, report not writable. Nothing was sent. |
| 3 | At least one request errored: unresolved `${…}`, missing secret, network or TLS failure, unsupported auth grant, expression that does not compile. Takes precedence over 1. |
| 130 | Interrupted (SIGINT); reports are flushed with what ran. |

Every error carries the engine's stable `WirebenchError.code`, printed to stderr and present in the
JSON report, so a pipeline can branch on it.

## 4. Data model and project format

- `RequestFile` gains `assertions?: readonly Assertion[]` (discriminated union on `type`).
- Auth and keystore shapes gain the optional `…Env` name beside each `…Ref`.
- `FORMAT_VERSION` goes 3 → 4 (assumption 3): `migrate.ts` gains the 3 → 4 step, `serialize.ts`
  writes both fields, and the format-v2 fixture set gains a v3 sibling so the migration is tested.
  The desktop writes version 4 only when it saves, as today; the CLI never writes (assumption 9), so
  it runs a version 3 project as it is, migrated in memory.
- `WORKSPACE_FORMAT_VERSION` is untouched; nothing here changes a workspace file.
- The project-format page under `docs/architecture/` and the CHANGELOG document the bump.
- The JSON report has its own `formatVersion`, starting at 1.

## 5. Engine (`packages/engine/src/`)

| Module | Change |
| --- | --- |
| `assert/` | New. `evaluateAssertions(exchange, assertions, context): Promise<AssertionResult[]>`; one file per type; no I/O beyond what `validateMessage` already does. |
| `run/` | New. `selectRequests(project, selectors)`, `prepareSoapSend` / `prepareRestSend` — a saved request composed into a send input from the engine's existing functions, secrets through the injected `getSecret` — and `runRequests(plan, hooks)`, which yields one result per request. Host-agnostic: the desktop can adopt it later for a "run folder" action. |
| `secrets/` | Secret resolution moved from the desktop's `secret-resolver.ts`, unchanged in behaviour; `getSecret` stays the injected seam. |
| `redact/` | Moved from the desktop's `redact.ts`; gains `withSecrets(values)` for literal masking. |
| `project/schema.ts`, `project/model.ts` | The two format additions of §4. |

The desktop's two files become one-line re-exports, so its diff is a pure relocation and every
importer keeps working; their tests move to the engine with the code.

## 6. CLI package (`packages/cli/`)

```text
packages/cli/
  package.json          name @wirebench/cli, bin { wirebench: ./dist/bin.js }, type module
  src/bin.ts            shebang, top-level error → exit code
  src/args.ts           node:util parseArgs; no argument-parsing dependency
  src/commands/run.ts
  src/commands/secrets-list.ts
  src/env-secrets.ts    getSecret over process.env
  src/reporters/        cli, junit, json, html
  src/exit-codes.ts
  test/unit/            vitest project cli-unit
  test/integration/     vitest project cli-integration (local HTTP server, spawns the built bin)
```

Dependencies: `@wirebench/engine` only. Reporters write XML and HTML by hand with an escaping
helper; no templating or XML library is added. Publishing to a registry and the container image
belong to #31.

## 7. Commands

```bash
pnpm --filter @wirebench/cli build            # tsc -b
pnpm --filter @wirebench/cli exec wirebench run <project> --env local
pnpm vitest run --project cli-unit --project cli-integration
WIREBENCH_SKIP_PERF=1 pnpm check              # before every commit
pnpm test:perf                                # before a push
```

## 8. Code style

As the engine: ESM, `NodeNext`, `strict` with `exactOptionalPropertyTypes`, `interface` with
`readonly` fields, discriminated unions, no `any`, JSDoc that says why, typed errors with a stable
code.

```ts
/** What one assertion found. `actual` is already redacted and truncated — safe for any reporter. */
export interface AssertionResult {
  readonly type: Assertion['type'];
  readonly label: string;
  readonly outcome: 'passed' | 'failed';
  readonly expected?: string;
  readonly actual?: string;
}

/**
 * Maps a finished run to the process exit code. An errored request outranks a failed assertion:
 * a pipeline that could not reach the service has learned nothing about the service.
 */
export function exitCodeFor(summary: RunSummary): ExitCode {
  if (summary.errored > 0) {
    return ExitCode.RunError;
  }
  return summary.failed > 0 ? ExitCode.AssertionFailed : ExitCode.Ok;
}
```

## 9. Slices, in order

Each is shippable alone and is one or more commits with `pnpm check` green.

| # | Slice | Done when |
| --- | --- | --- |
| S1 | Move secret resolution and redaction into the engine | Desktop behaviour and tests unchanged; nothing in `packages/engine/src` imports Electron. |
| S2 | Format version 4 and the `assert/` evaluator | A version 3 project migrates; `assertions:` and `…Env` survive load → save; each assertion type has passing and failing unit tests. |
| S3 | Engine `run/` and the `packages/cli` skeleton: `run` for SOAP and REST, `cli` reporter, exit codes | A fixture project runs green and red against a local server with the right codes. |
| S4 | Env-var secrets, `secrets list`, literal redaction | A run with the variable set authenticates; without it, exit 3 naming the variable; the value appears in no output. |
| S5 | `junit` and `json` reporters | JUnit validates against the XSD; JSON matches its documented shape. |
| S6 | `html` reporter | One offline file; passes the contrast check. |
| S7 | gRPC unary; OAuth2 client credentials | `status` (gRPC code), `match` (JSONPath) and `sla` work on a unary call; a client-credentials token is fetched and cached for the run. |

Docs — README section, `docs/architecture/`, CHANGELOG — land with the slice that makes them true.

## 10. Testing

- **Unit (engine):** every assertion type, both outcomes and the malformed case; `…Env` resolution
  order; literal redaction; selection order.
- **Unit (cli):** argument parsing, exit-code mapping, each reporter against a fixed `RunResult`
  (snapshot for JUnit, JSON and HTML).
- **Integration (cli):** spawn the built binary against a fixture project and a local HTTP server
  that can answer 200, 500, a SOAP fault, a schema-breaking body and a slow response. Assert exit
  code, stdout and report files. A secret-leak test greps every output for the variable's value.
- **Compatibility:** a version 3 fixture migrates to 4 unchanged in content; a version 4 project
  with `assertions:` and `…Env` loads, saves, and both are still there; a version 5 stamp is
  refused with `format-too-new`.
- No network in the default test run; no Electron window (owner's standing rule).

## 11. Boundaries

- **Always:** one commit per slice task after `WIREBENCH_SKIP_PERF=1 pnpm check`; redact before
  anything reaches a reporter; go through `loadProject` / `loadWorkspace`, never raw YAML; keep
  `packages/engine` free of Electron; keep the CLI's only runtime dependency the engine.
- **Ask first:** any format change beyond the two fields of §4; adding any dependency; changing a desktop behaviour while
  relocating code; changing the JSON report shape after S5; touching CI workflows.
- **Never:** write into the project or workspace; read `secrets.json` or a keychain; print or
  report a secret value; name in docs or code the products that inspired a feature; add telemetry
  or a login.

## 12. Out of scope

CI recipes and the container image (#31); `--baseline` (#36); MCP (#32); Sequences and property
transfer (#62); scripts (#63); data-driven runs (#73); an assertions editor in the desktop;
parallel execution; running a whole workspace in one invocation; OpenAPI response validation (#45); OAuth2 authorization-code in the CLI;
external secret managers (#37).

## 13. Success criteria

1. `wirebench run <project> --env <name>` sends every saved SOAP and REST request in project order
   and exits 0 when all pass.
2. Each of the five assertion types fails a run (exit 1) on a response built to break it, and the
   report names the request, the assertion and expected against actual.
3. An unknown environment, an invalid `assertions:` entry and a too-new format each exit 2 before
   anything is sent.
4. A missing secret, an unresolved `${…}` and an unreachable host each exit 3, with the engine
   error code on stderr.
5. `--reporter junit=… --reporter json=… --reporter html=…` writes all three in one run; the JUnit
   file validates against the XSD.
6. With `WIREBENCH_SECRET_<NAME>` set, an authenticated request succeeds on a machine with no
   keychain; the value appears in no stdout, stderr or report file.
7. `wirebench secrets list` names every variable the selection needs and exits 3 when one is unset.
8. After a run, `git status` in the project is clean apart from the requested report files.
9. The desktop opens a version 3 project, and re-saves a version 4 request with `assertions:` and
   `…Env` without losing them; its existing test suite passes unchanged after S1.
10. `pnpm check` and `pnpm test:perf` are green.

## Decisions

Settled with the owner on 2026-09-18:

1. **The format bump is taken.** Project `formatVersion` goes 3 → 4; a sidecar assertions file was
   rejected because it doubles the files per request and gives a desktop editor nothing to build on.
2. **Distribution belongs to #31.** This issue builds the binary inside the monorepo and publishes
   nothing.
3. **gRPC stays in this issue as S7**, the last slice, and is the first thing cut if time runs out.
4. **One project per invocation** (assumption 10).
