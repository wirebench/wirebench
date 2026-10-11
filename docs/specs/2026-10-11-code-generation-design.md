# Code generation in common languages — design

Issue #337 (milestone 5.1 — Daily driver).

## Goal

The Code slide-over shows the request in front of the user as code they can paste into the application
they are building. Today it offers cURL only (plus grpcurl and websocat for gRPC and WebSocket). This
adds eleven targets and a `wirebench run` line, every one built from the same resolved request the
send and the cURL export use, so each language agrees with the wire.

## Owner decisions (2026-10-11)

- **Secrets are environment variable reads.** With Show secrets off, a credential is never resolved:
  the snippet reads it from the variable the CLI reads it from (`envVariablesFor`), e.g.
  `os.environ['WIREBENCH_SECRET_API_TOKEN']`. A `${secret:name}` token becomes a read of
  `WIREBENCH_SECRET_<NAME>`. With Show secrets on, auth values are resolved as the cURL export
  resolves them. Values the masker has recorded are masked as `<redacted>` in every mode, as today.
- **REST and SOAP** get every target. gRPC and WebSocket keep their own grpcurl and websocat commands.
- **One Language picker** replaces the Shell picker. It lists cURL (POSIX) and cURL (PowerShell), which
  keep today's generator unchanged, then the new targets. For gRPC and WebSocket only the two shell
  entries apply.

## Targets

| id | Label | Notes |
| --- | --- | --- |
| `curl-posix`, `curl-powershell` | cURL | Today's `restToCurl` / `soapToCurl`, unchanged |
| `js-fetch` | JavaScript — fetch | Node 18+ (`process.env`, `node:fs/promises`) |
| `node-axios` | Node.js — axios | `validateStatus: () => true` |
| `python-requests` | Python — requests | |
| `go-net-http` | Go — net/http | Only the imports the snippet uses |
| `java-httpclient` | Java — HttpClient | `java.net.http`; multipart built by hand |
| `java-okhttp` | Java — OkHttp | OkHttp 4 |
| `csharp-httpclient` | C# — HttpClient | Top-level statements |
| `php-curl` | PHP — cURL | |
| `ruby-net-http` | Ruby — Net::HTTP | |
| `powershell-irm` | PowerShell — Invoke-RestMethod | PowerShell 7, splatted |
| `httpie` | HTTPie | |
| `wirebench-run` | wirebench run | `wirebench run <project> <request path> [--env <slug>]` for the saved request |

A feature a library cannot express (for example, skipping TLS verification with `fetch`) becomes a
comment in the snippet plus a note under the preview. Nothing is silently dropped.

## Model

The engine adds `http/codegen/`, which is protocol-neutral:

- `CodeRequest`: method, URL, headers, body (`none | raw | form | multipart | binary`, the same shapes as
  `CurlBody`), optional Basic credentials, `insecure`, `followRedirects`, `maxRedirects` and `timeoutMs`.
- Strings may carry **environment markers** (`envMarker(name)`), which are alphanumeric so they survive
  URL encoding. Each target splits a string on the markers and renders the pieces as concatenated
  literals and environment reads in its own syntax.
- `generateCode(target, request, options)` → `{ code, notes }`. The options are `indent` (2, 4 or tab),
  `followRedirects` and `timeoutMs`; when an option is absent, the request's own value applies.
- `restCodeRequest(input)` builds a `CodeRequest` from a `RestSendInput`, using the send's own `applyAuth`,
  `composeUrl` and `rawContentType`. `soapCodeRequest(input)` builds one from a `SoapSendInput`, with the
  same headers as `soapToCurl`.
- `secretTokensToEnv(value)` deep-maps every `${secret:name}` in the input to its marker. It runs
  *before* the URL is composed.

## Desktop

- A new channel, `request.code { requestId, target, options, draft? }` → `{ code, notes? }`, for REST and
  SOAP. Main resolves the request through `previewRest` / `previewSoap` (with no secret read), and its
  auth comes in one of two ways. With Show secrets off, a placeholder auth carries an env marker for the
  variable named by `envVariablesFor(secretNeedsOfAuth(auth)[0])`. With it on, the auth is resolved as
  the cURL export resolves it. The output is passed through `redactSecretText` unless Show secrets is on.
  The cURL targets delegate to the existing curl path.
- `wirebench-run` is built in main: the project directory, the request's run selector (its on-disk path
  without `.request.yaml`, from the protocol module's run groups), and `--env <slug>` when an
  environment is active.
- Renderer: `slideOver.codeTarget` and `slideOver.codeSettings[target]` live in the persisted UI state,
  which is per user (it replaces `codeShell`, and is migrated from it). The settings row offers Indent,
  Redirects (As request / Follow / Don't follow) and Timeout (seconds; blank means as the request).
  The Copy as cURL commands keep using the cURL shell that was picked last.

## Tests

- One snapshot test per target (`toMatchFileSnapshot`) over a fixed set of requests: query, headers,
  JSON, form, multipart, binary, Basic, bearer from env, an API key in the query, insecure with no
  redirects, and a SOAP envelope.
- Unit tests for the env marker split, `secretTokensToEnv`, and `restCodeRequest` / `soapCodeRequest`.
- Main tests for `request.code`: env reads with Show secrets off, real values with it on, and the
  `wirebench run` line.
- A renderer test for the picker, its persistence, and the migration from `codeShell`.

## Out of scope

- #346, the preview of generated headers.
- gRPC and WebSocket targets beyond today's commands.
- NTLM, Kerberos and OAuth2 tokens in the new targets: each is noted rather than generated.
