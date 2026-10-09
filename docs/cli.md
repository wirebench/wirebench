# CLI reference: `wirebench`

`@wirebench/cli` runs the requests already saved in a Wirebench project from a terminal or a
pipeline, and turns the result into an exit code and a report a CI system understands. It ships
alongside the desktop app in this monorepo; see [Run in CI](../README.md#run-in-ci) in the README
for the one-line pipeline step.

This page documents S1–S7: SOAP, REST, gRPC and WebSocket requests, all four assertion types that apply
to them, all four reporters, environment-variable secrets and OAuth2 client credentials — see the
[design spec](specs/2026-09-18-cli-runner-design.md) and, for S7,
[its own spec](specs/2026-09-22-cli-runner-design.md).

`wirebench run` and `wirebench secrets list` run a project in a pipeline. The verbs under
[Work with a project](#work-with-a-project) and [`wirebench mcp`](#wirebench-mcp) (issue #32, see the
[design spec](specs/2026-09-29-wirebench-mcp-server-design.md)) work on one project from a terminal or
an agent: import a definition, list and generate, send one request, validate, query and diff.

## Install and build

Inside this monorepo:

```bash
pnpm --filter @wirebench/engine build
pnpm --filter @wirebench/cli build
node packages/cli/dist/bin.js --help
```

Publishing a standalone package to a registry is out of scope for this issue (`#31`).

## Usage

```text
wirebench run <path> [selector…] [options]

<path>                 One project directory (wirebench.yaml). A workspace directory is exit 2, with a
                       message listing its projects. When the project sits inside a workspace, the
                       workspace's environments and properties still apply (found by walking up to
                       workspace.yaml).
[selector…]            Paths below <path>: a request file, an operation, an interface, an API.
                       None = every request in the project.
    --sequence <name>  Run a sequence (by name, or sequences/<slug>.sequence.yaml) instead of
                       requests: its steps in order, with their transfers and assertions.
                       Repeatable; cannot be combined with selectors.

-e, --env <name>       Environment by name, slug or id. Required when the target defines any.
    --var <k=v>        Override an environment property for this run. Repeatable.
    --reporter <spec>  cli | junit=<file> | json=<file> | html=<file>. Repeatable. Default: cli.
    --bail             Stop at the first failed or errored request; the rest are skipped.
    --timeout <ms>     Per-request timeout override.
    --sla <ms>         Default response-time ceiling for requests that declare none.
    --require-assertions  A request without assertions is an error.
    --baseline         Compare each response with its committed golden (<slug>.golden.yaml).
    --require-baseline With --baseline: a request without a golden is an error.
    --update-baseline  Save each changed response as its golden, keeping its ignore rules.
                       The only flag that writes to the project.
    --insecure         Skip TLS verification (as the desktop's per-environment switch).
    --no-secret-sources   Read secrets from WIREBENCH_SECRET_<NAME> only; skip the workspace's
                          secret sources.
    --trust-secret-sources
                          Use the workspace's shared secret sources as they are.
    --trust-secret-sources-hash <hash>
                          Use them only if the mapping's hash is <hash> (secrets list prints it).
    --no-color
-q, --quiet | -v, --verbose

wirebench secrets list <path> [selector… | --sequence <name>…] [-e <name>] [--var <k=v>…]
                       Prints every secret the selection needs: variable name, where it is used,
                       whether it is set. Exit 0 when all are set, 3 when one is missing. Never
                       prints a value. --var as for run, so a token only a --var holds is listed.
                       Also shows where each secret comes from, and prints the
                       secret-sources hash.

wirebench import <source> [--name <name>]
wirebench operations [<interface-or-api>]
wirebench generate <operation> [--optional all|required]
wirebench send <item> [-e <env>] [--body <text> | --body-file <file>] [--baseline]
wirebench call <operation> [--args <json|@file>] [-e <env>] [--schema]
wirebench validate <history-id|file> [--operation <ref>] [--direction request|response] [--status <n>]
wirebench query <expression> <history-id|file> [--namespace <prefix>=<uri>]… [--direction request|response]
wirebench history list [--item <text>] [--limit <n>]
wirebench history diff <from-id> <to-id> [--ignore <path>]…
                       Work on one project: see "Work with a project" below. Each takes --project <dir>
                       (default: the current directory) and --json; the ones that touch History take
                       --history-dir <dir>.

wirebench diff-contract <old> <new> [--fail-on breaking|any|none] [--reporter <kind>=<file>]… [--project <dir>] [-q]
                       Compares two versions of a WSDL or an OpenAPI document: see "Contract diff" below.

wirebench export <postman|opencollection> [--api <name|slug|id>] [--out <dir>] [--project <dir>] [--json]
                       Writes the project, or one API or interface, as a Postman Collection v2.1 or an
                       OpenCollection document: see "Export to another tool" below.

wirebench mcp [--project <dir>] [--allow-write] [--allow-send] [-e <a,b>] [--history-dir <dir>] [--http <port>] [--tools <name,…|none>]
                       Serves those verbs as MCP tools to a coding agent, over stdio or on 127.0.0.1.

wirebench mock <path> [mock…] [--port <n>] [--host <addr>] [--json] [-q]
                       Serves the project's mocks until stopped: see "wirebench mock" below.

wirebench mock check <path> [mock…] [--json]
                       Checks the mocks' stubs against the contract: see "wirebench mock check" below.

wirebench mock record <path> <mock> --target <url>
                       Records a mock's stubs from live traffic: see "wirebench mock record" below.

wirebench --version | --help
```

Requests run one after another, in the project's own order (`order`, then name) — deterministic,
and `--bail` stops after exactly the requests that would otherwise have run before the failure.
Parallelism is out of scope.

## Environments and properties

A `${…}` reference in a request resolves the way it does in the desktop app, against the scopes a
run supplies:

- **Environment** — the properties of the environment `--env` names, `${#Env#name}`. Each
  `--var k=v` is laid over them, so a `--var` always wins.
- **Project** — `wirebench.yaml`'s `properties`, `${#Project#name}`.
- **System** — the process environment, `${#System#name}`.

The `${name}` shorthand looks in the environment first, then the project, then the workspace.

There are no global properties: what the app reads from its user's preferences has no counterpart
in a pipeline.

**Inside a workspace.** When the project directory sits inside a workspace — the nearest
`workspace.yaml` above it lists the project, as an internal project under its `projects/` or a
linked one by path — the run resolves as the app does with that workspace open:

- the workspace's `properties` are the `${#Workspace#name}` scope;
- `--env` names a **workspace** environment (by name, slug or id), and the project's own
  environments are no longer offered on their own. The environment scope is that workspace
  environment's properties, with the project environment of the same slug, if there is one, laid
  over them (the project's value wins on a shared key) and `--var` over both;
- an endpoint or base URL comes from that linked project environment's override first, then the
  workspace environment's `<projectSlug>/<interfaceSlug>` override, then the request's, interface's
  or API's own.

A `workspace.yaml` that does not list the project, or that is not a workspace at all, is reported
with a warning and not applied.
`secrets list` reads the same scopes, so a `${secret:name}` token a workspace property holds is
listed too.

## Assertions

Declared per request, in `<Name>.request.yaml`, under `assertions:`:

```yaml
assertions:
  - type: status
    equals: [200, 201] # a number, a list, or a class: "2xx"
  - type: soap-fault
    expect: none # none (default) | present
  - type: match
    language: xpath # xpath | xquery | jsonpath
    expression: count(//m:Country) > 0
    namespaces: { m: 'http://example.org/countries' }
    equals: true # exactly one of: equals | matches (regex) | exists (boolean)
    name: at least one country # optional label used in reports
  - type: schema # response validates against the contract (XSD; SOAP structure first)
  - type: sla
    maxMs: 800 # compared with the exchange's durationMs
```

| Type | Holds when |
| --- | --- |
| `status` | the HTTP status is in the set — for a gRPC request, the gRPC status code (`0`–`16`, or its name: `OK`, `NOT_FOUND`, …) |
| `soap-fault` | a fault is absent (or present, when `expect: present`) |
| `match` | the XPath/XQuery/JSONPath expression's result equals, matches or exists |
| `schema` | the response validates against the interface's cached contract |
| `sla` | the exchange's `durationMs` is at or under `maxMs` — every leg of the send, an auth challenge included |

`soap-fault` and `schema` apply to SOAP requests only. On any other request they are errored
assertions, never silent passes: the request counts as errored and the run exits 3. A REST response is
checked against its OpenAPI schema with `wirebench validate`, not with a `schema` assertion.
A `match` result is compared as a string unless `equals` is a boolean or a number.

### gRPC requests

gRPC requests run like the others, in the same project order. A client- or bidirectional-streaming
request sends its saved `message` array in order and then half-closes. What `match` reads is the one
message of a unary or client-streaming call, and for a server-streaming or bidirectional call every
message in order as a JSON array (one that did not decode is `null`). The run's timeout bounds a stream, and a stream it cuts
fails with `timeout`. A request whose method is gone from the API's definition is skipped. The schema comes from the API's
**cached** definition (`apis/<slug>/definition/`, written when the desktop imports a `.proto` set
with caching on) — the runner never reads the original `.proto` folder nor asks the server for
reflection. An API without a cache errors each of its requests with `grpc-definition-missing`
(exit 3) and sends nothing. `status`, `match` (JSONPath over the response message, or the array of messages, as JSON)
and `sla` apply; `--timeout` replaces the request's own deadline.

```yaml
assertions:
  - type: status
    equals: OK # or 0
  - type: match
    language: jsonpath
    expression: $.message
    equals: Hello, Ada
```

A request with no `assertions:` passes on any response that came back; it is reported with a note.
`--require-assertions` turns that case into an error instead, for teams that want every request
covered.

Every assertion of a request is evaluated even after one fails, so the report shows everything
wrong with that response, not just the first.

### WebSocket requests and event streams

A saved WebSocket request runs as `send` runs it: the socket opens, the saved messages go out in order, and the
session closes after the reply that follows the last one, or when the request's timeout
passes. A session that gets no reply by then fails with `timeout`; a server that refuses the handshake or
cannot be reached fails with `ws-handshake-refused`. The texts received, in order, are a JSON array that `match`
reads.

A saved WebSocket request may carry `assertions:` like any other. They are checked against the
handshake status (`101`) and the messages the server sent, in order, as a JSON array: a message
that is JSON is its value, so `$[0].type` reads a field of the first one, and any other message
is its text. One without assertions passes with a note, and `--require-assertions` errors it.

A REST response of type `text/event-stream` is read until the stream ends or the timeout passes; a stream the
timeout cuts fails with `timeout`. In a run, in `send` and in a sequence step the response an assertion or a
transfer reads is a JSON array of each event's `data`, not the raw stream text: write `contains: "ok"` or a
`match` on `$[0]`, not `contains: "data: ok"`.

The error codes a send can end with, besides the HTTP layer's (`timeout`, `aborted`, `network`):
`rest-unresolved-properties`, `unresolved-properties` (SOAP), `grpc-unresolved-properties` and
`ws-unresolved-properties`, a `${…}` reference nothing resolves, refused before anything is sent;
`grpc-method-unset`, a gRPC request with no method; `secret-missing`, a credential secret that is not set;
`ws-handshake-refused`; `grpc-definition-missing`; and `exchange-not-streaming`, a message pushed to a send that
takes none (only a host that drives a send by hand can cause it; a run never does).

## Sequences

`--sequence <name>` runs a sequence instead of a selection of requests: its steps in order, each step's
transfers lifting values out of its response for the steps after it (`${#Sequence#name}`), and each step's
assertions after its request's own. The file format and the rules are in
[the Sequences design](specs/2026-09-28-sequences-design.md).

```text
wirebench run ./shop -e staging --sequence checkout --reporter junit=reports/checkout.xml
```

- A sequence is named by its name or by its file, `sequences/<slug>.sequence.yaml`. Repeat the flag to run
  several, in the order given. It cannot be combined with request selectors (exit 2).
- Every step is checked before anything is sent: a step whose request is gone, or is orphaned, refuses the run
  with exit 2, naming the step. A WebSocket request and a streaming gRPC call can be steps; they run as in a
  plain run, bounded by the step's timeout.
- Within a sequence, a failed or errored step skips the rest unless the sequence sets `stopOnFailure: false`.
  `--bail` skips the *sequences* after the first that fails.
- `--timeout`, `--sla` and `--require-assertions` apply to each step as they do to a request; a sequence's own
  `stepTimeoutMs` wins over `--timeout`.
- A step errors, before it is sent, when a response value would choose the scheme, host or port of its URL
  (`sequence-origin-from-response`) or put a line break into a header or URL (`sequence-value-invalid`).
- A transfer marked `secret: true`, or one whose value contains a secret the run already resolved, is masked in
  every report from the moment it is lifted, and no report carries its value at all.
- Each `wirebench run` keeps one cookie jar in memory, shared by every request, sequence step and iteration of
  the run; `wirebench call` keeps one per call, and `wirebench mcp` one for the server's lifetime. A REST request
  with `sendCookies: true` sends the cookies earlier responses in that run set. Nothing is written to disk. A
  `cookie` transfer (`Cookie: sid=${#Sequence#sid}`) still works, and is how a cookie reaches a non-REST step.

Each step is reported as a request of the run: grouped by its sequence (one JUnit test suite per sequence),
named `<sequence>/<n>. <step>`.

## Scripts

A saved SOAP, REST or gRPC request may carry a pre-request and a post-response script, in TypeScript files
beside it (`<request>.pre.ts`, `<request>.post.ts`). `wirebench run` runs them on every send, with and without
`--sequence`. What a script can do, and cannot, is in [the typed scripting design](specs/2026-09-28-typed-scripting-design.md).

- Every script of the selection is type-checked against its request's contract before anything is sent. A type error
  exits 2, naming the file, line and column on stderr. So does a script file that is missing.
- A pre-request script that throws, times out or changes where the request goes stops that request before it is sent
  (errored). A post-response script that throws keeps the response and errors the request.
- A post-response script's tests are reported as assertions of type `script`. A request whose only checks are
  script tests counts as asserted under `--require-assertions`.
- Values a script sets with `vars.set` are read by the requests after it as `${#Sequence#name}`. In a plain run they
  last for the run, in selection order, and in a sequence they join the sequence's values.
- A value set with `{ secret: true }`, or one that holds a secret the run resolved, is masked in every report. A
  secret a script reads with `secrets.get` must be listed in the request's `scripts.secrets`. It is read from
  `WIREBENCH_SECRET_<NAME>` like any other, and masked the same way.
- A script's log is printed with `-v`, and always for a request that did not pass. The `json` report carries it as
  `scriptLog`, and the `html` report shows it. It is masked like everything else.
- A request whose scripts are switched off (`scripts.enabled: false`, which is how scripts imported from a
  collection arrive) is sent without them, and is marked `(scripts off)`.

## Secrets

A ref in a saved request may carry a friendlier, committable name beside it:

```yaml
auth:
  type: basic
  username: svc-billing
  passwordRef: sec_01J8…
  passwordEnv: BILLING_PASSWORD # optional; [A-Z0-9_]+
```

The same `…Env` sibling exists for `tokenRef`, `valueRef` and `clientSecretRef`, and for a
keystore's password in the WSS keystore registry. **WS-Security passwords have no `…Env` name in
this release** — a username-token password, a signing-key password and a WS-Security keystore
password are supplied only through the ref-derived variable below; `wirebench secrets list` prints
that variable name for each of them. The same holds for the secrets of a SAML or issued-token
entry: the STS password, the STS client certificate's key password and its keystore's password,
the SAML issuer key password and its keystore's password, and the passwords of the proof and TLS
keystores an entry names.

Resolution for a ref, in order:

1. `WIREBENCH_SECRET_<NAME>` when the file declares a name (`passwordEnv`, `tokenEnv`, …).
2. `WIREBENCH_SECRET_<REF>` — the ref itself, upper-cased and with anything but `[A-Z0-9_]`
   turned into `_`.

Neither variable set → the request is `errored` with `secret-missing`, naming the variable to set.

A request that authenticates with Kerberos uses the runner's own ticket cache (`kinit` on the
runner, or the signed-in Windows account). `passwordEnv` applies to Kerberos only alongside a
`username`, which is Windows-only. A request whose Kerberos cannot start (no binding, no ticket, an
explicit account off Windows) is `errored` with its `kerberos-…` code, exit 3, and the run goes on.

The CLI never reads the desktop's `secrets.json` and never touches a keychain — a pipeline has no
user, so it has no keychain to read.

A webhook item that signs what it sends (see the
[Webhook signatures guide](https://wirebench.github.io/wirebench/docs/guides/webhook-signatures/)) reads its
signing secret from `WIREBENCH_SECRET_<secretEnv>`, the CI name saved on the item, folder or collection
(with no CI name, from the ref-derived variable above). Missing, the item fails and the message names
the variable; it is never sent unsigned. `wirebench secrets list` lists it like any other secret.

```bash
$ wirebench secrets list ./project --env local
VARIABLE                        STATE    PURPOSE                   USED BY
WIREBENCH_SECRET_DEMO_PASSWORD  missing  basic password for "svc"  demo/secure
```

Exit 0 when every variable a run of the selection would need is set, exit 3 when at least one is
missing.

With a workspace that maps a secret to a manager, `secrets list` adds a `SOURCE` column and a hash
line. `SOURCE` is `env` when the variable is set (it always wins), the mapping's kind (`vault`, `aws`,
…) when a source would supply the value, `kind (untrusted)` when the run would refuse the mapping
until it is trusted, `invalid` for an entry that does not parse, and `—` when nothing supplies it. A
name only a source supplies has the state `mapped`, and still counts as supplied for the exit code,
because the run itself refuses an untrusted mapping and prints the hash. The line
`Secret sources hash: <hash>` is the value `--trust-secret-sources-hash` takes. No value is ever
printed.

`secrets list` is conservative: it lists every secret the selected requests' configuration names,
without sending anything, so it cannot know which ones a particular run will actually ask for. A
WS-Security incoming configuration's decryption-key password, for example, is only needed when a
response arrives encrypted. So `secrets list` can exit 3 for a selection that `run` passes; treat
its list as what a run *may* need. Pass it the same `--var` flags as the run: a `${secret:name}`
token that only a `--var` property holds is listed only then.

### OAuth2 client credentials

A request, folder or API whose auth is OAuth2 with the **client-credentials** grant gets its token
at run time: the runner posts to the token URL (property expansion applies to it, the client ID, the
scopes and the audience) with the client secret from `clientSecretEnv` / `clientSecretRef` as above,
and sends the token as a Bearer — REST, SOAP, gRPC and WebSocket alike. One token is fetched per
configuration per run and reused until it is due for refresh; a failed fetch is not cached. When a
server refuses the token — an HTTP `401` (REST, SOAP, or a WebSocket upgrade), or a gRPC
`UNAUTHENTICATED` (16) — the run drops it, and the next request behind the same configuration fetches
a new one. A connection that gets no answer, or a `403`, keeps the token. The refused request is
reported as it came back and is **not** sent again: it may already have had an effect. The one
exception is a WebSocket upgrade refused with `401`: the underlying HTTP client re-sends it once, so
the server may see it twice with the same token. The token request honours
`--timeout`, `--insecure` and the proxy variables. The access token is masked in every report and in
stdout/stderr exactly like a secret from the environment. The **authorization-code** grant needs a
browser and a person, so a request that uses it is errored with `auth-grant-unsupported`.

### Masking has a floor

Every value resolved from the environment is registered with the redactor and masked wherever it
could appear — headers, URL, bodies, an assertion's `actual` text — in every reporter, the `cli`
one included. The value is also masked in each form the wire gives it: percent-encoded, form-encoded
(`+` for a space), with XML entities (`&amp;`, `&lt;`, …) and JSON string escapes (`\"`, `\\`),
and inside a `Basic` credential. **A resolved value shorter than 4 characters is not masked by this literal
replacement**: a value that short is too likely to occur by chance in ordinary text (a status code,
a short id), and masking it would shred unrelated output rather than protect anything. Pattern-based
redaction is unaffected by this floor — `Authorization`/`Proxy-Authorization` headers,
`wsse:Password` elements and the JSON/form secret-key list are always redacted regardless of the
underlying value's length. In practice: choose real secret values, not four-character test
placeholders, if you want the literal-masking guarantee to apply to them.

## Callback assertions

A `callback` assertion (see the
[Callback assertions guide](https://wirebench.github.io/wirebench/docs/guides/callback-assertions/)) waits
for a webhook at a catch URL of a Wirebench Server workspace, so `wirebench run` needs to reach that
server:

- `WIREBENCH_SERVER_URL` is the server's address and `WIREBENCH_SERVER_TOKEN` a CI token of the
  workspace. Both must be set; a blank value counts as unset. The token is never printed, and never
  written to a report or an error.
- Use an `https://` address outside a local network: over `http://` the token crosses the network in
  clear.
- Either unset, the request is still sent and each callback assertion is `errored` with `set
  WIREBENCH_SERVER_URL and WIREBENCH_SERVER_TOKEN to check callbacks`. The rest of the run proceeds.
- On a terminal only, the `cli` reporter prints a line while an item waits, for example
  `… demo/pay  waiting for callback orders-hook… (up to 30 s)`. It is not printed to a pipe or with
  `--quiet`.
- The `json` reporter gives an assertion that matched a `capture` field, `{ "hookId", "captureId" }`,
  beside `type`, `label`, `outcome` and `message`. Without a match the field is absent.
- `junit` writes a callback that could not be checked as an `<error>` and one that failed as a
  `<failure>`.
- Exit code 1 when a callback assertion failed; 3 when one could not be checked (no server variables,
  an unknown catch URL name, a refused token or an unreachable server). Exit 3 takes precedence.

## Baseline

`--baseline` compares each SOAP and REST response with the golden saved beside the request
(`<slug>.golden.yaml`, written by the desktop's Snapshot tab), by meaning and with the golden's
ignore rules. A difference fails the request (exit 1). A golden that cannot be read, or is too large
(over 2 MiB) to compare, is an error (exit 3). A request without a golden is noted and judged on its
other assertions; `--require-baseline` makes that an error too (exit 3). Other protocols are not
compared, and sequences are not compared.

`--require-baseline` without `--baseline`, and `--baseline` with `--sequence`, are usage errors
(exit 2).

### Updating goldens

`--update-baseline` saves each SOAP and REST response as its request's golden instead of comparing
it: a golden that differs is replaced, keeping its ignore rules; a missing one is created; one that
still matches is left as it is. It is the only flag that writes to the project, and it writes
nothing but `<slug>.golden.yaml` files. Review the result with `git diff -- '*.golden.yaml'` before
committing.

A request whose own assertions fail is not written, and fails the run (exit 1). A body with no text
form (binary) is not written either; the request's outcome is unchanged. A refusal errors the
request (exit 3) and leaves the file alone: a response that holds a secret value, a golden that is
malformed, a golden path that is not a regular file, a request file that is not on disk, or a write
that fails. `--update-baseline` with `--baseline`, `--require-baseline` or `--sequence` is a usage
error (exit 2).

The summary ends with the counts and the files it wrote:

```
baseline: 1 updated, 1 created, 3 matched, 0 not written, 0 refused
written:
  requests/get-order.golden.yaml
  requests/create-order.golden.yaml
```

## Reports

### `cli` (default)

One line per request as it finishes — outcome mark, status, duration — with the reasons for
anything that did not pass indented below it, and a summary line. Goes to stdout; diagnostics go to
stderr. `--quiet` suppresses passing lines; `--verbose` also prints each passing assertion.

With `--verbose`, a request that asks a security token service for a SAML token (WS-Trust, #41) also
writes one line per token request to stderr: the service's host, the status and whether the token was
fetched or came from the run's cache, and when it expires (UTC). The token, the service URL's path and
the password are never printed.

```text
STS sts.example.test 200 fetched, valid until 14:32
STS sts.example.test cached, valid until 14:32
```

A token with no lifetime reads `single use` instead of `valid until`. The cache lasts one run, so a
suite fetches each token once. The username credential's password and a certificate credential's key
password are WS-Security secrets: they have no `…Env` name, so supply them as
`WIREBENCH_SECRET_<REF>` as described under [Secrets](#secrets) (`wirebench secrets list` names them).

```text
✓ Echo/Echo/Say hello  404  6 ms
✓ demo/ok  200  1 ms
✗ demo/slow  200  204 ms
    responds within 50 ms — expected <= 50 ms, actual 204 ms
✗ demo/broken  500  2 ms
    status is 200 — expected 200, actual 500
✓ demo/secure  200  2 ms

3 passed, 2 failed, 0 errored, 0 skipped in 0.3s
```

With `--baseline`, a request's line also shows `baseline: matches`, `(no baseline)` or
`(baseline not compared: <protocol>)`, and a difference lists the changed paths under the request.
In JUnit it is a `<failure type="baseline">`. In the JSON report, each request gains a `baseline`
object. The summary gains one too, with the counts `matched`, `differs` and `missing`;
`formatVersion` stays 1.

### `junit=<file>`

One `<testsuite>` per operation or API folder — the request's group (its operation, or its folder
path under an API) — in first-seen order, one `<testcase>` per request. `classname` is that group
and `name` is the request's own name, so a consumer that shows `classname` + `name` together shows
the request's full path. `time` is seconds. A failed assertion is a `<failure>`, an errored request
an `<error>`, a bailed-out request a `<skipped/>`. Validates against the JUnit XSD CI systems use.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="5" failures="2" errors="0" skipped="0" time="0.272">
  <testsuite name="demo" tests="4" failures="2" errors="0" skipped="0" time="0.209">
    <testcase classname="demo" name="ok" time="0.001"/>
    <testcase classname="demo" name="slow" time="0.204">
      <failure message="responds within 50 ms — expected &lt;= 50 ms, actual 204 ms" type="sla"/>
      <system-out>…</system-out>
    </testcase>
    <testcase classname="demo" name="secure" time="0.002"/>
  </testsuite>
</testsuites>
```

### `json=<file>`

The stable machine interface, its own `formatVersion` starting at 1:

```json
{
  "formatVersion": 1,
  "tool": { "name": "wirebench", "version": "2.1.1" },
  "startedAt": "2026-09-19T00:47:26.163Z",
  "environment": "local",
  "summary": { "total": 5, "passed": 3, "failed": 2, "errored": 0, "skipped": 0, "durationMs": 272 },
  "requests": [
    {
      "path": "demo/slow",
      "group": "demo",
      "name": "slow",
      "protocol": "rest",
      "outcome": "failed",
      "status": 200,
      "durationMs": 203.55,
      "unasserted": false,
      "assertions": [
        {
          "type": "sla",
          "label": "responds within 50 ms",
          "outcome": "failed",
          "expected": "<= 50 ms",
          "actual": "204 ms"
        }
      ],
      "exchange": { "request": "GET /slow HTTP/1.1\r\n…", "response": "HTTP/1.1 200 OK\r\n…" }
    }
  ]
}
```

`protocol` is the request's kind: `"soap"`, `"rest"`, `"grpc"` or `"websocket"`; for a gRPC request `status` is the gRPC status
code. A sequence step (`--sequence`) carries three more fields, added within `formatVersion` 1:
`sequence` (`{ id, name, stepId }`), `transfers` (`[{ name, outcome, secret, value?, message? }]`, with no
`value` for a secret transfer) and `origin`, where the step's request went. A request with scripts may carry
`scriptLog` (what its scripts logged, masked) and `scriptsOff: true`, also within `formatVersion` 1, and a script's
tests are assertions with `"type": "script"`. `exchange` (redacted, raw HTTP) is included for a failed or errored request; a change to this
shape after S5 is an ask-first.

### `html=<file>`

One self-contained file — inline CSS, no script, no network fetch — with the summary and an
expandable entry per request. The redacted request and response are included for failed and
errored requests only.

Several reporters can be requested in one run: `--reporter junit=reports/wirebench.xml --reporter json=reports/wirebench.json`.
A report's directory is created if missing; a report that cannot be written is exit 2.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every selected request passed. |
| 1 | At least one assertion failed, or a response differs from its baseline; nothing errored. |
| 2 | Usage or load problem: bad flag, path is no project, unknown environment or selector, `--update-baseline` with `--baseline`, `--require-baseline` or `--sequence`, invalid `assertions:`, project format too new, report not writable. Nothing was sent. |
| 3 | At least one request errored: unresolved `${…}`, missing secret, network or TLS failure, unsupported auth grant, expression that does not compile. With `--baseline`, a golden that cannot be read or is too large (over 2 MiB) to compare; under `--require-baseline`, also a request with no golden. With `--update-baseline`, a golden that was refused (a secret in the response, a malformed golden, a golden path that is not a file, a request file not saved on disk) or could not be written. Takes precedence over 1. |
| 130 | Interrupted (`SIGINT`); reports are flushed with what ran. |

An errored request outranks a failed assertion (exit 3 over 1): a pipeline that could not reach the
service has learned nothing about the service. Every error carries the engine's stable
`WirebenchError.code`, printed to stderr and present in the JSON report, so a pipeline can branch on
it.

A missing WS-Security password or keystore password surfaces as `secret-missing` (exit 3), the same
as a missing `passwordEnv`/`tokenEnv` variable, and a missing keystore file as `keystore-unreadable`
(exit 3) — none of them is a usage mistake, since the project loaded fine and the problem is only
that this machine has nothing to authenticate with.

Three codes come from the engine's protocol modules and feature switches
([ADR-0017](adr/0017-a-protocol-is-a-module-behind-one-interface.md)):

| Code | Exit | When |
| --- | --- | --- |
| `feature-disabled` | 3 | A request's protocol is switched off, or the `scripts` feature is switched off and the request has active scripts. The request is not sent. The error's `details.feature` names the feature, and `details.requires` the feature it depends on when that one is what is off. No flag or variable of `wirebench` switches a feature off yet. |
| `container-unsupported` | none: a warning | An interface or API whose `kind` this build has no enabled protocol for. It is printed at load as `warning: container-unsupported: …`, its folder is left untouched, and its requests cannot be selected. The rest of the project runs. |
| `container-slug-conflict` | 3 | A save would write an interface or API into the folder of a container that was not loaded. Nothing is written. `wirebench import` does not run into it: it names the new folder around every container the project holds, loaded or not, so an import of `Shop` beside a `Shop` that was not loaded is written to `Shop-2`. |

## Proxy and TLS

No preferences file backs a pipeline run, so proxying and extra trust anchors come from the
conventions every other tool on the runner already obeys:

- `HTTPS_PROXY` / `https_proxy`, `HTTP_PROXY` / `http_proxy`, `NO_PROXY` / `no_proxy` — the proxy
  per scheme, with the usual comma-separated bypass list (`*`, a bare host, or a `.suffix`).
- `NODE_EXTRA_CA_CERTS` — Node's own variable for extra trust anchors.
- A client certificate comes from the request's own keystore, not from an environment variable; its
  password resolves through §Secrets above.
- `--insecure` skips TLS verification, the CLI equivalent of the desktop's per-environment switch.

## Work with a project

Every verb takes `--project <dir>` (default: the current directory) and `--json`, which prints the
result exactly as the MCP tool of the same name returns it. The verbs that read or write History
take `--history-dir <dir>`; by default they use the desktop's own History folder, so a send from the
terminal shows in the app's History panel and the other way round. The verbs are not gated: the
person typing the command has allowed it, so `import` and `send` need no flag. The gates below belong
to [`wirebench mcp`](#wirebench-mcp).

| Verb | Does |
| --- | --- |
| `wirebench import <source> [--name <name>]` | Adds a WSDL or an OpenAPI document to the project, as the desktop's import does: the definition is cached when the project's settings cache definitions, and each operation gets a `Request 1`. |
| `wirebench operations [<interface-or-api>]` | Lists SOAP operations (interface, binding, operation, SOAP action), REST endpoints (API, method, path, operationId) and saved WebSocket requests (API, URL), with the reference `generate` and `validate` take and the saved requests `send` takes. gRPC items are in the project but not listed. Each SOAP and REST row also carries `tool`, the name of the operation's tool (see [Contract operations as tools](#contract-operations-as-tools)), when its definition is readable. |
| `wirebench generate <operation> [--optional all\|required]` | Prints a sample request: a SOAP envelope built from the XSD, or a REST method, path, headers and JSON body. Nothing is saved. |
| `wirebench send <item> [-e <env>] [--body <text> \| --body-file <file>] [--baseline]` | Sends one saved SOAP, REST or WebSocket request as `run` sends it (environment, `WIREBENCH_SECRET_*` secrets, scripts, assertions, callback captures), prints the redacted response and the assertion results, and records the send in History, tagged `cli`. |
| `wirebench call <operation> [--args <json\|@file>] [-e <env>] [--schema]` | Calls one operation of an imported contract with JSON arguments, as its MCP tool does: builds the request a new request of the operation would be, sends it under the interface's or API's endpoint, auth and `WIREBENCH_SECRET_*` secrets, records it in History tagged `cli`, and prints the response (`--json`: the result as JSON, the same object the tool returns). `<operation>` is the `operations` reference or the tool name. `--args` takes JSON or `@<file>`; `--schema` prints the arguments' JSON Schema and sends nothing. A response is exit 0, a SOAP fault or a 4xx/5xx included. |
| `wirebench validate <history-id\|file> [--operation <ref>] [--direction request\|response] [--status <n>]` | Validates a SOAP message against the WSDL's XSD and SOAP rules (line and column), or a REST response body against its OpenAPI response schema (JSON path and keyword). |
| `wirebench query <expression> <history-id\|file> [--namespace <prefix>=<uri>]… [--direction request\|response]` | XPath 3.1 on XML (the document's own prefixes are known), JSONPath on JSON; one result per line. |
| `wirebench history list [--item <text>] [--limit <n>]` | The project's History, newest first: id, time, item, status and duration. `--item` matches part of the item path, in any case. `--limit` is 1 to 200 and defaults to 20. |
| `wirebench history diff <from-id> <to-id> [--ignore <path>]…` | The semantic XML or JSON diff of two responses, as the desktop's snapshot diff reports it. |

Details that are easy to get wrong:

- **`import`.** `<source>` is a local file or an http(s) URL. A relative path resolves against the
  working directory, so give an absolute path when a program (an MCP client) chooses the working
  directory. `import` reads any local path the process can read and fetches any http(s) URL the
  machine's network reaches, through `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`. The desktop limits an
  import to project roots and files the user picked; this does not. A WSDL import takes
  `cacheDefinitions` from the project's own settings, not from the desktop's preferences.
- **`send --baseline`.** The response body is compared with the golden saved beside the request
  (`<slug>.golden.yaml`), honouring its ignore rules. A difference is a failed `baseline` assertion
  (exit 1). No golden prints `baseline: no baseline saved` and does not fail. An unreadable or
  oversize (over 2 MB) golden is an error (exit 3). A WebSocket request is not compared. It combines
  with `--body` / `--body-file`, and the saved request's golden still applies.
- **`send`.** `--body` (or `--body-file`) replaces the saved SOAP envelope, or the saved raw or JSON
  body of a REST request, for this send only; nothing is saved. It is sent as written, so a `${…}`
  placeholder in it is refused with `invalid-input`. The saved request's own body still expands
  placeholders as usual. Secrets come only from `WIREBENCH_SECRET_<NAME>` variables, and only the ones
  the saved request uses. A WebSocket request is sent as a run sends it: the socket opens, the saved
  messages go out in order, and the session closes once a reply comes after the last one, or fails
  with `timeout` when the request's handshake timeout (else the project's default timeout) passes
  first, returning no frames and writing no History; a server that refuses or cannot be reached fails
  it with `ws-handshake-refused`. The result
  carries the handshake's status and headers, every text received as a JSON array in `body`, and
  `frames`, both ways, masked and capped as History stores them (`framesTruncated` says some were
  left out); `--body` does not apply to it. gRPC items are in the project, but `operations` does not
  list them and `send` refuses them with `unsupported-kind`, as it does an item inside a container
  that was not loaded, naming the reason. A name a REST and a WebSocket request share is ambiguous:
  pass the path. Server-sent events are a response mode of a REST
  request, not an item kind. The response body in the result is cut at 256 Ki characters, and
  `bodyTruncated` says when it was (the same cut applies to the History entry).
  A send that got no response is not written to History. When the History file is busy (another
  process holds it), the result comes back without `historyId`, and a warning says why on stderr.
- **`validate` and `query` sources.** `<history-id|file>` is a file when one exists at that path,
  otherwise a History id. On MCP the same choice is the `historyId`, `file` and `text` inputs, of
  which exactly one is passed. A `file` is read from any path the process can read, resolved against
  the working directory. It must be a regular file of at most 16 MiB, and any file in the History
  folder in use (`--history-dir`, or the default) is refused, whatever path or link reaches it; read
  History with `historyId`. `--direction` says which side of a History entry to read and
  which side of the contract to check (default `response`).
- **REST.** `validate` checks responses only. The status comes from the History entry, or from
  `--status`, and is 200 when neither gives one. `generate` for a REST operation prints the OpenAPI
  path template (`/pets/{petId}`), not a URL.
- **`validate` results.** `valid` is false only when the message was found wrong: a SOAP error, or a
  REST `contract` of `violation` or `unmatched` (the contract declares no response for the status).
  `checked` is false when a REST body could not be compared with a schema at all, and `contract` says
  why: `no-schema`, `no-contract`, `skipped` (not JSON, or over 1 MiB) or `not-checked` (the check ran
  out of time). Such a result is still `valid`, the verb exits 0, and its first line reads
  `not checked: <contract>`. A SOAP result is always `checked`. At most 50 problems are listed, for
  SOAP and REST alike, and `truncated` says when there were more (for REST, when the check stopped at
  50).
- **`query` caps.** Counted in characters, not bytes: one result keeps at most 64 Ki characters and all
  results together at most 256 Ki characters; `truncated` is set when anything was cut, and also when the engine returned more results than its
  own limit of 1000.
- **`history diff` cap.** The paths and values of the changes returned add up to at most 256 Ki
  characters; `truncated` says when more were left out.

A `<history-id|file>` argument that looks like a path but matches no file is tried as a History id,
and the error then says no file exists at that path either.

### Redaction

Every result and every error passes one step before anything is printed or returned:

1. The engine's own redactors run first, and they work by pattern:
   - Headers: the values of `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie` and
     `X-API-Key`.
   - URLs: a password in the URL, and the value of a query parameter named `api_key`, `apikey`,
     `api-key`, `access_token`, `token`, `key`, `auth`, `signature` or `sig`. A URL's user name is not
     masked.
   - XML: the text of a WS-Security `Password` element (a `#PasswordDigest` value is a hash and stays).
   - JSON and form bodies: the value under a key from a fixed list (`password`, `passwd`, `secret`,
     `token`, `access_token`, `refresh_token`, `client_secret`, `api_key`, `authorization` and the like).
     A value under any other name, such as `<ApiToken>`, stays readable.
2. Then every secret value the call resolved is masked wherever it appears, with the masker `run`
   uses (including its floor: a value of fewer than 4 characters is not masked literally). Under
   `wirebench mcp`, every `WIREBENCH_SECRET_*` value of at least 8 characters in the server's
   environment, and `WIREBENCH_MCP_TOKEN`, are masked in every tool's result as well, whether or not the
   call resolved them. A shorter value is masked only where a call resolved it, under the floor above.

`send`'s assertion results get the pattern redaction too: URLs in every label, expected and actual
value and message are redacted, and the value an assertion read is shown as `<redacted>` when it is a
credential: a header assertion on one of the headers above, a `match` whose JSONPath or XPath ends in
one of the secret keys above (`$.token`, `//Password`), and the same checks inside a callback
assertion's reasons. A node or object a `match` read (`$.auth`, `//Header`) goes through the XML or
JSON redaction above, so a password or secret key inside it is masked too; one the engine cut short at
200 characters that still holds a secret key or an unclosed `Password` shows as `<redacted>` whole.
`wirebench run` shows those values as they are.

`validate`, `query` and `history diff` apply the same pattern redaction to the message before they read
it, so the password and secret-keyed values above never appear in what they return. That is the whole
guarantee: it is not a promise that no query can learn a secret, because a secret in a value the patterns
do not cover is read as it is. Two responses that differ only in a masked value compare equal. Column
numbers in a `validate` problem count on the redacted text.

The three read the message as XML when its text starts with `<`, and as JSON otherwise; they never go by
a declared content type (a form-encoded History entry is the one place the declared type adds form
masking). `send` goes by the response's declared `Content-Type`: key-based masking applies to XML, and
to a JSON or form body only when the response declares that type. A body with any other type, plain
text for one, is masked only for the secret values resolved for the send.

History itself is not an agent-facing surface: an agent reads it through `history_list`,
`history_diff` and the `historyId` inputs, which redact, and `file` refuses any file in the History
folder in use.

### History location

History is the desktop's `<userData>/history/<projectId>.jsonl`, one file per project. `<userData>` is:

| OS | Folder |
| --- | --- |
| macOS | `~/Library/Application Support/Wirebench` |
| Windows | `%APPDATA%\Wirebench` |
| Linux | `$XDG_CONFIG_HOME/Wirebench`, or `~/.config/Wirebench` |

A development build of the desktop uses `<appData>/@wirebench/desktop` instead, and the end-to-end
suite sets `WIREBENCH_USER_DATA_DIR`; `--history-dir` reaches either. `--history-dir` names the folder
that holds the `.jsonl` files (the desktop's `<userData>/history`), not `userData` itself. The app and
the terminal or agent write the same file under a lock, and an open History panel refreshes when
another process writes it. Each entry is tagged `cli` or `mcp` by whichever sent it.

The desktop keeps as many entries as its History preference allows, which can be more than 1000. A
send from the terminal or an agent never trims History below what the file already holds: it adds its
entry and drops nothing, so the file can grow past the desktop's cap. The desktop's own cap applies
again on its next write. Without the desktop, then, the terminal and agents never trim History: the
file grows until the desktop next writes it and trims it to its own cap.

### Exit codes of the verbs

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | A `send` assertion failed, or `validate` found the message invalid (`valid: false`; a body it could not check exits 0). |
| 2 | A usage error: a refused or wrong call. Nothing was sent. |
| 3 | Everything else: a request error (an unset secret, a network or TLS failure, an assertion or script that errored), an unreadable History file, `history-busy`, an internal error. |

The error goes to stderr as `code: message`. Exit 2 is exactly these codes: `invalid-input`,
`project-not-found`, `workspace-not-project`, `file-not-found`, `item-not-found`, `item-ambiguous`,
`operation-not-found`, `container-not-found`, `environment-required`, `environment-not-found`,
`environment-not-allowed`, `history-entry-not-found`, `history-no-response`, `unsupported-kind`,
`unsupported-format`, `write-not-allowed`, `send-not-allowed`, `definition-cache-missing`,
`query-failed`, `operation-gone`, `no-endpoint` and `too-many-tools`.

## Export to another tool

`wirebench export` writes the project — or the one API or SOAP interface `--api` names, by name, slug
or id — to `--out` (default: the current directory, created when missing). It reads the project and
never changes it.

| Format           | Files                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `postman`        | `<name>.postman_collection.json` (Collection v2.1), and `<env>.postman_environment.json` per environment |
| `opencollection` | `<name>.opencollection.yml` (OpenCollection 1.0), its environments inside it             |

- `${name}` references become `{{name}}`; `${#Env#name}` and the other property scopes are flattened.
  `${#System#…}` and `${#Sequence#…}` have no equivalent and stay as written.
- No credential is ever written. Auth keeps its shape (type, user name, key name, token URL, client
  id) with every secret left empty; a `${secret:name}` becomes a secret variable with no value.
- A SOAP request becomes an HTTP POST of its envelope, with its `Content-Type` and `SOAPAction`.
  WS-Security, WS-Addressing, attachments and MTOM are reported, not written.
- Postman Collection v2.1 has no gRPC or WebSocket requests and no declarative assertions; they are
  left out and reported. OpenCollection carries both, and the status, response-time and JSON-path
  assertions.
- When the project sits inside a workspace, the workspace's environments and properties are exported
  with the project's.

The files written are printed, then `Warning:` lines for what was lost and `Note:` lines for what was
changed to fit. `--json` prints `{ files, counts, report }`. Exit 0, even with warnings; 2 for a usage
error; 3 when `--api` names nothing or there is nothing to export.

## `wirebench mcp`

```text
wirebench mcp [--project <dir>] [--allow-write] [--allow-send] [-e <a,b>] [--history-dir <dir>] [--http <port>] [--tools <name,…|none>]
```

Serves the verbs above as MCP tools to a coding agent: `import`, `operations`, `generate`, `send`,
`validate`, `query`, `history_list` and `history_diff`, and one tool per operation of the project's
imported contracts (below). Each of the eight takes the same input as its verb and returns the same
JSON as `--json`; a refusal is a tool result with `isError` and `{ "code", "message" }`. No model runs
inside Wirebench, and nothing is sent anywhere except the requests you or the agent ask `send` or a
contract tool to make.

| Flag | Meaning |
| --- | --- |
| `--project <dir>` | The project the tools work on (default: the current directory). Checked at start: a folder that is not a project exits 2. |
| `--allow-write` | Lets `import` write the project. Off: `import` answers `write-not-allowed`. |
| `--allow-send` | Lets `send` and the contract tools make requests. Off: they answer `send-not-allowed`. |
| `-e, --env <a,b>` | The environments `send` and the contract tools may use, by name, slug or id; any other is `environment-not-allowed`. Under `-e`, a call that resolves no environment (a project that defines none) is refused too. |
| `--tools <a,b\|none>` | The interfaces and APIs, by name or slug, whose operations are tools (default: all). `none` serves the eight tools above only. A name the project does not have exits 2. |
| `--history-dir <dir>` | The folder that holds the History `.jsonl` files (default: the desktop's, see [History location](#history-location)). |
| `--http <port>` | Streamable HTTP on `http://127.0.0.1:<port>/mcp` instead of stdio. A port from 1 to 65535, except 80: clients drop the default port from `Host` and `Origin`, so `--http 80` is refused. See below. |

`wirebench mcp` also takes `--no-secret-sources`, `--trust-secret-sources` and
`--trust-secret-sources-hash <hash>`, as for `run`, and fetches each secret-source value once for the
server's lifetime.

The gates apply to `wirebench mcp` only. Every tool is always listed, whatever the flags: a gated tool
whose gate is off refuses, and its error names the flag that would allow it, so the agent can tell
you what to pass.

On stdio, stdout carries protocol frames only; the startup line and every warning go to stderr.
The server ends when stdin closes or when the client closes the transport. Secrets come from `WIREBENCH_SECRET_<NAME>` variables in the server's
own environment and from the workspace's secret sources (subject to `--no-secret-sources`,
`--trust-secret-sources` and `--trust-secret-sources-hash`, as for `run`), are masked in every result, and are never an input of any tool. Every
`WIREBENCH_SECRET_*` value of 8 characters or more that the server was started with is masked in every
result, not only the ones a call used.

### Contract operations as tools

Every SOAP operation of an interface with a cached definition, and every endpoint of an API with a
cached OpenAPI document, is a tool of its own. The agent passes typed JSON and gets JSON back; it never
reads or writes an envelope.

- **Names.** `<container>_<operation>` in snake_case: `CalculatorService` and `Add` make
  `calculator_service_add`; a REST endpoint uses its `operationId`, or its method and path. At most 64
  characters (the container part is cut first). A name a fixed tool or an earlier operation already has
  gets `_2`, `_3`…; one operation bound twice (SOAP 1.1 and 1.2) is two tools. `wirebench operations`
  shows each row's `tool`.
- **Arguments.** A SOAP tool's arguments are its body element's content: one property per child
  element, `@name` for an attribute, `#text` for simple or mixed content, arrays where the XSD allows
  more than one, `null` for a nillable element, and an XML string for `xs:any` and `anyType`. A REST
  tool takes `path`, `query`, `headers` (not the ones the API's auth sets) and `body`. Every tool also
  takes `environment`, with `send`'s rules (`wirebench_environment` when the operation has an argument
  of that name).
- **Checks.** Arguments are checked against the tool's own JSON Schema and refused with `invalid-input`
  when they do not fit, or when a string holds `${`; a SOAP envelope is then checked against the XSD,
  and refused the same way. Nothing is sent after a refusal.
- **Sending.** The request is the one a new request of the operation would be: the binding's SOAP
  version and action, the interface's or API's endpoint for the environment, and the auth a new request
  there inherits. No endpoint is `no-endpoint`. Each call is recorded in History as `<operation> (MCP)`,
  tagged `mcp`.
- **Results.** `status`, `ok` (2xx and no fault), the redacted headers, and `result`: the SOAP body or
  the REST JSON as JSON. A fault comes back as `fault` with `code`, `reason` and its `detail`, a normal
  result rather than an error. A body that cannot be read as JSON comes back as `body` text, with a note.
- **The cap.** At most 128 contract tools. Above that, the server refuses to start (`too-many-tools`,
  exit 2) and names each container's count; pick some with `--tools`. When a change to the project takes
  the count over the cap while serving, the contract tools are withdrawn until it falls back.
- **Kept current.** The server watches the project folder. After a change (an `import`, an edit in the
  app) it rebuilds the tools and tells every session (`notifications/tools/list_changed`). A call to an
  operation the project no longer has is `operation-gone`.
- Each tool needs `--allow-send`, as `send` does, and is listed whatever the flags.

`wirebench call` runs the same core from a terminal, without the cap and the gates.

### Streamable HTTP

`--http <port>` serves the same tools to clients that connect by URL. It binds `127.0.0.1` and nothing
else; there is no flag to bind another address.

- Every request needs `Authorization: Bearer <token>`. The token is `WIREBENCH_MCP_TOKEN` when that is
  set; otherwise the server generates one at start (32 random bytes, base64url) and prints it once to
  stderr. The variable is trimmed, and an empty value counts as unset. A token you set must be at least
  16 characters with no spaces, or the server refuses to start (exit 2). A missing or wrong token gets 401.
- A request with an `Origin` other than `http://localhost:<port>` or `http://127.0.0.1:<port>` gets
  403, and this is checked before the token. It guards against a web page reaching the server through
  DNS rebinding. A request with no `Origin` header (a command-line client) is not refused on this
  ground.
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`; anything else gets 403. This is
  the second guard against DNS rebinding.
- Any path other than `/mcp` gets 404.
- Each session has its own server, all with the same gates. One process holds at most 64 live
  sessions. Only a real `initialize` request makes room: once the server has accepted it as one and the
  cap is reached, it closes the session that went longest without a request, preferring one with no
  open GET stream (a client listening for server messages is in use even when it sends nothing); when
  every session has a stream open, the idlest of all is closed. That client gets 404 on its next
  request and must initialize again. A malformed request, or one that is not an initialize, closes
  nobody's session. When every slot is a session still initializing, a new one gets 503. Every client
  shares the one token, so any holder of it can close other clients' sessions by opening new ones.
  There is no idle timeout below the cap: stop the process to drop every session.
- A request body is capped at 16 MiB. The server accepts at most 128 connections at once, and drops a
  connection that has not finished its headers after about 10 seconds.

## `wirebench mock record`

```text
wirebench mock record <path> <mock> --target <url> [--from <interface|api>] [--port <n>] [--host <addr>]
                      [--replace] [--no-dedupe] [--insecure]
```

Records a real system's answers as stubs of a mock (#60). Point a client at the address the command
prints instead of the real system, and use it as usual. Each request goes on to `<url>`, and the client
gets the real response. Each response to a request that reaches one of the contract's operations is kept.
Ctrl-C stops the recording, adds what was kept to the mock and saves the project. Each stub is a
`Recorded <status>` response file under `mocks/<mock>/operations/…`.

- `<mock>` is a mock's name or slug. If there is no such mock, `--from <interface|api>` creates one from
  that contract, with no stubs. Recording adds each operation it reaches.
- The mock's `path` maps onto the target's path. With a mock at `/orders` and `--target
  https://real.example/api`, the request `/orders/7?x=1` goes to `https://real.example/api/7?x=1`. A
  request outside the mock's path gets 404 and is not forwarded. Redirects are passed back, not followed.
- An operation keeps its dispatch style, so a `sequence` operation replays its recordings in the order they
  were made. `--replace` drops an operation's other responses (a generated `Default`, say) the first time
  a recording reaches it. A recording equal to a response the operation already has is skipped unless
  `--no-dedupe` is given.
- A binary response, or one over 5 MiB, is passed through and not kept. A `?wsdl` request and a request
  no operation matches are passed through and not kept either.
- stderr gets one line per request: `<method> <url> <status> <operation|-> recorded|<reason>`.
- The listener follows the mock's rules: loopback by default, the `Host` check, and the 10 MiB request
  cap. The upstream proxy comes from `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`. `--insecure` skips TLS
  verification of the target.
- What is kept is masked before it is saved: `Set-Cookie` and the other credential headers, secret keys
  in JSON and form bodies, `wsse:Password` and security tokens in XML, and every `WIREBENCH_SECRET_*` value.
  Requests are never saved.
- Exit codes: 0 when the recording ran, whether or not anything was kept (with nothing kept, the project
  is not written). 2 for a usage error, an unknown mock or `--from`, or a target that is not an http or
  https URL. 3 when the recorder cannot start (`mock-port-in-use`, `mock-definition-missing`, …).

## Contract diff

`wirebench diff-contract <old> <new>` compares two versions of a WSDL, or two versions of an OpenAPI
document, operation by operation (issue #56, see the
[design spec](specs/2026-10-08-wirebench-contract-diff-design.md)). Each side is a file, an `http(s)`
URL (fetched through the proxy the environment names, as `import` fetches), or `project:<name>`: the
cached definition of the interface or REST API of that name or slug in `--project` (default: the
current directory), read with no network access. A pipeline can so check a freshly built contract
against the one the project was built from.

```bash
wirebench diff-contract project:OrderService build/OrderService.wsdl --reporter markdown=contract-diff.md
```

What it compares:

- **Operations** added or removed, by the identity Update Definition uses (`{ns}Binding#Operation`,
  `METHOD /path`): a renamed binding or path is a removal and an addition.
- **Endpoints**: `soap:address` locations or OpenAPI `servers`. One removed and one added is a move.
- **Transport**: a WSDL operation's SOAP action, SOAP version and style; an OpenAPI operation's
  effective security.
- **Messages**: the request and the response of each operation, field by field — a WSDL body read
  through its XSD, an OpenAPI operation's parameters (as `request.query.<name>` and so on), request
  body and responses. Fields added, removed, made required or optional; types narrowed, widened or
  changed; enumeration values added or removed; constraints (lengths, bounds, patterns, formats)
  tightened or relaxed; media types and responses added or removed.

Each change is **breaking** or **compatible** for an existing client. The client writes the request
and reads the response, so the same change can be either:

| Change | Request | Response |
| --- | --- | --- |
| Operation removed, endpoint moved or removed, SOAP action, version, style or security changed | breaking | breaking |
| Field removed; type changed to an unrelated one; media type removed | breaking | breaking |
| Field added and required; field made required; type narrowed; enumeration value removed; constraint tightened | breaking | compatible |
| Field made optional; type widened; enumeration value added | compatible | breaking |
| Operation, endpoint, optional field or media type added; constraint relaxed | compatible | compatible |
| Response removed: a 2xx status or `default` / any other status | — | breaking / compatible |

In a WSDL a single element that becomes repeating (`maxOccurs` raised) is a widening, since one
element is still valid. Descriptions and documentation are not compared. Webhooks, callbacks, SOAP
headers and faults are not compared yet.

| Option | Does |
| --- | --- |
| `--fail-on breaking` | Default. Exit 1 when any change is breaking. |
| `--fail-on any` | Exit 1 on any change. |
| `--fail-on none` | Exit 0 whatever changed: report only. |
| `--reporter markdown=<file>` | A Markdown report: the two sides, the counts, a table of breaking changes and one of compatible changes. |
| `--reporter html=<file>` | The same as one self-contained HTML page, light and dark. |
| `--reporter json=<file>` | The diff as JSON: `format`, `old`, `new`, `operationsCompared`, `changes` (`kind`, `severity`, `operation`, `location`, `message`), `notes`, `summary`. |
| `-q`, `--quiet` | Print the counts only. |

stdout lists one change per line, breaking first, then the counts:

```text
BREAKING    OrderBinding#PlaceOrder request.note  note is now required
compatible  OrderBinding#PlaceOrder response.eta  eta added, optional
1 breaking, 1 compatible changes in 2 operations compared
```

Exit 0 when the gate passes and 1 when it fails. Exit 2 for a usage error, an unreadable file
(`file-not-found`), a missing cache (`definition-cache-missing`), an unknown `project:` name
(`container-not-found`), a document that is neither a WSDL nor an OpenAPI document
(`unsupported-format`) or two different formats (`contract-formats-differ`). Exit 3 when a document
cannot be fetched or parsed. What a definition could not resolve, and what its schema could not
express, is printed to stderr as a warning and does not change the exit code.

## `wirebench mock`

```text
wirebench mock <path> [mock…] [--port <n>] [--host <addr>] [--json] [-q]
```

Serves a project's [mock services](https://wirebench.github.io/wirebench/docs/reference/project-format/) without the app, until SIGINT or
SIGTERM. Design: [`specs/2026-10-08-headless-mock-design.md`](specs/2026-10-08-headless-mock-design.md).

- `<path>` is the project folder. `[mock…]` picks mocks by name, folder slug (`mocks/<slug>/`) or id;
  with none, every mock in the project starts, each on its own `port` from `mock.yaml`. A mock whose
  port is `0` gets a free one, which its listening line names.
- `--port <n>` overrides the port of the one selected mock (with several selected it is exit 2).
- `--host <addr>` is the address to listen on: `WIREBENCH_MOCK_HOST` when the flag is absent, else
  `127.0.0.1`. The project cannot choose it. Off loopback, a warning goes to stderr: the mock then answers
  any client that can reach the port, and the loopback-only `Host` check (421) no longer applies.
- stdout carries a `listening <name> <url>` line per mock once all have started, then one line per request:
  time, mock, method, path, status, operation, response and duration, with each validation problem
  indented below it. Bodies are not printed. `-q` keeps only the listening lines.
- `--json` writes the same as one JSON object per line: `{"type":"listening","mockId","mock","url","host","port"}`
  and `{"type":"exchange","mockId","mock",…}`, the second carrying the engine's whole exchange event with
  its headers masked and its bodies cut to 64 KiB.
- Warnings (a mock file that did not load, a stub operation the contract no longer has) go to stderr and
  do not stop the mocks.

| Exit | When |
| --- | --- |
| 0 | Stopped by SIGINT or SIGTERM. |
| 2 | Bad flags, an unknown or ambiguous mock, a project with no mocks, a path that is not a project. |
| 3 | A mock did not start: port in use, definition not cached, a gRPC or WebSocket container. The mocks already started are stopped first. |

A mock replays only what its stubs say, and its definition comes from the project's cache, so it never
touches the network and behaves the same on a runner as on a laptop.

## `wirebench mock check`

```text
wirebench mock check <path> [mock…] [--json]
```

Checks every stub of a project's mocks against the contract, without serving them (#325). A mock checks
the requests it receives; this checks the replies it would send, so a stub that drifted from the WSDL or
the OpenAPI document fails here instead of letting a client test pass against the mock and fail against
the real service. The contract comes from the definition cache, as when the mock serves.

- `<path>` and `[mock…]` select mocks as `wirebench mock` does.
- Each stub gets the checks a received response gets. SOAP: the envelope structure, the `Content-Type`
  against the binding's SOAP version, and the body against the output message's schema (a fault gets the
  structure checks only); a reply is sent with 200, a fault with 500 (400 or 500 in SOAP 1.2), and a
  one-way operation's empty acknowledgement with 200 or 202. REST: the status must be one the operation
  documents (exactly, by range or as `default`), the `Content-Type` one it declares for that status, and a
  JSON body must match the media type's schema.
- A stub of an operation the contract no longer has is not checked; `wirebench mock` warns of it.
- stdout carries a line per mock: `<name>: <n> stubs conform to the contract`, or the count that do not,
  followed by each such stub as `<operation> › <response> (<status>)` with its problems indented below it.
  `--json` writes one object per mock instead: `{"mockId","mock","checked","findings"}`, each finding naming
  the operation, the response and its problems (`in` is `status`, `header` or `body`).

| Exit | When |
| --- | --- |
| 0 | Every stub conforms. |
| 1 | At least one stub does not conform. |
| 2 | Bad flags, an unknown or ambiguous mock, a project with no mocks, a path that is not a project. |
| 3 | A mock's contract could not be read: definition not cached, a gRPC or WebSocket container. |

## Run in CI

Four ways to run a project in a pipeline, from the same package. Every secret is the caller's: map
each one to `WIREBENCH_SECRET_<NAME>` (the same variable `secrets list` reports) in the CI system's
own environment or variables, and the runner's masking hides the value in every reporter, the `cli`
one included — nothing here holds or asks for a secret itself. See the [docs-site "Run in
CI" guide](https://wirebench.github.io/wirebench/docs/guides/run-in-ci/) for the same recipes with more
walkthrough.

### GitHub Actions

```yaml
- uses: wirebench/wirebench/action@v5.0.0
  with:
    project: ./api-tests
    env: staging
    junit: reports/wirebench.xml
  env:
    WIREBENCH_SECRET_BILLING_PASSWORD: ${{ secrets.BILLING_PASSWORD }}
```

The action installs Node 24 (`node-version`, default `24` — this replaces `node` for later steps
of the same job), runs `@wirebench/cli` via `npx`, and exposes the exit code as the `exit-code`
output. Every input arrives through `env:`, never interpolated into the step's script. See
[`action/README.md`](../action/README.md) for the full input and output table.

### GitLab CI

```yaml
include:
  - remote: https://raw.githubusercontent.com/wirebench/wirebench/v5.0.0/templates/gitlab/wirebench.gitlab-ci.yml

api-tests:
  extends: .wirebench-run
  variables:
    WIREBENCH_VERSION: '5.0.0'
    WIREBENCH_PROJECT: api-tests
    WIREBENCH_ENV: staging
```

`.wirebench-run` runs `ghcr.io/wirebench/wirebench-cli:${WIREBENCH_VERSION}` and reports
`WIREBENCH_JUNIT` (default `wirebench-junit.xml`) as a JUnit artifact with `when: always`, so
results show even on a red pipeline. The template is not rewritten when a release tag is cut —
the tagged file must equal the tagged commit — so always pin `WIREBENCH_VERSION` explicitly
rather than relying on the `latest` default. Map a CI/CD variable to
`WIREBENCH_SECRET_<NAME>` and turn on "Mask variable" for it (Settings → CI/CD → Variables).

### Docker

```bash
docker run --rm -v "$PWD:/work" \
  -e WIREBENCH_SECRET_BILLING_PASSWORD \
  ghcr.io/wirebench/wirebench-cli:5.0.0 run ./project --env staging --reporter junit=reports/wirebench.xml
```

The image (`linux/amd64` and `linux/arm64`) runs as the non-root `node` user with `WORKDIR /work`
and `ENTRYPOINT ["node", "/app/dist/bin.js"]`, so `run <path>` (and any other subcommand) follows
the image reference directly. Mount the project at `/work` (or a subdirectory of it) and pass
secrets with `-e`.

### npx

```bash
WIREBENCH_SECRET_BILLING_PASSWORD="$BILLING_PASSWORD" \
  npx --yes @wirebench/cli@5.0.0 run ./project --env staging --reporter junit=reports/wirebench.xml
```

Works on any CI runner with Node 24 already available and no other setup — the same package the
GitHub Action installs under the hood.

Each recipe above exits non-zero on a broken service (1) or a broken pipeline (2, 3), and the
JUnit report names the request and the assertion that failed.

### Mocks in a pipeline

Start the mocks in the background, wait for the listening line, run the tests against them, then stop
them. On a runner with Node 24:

```bash
npx --yes @wirebench/cli@5.0.0 mock ./project orders --port 8089 > mock.log &
MOCK=$!
until grep -q '^listening ' mock.log; do sleep 0.2; done
npx --yes @wirebench/cli@5.0.0 run ./api-tests --env mocked
kill -TERM "$MOCK"; wait "$MOCK"
```

In a container the image already listens on every interface (`WIREBENCH_MOCK_HOST=0.0.0.0`), so only
the port has to be published. The process handles SIGTERM itself, so `docker stop` ends it at once
with exit 0:

```bash
docker run -d --name orders-mock -p 8089:8089 -v "$PWD:/work" \
  ghcr.io/wirebench/wirebench-cli:5.0.0 mock ./project orders --port 8089
```

A CI system's service containers start before the repository is checked out, so they cannot see the
project; start the mock from the job itself, as above, or bake the project into an image built
`FROM ghcr.io/wirebench/wirebench-cli` with it copied under `/work`.

