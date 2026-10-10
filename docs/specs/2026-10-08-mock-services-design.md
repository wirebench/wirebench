# Mock services — design

Issue: [#59](https://github.com/wirebench/wirebench/issues/59). Roadmap item 11.
Plan: `docs/plans/2026-10-08-mock-services-plan.md`. ADR: `docs/adr/0021-mock-stubs-are-files-under-mocks.md`.
Builds on: ADR-0003 (project format), ADR-0016 (scripts), ADR-0017 (protocol modules),
`2026-09-28-sequences-design.md` (#62, the per-file `version` precedent).
Later work on top of it: #60 (recording proxy, which writes stubs in this format) and #61 (headless
`wirebench mock`, which starts the engine's mock server from the CLI).

## Goal

A **mock service** answers SOAP or REST requests in place of a real system. It is generated from an
interface's WSDL or an API's OpenAPI document. Every incoming request is checked against that contract, and
a request that does not conform gets a SOAP fault or a 4xx. Each operation picks a response by sequence, at
random, by matching the request (XPath, JSONPath, query, header or path parameter), or with a sandboxed
script. A response can move a named scenario to its next state, so a mock can be stateful. The stubs are
plain files in the project, so they can be reviewed, diffed and merged like everything else in it.

## Decisions (owner, 2026-10-08)

1. **A per-file `version`, no `formatVersion` bump.** Mock files live in a new top-level `mocks/` folder,
   and each one carries `kind` and `version: 1`, as sequences do (ADR-0003, 2026-09-28 update). An older
   build never reads the folder and never deletes it. The roadmap's sentence that 5.0 is a major "because
   mock stubs are a new file kind" is corrected.
2. **Two pull requests.** PR 1 contains this spec, the plan, ADR-0021 and the engine `mock/` module with its
   protocol facets, all tested headless. PR 2 contains the desktop (the Mocks explorer group, the mock tab,
   start and stop, and the request log), the guide, and the e2e test. PR 2 closes #59.
3. **No lifecycle scripts and no response templating.** A script can only *dispatch*: pick a response and
   read or set scenario state. The roadmap also lists on-start, on-stop, on-request and after-request
   scripts, and responses that echo request values. Those are follow-up issues.

## Scope

- SOAP 1.1 and 1.2 over HTTP, from an interface's cached WSDL and XSDs.
- REST over HTTP, from an API's cached OpenAPI 3.x (or imported Swagger 2) document.
- Generating a mock with one operation per contract operation, each with one generated response.
- Request validation, with three modes: `reject` (the default), `report` and `off`.
- Dispatch styles: `sequence`, `random`, `match` and `script`, plus scenarios.
- `GET <path>?wsdl` serves the WSDL and its imports, with the addresses rewritten to the mock.
- `GET <path>/openapi.json` (or `.yaml`) serves the OpenAPI document and its referenced files, with the
  server URL rewritten to the mock (#324).
- The engine's `startMock()` runs on plain Node and needs neither Electron nor the desktop.

**Not in scope:**
- gRPC and WebSocket mocks. Their modules have no mock facet, and starting one is refused by name.
- Response templating and lifecycle scripts (decision 3).
- Recording (#60), the CLI command (#61), TLS and HTTPS, WS-Security on mock responses, and serving the
  OpenAPI document.
- Validating the stubs' own responses against the contract. Each of these can be added later without
  changing the version-1 file shape.

## Storage

```
my-service/
  wirebench.yaml
  interfaces/…
  apis/…
  sequences/…
  mocks/
    orders-mock/
      mock.yaml
      operations/
        place-order/
          operation.yaml
          accepted.response.yaml
          accepted.body.xml
          out-of-stock.response.yaml
          out-of-stock.body.xml
          dispatch.ts                 # only when dispatch: script
```

There is one folder per mock and one folder per operation, as interfaces have. Each **response is a file of
its own**, with its body in a file beside it in the body's own language. There are three reasons:
- two people adding responses to one operation edit two files;
- the recorder (#60) adds a stub by adding files and never rewrites a shared one;
- a body diffs as XML or JSON, never as an escaped string in YAML (ADR-0003's reason for `.xml` envelopes).

### `mock.yaml`

```yaml
kind: mock
version: 1
id: 01JB2M0CK000000000000000A1
name: Orders mock
order: 0
description: Stands in for the orders system in CI.
source:
  container: 01J9ZZ…          # an interface's or an API's id
  binding: '{urn:orders}OrderSoap12'   # SOAP only: which binding the mock speaks
port: 8089                    # 0 means any free port
path: /orders                 # SOAP: the endpoint path; REST: the prefix every operation path sits under
validation: reject            # reject | report | off
```

| Field | Meaning |
|---|---|
| `kind`, `version` | Always `mock`, and this file kind's own version, `1`. A higher `version` is refused as `mock-version-too-new`, and that mock alone is skipped. |
| `id`, `name`, `order`, `description?` | As for every other entity. The id comes from `generateId`. The folder's slug comes from `uniqueSlug` over the other mocks' slugs. |
| `source.container` | The id of the interface or API the mock implements. It is an id, never a path, so renaming the interface does not break the mock. Its protocol is the container's `kind`. |
| `source.binding` | SOAP only: the binding's QName in Clark notation, chosen when the mock is generated. A WSDL often has a SOAP 1.1 binding and a 1.2 binding with the same operations, and the binding decides the version, the SOAPActions and the fault shape. |
| `port` | 0–65535. The default for a new mock is 0. |
| `path` | Starts with `/`, with no `?` or `#`. The default is `/`. |
| `validation` | The default is `reject`. See [Validation](#validation). |

**The listening host is not in the file.** It is a start option that defaults to `127.0.0.1`. A file that
came from a teammate or a branch therefore cannot make your machine listen on every interface.

### `operation.yaml`

```yaml
id: 01JB2M0CK000000000000000B1
name: PlaceOrder
order: 0
operation: PlaceOrder          # the contract's key, see below
dispatch: match                # sequence | random | match | script
default: 01JB2M0CK000000000000000C1   # a response id, used when nothing else is picked
```

`operation` is the protocol's own key for one contract operation:
- SOAP uses the operation's name within `source.binding`.
- REST uses the lower-case method, a space, and the templated path as the document writes it:
  `post /orders/{id}`.

A key the contract no longer has still loads. The operation is reported as a start warning
`mock-operation-unknown`, and no request can reach it. `default` is optional. A default that names no
response is a load problem, and the field is dropped.

### `<slug>.response.yaml`

```yaml
id: 01JB2M0CK000000000000000C2
name: Out of stock
order: 1
status: 500
headers:
  - name: X-Trace
    value: mock
delayMs: 250
body: xml                      # xml | json | text | none
match:                         # used when the operation dispatches by match; every condition must hold
  - from: body
    language: xpath
    expression: //ord:sku
    namespaces: { ord: 'urn:orders' }
    equals: SKU-0
  - from: query
    name: dryRun
    exists: false
scenario:
  name: stock
  state: Empty                 # this response is a candidate only in this state
  next: Restocked              # sending it moves the scenario on
```

| Field | Meaning |
|---|---|
| `status` | 100–599. The default is 200. A generated SOAP fault uses 500, as SOAP 1.1 over HTTP requires. |
| `headers` | A list, so a name may repeat (`Set-Cookie`). If no `Content-Type` is given, the protocol's default is used. A header whose name or value holds CR, LF or NUL is a load problem. So are `Content-Length`, `Transfer-Encoding` and `Connection`: the server computes those. |
| `delayMs` | 0–60 000. The response is held this long before it is sent. |
| `body` | The language of the body file `<slug>.body.<xml|json|txt>`. With `none` there is no file and no body. A missing body file loads as an empty body and is a load problem. The body is sent byte for byte: no `${…}` is expanded (decision 3). |
| `match` | Up to 20 conditions (see [Dispatch](#dispatch)). |
| `scenario` | `name`, an optional `state` and an optional `next`. Each matches `^[A-Za-z0-9_.-]{1,64}$`. |

The loader opens a response's body only as `<slug>.body.<ext>` in the response's own directory. The slug
comes from the response file's own name and the extension from `body`, so a hand-edited file cannot point at
another path.

### Script file

`dispatch.ts` sits in the operation's directory and is read only when `dispatch: script`. The name is
fixed, so the file cannot name another path. It is TypeScript stripped to JavaScript, as request scripts are
(see [Script dispatch](#script-dispatch)). It must be no larger than 256 KiB.

### Loading, saving and the version

- **Discovery.** `readMocks(fs, root)` (in `mock/load.ts`) walks `mocks/*/mock.yaml`.
  - It never throws for a bad file. Each one becomes a project problem: `mock-file-invalid`,
    `mock-version-too-new` or `mock-duplicate-id`.
  - A bad `mock.yaml` skips the whole mock.
  - A bad operation or response file skips only that file. The rest of the mock loads.
- **A save never deletes a file it could not read.** This is the sequences rule.
  - For `mocks/`, "managed" means *loaded by this build*. So a save deletes only the files of mocks,
    operations and responses that this build loaded and the project no longer has.
  - A refused file (too new, malformed, or a duplicate) survives every save.
  - A save that would write over such a file is refused with `mock-file-conflict`.
- **No `formatVersion` bump** (decision 1).
  - `loadProject` gains `mocks` beside `sequences`.
  - An older build walks only the folders it knows, never lists `mocks/` as managed, and leaves it byte for
    byte. That holds for every build since 1.0, because `listManagedFiles` has always enumerated known
    folders only.
  - A later change to the shape of any mock file bumps that kind's `version`, and the loader refuses only
    the files that are too new for it.
- **Limits.** Each one is a `mock-file-invalid` problem for the file that breaks it:

  | Item | Limit |
  |---|---|
  | `mock.yaml`, `operation.yaml`, `*.response.yaml` | 64 KiB each |
  | A body file | 5 MiB |
  | Operations per mock | 1000 |
  | Responses per operation | 500 |
  | Match conditions per response | 20 |
  | Total body bytes per mock | 64 MiB (the responses past the cap are skipped) |

- Workspace sync carries the whole `projects/` tree, so mocks travel with no change there.

## Generating a mock

`generateMock(project, root, containerId, { name, fs?, registry? })` (in `mock/generate.ts`) returns a new
`MockDef` that has not been saved yet:

- one operation per contract operation (for SOAP, per operation of the chosen binding);
- `dispatch: sequence`;
- one response named `Default` per operation, which is also the operation's `default`.

For each protocol:
- **SOAP.** The binding is the first SOAP binding in the definition, the 1.1 one if both exist, unless the
  caller names one. The response is the operation's output message as a sample envelope. `buildSampleRequest`
  is generalised into `buildSampleMessage(input, op, 'input' | 'output')`, which uses the
  `<operation>Response` wrapper for RPC style. A one-way operation (one with no output) gets a response with
  status 202 and `body: none`.
- **REST.** The status is the lowest documented 2xx, or `default`, or 200. The body is that response's first
  named example, else a sample from its schema (`sampleFromSchema`, the request generator's own path), in
  JSON for a JSON media type and as text otherwise. A response with no content gets `body: none`.

The contract always comes from the container's **definition cache, read offline**: `readDefinitionCache`
for SOAP and `loadOpenApiDocument` for REST. A container whose definition is not cached fails with
`mock-definition-missing`, which tells the user to re-import with *Cache definitions* on. Generating a mock and
running one therefore never touch the network, and a mock behaves the same in CI as on a laptop.

## Running a mock

```ts
function startMock(input: {
  project: Project; root: string; mockId: string;
  host?: string;            // default 127.0.0.1
  port?: number;            // overrides mock.yaml's port
  fs?: FsLike; registry?: ProtocolRegistry; sandbox?: ScriptSandbox;
  onExchange?: (event: MockExchangeEvent) => void;
}): Promise<RunningMock>;

interface RunningMock {
  readonly url: string;          // http://127.0.0.1:8089/orders
  readonly port: number;
  readonly warnings: readonly MockWarning[];   // mock-operation-unknown, …
  reset(): void;                 // scenarios back to their start, sequence counters to 0
  stop(): Promise<void>;         // closes the listener and every open connection
}
```

- **The listener.** It uses `node:http`, so there is no new dependency.
  - Header and request timeouts are 30 s.
  - A request body over 10 MiB is refused with 413.
  - An open port is refused with `mock-port-in-use`, and any other listen error is `mock-listen-failed`.
  - A host other than loopback is allowed only when the caller passes it (the CLI's container mode, #61).
- **Host check.** When the mock listens on loopback, a request whose `Host` is not `localhost`,
  `127.0.0.1`, `[::1]` or the bound address is refused with 421. That stops a web page in the user's
  browser from reading the mock through DNS rebinding. The MCP loopback server has the same rule.
- **For each request:**
  1. The protocol facet serves the definition if the request asks for it.
  2. Otherwise it routes the request to an operation and validates it.
  3. Core dispatches to a response, applies the response's scenario `next`, waits `delayMs` and writes the
     reply.
- **The log.** Every request ends in one `MockExchangeEvent`:
  `{ id, at, method, path, operation?, responseId?, responseName?, status, durationMs, problems, error? }`,
  plus the request's and response's headers and bodies, each cut to 64 KiB with a `truncated` flag. The
  desktop's request log reads it, and the CLI prints it.
- **State.** The sequence counters and the scenario states belong to one running mock. They start empty;
  every scenario starts in the state `Started`. `reset()` clears both, and a restart starts fresh. Nothing
  is written back to the project.
- **Concurrency.** Requests are handled concurrently. A dispatch decision and its scenario change are made
  synchronously after the asynchronous match or script work, so two requests never both take one
  sequence slot.

### The protocol facet

ADR-0017 keeps core free of protocol code (`pnpm check:engine-layers`). So the mock core in `mock/` holds
the files, dispatch, scenarios and the server, and each protocol supplies a new optional facet on
`ProtocolModule`:

```ts
interface ProtocolMocking {
  /** Loads the contract for one mock, from the container's definition cache. */
  open(input: { project: Project; root: string; fs: FsLike; mock: MockDef }): Promise<MockContract>;
  /** The operations and default responses for a new mock. */
  generate(input: { project: Project; root: string; fs: FsLike; containerId: string;
                    binding?: string }): Promise<GeneratedMock>;
}

interface MockContract {
  readonly operations: readonly { key: string; name: string }[];
  /** The binding and SOAP version, for log display. */
  readonly summary: string;
  /** A definition document the request asks for (`?wsdl`), or undefined. */
  definition(request: MockRequest, baseUrl: string): MockReply | undefined;
  /** Which operation the request calls, the problems validation found, and what match conditions read. */
  route(request: MockRequest, mode: MockValidation): Promise<MockRoute>;
  /** The reply for a request that failed validation or reached no operation. */
  refuse(route: MockRoute): MockReply;
  /** The reply for a failure in the mock itself: no stub, no response, a failed script. */
  fail(code: string, message: string, route: MockRoute): MockReply;
  /** Default headers for a stub's reply (Content-Type by protocol and body language). */
  defaults(response: MockResponse): readonly HeaderPair[];
}
```

`soap/mock.ts` and `rest/mock.ts` implement the facet, and `soapProtocol` and `restProtocol` register it. gRPC
and WebSocket have no facet, so `startMock` and `generateMock` refuse their containers with
`mock-protocol-unsupported`.

## Validation

`validation: reject` answers a non-conforming request with a fault or a 4xx. `report` dispatches it anyway
and puts the problems in the log. `off` skips the contract check; a SOAP request must still name an
operation, and a REST request must still match a path.

### SOAP

- **Version.** The request's `Content-Type` must be the binding's: `text/xml` for 1.1,
  `application/soap+xml` for 1.2. Otherwise:
  - 415 with a fault in the binding's version, under `reject`;
  - a problem in the log, under `report`.
- **Routing**, in order:
  1. The SOAPAction: the 1.1 header, or the `action` parameter of the 1.2 `Content-Type`. It is matched
     against the binding's operations' `soapAction`.
  2. The first child of the `Body`: its QName is matched against the operation's input element
     (document/literal) or the RPC wrapper name.

  If they disagree, the body wins and the mismatch is a problem. If neither identifies an operation, the
  reply is a `Client` fault (1.1) or a `Sender` fault (1.2) with HTTP 500: "No operation of `<binding>` matches
  this request".
- **Contract check.** `validateMessage({ direction: 'request', … })` checks the SOAP structure, the version,
  the SOAPAction and the Body's children against the XSDs, with libxml2 on its worker under its own time
  budget. Under `reject`, problems give a `Client` or `Sender` fault with HTTP 500.
  - The `faultstring` (1.1) or `Reason` (1.2) is "The request does not conform to the contract".
  - The `detail` holds `<wb:problem line=".." column="..">message</wb:problem>` elements in the
    `urn:wirebench:mock` namespace, at most 20.
- **No DTD.** A request that carries a document type declaration is refused before it is parsed, whatever
  the mode. SOAP 1.1 (§3) and SOAP 1.2 (part 1, §5) forbid one in a message, and refusing it keeps entity
  tricks away from both xmldom and libxml2 (see [Security](#security)).

### REST

- **Routing.** `matchOperation(operations, method, url, [mockUrl])` finds the operation; a concrete path
  wins over a templated one.
  - No path matches: 404.
  - The path matches under another method: 405, with `Allow`.
- **Contract check** (a new `rest/request-check.ts`, the request-side counterpart of `contract-check.ts`),
  under the same limits:
  - **Path, query, header and cookie parameters.** Required ones must be present. Each value is converted to
    the parameter schema's primitive type: `integer`, `number`, `boolean`, or an array of them for a repeated
    query parameter, under the `form` style, which is the only one this slice parses. The value is then
    validated with `validateJsonSchema`. Another style is checked only for presence, with a
    "style not checked" note.
  - **Body.** A required body must be present.
  - **Content type.** The request's `Content-Type` must match one of the operation's request media types
    (exact, then `type/*`, then `*/*`); otherwise 415.
  - **JSON bodies** (any `+json` too) are parsed and validated against the media type's schema, with
    `validateJsonSchema(..., { redactValues: true })`. The problems name paths and keywords, and the values
    are left out.
- **Refusal.** Under `reject`, a request that fails is answered with 400 (404, 405 or 415 as above), as
  `application/problem+json`:
  `{ "type": "urn:wirebench:mock:request-invalid", "title": "The request does not conform to the contract",
  "status": 400, "errors": [{ "in": "query", "name": "limit", "path": "", "message": "…" }] }`.
  There are at most 20 errors.

## Dispatch

An operation's **candidates** are its responses, in `order`, whose `scenario.state` is absent or equals that
scenario's current state. Then:

| `dispatch` | Picks |
|---|---|
| `sequence` (default) | The next candidate in turn, wrapping round; one counter per operation. |
| `random` | A uniformly random candidate (`crypto.randomInt`). |
| `match` | The first candidate whose every `match` condition holds. A candidate with no conditions always matches, so it acts as a catch-all. |
| `script` | The candidate the script names (see below). |

If nothing is picked, the operation's `default` is used, whatever its scenario state. Failing that:
- for an operation with no responses at all, the reply is `mock-no-stub`;
- otherwise it is `mock-no-response`.

Both go through the facet's `fail()`: a `Server` or `Receiver` fault for SOAP, and 501 or 500 as
`application/problem+json` for REST. The response that is sent moves `scenario.name` to `scenario.next`, if it
has one.

**Match conditions** read what the facet's route exposed:

```ts
type MockMatch =
  | { from: 'body'; language: 'xpath' | 'jsonpath'; expression: string; namespaces?: Record<string, string> } & Check
  | { from: 'query' | 'header' | 'path'; name: string } & Check;   // path: a REST path parameter
type Check = { equals?: string; matches?: string; exists?: boolean };  // none given: exists: true
```

- `body` evaluates with `evaluateWithTimeout`, on the worker the assertions use, and compares the first item's
  string value (an element's text content, not its markup). A missing `namespaces` falls back to the
  request's own prefixes.
- `matches` uses `matchRegexWithTimeout`, so a catastrophic pattern from a shared file cannot block the
  server.
- An expression that fails to compile, or that times out, makes the condition false, and the log records a
  `mock-match-failed` problem.
- `query` and `header` take the first value; a header name is case-insensitive. `path` is REST only, and on
  SOAP it is always false.

### Script dispatch

`dispatch.ts` runs in the ADR-0016 sandbox (QuickJS on the shared worker, a fresh runtime per run, 1 s, 64 MiB)
with its own prelude:

```ts
declare const request: {
  readonly operation: string; readonly method: string; readonly path: string;
  readonly query: Readonly<Record<string, readonly string[]>>;
  readonly headers: readonly (readonly [string, string])[];
  readonly pathParams: Readonly<Record<string, string>>;
  readonly body: string;                 // as text, at most 1 MiB
};
declare const scenarios: { get(name: string): string; set(name: string, state: string): void };
declare const responses: readonly { readonly id: string; readonly name: string }[];  // the candidates
declare function respond(name: string): void;
declare function log(...values: unknown[]): void;
// plus crypto and encoding, as for request scripts. There is no vars, props or secrets: a mock holds none.
```

- The script picks with `respond(name)`. Without a call, the operation's `default` is used. A name that is not
  a candidate fails with `mock-script-failed`.
- Scenario changes from `scenarios.set` apply after the script ends and before the chosen response's own
  `next`.
- A script error, a timeout or an out-of-memory failure is `mock-script-failed` (500, or a `Server` fault),
  with the sandbox's message in the log.
- A mock whose operations use scripts starts the sandbox lazily, on the first script request. `stop()`
  disposes of it unless the caller passed its own.

## Serving the WSDL

`GET <path>?wsdl` (the key is case-insensitive and has no value) returns the root WSDL with
`Content-Type: text/xml; charset=utf-8`:
- Every `soap:address` and `soap12:address` `location` in it is rewritten to the mock's URL.
- Every `wsdl:import/@location`, `xsd:import/@schemaLocation` and `xsd:include/@schemaLocation` that resolves
  to a bundled document is rewritten to `<mock url>?wsdl=<n>` (WSDL) or `?xsd=<n>` (XSD). Here `n` is the
  document's index in the bundle. `GET ?xsd=<n>` serves that document, rewritten the same way.

Only bundle documents can be served, by index, so a request cannot name a path or a URL. A reference that
resolves to nothing in the bundle is left as it is. Serving needs `GET`; any other method on
`?wsdl` is treated as an ordinary request.

## Serving the OpenAPI document

Added by #324. `GET <path>/openapi.json` returns the API's cached root document as JSON
(`Content-Type: application/json`), and `GET <path>/openapi.yaml` returns it as YAML
(`application/yaml`), whichever format it was cached in:
- An OpenAPI 3 document's top-level `servers` becomes the mock's URL alone, and so does every path-level or
  operation-level `servers` it has. A Swagger 2.0 document gets the mock's `host`, `basePath` and `schemes`.
- Every `$ref` whose document part resolves to a cached document is rewritten to `<mock url>/openapi/<n>.json`
  (or `.yaml`, following the request), its fragment kept. Here `n` is the document's index in the cache's
  manifest, root first. `GET <path>/openapi/<n>.json` (or `.yaml`) serves that document, rewritten the same way.

Only cached documents can be served, by index, so a request cannot name a path or a URL. A reference that
resolves to nothing in the cache is left as the document wrote it. No document's own location is ever
written into a reply, since a location may carry a credential in its query or user info; the document is
otherwise the cached text as fetched, and a mock holds no secret that could be put into it. Serving needs
`GET`. If the API itself documents a `GET` at one of these paths, that request is routed to the operation
instead, so a mock never shadows the contract it implements. A recording proxy relays these requests and
does not record them, as it does `?wsdl`.

## Security

A mock adds the first listening socket to the engine, and three kinds of untrusted input:
- requests from whatever can reach the port;
- stub files from teammates or a pulled branch;
- dispatch scripts.

1. **Loopback by default, and never chosen by the file.** The host is a start option only. On loopback,
   the `Host` check refuses DNS-rebound requests with 421.
2. **Bounded requests.** These limits keep a hostile client from exhausting memory or holding the
   server's sockets:
   - a 10 MiB body;
   - 30 s for the headers and for the whole request;
   - libxml2 validation on its worker with a time budget;
   - JSON Schema validation inside `MAX_VALIDATE_NODES`;
   - XPath, JSONPath and regular expressions on the evaluation worker with 5 s budgets.
3. **XML without a DTD.** A SOAP request that contains `<!DOCTYPE` is refused with a `Client` or `Sender`
   fault before any parser sees it, as the SOAP specifications require. A billion-laughs or XXE body is
   therefore a fault, not a hang and not a file read.
4. **Stubs are data.** A stub file is untrusted input, parsed and checked like a sequence file:
   - the size is checked first;
   - the YAML uses the core schema;
   - it is validated with zod and the limits above;
   - its slugs pass the ADR-0005 path rules;
   - a body is served literally and never expanded, so a stub cannot read a property, a secret or an
     environment variable;
   - a header with CR, LF or NUL is refused at load, so a stub cannot split a response.
5. **Scripts run with no capabilities** (ADR-0016). A dispatch script sees the request and the scenario
   states, and nothing else. It has no secrets, no properties, no network, no files and no timers.
6. **What the log carries.** A request and a stub reply hold no project secrets, because the mock has none.
   But a client may send credentials (`Authorization`). The log therefore masks `Authorization`,
   `Proxy-Authorization`, `Cookie` and `Set-Cookie` values with the engine's header redaction before an event
   leaves the engine. The desktop shows the masked event.
7. **What this does not change.** A mock binds a port only when the user starts it. It sends nothing; a
   recording proxy that forwards traffic is #60, and it will have its own section.

`docs/security.md` gets a "Mock services" section with these rules and the tests that prove them.

## Error codes

- **Load problems:** `mock-file-invalid`, `mock-version-too-new` and `mock-duplicate-id`.
- **Save error:** `mock-file-conflict`.
- **Start and generate errors:** `mock-not-found`, `mock-container-missing`, `mock-protocol-unsupported`,
  `mock-definition-missing`, `mock-port-in-use` and `mock-listen-failed`.
- **Start warnings:** `mock-operation-unknown` and `mock-binding-unknown`. With `mock-binding-unknown` the
  start fails.
- **Request problems, which appear in the log and in the reply:** `mock-request-invalid`,
  `mock-operation-not-found`, `mock-no-stub`, `mock-no-response`, `mock-script-failed`, `mock-match-failed`,
  `mock-request-too-large` and `mock-host-refused`.

## Desktop (PR 2)

- **The explorer.**
  - A project with mocks gets a **Mocks** group after Sequences.
  - *New Mock…* sits on the project menu and on an interface's or API's menu. It asks for a name and, for a
    WSDL with several bindings, a binding. It then generates and saves the mock and opens its tab.
  - A mock's menu offers *Open*, *Start* or *Stop*, *Rename…*, *Duplicate* and *Delete*.
  - A running mock shows a running badge and its URL.
- **The mock tab.**
  - The header holds the name, the port, the path, the validation mode, *Start* or *Stop*, the URL with
    *Copy*, and *Reset state*.
  - The operations list sits on the left, with each operation's dispatch style.
  - The selected operation shows:
    - its responses (*Add*, *Duplicate*, *Remove*, reorder, and set as default);
    - the selected response's status, headers, delay, scenario and match conditions;
    - its body in the editor, in its language.
  - *Script* opens `dispatch.ts` in the script editor, with the dispatch API's types.
  - Edits apply at once, through `project.mutate`, as on a sequence tab.
- **The request log**, below the operations. It has one row per `MockExchangeEvent`: time, method, path,
  operation, response, status and duration, with problems shown inline. Selecting a row shows both sides.
  *Clear* empties the list. A log is kept for the session and is not persisted.
- **Main process.**
  - `main/mock-runner.ts` keeps the running mocks, at most one per mock id. It restarts a running mock when
    its project changes.
  - It stops every mock when its project closes and when the app quits.
  - The IPC is `mock.start`, `mock.stop`, `mock.reset`, the event `mock.exchange` and the event `mock.state`.
  - `project-watch` manages `mocks/`.
- **Preferences.** *Mock services → Listen on all interfaces* is off by default. When it is on, the mock
  binds `0.0.0.0` and the tab shows a warning.

## Testing

- **Files.** These tests cover the mock files:
  - schema round-trip, key order and determinism;
  - every limit, version refusal and duplicate ids;
  - body files by language, and a missing body;
  - header refusals;
  - a format-v8 project with a `mocks/` folder, opened and saved with `formatVersion` unchanged;
  - a refused file surviving a save, and `mock-file-conflict`.
- **Generate.** SOAP document/literal, RPC and one-way operations; a WSDL with two bindings. REST with
  example, schema sample and no-content responses.
- **SOAP facet.** These run over real HTTP with the fixtures' WSDLs:
  - routing by SOAPAction, by body QName, and on a disagreement;
  - every validation mode;
  - the 1.1 and 1.2 fault shapes;
  - wrong content type;
  - `?wsdl` and `?xsd=n` with the addresses and imports rewritten;
  - a DTD body refused.
- **REST facet.** These cover:
  - 404 and 405 with `Allow`, and 415;
  - each parameter type's conversion and validation;
  - a missing required parameter or body;
  - JSON body problems with values redacted.
- **Dispatch.**
  - `sequence` wraps, `random` stays within the candidates (with a seeded `randomInt`), and `match` covers
    each source and check;
  - a regex timeout does not block a timer;
  - scenarios: state filtering, `next`, and `reset()`;
  - the `default` fallback, `mock-no-stub` and `mock-no-response`;
  - two concurrent requests take two sequence slots.
- **Script.** `respond`, `scenarios.get` and `set`, an unknown name, a timeout and an error.
- **Server.**
  - the host check, the 413 cap, `delayMs`, and `stop()` closing keep-alive connections;
  - port in use;
  - the log event's masking and truncation;
  - `startMock` refusing a gRPC container.
- **Desktop (PR 2).** The runner and IPC in main, the renderer tab and log, and one e2e test: generate a REST
  mock, start it, `fetch` it, and see the row.

## Docs

- `reference/project-format.md`: the `mocks/` folder and its files.
- ADR-0021, and an ADR-0003 update.
- `docs/security.md`: "Mock services".
- `docs/roadmap.md`: correct the "major because" sentence, and mark item 11's first part.
- `CHANGELOG.md`.
- PR 2: `docs-site/.../guides/mock-services.mdx`, a sidebar entry, and the success-criteria rows.

## Follow-ups (issues to open)

- Lifecycle scripts (start, stop, on-request and after-request) under ADR-0016 (#322).
- Response templating from request values, under ADR-0015's rules turned around (#323).
- Serving the OpenAPI document from a REST mock (#324).
- Validating stub responses against the contract, as a lint in the mock tab (#325).
- HTTPS mocks (#326).
- Generated REST response stubs keep `readOnly` properties (#327).
