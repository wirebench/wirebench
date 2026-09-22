# CLI reference: `wirebench run`

`@wirebench/cli` runs the requests already saved in a Wirebench project from a terminal or a
pipeline, and turns the result into an exit code and a report a CI system understands. It ships
alongside the desktop app in this monorepo; see [Run in CI](../README.md#run-in-ci) in the README
for the one-line pipeline step.

This page documents S1–S7: SOAP, REST and unary gRPC requests, all four assertion types that apply
to them, all four reporters, environment-variable secrets and OAuth2 client credentials — see the
[design spec](specs/2026-09-18-cli-runner-design.md) and, for S7,
[its own spec](specs/2026-09-22-cli-runner-design.md).

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

Requests run one after another, in the project's own order (`order`, then name) — deterministic,
and `--bail` stops after exactly the requests that would otherwise have run before the failure.
Parallelism is out of scope.

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

`soap-fault` on a REST request and an XSD `schema` assertion on a REST request are load errors
(exit 2), not silent passes. `schema` for REST is reserved but not implemented until `#45`
(OpenAPI response validation) lands. A `match` result is compared as a string unless `equals` is a
boolean or a number.

### gRPC requests

Unary gRPC requests run like the others, in the same project order; server-, client- and
bidirectional-streaming requests are skipped (a selector naming one matches nothing, exit 2), and so
is a request whose method is gone from the API's definition. The schema comes from the API's
**cached** definition (`apis/<slug>/definition/`, written when the desktop imports a `.proto` set
with caching on) — the runner never reads the original `.proto` folder nor asks the server for
reflection. An API without a cache errors each of its requests with `grpc-definition-missing`
(exit 3) and sends nothing. `status`, `match` (JSONPath over the first response message as JSON)
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
that variable name for each of them.

Resolution for a ref, in order:

1. `WIREBENCH_SECRET_<NAME>` when the file declares a name (`passwordEnv`, `tokenEnv`, …).
2. `WIREBENCH_SECRET_<REF>` — the ref itself, upper-cased and with anything but `[A-Z0-9_]`
   turned into `_`.

Neither variable set → the request is `errored` with `secret-missing`, naming the variable to set.
The CLI never reads the desktop's `secrets.json` and never touches a keychain — a pipeline has no
user, so it has no keychain to read.

```bash
$ wirebench secrets list ./project --env local
VARIABLE                        STATE    PURPOSE                   USED BY
WIREBENCH_SECRET_DEMO_PASSWORD  missing  basic password for "svc"  demo/secure
```

Exit 0 when every variable a run of the selection would need is set, exit 3 when at least one is
missing.

`secrets list` is conservative: it lists every secret the selected requests' configuration names,
without sending anything, so it cannot know which ones a particular run will actually ask for. A
WS-Security incoming configuration's decryption-key password, for example, is only needed when a
response arrives encrypted. So `secrets list` can exit 3 for a selection that `run` passes; treat
its list as what a run *may* need.

### OAuth2 client credentials

A request, folder or API whose auth is OAuth2 with the **client-credentials** grant gets its token
at run time: the runner posts to the token URL (property expansion applies to it, the client ID,
the scopes and the audience) with the client secret from `clientSecretEnv` / `clientSecretRef` as
above, and sends the token as a Bearer — REST and gRPC alike. One token is fetched per
configuration per run and reused until it is due for refresh; a failed fetch is not cached. When a
server refuses the token — a REST `401` or a gRPC `UNAUTHENTICATED` (16) — the run drops it, and the
next request behind the same configuration fetches a new one. The refused request is reported as it
came back and is **not** sent again: it may already have had an effect. The token request honours `--timeout`, `--insecure` and the proxy variables. The access token is masked
in every report and in stdout/stderr exactly like a secret from the environment. The
**authorization-code** grant needs a browser and a person, so a request that uses it is errored with
`auth-grant-unsupported`.

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

## Reports

### `cli` (default)

One line per request as it finishes — outcome mark, status, duration — with the reasons for
anything that did not pass indented below it, and a summary line. Goes to stdout; diagnostics go to
stderr. `--quiet` suppresses passing lines; `--verbose` also prints each passing assertion.

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

`protocol` is `"soap"`, `"rest"` or `"grpc"`; for a gRPC request `status` is the gRPC status
code. `exchange` (redacted, raw HTTP) is included for a failed or errored request; a change to this
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
| 1 | At least one assertion failed; nothing errored. |
| 2 | Usage or load problem: bad flag, path is no project, unknown environment or selector, invalid `assertions:`, project format too new, report not writable. Nothing was sent. |
| 3 | At least one request errored: unresolved `${…}`, missing secret, network or TLS failure, unsupported auth grant, expression that does not compile. Takes precedence over 1. |
| 130 | Interrupted (`SIGINT`); reports are flushed with what ran. |

An errored request outranks a failed assertion (exit 3 over 1): a pipeline that could not reach the
service has learned nothing about the service. Every error carries the engine's stable
`WirebenchError.code`, printed to stderr and present in the JSON report, so a pipeline can branch on
it.

A missing WS-Security password or keystore password surfaces as `secret-missing` (exit 3), the same
as a missing `passwordEnv`/`tokenEnv` variable, and a missing keystore file as `keystore-unreadable`
(exit 3) — none of them is a usage mistake, since the project loaded fine and the problem is only
that this machine has nothing to authenticate with.

## Proxy and TLS

No preferences file backs a pipeline run, so proxying and extra trust anchors come from the
conventions every other tool on the runner already obeys:

- `HTTPS_PROXY` / `https_proxy`, `HTTP_PROXY` / `http_proxy`, `NO_PROXY` / `no_proxy` — the proxy
  per scheme, with the usual comma-separated bypass list (`*`, a bare host, or a `.suffix`).
- `NODE_EXTRA_CA_CERTS` — Node's own variable for extra trust anchors.
- A client certificate comes from the request's own keystore, not from an environment variable; its
  password resolves through §Secrets above.
- `--insecure` skips TLS verification, the CLI equivalent of the desktop's per-environment switch.

## Run in CI

Four ways to run a project in a pipeline, from the same package. Every secret is the caller's: map
each one to `WIREBENCH_SECRET_<NAME>` (the same variable `secrets list` reports) in the CI system's
own environment or variables, and the runner's masking hides the value in every reporter, the `cli`
one included — nothing here holds or asks for a secret itself. See the [docs-site "Run in
CI" guide](https://wirebench.github.io/wirebench/guides/run-in-ci/) for the same recipes with more
walkthrough.

### GitHub Actions

```yaml
- uses: wirebench/wirebench/action@v2.3.0
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
  - remote: https://raw.githubusercontent.com/wirebench/wirebench/v2.3.0/templates/gitlab/wirebench.gitlab-ci.yml

api-tests:
  extends: .wirebench-run
  variables:
    WIREBENCH_VERSION: '2.3.0'
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
  ghcr.io/wirebench/wirebench-cli:2.3.0 run ./project --env staging --reporter junit=reports/wirebench.xml
```

The image (`linux/amd64` and `linux/arm64`) runs as the non-root `node` user with `WORKDIR /work`
and `ENTRYPOINT ["node", "/app/dist/bin.js"]`, so `run <path>` (and any other subcommand) follows
the image reference directly. Mount the project at `/work` (or a subdirectory of it) and pass
secrets with `-e`.

### npx

```bash
WIREBENCH_SECRET_BILLING_PASSWORD="$BILLING_PASSWORD" \
  npx --yes @wirebench/cli@2.3.0 run ./project --env staging --reporter junit=reports/wirebench.xml
```

Works on any CI runner with Node 24 already available and no other setup — the same package the
GitHub Action installs under the hood.

Each recipe above exits non-zero on a broken service (1) or a broken pipeline (2, 3), and the
JUnit report names the request and the assertion that failed.
