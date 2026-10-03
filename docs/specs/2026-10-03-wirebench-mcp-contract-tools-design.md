# Wirebench: a contract's operations as MCP tools — design

Date: 2026-10-03 · Status: design approved by the owner in conversation 2026-10-03 · Issue #33
(roadmap item 4, second step; milestone 3.0)

- Builds on:
  - `docs/specs/2026-09-29-wirebench-mcp-server-design.md` (#32): the ops layer
    (`packages/cli/src/ops/`), `wirebench mcp`, its gates, redaction and History shared by two
    writers. Its revisions R1–R10 hold here.
  - The XSD model and form model (`packages/engine/src/xsd/`: `buildForm`, `applyForm`), the sample
    generator, `validateMessage`, SOAP fault parsing (`soap/fault.ts`), effective auth
    (`project/endpoints.ts`), the OpenAPI loader and the REST contract check.
- Decisions recorded here (owner, 2026-10-03):
  - **Every operation is a tool, with a cap.** Every SOAP operation and REST endpoint in the project
    becomes one MCP tool. Above 128 tools, `wirebench mcp` refuses to start and names
    `--tools <container,…>` to narrow the set.
  - **Structured arguments.** A tool's input schema comes from the XSD (SOAP) or the OpenAPI JSON
    Schema (REST). Wirebench builds the envelope or the request, so the agent never writes XML.
  - **Built from the contract and its container.** A call is a temporary request, built the way the
    desktop builds a new request: the endpoint comes from the environment, and auth is inherited
    from the interface or API. It does not need a saved request and does not run a saved request's
    scripts or assertions.
  - **JSON out.** A SOAP response body comes back as JSON, read through the output message's XSD. A
    fault comes back as a structured `fault`. A REST JSON body comes back parsed.
  - **CLI parity.** `wirebench call` runs the same core as the tools.

## 1. Goal

An agent working against a legacy SOAP service (or a REST API) can call an operation by name, with
typed arguments, through the user's own Wirebench project. The project's environment, auth and
secrets apply, and every call lands in History. The agent never reads or writes an envelope.

### 1.1 In scope

- An engine bridge between XSD and JSON: a JSON Schema for an element, XML from JSON, and JSON from
  XML.
- A `contract-tools` module in the CLI that derives one tool per operation from the project. It
  sends through the engine as `send` does.
- Registering those tools in `wirebench mcp`, keeping them current as the project changes, and the
  `--tools` flag.
- `wirebench call`, and a `tool` field on `operations` rows.
- Docs: `docs/cli.md`, the "Agents (MCP)" guide, `docs/security.md`, `CHANGELOG.md` and the item 4
  status in `docs/roadmap.md`.

### 1.2 Not in scope

- gRPC and WebSocket operations. The issue names the XSD and JSON Schema. gRPC's proto contract
  can follow as its own issue.
- SOAP header parts as arguments. Headers come from the container's auth, WS-Addressing and
  WS-Security settings, as for a new request.
- Saved requests' scripts, assertions and callback captures. `send` remains the way to run a saved
  request.
- Non-JSON REST bodies as structured arguments. They are a `body` string (§3.2).
- MCP resources and prompts.
- Any desktop change. History already shows ad-hoc entries.

## 2. Tools

### 2.1 Which operations

- Every SOAP operation (one per binding operation, as `operations` lists them) and every REST
  endpoint in an OpenAPI-backed API becomes a tool.
- An interface whose definition is not cached, or an API whose document cannot be loaded, adds no
  tools. Its reason goes to stderr once per rebuild.
- `--tools <name,…>` keeps only the named containers (an interface or API, by name or slug).
  `--tools none` turns contract tools off. An unknown name is a usage error (exit 2).
- **Cap: 128 contract tools.** When the project (after `--tools`) yields more, `wirebench mcp`
  refuses to start (exit 2). The message gives the count per container and names `--tools`.
- The fixed tools from #32 are always there and do not count toward the cap.

### 2.2 Names

- `<container>_<operation>`: the container's slug, then the SOAP operation name or the REST
  `operationId`, or `<method>_<path>` when an endpoint has no `operationId`.
- Lower-cased snake_case. CamelCase is split on case changes. Every run of characters outside
  `[a-z0-9]` becomes one `_`, and leading or trailing `_` is dropped.
- At most 64 characters. A longer name keeps the operation part, cuts the container part, and
  then cuts the end.
- A name equal to a fixed tool's name, or to an earlier generated name, gets `_2`, `_3`, and so on.
  Names are assigned in `operations` order, so they are stable while the project is unchanged.
- One SOAP operation bound twice (for example SOAP 1.1 and 1.2 bindings) is two tools. The second
  gets the numeric suffix, and its description names the binding.

### 2.3 Description

- The operation's documentation: the WSDL `<documentation>`, or the OpenAPI `summary`, then its
  `description`. It is cut at 1,000 characters.
- Then a fixed line: which container it sends through, that it sends a real request and records
  it in History, and that it needs `--allow-send` (and, when `--env` is set, which environments).
- The text comes from the contract, which the user imported. It is data in a description, as
  `operations` already returns it.

### 2.4 Gates

- The tools are listed whatever the gates. A call without `--allow-send` is refused with
  `send-not-allowed`, as `send` is refused.
- Every tool takes an optional `environment` argument. It follows `send`'s rules: it is required
  when the project defines environments, and refused with `environment-not-allowed` when it is
  outside `--env`.

## 3. Input schemas

The tool's `inputSchema` is a JSON Schema object:

```json
{ "type": "object", "properties": { "environment": {…}, …operation arguments… }, "required": […] }
```

### 3.1 SOAP: the XSD-to-JSON bridge (`packages/engine/src/xsd/json-bridge.ts`)

- `jsonSchemaOf(schemaSet, element)` maps the input message's body element to JSON Schema. Each of
  the element's children becomes one top-level property. A part defined by `type` rather than
  `element` maps from that type.

| XSD | JSON Schema |
| --- | --- |
| `sequence`, `all` | `object`; `required` holds the particles with `minOccurs ≥ 1`; `additionalProperties: false` |
| `choice` | `oneOf`, one object per branch |
| `maxOccurs > 1` or `unbounded` | `array` of the item, with `minItems` and `maxItems` |
| `nillable="true"` | the type, or `null` |
| `string`, `token`, `anyURI`, dates, times | `string`, with `format: date`, `date-time` or `time` where it fits |
| `int`, `long`, `short`, `integer` families | `integer`, with the type's bounds |
| `decimal`, `float`, `double` | `number` |
| `boolean` | `boolean` |
| `base64Binary`, `hexBinary` | `string` with `contentEncoding` |
| facets `enumeration`, `pattern`, `min/maxInclusive`, `min/maxExclusive`, `length`, `min/maxLength` | `enum`, `pattern`, `minimum`/`maximum`, `exclusiveMinimum`/`exclusiveMaximum`, `minLength`/`maxLength` |
| attribute `a` | property `@a`; it is required when `use="required"` |
| simple content with attributes, and mixed content | property `#text` beside the `@` properties |
| a named complex type | `$defs/<type>`, referenced with `$ref`, which also handles recursive types |
| `xs:any`, `anyType` | `string`: an XML fragment, inserted as written after a well-formedness check |
| an XSD `pattern` that JSON Schema regex cannot express | left out of the schema; the XSD check (§3.3) still applies it |

- A property's `description` carries the element's `xs:documentation`, cut at 200 characters.
- Children with the same local name from different namespaces are both kept; the second becomes
  `prefix:name`.
- When a tool's schema is larger than 64 KB of JSON, the tool keeps it in full and a note goes to
  stderr. Agents vary in how much schema they read, and cutting it would break the calls.

### 3.2 REST

- The properties are `path`, `query`, `headers` and `body`. A property is present only when the
  operation declares something for it.
  - `path`: an object with one required string, number or integer property per path parameter,
    using the parameter's schema.
  - `query`: an object of the declared query parameters, with their schemas and `required` flags.
  - `headers`: an object of the declared header parameters. Headers that auth sets (`Authorization`,
    or the API key's header) are not listed, because the container's auth sets them.
  - `body`: the request body's JSON media type schema, resolved with its `$ref`s into `$defs`. When
    the body is not JSON, `body` is a string sent with the declared media type.
- Cookie parameters are not listed. A required cookie parameter adds a note to the description.

### 3.3 Checks before sending

1. The arguments are validated against the tool's own JSON Schema, using the engine's JSON Schema
   validator (the one the REST contract check uses). A violation is refused with `invalid-input`,
   listing each JSON Pointer and keyword.
2. A `${` in any string argument is refused with `invalid-input`. This is #32's ruling on the
   `send` body override: a placeholder would expand against the server's own environment.
3. SOAP: the built envelope's body is checked with `validateMessage` against the XSD. A problem is
   refused with `invalid-input`, listing each problem's path and message. Nothing is sent.

## 4. Sending

### 4.1 The temporary request

The tool builds the request the desktop would create for that operation, then fills in the
arguments. It is not saved.

- **SOAP:** the binding's SOAP version and action. The body is `xmlFromJson(schemaSet, element,
  args)`, which builds on the form model (`buildForm` → edits → `applyForm`), so namespaces,
  `elementFormDefault` and element order follow the XSD as the desktop's form does. The interface's
  WS-Addressing and WS-Security settings apply, as for a new request.
- **REST:** the method, and the path template filled from `path` with each value percent-encoded.
  `query` and `headers` are serialized in OpenAPI's default styles (`form` and `simple`, exploded).
  The body is the JSON of `body`, sent with the media type.
- **Endpoint:** the container's endpoint for the chosen environment, resolved as for a new request
  (`project/endpoints.ts` for SOAP, the API's base URL for REST). With no endpoint, the call is
  refused with `no-endpoint`, naming the container and environment.
- **Auth:** the effective auth a new request under that container inherits (`effectiveAuth`, and
  the REST `inherited` ladder). Secrets resolve from `WIREBENCH_SECRET_<name>` through
  `createEnvSecrets`. A missing secret is refused with `wirebench run`'s advice.

### 4.2 Through the engine

- The request goes through `runRequests` with `RunOptions.onSent`, as `send` does. Proxy, TLS,
  keystores and timeouts behave as they do for `send`.
- It runs no scripts, no assertions and no callback captures, because none were saved.
- History gets an ad-hoc entry built by `historyEntryFor`: no `requestId`, `requestName`
  `<operation> (MCP)` (or `(CLI)`), the interface or API name, the operation name and origin `mcp` or
  `cli`. The entry is redacted and capped as for `send`.

## 5. Results

```ts
interface CallResult {
  readonly tool: string;
  readonly operation: string; // the operations ref
  readonly kind: 'soap' | 'rest';
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean; // 2xx and no fault
  readonly durationMs: number;
  readonly headers: Readonly<Record<string, string>>; // lower-cased, redacted
  readonly result?: unknown; // the response body as JSON
  readonly fault?: { readonly code: string; readonly reason: string; readonly detail?: unknown };
  readonly body?: string; // raw body, only when `result` could not be built
  readonly bodyTruncated?: boolean;
  readonly notes: readonly string[]; // why `body` is raw, schema gaps met while reading
  readonly historyId?: string;
}
```

- **SOAP:** `jsonFromXml(schemaSet, element, xml)` reads the body's first child against the output
  message's element. It uses the same mapping as §3.1, in reverse:
  - Arrays come from `maxOccurs`, so one occurrence is still an array.
  - `integer`, `number` and `boolean` values are typed when they are lexically valid. Otherwise the
    value stays a string, with a note.
  - An element the XSD does not declare is kept as a string of its XML, with a note.
- **Fault:** `parseFault` gives `code` and `reason`. `detail` is read as JSON through the fault
  message's XSD when the WSDL declares one, or kept as an XML string otherwise.
- **REST:** a JSON body is parsed into `result`. Any other body is returned as `body` text.
- **Fallback:** when the body cannot be parsed, `body` carries the raw text, capped at
  `MAX_STORED_CHARS` as `send` caps it, and `notes` says why.
- **Redaction:** the result passes through #32's redaction step before it leaves the op. Secret-key
  redaction runs over the JSON, then each resolved secret value is masked in the serialized result.
- **Errors:** a response with a fault or a non-2xx status is a normal result (`ok: false`), not an
  `isError`. Refusals (`send-not-allowed`, `environment-not-allowed`, `invalid-input`, `no-endpoint`,
  `operation-gone`) and transport failures are `isError` results carrying `{ code, message }`, as
  for every op.

## 6. Keeping the tool list current

- The project is read fresh for every call, as for every op. A tool resolves its operation by its
  ref at call time. If the operation is gone, the call is refused with `operation-gone`.
- `wirebench mcp` watches the project directory (debounced 500 ms). On a change it rebuilds the
  contract tools. When the set of names or schemas differs, it re-registers them and sends
  `notifications/tools/list_changed` to every session. The server declares `tools.listChanged`.
- When a change takes the count over the cap, the contract tools are withdrawn (list_changed is
  sent, and a warning naming `--tools` goes to stderr). The fixed tools stay. The contract tools
  come back when the count falls under the cap again.
- The `import` op triggers the same rebuild through the watcher, so an agent can import a WSDL and
  then call its operations.

## 7. CLI

- `wirebench call <operation> [--args <json | @file>] [--env <name>] [--project <dir>] [--json]`
  - `<operation>` is the tool name or the `operations` ref.
  - `--args` defaults to `{}`. A path after `@` is read as JSON.
  - It is not gated, as `send` from the CLI is not.
  - Human output shows the status line, the fault if there is one, and `result` pretty-printed.
    `--json` prints the `CallResult`.
  - Exit codes: 0 when the call got a response, including a fault; 2 for usage or `invalid-input`;
    3 for a run error.
- `wirebench call <operation> --schema` prints the tool's input schema and sends nothing.
- `operations` rows gain `tool`: the generated name, or absent for WebSocket rows.
- `wirebench mcp` gains `--tools <name,… | none>`.

## 8. Module layout

- `packages/engine/src/xsd/json-bridge.ts`: `jsonSchemaOf`, `xmlFromJson` and `jsonFromXml`. These
  are pure functions, exported from the engine.
- `packages/cli/src/ops/contract-tools.ts`: `deriveContractTools(project, options)`, which returns
  `{ name, ref, description, inputSchema }[]` and the cap verdict. The naming rules (§2.2) live here.
- `packages/cli/src/ops/call.ts`: the `call` core, `(tool, args, context) => CallResult`. It builds
  the temporary request, sends it, records History and reads the result.
- `packages/cli/src/mcp/contract-tools.ts`: registers the tools, runs the watcher and sends
  list_changed.
- `packages/cli/src/commands/call.ts`: the CLI verb.

`registerTool` takes a zod schema, but these schemas are JSON Schema built at run time. The plan
picks how to register them: the SDK's low-level `tools/list` and `tools/call` handlers beside
`McpServer`, or a schema adapter. Either way the arguments are validated by §3.3, not by the SDK.

## 9. Testing

- **Bridge:** unit tests over fixture XSDs:
  - every row of the §3.1 table;
  - `choice`, recursion through `$defs`, nillable values, attributes and simple content;
  - qualified and unqualified `elementFormDefault`;
  - round trips: `jsonFromXml(xmlFromJson(x))` equals `x`, and `xmlFromJson` output passes
    `validateMessage`.
- **Derivation:** naming (case splitting, the 64-character cut, clashes with fixed tools, two
  bindings), `--tools` filtering, the cap verdict, and an uncached definition giving a note rather
  than an error.
- **Call:** against the `calculator.wsdl` and `pets.openapi.yaml` fixtures with a local stub server:
  - argument and XSD refusals, `${` refused, `no-endpoint`, the gates and `operation-gone`;
  - inherited auth applied, and a secret value masked in the result;
  - a fault returned as `fault`;
  - a History entry written as an ad-hoc entry.
- **MCP:** an in-memory client lists the fixed and contract tools and calls one, sees a gate
  refusal as `isError`, and receives `tools/list_changed` after an import. The server refuses to
  start above the cap.
- **CLI:** `call` with human and `--json` output, `--schema`, and the exit codes.
- No e2e. The desktop does not change.

## 10. Docs

- `docs/cli.md`: `wirebench call` and `wirebench mcp --tools`.
- The "Agents (MCP)" guide in `docs-site`: contract tools, naming, the cap, and a worked SOAP call.
- `docs/security.md`: contract text appears in tool descriptions; arguments are checked and never
  expanded.
- `CHANGELOG.md`, and the item 4 status in `docs/roadmap.md`.

## Revisions after planning

Checked against the code while writing `docs/plans/2026-10-03-wirebench-mcp-contract-tools-plan.md`.
The decisions above stand; these correct facts.

- **R1 — The JSON Schema validator does not follow `$ref`.** `validateJsonSchema`
  (`packages/engine/src/json/schema-validate.ts`, the validator the REST contract check runs on its
  worker) accepts any `$ref` without checking it, and does not assert `format`. It is not exported from
  the engine yet. §3.3 step 1 therefore validates the arguments against a copy of the tool's schema
  whose `#/$defs/…` references are replaced by the definitions themselves (a graph, which the validator
  walks under its own cycle and depth caps), in process. The published `inputSchema` keeps its `$ref`s.
- **R2 — The loaded OpenAPI document keeps only part of a schema, already dereferenced.** The document
  `loadOpenApiDocument` returns has every `$ref` inlined into one shared, possibly cyclic, object graph,
  and `parseSchema` (`rest/openapi/parse.ts`) keeps only `type`, `format`, `title`, `description`,
  `default`, `example(s)`, `enum`, `const`, `properties`, `required`, `items`, `additionalProperties`,
  `allOf`/`oneOf`/`anyOf`, `discriminator`, `nullable`, `deprecated`, `readOnly`, `writeOnly` and
  `xml`. So in §3.2 a REST tool's schema carries no numeric bounds, lengths or patterns (the server is
  the check for those), and "resolved with its `$ref`s into `$defs`" becomes: a schema node the graph
  reaches more than once (shared or recursive) becomes one `$defs` entry, named after its `title` or
  `Schema<n>`, since the component names are gone by then.
- **R3 — The engine already percent-encodes path and query values.** `composeUrl`
  (`rest/url.ts`) encodes every path-parameter and query value on send (a request's `encodeUrl`
  setting, on by default). §4.1's REST call fills the temporary request's path-parameter and query rows
  with the raw values; encoding them first would encode them twice.
- **R4 — Endpoints resolve in `project/environments.ts`, not `project/endpoints.ts`.** `endpoints.ts`
  holds `effectiveAuth`; the endpoint and the base URL resolve in `project/environments.ts`
  (`resolveEndpoint`, `resolveApiBaseUrl`) and, inside a workspace, through the workspace's
  environment, where one helper the run uses (`withActiveEnvironment`) is not exported. §4.1's
  `no-endpoint` is therefore the engine's own verdict on the send: SOAP's `endpoint-unresolved`, or
  REST's `rest-url-incomplete` with a `no-host` problem (no base URL and a relative path).
- **R5 — REST auth inherits through `resolveAuthChain`.** `project/inherit.ts`'s `inherited` is the
  settings ladder, not the auth one. A REST request whose auth is `inherit` takes its folders' and then
  its API's (`restEffectiveAuth`, built on `resolveAuthChain`); a SOAP request with no auth of its own
  takes its endpoint's and then its interface's (`soapEffectiveAuth`, built on `effectiveAuth`). The
  engine applies both when it sends, so the temporary request only leaves its own auth unset.
- **R6 — `operations` rows without a tool.** Besides WebSocket rows, `tool` is absent from a SOAP row
  whose interface has no readable cached definition, and from a REST row that `operations` lists from
  a saved request because the API's document is not cached: neither yields a tool (§2.1).
- **R7 — The form model writes no text in a complex element.** `applyForm` emits a `group` node's
  children and never a text value, so mixed content's `#text` (§3.1) is written by the bridge as a text
  node ahead of the element's children, and an `xs:any` fragment as a verbatim node; `applyForm`
  re-indents such a node line by line, so a fragment's own line indentation is not kept.
- **R8 — `buildForm` cuts recursion at a depth when nothing is written there.** A fresh form stops
  expanding a complex element past `maxDepth` (5) unless the source document goes that deep. The bridge
  builds the form, fills it, and when the arguments reach below a cut it builds the form again from the
  XML it wrote, one level deeper each round, up to 64 rounds.
- **R9 — A choice maps to joined properties and an `allOf`, not a bare `oneOf`.** A `choice` does not
  become a `oneOf` of whole objects: its branch properties join the parent object's `properties`, and
  the object gains `allOf: [{ oneOf: [...] }]` with one option per branch. Each option requires that
  branch's required keys (or at least one of its keys when none is required) and forbids every other
  branch's keys. When the choice is optional, or a branch can be empty, one more option forbids every
  branch key.
