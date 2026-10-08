# Mock recording proxy — design

Issue: [#60](https://github.com/wirebench/wirebench/issues/60). Roadmap item 11.
Plan: `docs/plans/2026-10-08-mock-recording-plan.md`.
Builds on: `2026-10-08-mock-services-design.md` (#59) and ADR-0021. The recorder writes stubs in that format
and changes nothing in it.

## Goal

A user points a client at a local port instead of the real system, and uses it as usual. Every exchange is
passed through to the real system unchanged. Each one that reaches a contract operation is also kept as a
stub of a mock. When the recording stops, the stubs are saved as ordinary response files under `mocks/`.
The mock can then stand in for the system it recorded. Watching a live exchange on the wire, which people
used a TCP monitor for, is the same proxy with its log on.

## Decisions (owner, 2026-10-08)

1. **Engine and CLI in this PR.** `wirebench mock record` is the first way to record. The desktop's
   *Record* button comes with #59's desktop PR, because the mock tab it belongs on is built there.
2. **A reverse proxy into one mock.** The recorder records into an existing mock, or into a new empty one
   generated for a named interface or API. Routing a request to an operation is the mock's own facet
   (`MockContract.route`), so recording and serving can never disagree about which operation a request
   calls.
3. **The upstream is a start option, never a file field.** The listening host is one already (ADR-0021).
   A shared `mock.yaml` therefore cannot send a teammate's traffic anywhere.

## Scope

- HTTP/1.1 on the listening side. The upstream may be `http:` or `https:`, with the engine's TLS and proxy
  options.
- SOAP and REST mocks. These are the protocols with a mock facet.
- Textual bodies (XML, JSON and text). A binary response is relayed but not recorded.

**Not in scope:** HTTPS on the listening side (#326 covers mocks), recording match conditions from the
request, a forward (`CONNECT`) proxy, and the desktop button (decision 1).

## Engine

```ts
function startRecorder(input: {
  project: Project; root: string; mockId: string;
  target: string;              // http(s) URL; the mock's path maps onto it
  host?: string; port?: number; // default 127.0.0.1, mock.yaml's port
  tls?: TlsOptions; proxy?: ProxyOptions; timeoutMs?: number;   // upstream; default 60 s
  secrets?: readonly string[]; // more values to mask in what is recorded
  fs?: FsLike; registry?: ProtocolRegistry;
  onExchange?: (event: RecordExchangeEvent) => void;
}): Promise<RunningRecorder>;

interface RunningRecorder {
  readonly url: string; readonly host: string; readonly port: number;
  recordings(): readonly MockRecording[];   // in arrival order
  stop(): Promise<void>;
}

interface MockRecording { operation: string; operationName: string; status: number;
  headers: readonly MockHeader[]; body: MockBodyLanguage; bodyText: string }

function addRecordedStubs(mock: MockDef, recordings: readonly MockRecording[],
  options?: { replace?: boolean; dedupe?: boolean; newId?: () => string }): RecordedStubs;
// → { mock: MockDef; added: number; skipped: readonly { operation: string; reason: string }[] }
```

### For each request

1. **The listener.** It is the mock server's listener, with its rules: `node:http`, loopback by default,
   the `Host` check (421), the 10 MiB body cap (413) and the 30 s timeouts.
2. **Path.** A request outside the mock's `path` gets 404 and is not forwarded. Otherwise the part after
   the mock's path is appended to the target's path, with the raw query. The target's origin is fixed, so no
   request path can change the host it goes to.
3. **Forward.** The request goes upstream through `sendHttp`. The method, the body and the headers are
   sent as received, except the hop-by-hop headers (`Connection`, `Keep-Alive`, `Proxy-*`, `TE`,
   `Trailer`, `Transfer-Encoding`, `Upgrade`, and any field `Connection` names), `Host`,
   `Content-Length` and the conditional headers (`If-None-Match`, `If-Modified-Since` and the rest).
   Without the conditional headers the upstream sends a full response to keep, not a 304. Redirects are not followed, and
   the body is decompressed. A method `sendHttp` does not send gets 501.
4. **Relay.** The client gets the upstream status, the headers without hop-by-hop fields, `Content-Encoding`
   or `Content-Length`, and the decompressed body. A HEAD reply keeps the upstream's `Content-Length`,
   and a 204 or 304 gets none. It is the real response: masking applies only to what
   is kept. An upstream failure gets 502 (504 on a timeout) with a plain-text reason. A response over 64 MiB
   also gets 502.
5. **Route.** A definition request (`?wsdl`) is relayed and not recorded. Any other request is routed with
   `contract.route(request, 'off', …)`. A refused route is relayed and not recorded, with the problem
   `mock-record-unrouted`.
6. **Keep.** The upstream response becomes a `MockRecording` (see [Masking](#masking)), unless the body is
   binary (`mock-record-binary`) or over the 5 MiB stub limit (`mock-record-too-large`).
7. **Log.** Every request ends in one `RecordExchangeEvent`. Its fields are the mock's `MockExchangeEvent`
   fields and `recorded: boolean`, with the same masking and 64 KiB cut.

### What a recording keeps

- **Status.** The upstream status.
- **Headers.** All of them, in wire order, except:
  - the ones the server computes (`MOCK_RESERVED_HEADERS`);
  - the hop-by-hop headers;
  - `Content-Encoding`, because the body is kept decompressed;
  - `Date`, because a replayed date would be stale.
- **Body language.** It comes from the `Content-Type`:
  - XML for `text/xml`, `application/xml` and any `+xml`;
  - JSON for `application/json` and any `+json`;
  - text for any other `text/*`, form-urlencoded, and a body without a `Content-Type`;
  - `none` for an empty body.

  Anything else is binary. The body is decoded with its charset. When that charset is not UTF-8, the kept
  `Content-Type` says `charset=utf-8`, because a stub file is UTF-8 and is sent byte for byte.

### Masking

The recorded stub is a file a team commits, so it must hold no credential. The engine's existing masks are
used, and they write the redaction marker:
- **Headers.** `redactHeaderPairs` masks `Set-Cookie`, `Authorization`, `Proxy-Authorization`, `Cookie`,
  `X-Api-Key` and Negotiate tokens in a challenge.
- **XML bodies.** `redactXml` masks `wsse:Password`, and `redactSecurityTokens` masks SAML signatures,
  ciphertext and Kerberos tokens.
- **JSON and form bodies.** `redactStructuredBody` masks the values under `SECRET_BODY_KEYS` (`password`,
  `access_token`, `client_secret`, and the rest of that list). A text body that parses as a JSON object
  or array gets the same mask, whatever its `Content-Type`. Any other text body is masked only by the known
  values below.
- **Known values.** `createSecretMasker(input.secrets)` masks each listed value, in all its encoded forms,
  in the header values and the body (with the XML marker in XML). The CLI passes every `WIREBENCH_SECRET_*`
  value.

The request is never written to the project. It is only relayed, and the log event masks it as the mock
log does.

### Saving

`addRecordedStubs` is pure. The caller saves the returned mock with `saveProject`. The save adds one response
file and its body file per stub, and rewrites an `operation.yaml` only when it creates the operation, sets
its default or, with `replace`, changes its responses.

- **Operation.** A recording goes into the operation whose `operation` key it routed to. If there is none, a
  new operation is created with the contract's name, a unique slug, `dispatch: sequence` and the first
  recording as its default.
- **Response.** Each stub is named `Recorded <status>`, made unique within the operation (`Recorded 200 2`),
  and placed after the operation's responses.
- **Dispatch.** An existing operation keeps its dispatch and default. With `sequence`, a recording therefore
  replays in the order it was recorded.
- **`dedupe`** (default on). A recording whose status, headers and body equal a response already in the
  operation, or an earlier recording in the same call, is skipped (`duplicate`).
- **`replace`.** An operation that gets at least one recording loses its other responses. A generated
  `Default` therefore stops answering in place of the recorded traffic. The new default is the operation's
  first recorded stub.
- **Limits.** ADR-0021's limits apply. A stub past the limit is skipped with its reason: `responses` for 500
  per operation, `operations` for 1000 per mock, and `bodies` for 64 MiB of bodies in the mock.

## CLI

```
wirebench mock record <path> <mock> --target <url> [--from <interface|api>] [--port <n>] [--host <addr>]
                      [--replace] [--no-dedupe] [--insecure]
```

- `<mock>` is a mock's name or slug.
  - If no mock has that name and `--from` names an interface or an API, the CLI generates a mock for it
    with that name and no operations (`generateMock`, with its operations dropped). Recording adds each
    operation it reaches, and the mock is saved when the recording ends.
  - With no such mock and no `--from`, exit 2.
- The upstream proxy comes from `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`, as for `run`. `--insecure` skips
  TLS verification.
- It prints `recording <listen url> -> <target>` to stderr, then one line per exchange:
  `<method> <url> <status> <operation|-> recorded|<reason>`.
- On SIGINT or SIGTERM it stops, adds the stubs and saves the project. It then prints
  `saved <n> stubs to mocks/<slug>/ (<m> skipped)` and exits 0. With nothing recorded it does not save.
- Exit 2 is a usage error, an unknown mock or an unknown `--from`. Exit 3 is a listen failure, an
  unsupported protocol or a missing definition cache.

## Security

1. **Loopback by default, `Host` checked.** These are the mock's rules. A web page cannot use the recorder
   as a relay into the network through DNS rebinding.
2. **One upstream origin, chosen by the user.** The target is a start option, never stored. The request
   path is appended to it, and a URL is never taken from the request, so the recorder is not an open
   proxy. Redirects are relayed, not followed.
3. **Credentials pass through, never into files.** The client's `Authorization` reaches the upstream, as
   it must. Requests are not recorded. Responses are masked as described in [Masking](#masking) before
   they become a `MockRecording`, so nothing unmasked reaches `addRecordedStubs` or the disk.
4. **Bounded.** The limits are 10 MiB per request, 64 MiB per relayed response, 5 MiB per stub, and the
   ADR-0021 counts. The upstream timeout is 60 s.
5. **Stubs stay data.** A recorded body is literal text, as every stub is. A `${…}` in a recorded body is
   never expanded.

`docs/security.md` gets a "Mock recording" subsection under "Mock services".

## Error codes

- **Start:** the mock's start codes, and `mock-record-target-invalid`, for a target that is not an
  absolute `http:` or `https:` URL, or that carries a user name or password.
- **Per exchange:** `mock-record-unrouted`, `mock-record-binary`, `mock-record-too-large` and
  `mock-record-upstream-failed`.

## Testing

- **Engine, with a fake facet and a local upstream server:**
  - path mapping and the 404 outside the mock's path;
  - which headers are forwarded and relayed;
  - a decompressed relay, and 502 and 504;
  - the host check;
  - a definition request and an unrouted request, relayed and not recorded;
  - a binary body and an oversized body;
  - masking of headers, of XML, JSON and form bodies, and of known values;
  - the charset rewrite.
- **`addRecordedStubs`:** a new operation, unique names and slugs, dedupe, `replace`, the three limits,
  and that the input mock is not mutated.
- **Round trip, with the real REST facet:** record through the proxy, save, load, start the mock, and get
  the recorded response back.
- **CLI:** argument errors, `--from`, and a recording session stopped with an `AbortSignal` that saves the
  stubs. These run in-process, with no child process.

## Docs

- `docs/cli.md` (the `mock record` command).
- `docs/security.md`.
- `docs/roadmap.md` (item 11's recording part).
- `CHANGELOG.md`.

## Follow-ups

- The desktop's *Record* button in the mock tab (#59, PR 2).
- Recording match conditions from the request, so that one operation's recorded responses are picked by
  request rather than in sequence.
