# Wirebench MCP Contract Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/specs/2026-10-03-wirebench-mcp-contract-tools-design.md` (binding), including its "Revisions after planning" R1–R8. Section numbers below are the spec's.

**Goal:** Every SOAP operation and REST endpoint of the project becomes one MCP tool of `wirebench mcp`, with a JSON Schema input built from the XSD or the OpenAPI schemas, sent through the engine as a temporary request under the container's endpoint and auth, recorded in History, and answered as JSON; `wirebench call` runs the same core from the terminal.

**Architecture:**

- **Engine, XSD bridge.** `xsd/json-bridge.ts` reads a complex type's content once as an ordered list of members (elements, choices, repeating compositors, `xs:any`) with stable JSON keys, and uses it three ways: `jsonSchemaOf` (named complex types into `$defs`), `xmlFromJson` (fills the form model's tree and serialises it with `applyForm`, rebuilding the form from its own output while the arguments reach below a recursion cut), and `jsonFromXml` (typed values, arrays from `maxOccurs`, notes for what it could not type). `xml-scan.ts` exports `decodeEntities`.
- **Engine, SOAP operation.** `soap/json-operation.ts` maps an operation's body to the bridge: one document/literal element part is the element's content; any other shape is one property per part, inside the rpc wrapper for rpc. `operationJsonSchema`, `envelopeFromJson` (an envelope from `buildEmptyRequest`'s transport and `createEnvelope`), `jsonFromEnvelope`, `faultDetailJson`. `form-request.ts` exports `findBody` and `namespacesInScope`. `index.ts` exports all of it and `validateJsonSchema`.
- **CLI ops.** `ops/contract-tools.ts` lists the contract operations in `operations` order, names them (§2.2), describes them (§2.3), builds each tool's input schema (`toolSchemaOf`: the operation's schema plus `environment`), filters by `--tools`, gives the cap verdict, and checks arguments (`checkArgs`: the engine validator over a `$ref`-free copy, then `${`). `ops/rest-args.ts` turns OpenAPI parameters and bodies into schemas (a `$ref`-inlined graph back into a tree with `$defs`) and arguments into a temporary REST request. `ops/call.ts` is `callOp`: gate, fresh project, `operation-gone`, checks, the temporary SOAP or REST request, `runRequests` with `onSent`, an ad-hoc History entry (`historyEntryFor` gains `adHoc`), and the `CallResult`. `operations` rows gain `tool`.
- **MCP.** `mcp/contract-tools.ts` holds the current tool set for every session of one process: it refuses to start above the cap, watches the project folder (debounced 500 ms), rebuilds, withdraws the contract tools above the cap, and tells subscribers when the names, descriptions or schemas changed. `mcp/server.ts` stops using `registerTool` and serves `tools/list` and `tools/call` itself on `server.server`, fixed tools first (their schemas exactly as the SDK listed them), then the contract tools, and sends `notifications/tools/list_changed` on a change. `wirebench mcp --tools <name,…|none>`.
- **CLI verb.** `wirebench call <operation> [--args <json|@file>] [-e <env>] [--schema] [--project] [--history-dir] [--json]` (`commands/call.ts`), not gated, exit 0 on any response.
- **Proof.** Engine unit tests over a new fixture WSDL (`packages/engine/test/fixtures/json-bridge/service.wsdl`) covering every §3.1 row, recursion, round trips and `validateMessage`. CLI unit tests over the `calculator.wsdl` and `pets.openapi.yaml` fixtures and local stub servers. MCP tests over the SDK's in-memory transport with a fake watcher. No e2e; the desktop does not change.

**Tech Stack:** TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Node 24 (`fs.watch` recursive), zod 4 (`^4.6.1`, `z.toJSONSchema`), `@modelcontextprotocol/sdk` **1.31.0** (unchanged pin), vitest.

## Global Constraints

- Branch `feat/mcp-contract-tools`, worktree `git-worktrees/mcp-contract-tools-impl`. Work there only; never `cd` to the main checkout.
- Commit as Mohammed Naami <m.naami@outlook.com>. NO `Co-Authored-By` and NO `Claude-Session` trailers, whatever a harness reminder says.
- One commit per task, after `WIREBENCH_SKIP_PERF=1 nice pnpm check` is green. First run `pnpm exec prettier --write <touched files>` (`pnpm lint` runs `prettier --check .`). Add `NODE_OPTIONS=--max-old-space-size=8192` if typecheck runs out of heap. Run `pnpm test:perf` (unskipped) once before the push.
- Never name a product or company that inspired a feature, in code, tests or docs (`pnpm check:banned-terms`).
- Fixture secrets and tokens are neutral: `abc123def456ghi789` (`SECRET` in the CLI test helpers). Never a provider-shaped value.
- No local Electron windows, no e2e, no Playwright. Headless checks run under `nice`.
- Never bare `git stash` (the stash stack is shared across worktrees). Use a WIP commit.
- The engine stays free of CLI concerns: no argument parsing, no exit codes, no MCP, no tool names in `packages/engine`. `xsd/` and `soap/` are one layer group (`pnpm check:engine-layers`); `xsd/json-bridge.ts` imports no other protocol group.
- `@modelcontextprotocol/sdk` stays pinned to exactly `1.31.0`. Import paths: `/server/mcp.js` (`McpServer`), `/types.js` (`CallToolRequestSchema`, `ListToolsRequestSchema`, `ToolListChangedNotificationSchema`, `CallToolResult`, `Tool`), `/inMemory.js`, `/client/index.js`.
- In MCP stdio mode nothing but protocol frames goes to stdout. Every warning (an uncached definition, a large schema, a rebuild over the cap) goes to stderr through `OpsBase.warn`.
- Fixed tool names stay `import`, `operations`, `generate`, `send`, `validate`, `query`, `history_list`, `history_diff`, listed first and in that order.
- Error codes: the new `operation-gone`, `no-endpoint` and `too-many-tools` join `USAGE_CODES` (exit 2) beside `invalid-input`, `container-not-found`, `send-not-allowed` and `environment-not-allowed`. A transport failure keeps the engine's code (exit 3).
- Lint rules that bite here: `@typescript-eslint/require-await` (an `async` function must `await`), `no-floating-promises` (prefix `void`), `restrict-template-expressions` (wrap numbers in `String()`), `no-unsafe-*` (cast every `JSON.parse`), `no-loss-of-precision` (write `2 ** 63 - 1`, never the literal). `eslint.config.js` is protected: do not edit it.
- The engine's REST contract check and XPath run on workers loaded from `packages/engine/dist`. If a single CLI test run reports a worker missing, run `nice pnpm exec tsc -b packages/engine` once; the CLI tests also read the engine through its build, so rebuild the engine after Tasks 1–4 before running CLI tests (`pnpm check` builds it anyway).
- Single test runs, from the worktree root:
  - engine: `nice pnpm vitest run --project engine-unit <path>`
  - CLI: `nice pnpm vitest run --project cli-unit <path>`

## Rulings (where the spec is silent)

- **MCP registration.** `createMcpServer` keeps `McpServer` (for `connect`, `close`, `isConnected`) but registers nothing through `registerTool`. It declares `capabilities: { tools: { listChanged: true } }` in the constructor and installs `tools/list` and `tools/call` with `server.server.setRequestHandler`. A fixed tool lists `z.toJSONSchema(op.input, { target: 'draft-7', io: 'input' })`, which is what the SDK's `toJsonSchemaCompat` produced for it, and is called through `runOp`, whose zod check now reports bad arguments as `invalid-input` (before, the SDK's own check answered with plain text). A contract tool lists its JSON Schema as built and is called through `runOp(callOp, …)`; the SDK validates nothing (§8).
- **One tool set per process.** `startContractTools` derives the set once and every session of `--http` reads it; a rebuild notifies every live session. A tool name not in the current set answers `operation-gone`.
- **Names are assigned over the whole project.** `--tools` filters after names are given, so a name does not change when the filter does, and `operations` shows the same names. Operations are named in `operations` order: interfaces by their order, each one's operations by order; then APIs by order, each document's operations in document order. A container slug and an operation part are each made snake_case; an empty part becomes `contract` or `operation`.
- **Clash suffixes.** A name equal to a fixed tool's or an earlier one gets `_2`, `_3`…; when the suffix would pass 64 characters, the base is cut first.
- **Keys of a complex type's JSON object.** An attribute is `@<local>`, an element `<local>`. A second particle with the same local name in another namespace is `<prefix>:<local>`, the prefix from `prefixForNamespace`. Any key already taken gets `_2`, `_3`…. Simple content and mixed text are `#text`; an `xs:any` particle is `#any`; a compositor with `maxOccurs > 1` is an array under `#sequence`, `#all` or `#choice` (`_2` for a second one in the same object), each item an object of its own members.
- **A body element of simple type** (document/literal) takes its value as the tool's one argument `#text`.
- **The `environment` argument's name.** It is `environment`, unless the operation's own arguments have a property of that name; then it is `wirebench_environment`. It is never in the schema's `required`; `environment-required` refuses at call time, as for `send`.
- **Choices in JSON Schema.** A choice's branch properties join the object's `properties`; the choice adds `allOf: [{ oneOf: [...] }]`, one option per branch, each requiring that branch's required keys (or at least one of its keys when none is required) and forbidding every other branch's keys. When the choice is optional, or a branch can be empty, one more option forbids every branch key.
- **XSD facets.** A pattern becomes `^(?:<pattern>)$` when it compiles with the `u` flag and uses none of `\i`, `\I`, `\c`, `\C`, `\p{Is…}` or class subtraction; otherwise it is left out with a note. Bounds become `minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum` for integer and number types only (date bounds stay out); an integer type with no bound facet takes its type's own range. `length` sets both `minLength` and `maxLength`. A list or union type is a `string`. `xs:float` and `xs:double` special values (`INF`, `NaN`) cannot be sent as numbers. An abstract complex type maps to its first concrete derivation, and an abstract element head to its first concrete substitution, as the form model builds them. An element's `fixed` value is written when the element is required and absent; it is not a `const`.
- **Numbers into XML** are written with `String(value)`; booleans as `true`/`false`. A `null` writes `xsi:nil="true"` on a nillable element.
- **Reading XML.** `true`/`1` and `false`/`0` read as booleans. An integer outside the safe range stays a string with a note, as does a value that is not lexically valid. A child the type does not declare is kept under its local name as its XML text, with a note; when the type has an `xs:any` particle, every such child goes into `#any` instead, joined by newlines, without a note. Mixed text is the text outside the children, each run trimmed, joined by one space.
- **SOAP envelope.** `envelopeFromJson` writes the envelope with no indentation (`createEnvelope(…, { indent: '' })`): `createEnvelope` indents every line of the body, and a multi-line string value must reach the server unchanged. The rpc wrapper is `<p:Op xmlns:p="ns">`, where `ns` is the binding's `soap:body` `namespace` (else the definition's target namespace) and `p` comes from `prefixForNamespace`. A SOAP-encoded binding is built as literal, and the XSD check decides.
- **XSD check (§3.3 step 3).** Only `validateMessage` problems of severity `error` refuse the call; each is listed as its `path` (else `line N`) and message.
- **Fault `detail`.** When the detail's first element is the element of a fault message part the operation declares, `detail` is that element's content as JSON; otherwise it is the detail's XML text, redacted as XML.
- **REST argument schemas.** `path` lists every path parameter, all required. `query` lists the declared query parameters with their `required`. `headers` lists the declared header parameters except `Accept`, `Content-Type`, `Authorization` and, when the API's own auth is an API key in a header, that header. `body` is the JSON media type's schema (`application/json` or `+json`; a JSON media type with no schema allows any value) and is required when the request body is; any other media type makes `body` a string sent with that type. A `readOnly` property is left out of a request body schema. A parameter's declared `style` is not honoured: path and header values are `simple` (arrays joined by `,`, objects as `k=v,k=v`), query values `form` exploded (an array repeats the name, an object becomes one parameter per property). A required cookie parameter adds a sentence to the description.
- **REST temporary request.** Built with `createRestRequest`: the method, the OpenAPI path as its URL (relative to the API's base URL), one enabled row per path, query and header value, a raw JSON or text body with the media type, auth `inherit`, and the `contract` link. No folder chain. An operation's own `security`, which the import turns into the saved request's own auth when it differs from the API's, is not applied: the tool takes the API's auth, as §4.1 says.
- **SOAP temporary request.** Built with `createRequest`: the envelope, the binding's SOAP version and action, and the interface's default endpoint (else its first). Its own auth, WS-Addressing and WS-Security are unset, so the interface's apply as for a new request.
- **A definition gone at call time.** `resolveOperation` answering `operation-not-found` or `definition-cache-missing` for a tool's ref is `operation-gone`: either way the tool the agent listed cannot be called.
- **`wirebench call` and the cap.** The cap and `--tools` belong to `wirebench mcp`; `call` finds one operation (by ref, then by tool name) and builds only its schema.
- **History.** An ad-hoc entry has no `requestId`; `requestName` is `<operation> (MCP)` or `<operation> (CLI)`; `operationName` is the SOAP operation, or the REST `operationId`, else `METHOD /path`. Tags `['mcp']` or `['cli']`. Written with `keepAtLeastCurrent`, as `send` writes; a busy History leaves the result without `historyId` and warns.
- **Results.** `result` is redacted for secret keys by `redactStructuredBody` over its JSON, and a string `detail` or `body` by `redactBody`. After that, any number or boolean whose text contains a resolved secret becomes the masked string, and object keys are masked; `runOp`'s step then masks the strings. `ok` is a 2xx status with no fault. `body` is filled only when `result` could not be built, cut at `MAX_STORED_CHARS`.
- **Schema size.** A tool schema over 64 KiB of JSON is served in full; a note naming the tool and its size goes to stderr on every derivation.
- **Watching.** `fs.watch(projectDir, { recursive: true })`, ignoring any path under `.git`. A rebuild that fails (a project half-written) keeps the previous set and warns. A rebuild over the cap warns each time; one whose `--tools` name has gone serves no contract tools and warns.
- **`wirebench call`.** Takes `--history-dir` too (it writes History). `<operation>` is an `operations` ref first, else a tool name. `--args` that is not a JSON object, or a file that cannot be read, is `invalid-input` or `file-not-found` (exit 2). `-e <env>` sets the environment argument, overriding one in `--args`.
- **Startup line.** `wirebench mcp` writes `wirebench mcp: <n> contract tools` to stderr after its serving line when `n > 0`.

---

## File Structure

Engine (`packages/engine/src/`):
- `xsd/json-bridge.ts` — **new**: members and keys, `jsonSchemaOf`, `createJsonSchemaWriter` (Task 1); `xmlFromJson`, `jsonFromXml` (Task 2).
- `xsd/xml-scan.ts`: `decodeEntities` exported (Task 2).
- `soap/json-operation.ts` — **new**: `operationJsonSchema`, `envelopeFromJson`, `jsonFromEnvelope`, `faultDetailJson` (Task 3).
- `soap/form-request.ts`: `findBody`, `namespacesInScope` exported (Task 3).
- `index.ts`: the bridge (Tasks 1–2), the operation helpers (Task 3), `validateJsonSchema` (Task 4).

Engine tests: `packages/engine/test/fixtures/json-bridge/service.wsdl` — **new** (Task 1); `packages/engine/test/unit/xsd/json-bridge-schema.test.ts` (Task 1), `json-bridge-xml.test.ts` (Task 2), `packages/engine/test/unit/soap/json-operation.test.ts` (Task 3) — **new**.

CLI (`packages/cli/src/`):
- `ops/contract-tools.ts`, `ops/rest-args.ts` — **new** (Task 4; `rest-args.ts` grows in Task 6).
- `ops/operations.ts` (`tool` on rows), `commands/ops-output.ts` (Task 4).
- `ops/call.ts` — **new** (Task 5, REST in Task 6, `findContractTool` in Task 8); `ops/history-entry.ts` (`adHoc`), `ops/send.ts` (`sendFailure` exported), `ops/errors.ts` (codes) (Task 5).
- `mcp/contract-tools.ts` — **new**; `mcp/server.ts`, `commands/mcp.ts`, `args-ops.ts` (`--tools`) (Task 7).
- `commands/call.ts` — **new**; `args-ops.ts`, `args.ts`, `main.ts` (Task 8).

CLI tests (`packages/cli/test/unit/`): `ops/helpers.ts` (`manyOperationsOpenApi`), `ops/contract-tools.test.ts`, `ops/operations.test.ts` (Task 4); `ops/rest-args.test.ts` (Task 4, grows in Task 6); `ops/call.test.ts` (Tasks 5–6); `mcp/contract-tools.test.ts`, `args.test.ts` (Task 7); `call-verb.test.ts`, `args.test.ts` (Task 8).

Docs (Task 9): `docs/cli.md`, `docs-site/src/content/docs/guides/agents-mcp.mdx`, `docs/security.md`, `CHANGELOG.md`, `docs/roadmap.md`.

---

### Task 1: Engine — the XSD to JSON Schema bridge

**Files:**
- Create: `packages/engine/src/xsd/json-bridge.ts`
- Create: `packages/engine/test/fixtures/json-bridge/service.wsdl`
- Modify: `packages/engine/src/index.ts` (after the `./xsd/form-edits.js` exports)
- Test: `packages/engine/test/unit/xsd/json-bridge-schema.test.ts` (new)

**Interfaces:**
- Consumes: `SchemaSet` (`lookupElement`, `lookupType`, `resolveContent`, `substitutionsFor`, `builtin`), `resolveType`/`ResolvedType`/`firstConcreteDerived` (`xsd/sample-types.ts`), `builtinBaseOf`/`SimpleTypeRef` (`xsd/sample-values.ts`), `prefixForNamespace` (`xml/prefixes.ts`), `NS`, `qnameToString`; in the test `importWsdl` (`soap/import.ts`), `validateJsonSchema` (`json/schema-validate.ts`).
- Produces:
  - `type JsonSchemaObject = Record<string, unknown>`
  - `type BridgeTarget = { readonly element: QName } | { readonly name: QName; readonly type: QName }`
  - `interface JsonSchemaOfResult { readonly schema: JsonSchemaObject; readonly notes: readonly string[] }`
  - `jsonSchemaOf(schemaSet: SchemaSet, target: BridgeTarget): JsonSchemaOfResult` — the target's own content inline (even for a named type), every named complex type it reaches in `$defs`
  - `interface JsonSchemaWriter { schemaOf(target: BridgeTarget): JsonSchemaObject; defs(): JsonSchemaObject | undefined; notes(): readonly string[] }` and `createJsonSchemaWriter(schemaSet: SchemaSet): JsonSchemaWriter` — several targets sharing one `$defs`
  - `const MAX_PROPERTY_DESCRIPTION = 200`
  - Internal, used again in Task 2: `type Member`, `contentShape(set, type, notes)`, `typeOfDecl`, `jsonKind`, `typedLexical`, `repeats`, `memberKeys`, `namesOf`, `targetType`

- [ ] **Step 1: Write the fixture and the failing test**

```xml
<!-- packages/engine/test/fixtures/json-bridge/service.wsdl -->
<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
                  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
                  xmlns:xs="http://www.w3.org/2001/XMLSchema"
                  xmlns:tns="urn:wb:bridge"
                  targetNamespace="urn:wb:bridge">
  <wsdl:types>
    <xs:schema targetNamespace="urn:wb:bridge:loose" elementFormDefault="unqualified">
      <xs:element name="Loose">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="a" type="xs:string"/>
            <xs:element name="b" type="xs:int"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
      <xs:element name="id" type="xs:string"/>
    </xs:schema>
    <xs:schema targetNamespace="urn:wb:bridge" elementFormDefault="qualified"
               xmlns:loose="urn:wb:bridge:loose">
      <xs:import namespace="urn:wb:bridge:loose"/>
      <xs:element name="Order">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="id" type="xs:int">
              <xs:annotation><xs:documentation>The order number.</xs:documentation></xs:annotation>
            </xs:element>
            <xs:element name="customer" type="tns:Customer"/>
            <xs:element name="line" type="tns:Line" maxOccurs="unbounded"/>
            <xs:element name="note" type="xs:string" minOccurs="0" nillable="true"/>
            <xs:choice>
              <xs:element name="card" type="xs:string"/>
              <xs:element name="invoice">
                <xs:complexType>
                  <xs:attribute name="days" type="xs:int" use="required"/>
                </xs:complexType>
              </xs:element>
            </xs:choice>
            <xs:element name="priority" type="tns:Priority"/>
            <xs:element name="placed" type="xs:date"/>
            <xs:element name="paid" type="xs:boolean"/>
            <xs:element name="total" type="xs:decimal"/>
            <xs:element name="blob" type="xs:base64Binary" minOccurs="0"/>
            <xs:any namespace="##other" processContents="lax" minOccurs="0"/>
          </xs:sequence>
          <xs:attribute name="channel" type="xs:string" use="required"/>
        </xs:complexType>
      </xs:element>
      <xs:complexType name="Customer">
        <xs:sequence>
          <xs:element name="name" type="xs:string"/>
          <xs:element name="email" type="xs:string" minOccurs="0"/>
        </xs:sequence>
      </xs:complexType>
      <xs:complexType name="Line">
        <xs:sequence>
          <xs:element name="sku" type="tns:Sku"/>
          <xs:element name="qty" type="tns:Quantity"/>
        </xs:sequence>
      </xs:complexType>
      <xs:simpleType name="Sku">
        <xs:restriction base="xs:string"><xs:pattern value="[A-Z]{3}-\d+"/></xs:restriction>
      </xs:simpleType>
      <xs:simpleType name="Quantity">
        <xs:restriction base="xs:int">
          <xs:minInclusive value="1"/>
          <xs:maxInclusive value="99"/>
        </xs:restriction>
      </xs:simpleType>
      <xs:simpleType name="Priority">
        <xs:restriction base="xs:string">
          <xs:enumeration value="LOW"/>
          <xs:enumeration value="HIGH"/>
        </xs:restriction>
      </xs:simpleType>
      <xs:simpleType name="Code">
        <xs:restriction base="xs:string"><xs:pattern value="\i\c*"/></xs:restriction>
      </xs:simpleType>
      <xs:complexType name="Tree">
        <xs:sequence>
          <xs:element name="label" type="xs:string"/>
          <xs:element name="child" type="tns:Tree" minOccurs="0" maxOccurs="unbounded"/>
        </xs:sequence>
      </xs:complexType>
      <xs:element name="Root" type="tns:Tree"/>
      <xs:element name="Price">
        <xs:complexType>
          <xs:simpleContent>
            <xs:extension base="xs:decimal">
              <xs:attribute name="currency" type="xs:string" use="required"/>
            </xs:extension>
          </xs:simpleContent>
        </xs:complexType>
      </xs:element>
      <xs:element name="Remark">
        <xs:complexType mixed="true">
          <xs:sequence>
            <xs:element name="em" type="xs:string" minOccurs="0"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
      <xs:element name="Tagged">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="code" type="tns:Code"/>
            <xs:element name="small" type="xs:short"/>
            <xs:element name="hex" type="xs:hexBinary"/>
            <xs:element name="at" type="xs:dateTime"/>
            <xs:element name="token" type="xs:token"/>
            <xs:element name="free" type="xs:anyType"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
      <xs:element name="Steps">
        <xs:complexType>
          <xs:sequence maxOccurs="unbounded">
            <xs:element name="name" type="xs:string"/>
            <xs:element name="wait" type="xs:int"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
      <xs:element name="Pair">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="id" type="xs:int"/>
            <xs:element ref="loose:id"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
      <xs:element name="OrderResult">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="orderId" type="xs:int"/>
            <xs:element name="status" type="xs:string"/>
            <xs:element name="tags" type="xs:string" minOccurs="0" maxOccurs="unbounded"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
      <xs:element name="OrderFault">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="reason" type="xs:string"/>
            <xs:element name="code" type="xs:int"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
    </xs:schema>
  </wsdl:types>
  <wsdl:message name="PlaceOrderIn"><wsdl:part name="parameters" element="tns:Order"/></wsdl:message>
  <wsdl:message name="PlaceOrderOut"><wsdl:part name="parameters" element="tns:OrderResult"/></wsdl:message>
  <wsdl:message name="OrderFaultMsg"><wsdl:part name="fault" element="tns:OrderFault"/></wsdl:message>
  <wsdl:message name="QuoteIn">
    <wsdl:part name="item" type="xs:string"/>
    <wsdl:part name="count" type="xs:int"/>
  </wsdl:message>
  <wsdl:message name="QuoteOut"><wsdl:part name="price" type="xs:decimal"/></wsdl:message>
  <wsdl:portType name="BridgePort">
    <wsdl:operation name="PlaceOrder">
      <wsdl:documentation>Places an order.</wsdl:documentation>
      <wsdl:input message="tns:PlaceOrderIn"/>
      <wsdl:output message="tns:PlaceOrderOut"/>
      <wsdl:fault name="OrderFault" message="tns:OrderFaultMsg"/>
    </wsdl:operation>
  </wsdl:portType>
  <wsdl:portType name="BridgeRpcPort">
    <wsdl:operation name="Quote">
      <wsdl:input message="tns:QuoteIn"/>
      <wsdl:output message="tns:QuoteOut"/>
    </wsdl:operation>
  </wsdl:portType>
  <wsdl:binding name="BridgeSoap" type="tns:BridgePort">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="PlaceOrder">
      <soap:operation soapAction="urn:wb:bridge/PlaceOrder"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
      <wsdl:output><soap:body use="literal"/></wsdl:output>
      <wsdl:fault name="OrderFault"><soap:fault name="OrderFault" use="literal"/></wsdl:fault>
    </wsdl:operation>
  </wsdl:binding>
  <wsdl:binding name="BridgeRpc" type="tns:BridgeRpcPort">
    <soap:binding style="rpc" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Quote">
      <soap:operation soapAction="urn:wb:bridge/Quote"/>
      <wsdl:input><soap:body use="literal" namespace="urn:wb:bridge:rpc"/></wsdl:input>
      <wsdl:output><soap:body use="literal" namespace="urn:wb:bridge:rpc"/></wsdl:output>
    </wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="BridgeService">
    <wsdl:port name="BridgeSoapPort" binding="tns:BridgeSoap">
      <soap:address location="http://127.0.0.1:9/bridge"/>
    </wsdl:port>
    <wsdl:port name="BridgeRpcPort" binding="tns:BridgeRpc">
      <soap:address location="http://127.0.0.1:9/bridge-rpc"/>
    </wsdl:port>
  </wsdl:service>
</wsdl:definitions>
```

The XML declaration must be the first line of the file: put the path comment nowhere in the real file.

```ts
// packages/engine/test/unit/xsd/json-bridge-schema.test.ts
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateJsonSchema } from '../../../src/json/schema-validate.js';
import { importWsdl } from '../../../src/soap/import.js';
import type { WsdlImportResult } from '../../../src/soap/types.js';
import { createJsonSchemaWriter, jsonSchemaOf } from '../../../src/xsd/json-bridge.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/json-bridge/service.wsdl', import.meta.url));
const BRIDGE = 'urn:wb:bridge';
const XSD = 'http://www.w3.org/2001/XMLSchema';

let wsdl: WsdlImportResult;

beforeAll(async () => {
  wsdl = await importWsdl({ kind: 'file', path: FIXTURE });
});

const element = (localName: string, namespaceUri = BRIDGE) => ({ element: { namespaceUri, localName } });

describe('jsonSchemaOf', () => {
  it('maps a sequence, its attributes, occurrences, facets and named types', () => {
    const { schema } = jsonSchemaOf(wsdl.schemaSet, element('Order'));

    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['@channel', 'id', 'customer', 'line', 'priority', 'placed', 'paid', 'total'],
      properties: {
        '@channel': { type: 'string' },
        id: { type: 'integer', minimum: -2147483648, maximum: 2147483647, description: 'The order number.' },
        customer: { $ref: '#/$defs/Customer' },
        line: { type: 'array', minItems: 1, items: { $ref: '#/$defs/Line' } },
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        card: { type: 'string' },
        invoice: {
          type: 'object',
          properties: { '@days': { type: 'integer' } },
          required: ['@days'],
          additionalProperties: false,
        },
        priority: { type: 'string', enum: ['LOW', 'HIGH'] },
        placed: { type: 'string', format: 'date' },
        paid: { type: 'boolean' },
        total: { type: 'number' },
        blob: { type: 'string', contentEncoding: 'base64' },
        '#any': { type: 'string' },
      },
      $defs: {
        Customer: {
          type: 'object',
          properties: { name: { type: 'string' }, email: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
        Line: {
          type: 'object',
          properties: {
            sku: { type: 'string', pattern: '^(?:[A-Z]{3}-\\d+)$' },
            qty: { type: 'integer', minimum: 1, maximum: 99 },
          },
          required: ['sku', 'qty'],
        },
      },
    });
    expect(Object.keys(schema['properties'] as object)).toEqual([
      '@channel',
      'id',
      'customer',
      'line',
      'note',
      'card',
      'invoice',
      'priority',
      'placed',
      'paid',
      'total',
      'blob',
      '#any',
    ]);
  });

  it('turns a choice into one oneOf option per branch, each forbidding the others', () => {
    const { schema } = jsonSchemaOf(wsdl.schemaSet, element('Order'));
    expect(schema['allOf']).toEqual([
      {
        oneOf: [
          { required: ['card'], not: { anyOf: [{ required: ['invoice'] }] } },
          { required: ['invoice'], not: { anyOf: [{ required: ['card'] }] } },
        ],
      },
    ]);
    const valid = {
      '@channel': 'web',
      id: 1,
      customer: {},
      line: [{}],
      card: 'x',
      priority: 'LOW',
      placed: '2026-10-03',
      paid: true,
      total: 1,
    };
    expect(validateJsonSchema(valid, schema)).toEqual([]);
    expect(validateJsonSchema({ ...valid, invoice: { '@days': 3 } }, schema).map((p) => p.keyword)).toContain(
      'oneOf',
    );
    const neither = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'card'));
    expect(validateJsonSchema(neither, schema).map((p) => p.keyword)).toContain('oneOf');
  });

  it('handles recursion through $defs, and inlines the root even when its type is named', () => {
    const { schema } = jsonSchemaOf(wsdl.schemaSet, element('Root'));
    expect(schema).toMatchObject({
      type: 'object',
      required: ['label'],
      properties: {
        label: { type: 'string' },
        child: { type: 'array', items: { $ref: '#/$defs/Tree' } },
      },
      $defs: {
        Tree: {
          type: 'object',
          properties: { label: { type: 'string' }, child: { type: 'array', items: { $ref: '#/$defs/Tree' } } },
        },
      },
    });
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });

  it('maps simple content with attributes, and mixed content, to #text beside the @ properties', () => {
    expect(jsonSchemaOf(wsdl.schemaSet, element('Price')).schema).toEqual({
      type: 'object',
      properties: { '@currency': { type: 'string' }, '#text': { type: 'number' } },
      required: ['@currency'],
      additionalProperties: false,
    });
    expect(jsonSchemaOf(wsdl.schemaSet, element('Remark')).schema).toEqual({
      type: 'object',
      properties: { '#text': { type: 'string' }, em: { type: 'string' } },
      additionalProperties: false,
    });
  });

  it('maps the built-in families, leaves out a pattern JSON Schema cannot say, and notes it', () => {
    const { schema, notes } = jsonSchemaOf(wsdl.schemaSet, element('Tagged'));
    expect(schema['properties']).toEqual({
      code: { type: 'string' },
      small: { type: 'integer', minimum: -32768, maximum: 32767 },
      hex: { type: 'string', contentEncoding: 'base16' },
      at: { type: 'string', format: 'date-time' },
      token: { type: 'string' },
      free: { type: 'string', description: 'An XML fragment, inserted as written' },
    });
    expect(notes).toEqual([expect.stringContaining('\\i\\c*')]);
  });

  it('maps a repeating compositor to an array under #sequence', () => {
    expect(jsonSchemaOf(wsdl.schemaSet, element('Steps')).schema).toEqual({
      type: 'object',
      properties: {
        '#sequence': {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              wait: { type: 'integer', minimum: -2147483648, maximum: 2147483647 },
            },
            required: ['name', 'wait'],
            additionalProperties: false,
          },
        },
      },
      required: ['#sequence'],
      additionalProperties: false,
    });
  });

  it('keeps two children of one local name from two namespaces, the second prefixed', () => {
    const keys = Object.keys(jsonSchemaOf(wsdl.schemaSet, element('Pair')).schema['properties'] as object);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe('id');
    expect(keys[1]).toMatch(/^[A-Za-z][\w.-]*:id$/);
  });

  it('maps a type target (an rpc part), and shares $defs across targets of one writer', () => {
    expect(
      jsonSchemaOf(wsdl.schemaSet, {
        name: { namespaceUri: '', localName: 'count' },
        type: { namespaceUri: XSD, localName: 'int' },
      }).schema,
    ).toEqual({ type: 'integer', minimum: -2147483648, maximum: 2147483647 });

    const writer = createJsonSchemaWriter(wsdl.schemaSet);
    writer.schemaOf(element('Order'));
    writer.schemaOf(element('Root'));
    expect(Object.keys(writer.defs() ?? {})).toEqual(['Customer', 'Line', 'Tree']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/xsd/json-bridge-schema.test.ts`
Expected: FAIL — `Cannot find module '../../../src/xsd/json-bridge.js'`.

- [ ] **Step 3: Implement the schema half of the bridge**

Create `packages/engine/src/xsd/json-bridge.ts`:

```ts
/**
 * Between an XSD and JSON (#33 spec §3.1, §5): the JSON Schema a body element's content maps to, XML
 * written from a JSON value through the form model, and JSON read back from XML.
 *
 * All three read a complex type's content the same way, as an ordered list of {@link Member}s with
 * stable JSON keys, in the order the form model emits its nodes: so the property a value is written
 * from is the one the schema names and the one the reader fills. Pure and synchronous.
 */
import type { QName } from '../wsdl/qname.js';
import { qnameToString } from '../wsdl/qname.js';
import { NS } from '../xml/namespaces.js';
import { prefixForNamespace } from '../xml/prefixes.js';
import type {
  ComplexType,
  ElementDecl,
  Facet,
  Occurs,
  Particle,
  ResolvedAttribute,
  ResolvedContent,
  SimpleType,
} from './model.js';
import { firstConcreteDerived, resolveType } from './sample-types.js';
import type { ResolvedType } from './sample-types.js';
import { builtinBaseOf } from './sample-values.js';
import type { SimpleTypeRef } from './sample-values.js';
import type { SchemaSet } from './schema-set.js';

/** A JSON Schema, as plain JSON. */
export type JsonSchemaObject = Record<string, unknown>;

/** What the bridge maps: a global element, or an element named here whose content is a type (an rpc part). */
export type BridgeTarget = { readonly element: QName } | { readonly name: QName; readonly type: QName };

export interface JsonSchemaOfResult {
  readonly schema: JsonSchemaObject;
  /** What the schema could not say: a pattern JSON Schema cannot express, an unresolved reference. */
  readonly notes: readonly string[];
}

/** Several targets written against one `$defs`: an operation's parts. */
export interface JsonSchemaWriter {
  /** The target's own content, inline even when its type is named. */
  schemaOf(target: BridgeTarget): JsonSchemaObject;
  /** Every named complex type reached so far, keyed as the `$ref`s name them; undefined when none. */
  defs(): JsonSchemaObject | undefined;
  notes(): readonly string[];
}

/** A property's description is the element's documentation, cut to this many characters. */
export const MAX_PROPERTY_DESCRIPTION = 200;

const FRAGMENT_DESCRIPTION = 'An XML fragment, inserted as written';

export const ONCE: Occurs = { min: 1, max: 1 };

/** One thing a complex type's content contributes to its JSON object, in particle order. */
export type Member =
  | {
      readonly kind: 'element';
      readonly key: string;
      readonly decl: ElementDecl;
      /** Every name that stands for it: the declaration's, and its substitution group's. */
      readonly names: readonly QName[];
      readonly occurs: Occurs;
      readonly optional: boolean;
    }
  | { readonly kind: 'any'; readonly key: string; readonly occurs: Occurs; readonly optional: boolean }
  | {
      readonly kind: 'choice';
      readonly occurs: Occurs;
      readonly optional: boolean;
      readonly branches: readonly (readonly Member[])[];
    }
  | {
      /** A compositor with `maxOccurs > 1`: an array of objects, each holding `members`. */
      readonly kind: 'group';
      readonly key: string;
      readonly compositor: 'sequence' | 'all' | 'choice';
      readonly occurs: Occurs;
      readonly optional: boolean;
      readonly members: readonly Member[];
    };

/** A complex type's content as the bridge reads it. */
export interface ContentShape {
  readonly content: ResolvedContent;
  readonly attributes: readonly { readonly key: string; readonly attribute: ResolvedAttribute }[];
  readonly members: readonly Member[];
}

/** True when a particle may appear more than once. */
export function repeats(occurs: Occurs): boolean {
  return occurs.max === 'unbounded' || occurs.max > 1;
}

/** The keys of one JSON object: unique, and stable for one content model. */
class KeySpace {
  private readonly taken = new Set<string>();
  private readonly prefixes = new Set<string>();
  private readonly elementNamespaces = new Map<string, string>();
  private readonly attributeNamespaces = new Map<string, string>();

  element(name: QName): string {
    return this.unique(this.qualified(name, this.elementNamespaces));
  }

  attribute(name: QName): string {
    return this.unique(`@${this.qualified(name, this.attributeNamespaces)}`);
  }

  reserve(key: string): string {
    return this.unique(key);
  }

  /** The local name; a second namespace for it gets a prefix. */
  private qualified(name: QName, seen: Map<string, string>): string {
    const first = seen.get(name.localName);
    if (first === undefined) {
      seen.set(name.localName, name.namespaceUri);
      return name.localName;
    }
    if (first === name.namespaceUri) {
      return name.localName;
    }
    const prefix = prefixForNamespace(name.namespaceUri, this.prefixes);
    this.prefixes.add(prefix);
    return `${prefix}:${name.localName}`;
  }

  private unique(key: string): string {
    let candidate = key;
    for (let n = 2; this.taken.has(candidate); n += 1) {
      candidate = `${key}_${String(n)}`;
    }
    this.taken.add(candidate);
    return candidate;
  }
}

/** The declaration a particle stands for, an abstract head replaced by its first concrete member. */
function elementTarget(
  set: SchemaSet,
  particle: Particle,
): { readonly decl: ElementDecl; readonly names: readonly QName[] } | undefined {
  if (particle.kind === 'localElement') {
    return { decl: particle.decl, names: [particle.decl.name] };
  }
  if (particle.kind !== 'elementRef') {
    return undefined;
  }
  const head = set.lookupElement(particle.ref);
  if (head === undefined) {
    return undefined;
  }
  const substitutions = set.substitutionsFor(particle.ref);
  const decl = head.abstract ? (substitutions.find((candidate) => !candidate.abstract) ?? head) : head;
  return { decl, names: [head.name, ...substitutions.map((member) => member.name)] };
}

/** The members a particle contributes, mirroring `buildParticle` in `form-model.ts` node for node. */
function membersOf(
  set: SchemaSet,
  particle: Particle | undefined,
  keys: KeySpace,
  optional: boolean,
  notes: string[],
): Member[] {
  if (particle === undefined) {
    return [];
  }
  const target = elementTarget(set, particle);
  if (target !== undefined) {
    return [
      {
        kind: 'element',
        key: keys.element(target.decl.name),
        decl: target.decl,
        names: target.names,
        occurs: particle.occurs,
        optional: optional || particle.occurs.min === 0,
      },
    ];
  }
  switch (particle.kind) {
    case 'localElement':
      return [];
    case 'elementRef':
      notes.push(`no element ${qnameToString(particle.ref)} in the schema`);
      return [];
    case 'groupRef':
      // `resolveContent` expands group references before this runs.
      return [];
    case 'any':
      return [
        {
          kind: 'any',
          key: keys.reserve('#any'),
          occurs: particle.occurs,
          optional: optional || particle.occurs.min === 0,
        },
      ];
    case 'choice': {
      const choiceOptional = optional || particle.occurs.min === 0;
      if (repeats(particle.occurs)) {
        const itemKeys = new KeySpace();
        return [
          {
            kind: 'group',
            key: keys.reserve('#choice'),
            compositor: 'choice',
            occurs: particle.occurs,
            optional: choiceOptional,
            members: [
              {
                kind: 'choice',
                occurs: ONCE,
                optional: false,
                branches: particle.particles.map((branch) => membersOf(set, branch, itemKeys, false, notes)),
              },
            ],
          },
        ];
      }
      return [
        {
          kind: 'choice',
          occurs: particle.occurs,
          optional: choiceOptional,
          branches: particle.particles.map((branch) => membersOf(set, branch, keys, false, notes)),
        },
      ];
    }
    case 'sequence':
    case 'all': {
      const groupOptional = optional || particle.occurs.min === 0;
      if (repeats(particle.occurs)) {
        const itemKeys = new KeySpace();
        return [
          {
            kind: 'group',
            key: keys.reserve(`#${particle.kind}`),
            compositor: particle.kind,
            occurs: particle.occurs,
            optional: groupOptional,
            members: particle.particles.flatMap((child) => membersOf(set, child, itemKeys, false, notes)),
          },
        ];
      }
      return particle.particles.flatMap((child) => membersOf(set, child, keys, groupOptional, notes));
    }
  }
}

/** An abstract type stands for its first concrete derivation, as the form model builds it. */
function concrete(set: SchemaSet, type: ComplexType): ComplexType {
  return type.abstract ? (firstConcreteDerived(set, type) ?? type) : type;
}

/** A complex type's attributes (SOAP-encoding bookkeeping left out, as the form does) and members. */
export function contentShape(set: SchemaSet, type: ComplexType, notes: string[]): ContentShape {
  const content = set.resolveContent(concrete(set, type));
  const keys = new KeySpace();
  const attributes = content.attributes
    .filter((attribute) => attribute.name.namespaceUri !== NS.SOAP11_ENC)
    .map((attribute) => ({ key: keys.attribute(attribute.name), attribute }));
  return { content, attributes, members: membersOf(set, content.particle, keys, false, notes) };
}

/** Every key a member puts in its object. */
export function memberKeys(member: Member): string[] {
  return member.kind === 'choice' ? member.branches.flat().flatMap(memberKeys) : [member.key];
}

/** Every element name a list of members can claim. */
export function namesOf(members: readonly Member[]): QName[] {
  return members.flatMap((member) => {
    switch (member.kind) {
      case 'element':
        return [...member.names];
      case 'any':
        return [];
      case 'choice':
        return member.branches.flatMap(namesOf);
      case 'group':
        return namesOf(member.members);
    }
  });
}

export function typeOfDecl(set: SchemaSet, decl: ElementDecl): ResolvedType {
  return resolveType(set, decl.type ?? decl.anonymousType);
}

/** The type of a target's content, or undefined when its element is not in the schema. */
export function targetType(set: SchemaSet, target: BridgeTarget): ResolvedType | undefined {
  if ('element' in target) {
    const decl = set.lookupElement(target.element);
    return decl === undefined ? undefined : typeOfDecl(set, decl);
  }
  return resolveType(set, target.type);
}

// ---------------------------------------------------------------------------
// Simple types
// ---------------------------------------------------------------------------

/** The value range of each built-in integer type; `undefined` where it is open. */
const INTEGER_BOUNDS: Readonly<Record<string, readonly [number | undefined, number | undefined]>> = {
  integer: [undefined, undefined],
  nonPositiveInteger: [undefined, 0],
  negativeInteger: [undefined, -1],
  long: [-(2 ** 63), 2 ** 63 - 1],
  int: [-(2 ** 31), 2 ** 31 - 1],
  short: [-32768, 32767],
  byte: [-128, 127],
  nonNegativeInteger: [0, undefined],
  unsignedLong: [0, 2 ** 64 - 1],
  unsignedInt: [0, 2 ** 32 - 1],
  unsignedShort: [0, 65535],
  unsignedByte: [0, 255],
  positiveInteger: [1, undefined],
};
const NUMBER_TYPES = new Set(['decimal', 'float', 'double']);
const FORMATS: Readonly<Record<string, string>> = { date: 'date', dateTime: 'date-time', time: 'time' };
const ENCODINGS: Readonly<Record<string, string>> = { base64Binary: 'base64', hexBinary: 'base16' };

export type JsonKind = 'integer' | 'number' | 'boolean' | 'string';

/** A simple type and the user-declared types it restricts, nearest first; built-ins end the chain. */
function simpleChain(set: SchemaSet, ref: SimpleTypeRef): SimpleType[] {
  const chain: SimpleType[] = [];
  const seen = new Set<string>();
  let current: SimpleTypeRef = ref;
  while (current !== undefined) {
    let simple: SimpleType | undefined;
    if ('kind' in current) {
      simple = current;
    } else {
      const key = qnameToString(current);
      if (seen.has(key) || set.builtin(current) !== undefined) {
        break;
      }
      seen.add(key);
      const found = set.lookupType(current);
      simple = found?.kind === 'simpleType' ? found : undefined;
    }
    if (simple === undefined) {
      break;
    }
    chain.push(simple);
    if (simple.variety !== 'atomic') {
      break;
    }
    current = simple.base ?? simple.baseType;
  }
  return chain;
}

/** The nearest facet of `kind` in a restriction chain. */
function facet<K extends Facet['kind']>(chain: readonly SimpleType[], kind: K): Extract<Facet, { kind: K }> | undefined {
  for (const simple of chain) {
    const found = simple.facets.find((candidate): candidate is Extract<Facet, { kind: K }> => candidate.kind === kind);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** The XSD built-in a simple type restricts, by local name; undefined when it is no XSD built-in. */
function builtinLocal(set: SchemaSet, ref: SimpleTypeRef): string | undefined {
  const builtin = builtinBaseOf(set, ref);
  return builtin !== undefined && builtin.name.namespaceUri === NS.XSD ? builtin.name.localName : undefined;
}

/** The JSON type a simple type's values take. A list or union is a string. */
export function jsonKind(set: SchemaSet, ref: SimpleTypeRef): JsonKind {
  if (simpleChain(set, ref).some((simple) => simple.variety !== 'atomic')) {
    return 'string';
  }
  const local = builtinLocal(set, ref);
  if (local === undefined) {
    return 'string';
  }
  if (Object.hasOwn(INTEGER_BOUNDS, local)) {
    return 'integer';
  }
  if (NUMBER_TYPES.has(local)) {
    return 'number';
  }
  return local === 'boolean' ? 'boolean' : 'string';
}

const INTEGER_TEXT = /^[+-]?\d+$/;
const NUMBER_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** A lexical value as its JSON type, or undefined when it is not lexically valid for it. */
export function typedLexical(kind: JsonKind, text: string): unknown {
  switch (kind) {
    case 'string':
      return text;
    case 'integer': {
      if (!INTEGER_TEXT.test(text)) return undefined;
      const value = Number(text);
      return Number.isSafeInteger(value) ? value : undefined;
    }
    case 'number':
      return NUMBER_TEXT.test(text) ? Number(text) : undefined;
    case 'boolean':
      return text === 'true' || text === '1' ? true : text === 'false' || text === '0' ? false : undefined;
  }
}

/** XSD-only regex syntax that ECMAScript has no form for. */
const XSD_ONLY_PATTERN = /\\[iIcC]|\\p\{Is|-\[/;

/** An XSD pattern as a JSON Schema one (XSD patterns are anchored), or undefined when it has none. */
function jsonPattern(pattern: string): string | undefined {
  if (XSD_ONLY_PATTERN.test(pattern)) {
    return undefined;
  }
  const anchored = `^(?:${pattern})$`;
  try {
    return new RegExp(anchored, 'u').source.length > 0 ? anchored : undefined;
  } catch {
    return undefined;
  }
}

function simpleSchema(set: SchemaSet, ref: SimpleTypeRef, notes: string[], where: string): JsonSchemaObject {
  const chain = simpleChain(set, ref);
  if (chain.some((simple) => simple.variety !== 'atomic')) {
    return { type: 'string' };
  }
  const local = builtinLocal(set, ref);
  const kind = jsonKind(set, ref);
  const schema: JsonSchemaObject = { type: kind };
  const format = local === undefined ? undefined : FORMATS[local];
  if (format !== undefined) {
    schema['format'] = format;
  }
  const enumeration = facet(chain, 'enumeration');
  if (enumeration !== undefined) {
    schema['enum'] = enumeration.values.map((value) => typedLexical(kind, value) ?? value);
  }
  const pattern = facet(chain, 'pattern');
  if (pattern !== undefined) {
    const translated = jsonPattern(pattern.value);
    if (translated === undefined) {
      notes.push(`${where}: the XSD pattern ${pattern.value} has no JSON Schema form; the XSD check still applies it`);
    } else if (kind === 'string') {
      schema['pattern'] = translated;
    }
  }
  if (kind === 'integer' || kind === 'number') {
    const [low, high] = (local === undefined ? undefined : INTEGER_BOUNDS[local]) ?? [undefined, undefined];
    const bound = (name: 'minInclusive' | 'maxInclusive' | 'minExclusive' | 'maxExclusive'): number | undefined => {
      const found = facet(chain, name);
      const value = found === undefined ? undefined : Number(found.value);
      return value !== undefined && Number.isFinite(value) ? value : undefined;
    };
    const minimum = bound('minInclusive') ?? (bound('minExclusive') === undefined ? low : undefined);
    const maximum = bound('maxInclusive') ?? (bound('maxExclusive') === undefined ? high : undefined);
    const exclusiveMinimum = bound('minExclusive');
    const exclusiveMaximum = bound('maxExclusive');
    if (minimum !== undefined) schema['minimum'] = minimum;
    if (maximum !== undefined) schema['maximum'] = maximum;
    if (exclusiveMinimum !== undefined) schema['exclusiveMinimum'] = exclusiveMinimum;
    if (exclusiveMaximum !== undefined) schema['exclusiveMaximum'] = exclusiveMaximum;
  }
  if (kind === 'string') {
    const length = facet(chain, 'length');
    const minLength = facet(chain, 'minLength')?.value ?? length?.value;
    const maxLength = facet(chain, 'maxLength')?.value ?? length?.value;
    if (minLength !== undefined) schema['minLength'] = minLength;
    if (maxLength !== undefined) schema['maxLength'] = maxLength;
  }
  const encoding = local === undefined ? undefined : ENCODINGS[local];
  if (encoding !== undefined) {
    schema['contentEncoding'] = encoding;
  }
  return schema;
}

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

function arrayOf(items: JsonSchemaObject, occurs: Occurs): JsonSchemaObject {
  return {
    type: 'array',
    items,
    ...(occurs.min > 0 ? { minItems: occurs.min } : {}),
    ...(occurs.max !== 'unbounded' ? { maxItems: occurs.max } : {}),
  };
}

/** The pieces of one object schema while its members are written. */
class ObjectParts {
  readonly properties: Record<string, JsonSchemaObject> = {};
  readonly required: string[] = [];
  readonly allOf: JsonSchemaObject[] = [];

  schema(): JsonSchemaObject {
    return {
      type: 'object',
      properties: this.properties,
      ...(this.required.length > 0 ? { required: this.required } : {}),
      additionalProperties: false,
      ...(this.allOf.length > 0 ? { allOf: this.allOf } : {}),
    };
  }
}

const requiring = (keys: readonly string[]): JsonSchemaObject[] => keys.map((key) => ({ required: [key] }));

class SchemaWriter implements JsonSchemaWriter {
  private readonly found: string[] = [];
  private readonly definitions = new Map<string, JsonSchemaObject>();
  /** Clark name of a named complex type → its `$defs` key. */
  private readonly defKeys = new Map<string, string>();

  constructor(private readonly set: SchemaSet) {}

  schemaOf(target: BridgeTarget): JsonSchemaObject {
    const type = targetType(this.set, target);
    if (type === undefined) {
      this.found.push(`no element ${'element' in target ? qnameToString(target.element) : ''} in the schema`);
      return {};
    }
    return this.content(type, true, '');
  }

  defs(): JsonSchemaObject | undefined {
    return this.definitions.size === 0 ? undefined : Object.fromEntries(this.definitions);
  }

  notes(): readonly string[] {
    return this.found;
  }

  private content(type: ResolvedType, inline: boolean, where: string): JsonSchemaObject {
    switch (type.kind) {
      case 'anyType':
        return { type: 'string', description: FRAGMENT_DESCRIPTION };
      case 'soapencArray':
        this.found.push(`${where}: a SOAP-encoded array is taken as an XML fragment`);
        return { type: 'string', description: FRAGMENT_DESCRIPTION };
      case 'simple':
        return simpleSchema(this.set, type.ref, this.found, where);
      case 'complex':
        return inline || type.type.name === undefined ? this.object(type.type) : this.ref(type.type, type.type.name);
    }
  }

  private ref(type: ComplexType, name: QName): JsonSchemaObject {
    const clark = qnameToString(name);
    let key = this.defKeys.get(clark);
    if (key === undefined) {
      key = name.localName;
      for (let n = 2; this.definitions.has(key); n += 1) {
        key = `${name.localName}_${String(n)}`;
      }
      this.defKeys.set(clark, key);
      // Taken before the type is written, so a recursive reference finds it.
      this.definitions.set(key, {});
      this.definitions.set(key, this.object(type));
    }
    return { $ref: `#/$defs/${key}` };
  }

  private object(type: ComplexType): JsonSchemaObject {
    const shape = contentShape(this.set, type, this.found);
    const parts = new ObjectParts();
    for (const { key, attribute } of shape.attributes) {
      parts.properties[key] = simpleSchema(this.set, attribute.type ?? attribute.anonymousType, this.found, key);
      if (attribute.use === 'required' && attribute.fixed === undefined) {
        parts.required.push(key);
      }
    }
    if (shape.content.simpleContentBase !== undefined) {
      parts.properties['#text'] = simpleSchema(this.set, shape.content.simpleContentBase, this.found, '#text');
    } else if (shape.content.mixed) {
      parts.properties['#text'] = { type: 'string' };
    }
    for (const member of shape.members) {
      this.member(member, parts);
    }
    return parts.schema();
  }

  private member(member: Member, parts: ObjectParts): void {
    switch (member.kind) {
      case 'element': {
        const { decl } = member;
        let schema = this.content(typeOfDecl(this.set, decl), false, member.key);
        if (decl.nillable) {
          schema = { anyOf: [schema, { type: 'null' }] };
        }
        if (repeats(member.occurs)) {
          schema = arrayOf(schema, member.occurs);
        }
        if (decl.documentation !== undefined && decl.documentation.length > 0) {
          schema = { ...schema, description: decl.documentation.slice(0, MAX_PROPERTY_DESCRIPTION) };
        }
        parts.properties[member.key] = schema;
        if (!member.optional) parts.required.push(member.key);
        return;
      }
      case 'any':
        parts.properties[member.key] = { type: 'string', description: FRAGMENT_DESCRIPTION };
        if (!member.optional) parts.required.push(member.key);
        return;
      case 'group': {
        const item = new ObjectParts();
        for (const inner of member.members) {
          this.member(inner, item);
        }
        parts.properties[member.key] = arrayOf(item.schema(), member.occurs);
        if (!member.optional) parts.required.push(member.key);
        return;
      }
      case 'choice':
        this.choice(member, parts);
        return;
    }
  }

  private choice(member: Extract<Member, { kind: 'choice' }>, parts: ObjectParts): void {
    const branches = member.branches.map((branch) => {
      const inner = new ObjectParts();
      for (const child of branch) {
        this.member(child, inner);
      }
      return inner;
    });
    const keysOf = branches.map((inner) => Object.keys(inner.properties));
    const all = keysOf.flat();
    const options: JsonSchemaObject[] = branches.map((inner, index) => {
      const own = keysOf[index] ?? [];
      const others = all.filter((key) => !own.includes(key));
      return {
        ...(inner.required.length > 0 ? { required: inner.required } : own.length > 0 ? { anyOf: requiring(own) } : {}),
        ...(others.length > 0 ? { not: { anyOf: requiring(others) } } : {}),
        ...(inner.allOf.length > 0 ? { allOf: inner.allOf } : {}),
      };
    });
    const emptyLegal = member.optional || branches.some((inner) => inner.required.length === 0);
    if (emptyLegal && all.length > 0 && !keysOf.some((keys) => keys.length === 0)) {
      options.push({ not: { anyOf: requiring(all) } });
    }
    for (const inner of branches) {
      Object.assign(parts.properties, inner.properties);
    }
    if (options.length > 1) {
      parts.allOf.push({ oneOf: options });
    }
  }
}

export function createJsonSchemaWriter(schemaSet: SchemaSet): JsonSchemaWriter {
  return new SchemaWriter(schemaSet);
}

/**
 * The JSON Schema of `target`'s content: an object of its attributes (`@a`), its text (`#text`) and its
 * child elements for a complex type, the value's own schema for a simple one. Named complex types the
 * content reaches are `$defs` entries referenced with `$ref`, which also carries recursion.
 */
export function jsonSchemaOf(schemaSet: SchemaSet, target: BridgeTarget): JsonSchemaOfResult {
  const writer = createJsonSchemaWriter(schemaSet);
  const schema = writer.schemaOf(target);
  const defs = writer.defs();
  return { schema: defs === undefined ? schema : { ...schema, $defs: defs }, notes: writer.notes() };
}
```

In `packages/engine/src/index.ts`, after `export type { FormEdit } from './xsd/form-edits.js';`, add:

```ts
export { createJsonSchemaWriter, jsonSchemaOf, MAX_PROPERTY_DESCRIPTION } from './xsd/json-bridge.js';
export type { BridgeTarget, JsonSchemaObject, JsonSchemaOfResult, JsonSchemaWriter } from './xsd/json-bridge.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/xsd/json-bridge-schema.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/engine/src/xsd/json-bridge.ts packages/engine/src/index.ts packages/engine/test/unit/xsd/json-bridge-schema.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/xsd/json-bridge.ts packages/engine/src/index.ts packages/engine/test/unit/xsd/json-bridge-schema.test.ts packages/engine/test/fixtures/json-bridge/service.wsdl
git commit -m "feat(engine): an XSD element's content as JSON Schema (#33)"
```

---

### Task 2: Engine — XML from JSON, and JSON from XML

**Files:**
- Modify: `packages/engine/src/xsd/json-bridge.ts` (append)
- Modify: `packages/engine/src/xsd/xml-scan.ts` (`decodeEntities` exported)
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/test/unit/xsd/json-bridge-xml.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `contentShape`, `Member`, `memberKeys`, `namesOf`, `repeats`, `typeOfDecl`, `jsonKind`, `typedLexical`, `ONCE`; `buildForm`, `buildFormForType`, `applyForm`, `FormNode` (`xsd/form-model.ts`); `scanXml`, `ScannedElement`, `decodeEntities` (`xsd/xml-scan.ts`); `escapeText` (`xsd/xml-writer.ts`); `parseXmlDetailed` (`xml/parse.ts`); `qnameEquals` (`wsdl/qname.ts`).
- Produces:
  - `interface XmlFromJsonOptions { readonly prefixes?: Readonly<Record<string, string>>; readonly inScope?: Readonly<Record<string, string>> }`
  - `interface XmlFromJsonResult { readonly xml: string; readonly notes: readonly string[]; readonly problems: readonly string[] }` — `problems` non-empty means nothing may be sent
  - `const MAX_FILL_ROUNDS = 64`
  - `xmlFromJson(schemaSet: SchemaSet, target: BridgeTarget, value: unknown, options?: XmlFromJsonOptions): XmlFromJsonResult`
  - `interface JsonFromXmlResult { readonly value: unknown; readonly notes: readonly string[] }`
  - `jsonFromXml(schemaSet: SchemaSet, target: BridgeTarget, xml: string, options?: { readonly inScope?: Readonly<Record<string, string>> }): JsonFromXmlResult`
  - `decodeEntities(raw: string): string` exported from `xsd/xml-scan.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/xsd/json-bridge-xml.test.ts
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { importWsdl } from '../../../src/soap/import.js';
import type { WsdlImportResult } from '../../../src/soap/types.js';
import { jsonFromXml, jsonSchemaOf, xmlFromJson } from '../../../src/xsd/json-bridge.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/json-bridge/service.wsdl', import.meta.url));
const BRIDGE = 'urn:wb:bridge';

let wsdl: WsdlImportResult;

beforeAll(async () => {
  wsdl = await importWsdl({ kind: 'file', path: FIXTURE });
});

const element = (localName: string) => ({ element: { namespaceUri: BRIDGE, localName } });

function roundTrip(localName: string, value: unknown): { xml: string; back: unknown; notes: readonly string[] } {
  const written = xmlFromJson(wsdl.schemaSet, element(localName), value);
  expect(written.problems).toEqual([]);
  const read = jsonFromXml(wsdl.schemaSet, element(localName), written.xml);
  return { xml: written.xml, back: read.value, notes: [...written.notes, ...read.notes] };
}

const ORDER = {
  '@channel': 'web',
  id: 7,
  customer: { name: 'Ada', email: 'ada@example.com' },
  line: [
    { sku: 'ABC-1', qty: 2 },
    { sku: 'XYZ-22', qty: 1 },
  ],
  note: null,
  invoice: { '@days': 30 },
  priority: 'HIGH',
  placed: '2026-10-03',
  paid: false,
  total: 12.5,
  '#any': '<x:extra xmlns:x="urn:other">kept</x:extra>',
};

/** `{ label, child: [{ label, child: [...] }] }`, `depth` levels deep. */
function tree(depth: number): unknown {
  return depth === 0 ? { label: '0' } : { label: String(depth), child: [tree(depth - 1)] };
}

describe('xmlFromJson and jsonFromXml', () => {
  it('round-trips a sequence with attributes, a choice, a nil, repeats and a wildcard', () => {
    const { xml, back, notes } = roundTrip('Order', ORDER);
    expect(back).toEqual(ORDER);
    expect(notes).toEqual([]);
    // Element order follows the XSD, not the JSON.
    expect(xml.indexOf(':customer')).toBeLessThan(xml.indexOf(':priority'));
    expect(xml).toContain('xsi:nil="true"');
    expect(xml).toContain('days="30"');
    expect(xml).toContain('<x:extra xmlns:x="urn:other">kept</x:extra>');
    expect(xml).not.toContain(':card');
  });

  it('writes recursion deeper than the form cuts it, rebuilding from its own XML', () => {
    const value = tree(9);
    expect(roundTrip('Root', value).back).toEqual(value);
  });

  it('round-trips simple content, mixed content, a repeating sequence and a prefixed key', () => {
    expect(roundTrip('Price', { '@currency': 'EUR', '#text': 9.99 }).back).toEqual({
      '@currency': 'EUR',
      '#text': 9.99,
    });
    expect(roundTrip('Remark', { '#text': 'hello world', em: 'there' }).back).toEqual({
      '#text': 'hello world',
      em: 'there',
    });
    const steps = {
      '#sequence': [
        { name: 'a', wait: 1 },
        { name: 'b', wait: 2 },
      ],
    };
    expect(roundTrip('Steps', steps).back).toEqual(steps);
    const keys = Object.keys(jsonSchemaOf(wsdl.schemaSet, element('Pair')).schema['properties'] as object);
    const pair = { id: 1, [keys[1] ?? '']: 'loose' };
    expect(roundTrip('Pair', pair).back).toEqual(pair);
  });

  it('keeps a multi-line string exactly', () => {
    const value = { ...ORDER, customer: { name: 'line one\n   line two' } };
    expect(roundTrip('Order', value).back).toEqual(value);
  });

  it('refuses a wildcard fragment that is not well formed', () => {
    const written = xmlFromJson(wsdl.schemaSet, element('Order'), { ...ORDER, '#any': '<a><b></a>' });
    expect(written.problems).toEqual([expect.stringContaining('#any')]);
  });

  it('reads arrays from maxOccurs, keeps untyped values as strings, and notes what the schema lacks', () => {
    const xml =
      '<r:OrderResult xmlns:r="urn:wb:bridge"><r:orderId>x7</r:orderId><r:status>ok</r:status>' +
      '<r:tags>a</r:tags><r:surprise>1</r:surprise></r:OrderResult>';
    const { value, notes } = jsonFromXml(wsdl.schemaSet, element('OrderResult'), xml);
    expect(value).toEqual({
      orderId: 'x7',
      status: 'ok',
      tags: ['a'],
      surprise: '<r:surprise>1</r:surprise>',
    });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('orderId');
    expect(notes[1]).toContain('surprise');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/xsd/json-bridge-xml.test.ts`
Expected: FAIL — `xmlFromJson` is not exported from `json-bridge.js`.

- [ ] **Step 3: Implement**

In `packages/engine/src/xsd/xml-scan.ts`, export the entity decoder (the body is unchanged):

```ts
/** Decodes the five predefined XML entities plus numeric character references. */
export function decodeEntities(raw: string): string {
```

Add these imports at the top of `packages/engine/src/xsd/json-bridge.ts`, beside Task 1's:

```ts
import { qnameEquals } from '../wsdl/qname.js';
import { parseXmlDetailed } from '../xml/parse.js';
import { applyForm, buildForm, buildFormForType } from './form-model.js';
import type { FormNode } from './form-model.js';
import { decodeEntities, scanXml } from './xml-scan.js';
import type { ScannedElement } from './xml-scan.js';
import { escapeAttribute, escapeText } from './xml-writer.js';
```

and `ElementDecl` is already imported from `./model.js`. Append to the file:

```ts
// ---------------------------------------------------------------------------
// XML from JSON
// ---------------------------------------------------------------------------

export interface XmlFromJsonOptions {
  /** The prefix already declared around the fragment, per namespace URI. */
  readonly prefixes?: Readonly<Record<string, string>>;
  /** The namespace URI per prefix declared around the fragment. */
  readonly inScope?: Readonly<Record<string, string>>;
}

export interface XmlFromJsonResult {
  readonly xml: string;
  /** What was written differently from what was asked. */
  readonly notes: readonly string[];
  /** Why the value cannot be written: a fragment that is not well formed. When any, `xml` is empty. */
  readonly problems: readonly string[];
}

/** How many times the form is rebuilt to reach below its depth cut (spec revision R8). */
export const MAX_FILL_ROUNDS = 64;

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A JSON scalar as XML text: strings as they are, numbers and booleans with `String`. */
function lexical(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

/** A synthetic node `applyForm` writes verbatim: a mixed text run (escaped), or an XML fragment. */
function verbatim(id: string, raw: string): FormNode {
  return {
    id,
    kind: 'any',
    name: { namespaceUri: '', localName: '#text' },
    label: '',
    required: false,
    occurs: ONCE,
    present: true,
    raw,
    children: [],
  };
}

/** A node, and everything under it, left out of the document. */
function absent(node: FormNode): FormNode {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    label: node.label,
    required: node.required,
    occurs: node.occurs,
    present: false,
    ...(node.type !== undefined ? { type: node.type } : {}),
    ...(node.kind === 'field' || node.kind === 'attribute' ? { value: node.value ?? '' } : {}),
    children: node.children.map(absent),
    ...(node.choice !== undefined ? { choice: {} } : {}),
    ...(node.repeat !== undefined ? { repeat: { ...node.repeat, instances: [] } } : {}),
  };
}

/** The element a target's root is: its global declaration (an abstract head replaced), or a synthetic one. */
function rootDecl(set: SchemaSet, target: BridgeTarget): ElementDecl | undefined {
  if (!('element' in target)) {
    return {
      kind: 'element',
      name: target.name,
      type: target.type,
      nillable: false,
      abstract: false,
      source: { location: '<synthetic>' },
    };
  }
  const decl = set.lookupElement(target.element);
  if (decl === undefined || !decl.abstract) {
    return decl;
  }
  return set.substitutionsFor(decl.name).find((candidate) => !candidate.abstract) ?? decl;
}

/** Fills one form tree from a JSON value, as the desktop's form edits would. */
class Filler {
  /** Values that reach below a recursion cut; another round writes them. */
  pending = 0;
  readonly notes: string[] = [];
  readonly problems: string[] = [];

  constructor(
    private readonly set: SchemaSet,
    private readonly inScope: Readonly<Record<string, string>>,
  ) {}

  element(node: FormNode, decl: ElementDecl, value: unknown, where: string): FormNode {
    if (value === undefined) {
      return node.kind === 'field' && node.fixed !== undefined && node.required
        ? { ...node, present: true, value: node.fixed }
        : absent(node);
    }
    if (value === null) {
      return this.nil(node, decl, where);
    }
    const resolved = typeOfDecl(this.set, decl);
    if (resolved.kind === 'anyType' || resolved.kind === 'soapencArray') {
      const text = lexical(value);
      return this.wellFormed(text, where)
        ? { ...node, kind: 'group', present: true, children: [verbatim(`${node.id}/x`, text)] }
        : absent(node);
    }
    if (resolved.kind === 'simple') {
      const scalar = isObject(value) && '#text' in value ? value['#text'] : value;
      return { ...node, present: true, value: lexical(scalar) };
    }
    if (!isObject(value)) {
      this.notes.push(`${where}: expected an object; written empty`);
    }
    const fields: JsonObject = isObject(value) ? value : {};
    const shape = contentShape(this.set, resolved.type, []);
    const attributes = node.children
      .filter((child) => child.kind === 'attribute')
      .map((child) => this.attribute(child, shape, fields));
    if (node.kind === 'field') {
      // Simple content: the text beside the attributes.
      const text = fields['#text'];
      return { ...node, present: true, value: text === undefined ? (node.fixed ?? '') : lexical(text), children: attributes };
    }
    if (node.truncated === true) {
      const deeper = fields['#text'] !== undefined || shape.members.some((member) => memberKeys(member).some((key) => fields[key] !== undefined));
      if (deeper) {
        this.pending += 1;
      }
      return { ...node, present: true, children: attributes };
    }
    // Leftovers (`/~`) are what an earlier round wrote under `#any`: the JSON writes them again.
    const particles = node.children.filter((child) => child.kind !== 'attribute' && !child.id.startsWith(`${node.id}/~`));
    const text =
      shape.content.mixed && fields['#text'] !== undefined
        ? [verbatim(`${node.id}/t`, escapeText(lexical(fields['#text'])))]
        : [];
    return {
      ...node,
      present: true,
      children: [...attributes, ...text, ...this.members(particles, shape.members, fields, where)],
    };
  }

  private nil(node: FormNode, decl: ElementDecl, where: string): FormNode {
    if (!decl.nillable) {
      this.notes.push(`${where}: null for an element that is not nillable; left out`);
      return absent(node);
    }
    const kept = (node.extraAttributes ?? []).filter((extra) => extra.name !== 'xsi:nil' && extra.name !== 'xmlns:xsi');
    return {
      ...node,
      kind: 'field',
      present: true,
      value: '',
      children: [],
      extraAttributes: [...kept, { name: 'xmlns:xsi', value: NS.XSI }, { name: 'xsi:nil', value: 'true' }],
    };
  }

  private attribute(node: FormNode, shape: ContentShape, fields: JsonObject): FormNode {
    const match = shape.attributes.find((candidate) => qnameEquals(candidate.attribute.name, node.name));
    const value = match === undefined ? undefined : fields[match.key];
    if (value === undefined) {
      return node.fixed !== undefined && node.required ? { ...node, present: true, value: node.fixed } : { ...node, present: false };
    }
    return { ...node, present: true, value: lexical(value) };
  }

  /** The particle nodes of one element (or one repeat occurrence), filled member by member. */
  private members(nodes: readonly FormNode[], members: readonly Member[], fields: JsonObject, where: string): FormNode[] {
    if (nodes.length !== members.length) {
      this.notes.push(`${where}: the form and the schema disagree on this content; it is left out`);
      return nodes.map(absent);
    }
    return members.map((member, index) => this.member(nodes[index] as FormNode, member, fields, where));
  }

  private member(node: FormNode, member: Member, fields: JsonObject, where: string): FormNode {
    switch (member.kind) {
      case 'element': {
        const value = fields[member.key];
        const at = `${where}/${member.key}`;
        if (!repeats(member.occurs)) {
          return this.element(node, member.decl, value, at);
        }
        const items = value === undefined ? [] : Array.isArray(value) ? (value as unknown[]) : [value];
        return this.repeat(node, items, (slot, item, index) => this.element(slot, member.decl, item, `${at}/${String(index)}`));
      }
      case 'any': {
        const value = fields[member.key];
        if (value === undefined) {
          return absent(node);
        }
        const text = lexical(value);
        return this.wellFormed(text, `${where}/${member.key}`) ? { ...node, present: true, raw: text } : absent(node);
      }
      case 'choice':
        return this.choice(node, member, fields, where);
      case 'group': {
        const value = fields[member.key];
        const items = value === undefined ? [] : Array.isArray(value) ? (value as unknown[]) : [value];
        const at = `${where}/${member.key}`;
        if (member.compositor === 'choice') {
          // The form models a repeating choice as one choice node: one copy of it per item.
          const inner = member.members[0];
          if (inner?.kind !== 'choice') {
            return absent(node);
          }
          const instances = items.map((item, index) =>
            this.choice(node, inner, isObject(item) ? item : {}, `${at}/${String(index)}`),
          );
          return {
            id: node.id,
            kind: 'repeat',
            name: node.name,
            label: node.label,
            required: node.required,
            occurs: member.occurs,
            present: instances.length > 0,
            children: [],
            repeat: { instances, template: node, canAdd: true, canRemove: true },
          };
        }
        return this.repeat(node, items, (slot, item, index) => ({
          ...slot,
          present: true,
          children: this.members(slot.children, member.members, isObject(item) ? item : {}, `${at}/${String(index)}`),
        }));
      }
    }
  }

  private repeat(
    node: FormNode,
    items: readonly unknown[],
    fill: (slot: FormNode, item: unknown, index: number) => FormNode,
  ): FormNode {
    const slots = node.repeat;
    if (node.kind !== 'repeat' || slots === undefined) {
      this.notes.push(`${node.label}: the form has no repeat here; left out`);
      return absent(node);
    }
    // An occurrence an earlier round wrote is built from the XML, below the cut; a new one from the template.
    const instances = items.map((item, index) => fill(slots.instances[index] ?? slots.template, item, index));
    return { ...node, present: instances.length > 0, repeat: { ...slots, instances } };
  }

  private choice(node: FormNode, member: Extract<Member, { kind: 'choice' }>, fields: JsonObject, where: string): FormNode {
    if (node.kind !== 'choice') {
      this.notes.push(`${where}: the form has no choice here; left out`);
      return absent(node);
    }
    const chosen = member.branches.findIndex((branch) =>
      branch.flatMap(memberKeys).some((key) => fields[key] !== undefined),
    );
    const children = node.children.map((branchNode, index) => {
      const branch = member.branches[index] ?? [];
      if (index !== chosen) {
        return absent(branchNode);
      }
      const [only] = branch;
      if (branch.length === 1 && only !== undefined) {
        return this.member(branchNode, only, fields, where);
      }
      return { ...branchNode, present: true, children: this.members(branchNode.children, branch, fields, where) };
    });
    return { ...node, present: chosen !== -1, children, choice: chosen === -1 ? {} : { selected: chosen } };
  }

  /** An XML fragment is inserted as written, once a strict parser reads it whole. */
  private wellFormed(text: string, where: string): boolean {
    const declarations = Object.entries(this.inScope)
      .map(([prefix, uri]) => ` xmlns:${prefix}="${escapeAttribute(uri)}"`)
      .join('');
    try {
      const { problems } = parseXmlDetailed(`<wirebench-fragment${declarations}>${text}</wirebench-fragment>`);
      const errors = problems.filter((problem) => problem.level === 'error');
      if (errors.length === 0) {
        return true;
      }
      this.problems.push(`${where}: not well-formed XML: ${errors.map((problem) => problem.message).join('; ')}`);
    } catch (error) {
      this.problems.push(`${where}: not well-formed XML: ${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  }
}

/**
 * XML for `target` from a JSON value shaped by {@link jsonSchemaOf}: the form model is built, filled,
 * and serialised, so names, prefixes and element order are the desktop form's. When the value reaches
 * below the form's depth cut, the form is built again from the XML written so far, one level deeper
 * each round, up to {@link MAX_FILL_ROUNDS}. Written with no indentation, so text values stay exact.
 */
export function xmlFromJson(
  schemaSet: SchemaSet,
  target: BridgeTarget,
  value: unknown,
  options: XmlFromJsonOptions = {},
): XmlFromJsonResult {
  const decl = rootDecl(schemaSet, target);
  if (decl === undefined) {
    const name = 'element' in target ? qnameToString(target.element) : '';
    return { xml: '', notes: [], problems: [`no element ${name} in the schema`] };
  }
  const formOptions = {
    ...(options.prefixes !== undefined ? { prefixes: options.prefixes } : {}),
    ...(options.inScope !== undefined ? { inScope: options.inScope } : {}),
  };
  let xml: string | undefined;
  let notes: readonly string[] = [];
  for (let round = 0; round < MAX_FILL_ROUNDS; round += 1) {
    const form =
      'element' in target
        ? buildForm(schemaSet, target.element, xml, formOptions)
        : buildFormForType(schemaSet, target.name, target.type, xml, formOptions);
    const filler = new Filler(schemaSet, options.inScope ?? {});
    const filled = filler.element(form, decl, value, form.label);
    if (filler.problems.length > 0) {
      return { xml: '', notes: filler.notes, problems: filler.problems };
    }
    xml = applyForm(filled, { indent: '' });
    notes = filler.notes;
    if (filler.pending === 0) {
      return { xml, notes, problems: [] };
    }
  }
  return {
    xml: xml ?? '',
    notes: [
      ...notes,
      `the arguments nest more than ${String(MAX_FILL_ROUNDS)} levels below the form's depth limit; the deepest were left out`,
    ],
    problems: [],
  };
}

// ---------------------------------------------------------------------------
// JSON from XML
// ---------------------------------------------------------------------------

export interface JsonFromXmlResult {
  readonly value: unknown;
  /** Values that could not be typed, and elements the schema does not declare. */
  readonly notes: readonly string[];
}

/** The unclaimed children of one element, taken by name as members are read. */
class ReadPool {
  private readonly used: boolean[];

  constructor(private readonly children: readonly ScannedElement[]) {
    this.used = children.map(() => false);
  }

  private matches(child: ScannedElement, names: readonly QName[]): boolean {
    return names.some((name) => name.localName === child.localName && name.namespaceUri === child.namespaceUri);
  }

  take(names: readonly QName[]): ScannedElement | undefined {
    const index = this.children.findIndex((child, at) => this.used[at] !== true && this.matches(child, names));
    if (index === -1) {
      return undefined;
    }
    this.used[index] = true;
    return this.children[index];
  }

  has(names: readonly QName[]): boolean {
    return this.children.some((child, at) => this.used[at] !== true && this.matches(child, names));
  }

  remaining(): number {
    return this.used.filter((used) => !used).length;
  }

  leftovers(): ScannedElement[] {
    return this.children.filter((_, at) => this.used[at] !== true);
  }
}

const localOf = (name: string): string => (name.includes(':') ? name.slice(name.indexOf(':') + 1) : name);

class Reader {
  readonly notes: string[] = [];

  constructor(
    private readonly set: SchemaSet,
    private readonly source: string,
  ) {}

  element(el: ScannedElement, decl: ElementDecl, where: string): unknown {
    if (el.attributes.some((attribute) => attribute.name.endsWith(':nil') && (attribute.value === 'true' || attribute.value === '1'))) {
      return null;
    }
    const type = typeOfDecl(this.set, decl);
    switch (type.kind) {
      case 'anyType':
      case 'soapencArray':
        return this.inner(el);
      case 'simple':
        return this.typed(jsonKind(this.set, type.ref), el.text?.value ?? '', where);
      case 'complex':
        return this.object(el, type.type, where);
    }
  }

  private object(el: ScannedElement, type: ComplexType, where: string): Record<string, unknown> {
    const shape = contentShape(this.set, type, []);
    const out: Record<string, unknown> = {};
    for (const attribute of el.attributes) {
      if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) {
        continue;
      }
      const local = localOf(attribute.name);
      const match = shape.attributes.find((candidate) => candidate.attribute.name.localName === local);
      if (match === undefined) {
        if (!attribute.name.includes(':')) {
          this.notes.push(`${where}/@${local}: not in the schema; left out`);
        }
        continue;
      }
      const ref = match.attribute.type ?? match.attribute.anonymousType;
      out[match.key] = this.typed(jsonKind(this.set, ref), attribute.value, `${where}/@${local}`);
    }
    if (shape.content.simpleContentBase !== undefined) {
      out['#text'] = this.typed(jsonKind(this.set, shape.content.simpleContentBase), el.text?.value ?? '', `${where}/#text`);
      return out;
    }
    if (shape.content.mixed) {
      const text = this.mixedText(el);
      if (text !== '') {
        out['#text'] = text;
      }
    }
    const pool = new ReadPool(el.children);
    this.members(shape.members, pool, out, where);
    const leftovers = pool.leftovers();
    const wildcard = shape.members.find((member) => member.kind === 'any');
    if (leftovers.length > 0 && wildcard !== undefined && wildcard.kind === 'any') {
      out[wildcard.key] = leftovers.map((child) => this.slice(child)).join('\n');
    } else {
      for (const child of leftovers) {
        let key = child.localName;
        for (let n = 2; key in out; n += 1) {
          key = `${child.localName}_${String(n)}`;
        }
        out[key] = this.slice(child);
        this.notes.push(`${where}/${child.localName}: not in the schema; kept as its XML`);
      }
    }
    return out;
  }

  private members(members: readonly Member[], pool: ReadPool, out: Record<string, unknown>, where: string): void {
    for (const member of members) {
      switch (member.kind) {
        case 'element': {
          const at = `${where}/${member.key}`;
          if (!repeats(member.occurs)) {
            const child = pool.take(member.names);
            if (child !== undefined) {
              out[member.key] = this.element(child, this.declFor(member, child), at);
            }
            break;
          }
          const max = member.occurs.max === 'unbounded' ? Number.POSITIVE_INFINITY : member.occurs.max;
          const items: unknown[] = [];
          let child = pool.take(member.names);
          while (child !== undefined) {
            items.push(this.element(child, this.declFor(member, child), `${at}/${String(items.length)}`));
            child = items.length < max ? pool.take(member.names) : undefined;
          }
          if (items.length > 0) {
            out[member.key] = items;
          }
          break;
        }
        case 'any':
          break;
        case 'choice': {
          const branch = member.branches.find((candidate) => pool.has(namesOf(candidate)));
          if (branch !== undefined) {
            this.members(branch, pool, out, where);
          }
          break;
        }
        case 'group': {
          const names = namesOf(member.members);
          const max = member.occurs.max === 'unbounded' ? Number.POSITIVE_INFINITY : member.occurs.max;
          const items: Record<string, unknown>[] = [];
          while (items.length < max && pool.has(names)) {
            const before = pool.remaining();
            const item: Record<string, unknown> = {};
            this.members(member.members, pool, item, `${where}/${member.key}/${String(items.length)}`);
            if (pool.remaining() === before) {
              break;
            }
            items.push(item);
          }
          if (items.length > 0) {
            out[member.key] = items;
          }
          break;
        }
      }
    }
  }

  /** The declaration for the name actually written: a substitution group member when it is one. */
  private declFor(member: Extract<Member, { kind: 'element' }>, child: ScannedElement): ElementDecl {
    const name = member.names.find(
      (candidate) => candidate.localName === child.localName && candidate.namespaceUri === child.namespaceUri,
    );
    if (name === undefined || qnameEquals(name, member.decl.name)) {
      return member.decl;
    }
    return this.set.lookupElement(name) ?? member.decl;
  }

  private typed(kind: JsonKind, text: string, where: string): unknown {
    if (kind === 'string') {
      return text;
    }
    const value = typedLexical(kind, text.trim());
    if (value === undefined) {
      this.notes.push(`${where}: "${text}" is not a valid ${kind}; kept as a string`);
      return text;
    }
    return value;
  }

  private slice(el: ScannedElement): string {
    return this.source.slice(el.range.start, el.range.end);
  }

  /** Where an element's content starts: after its start tag's `>`. */
  private contentStart(el: ScannedElement): number {
    const last = el.attributes.at(-1);
    return this.source.indexOf('>', last === undefined ? el.range.start : last.valueRange.end) + 1;
  }

  private closeStart(el: ScannedElement): number {
    return this.source.lastIndexOf('</', el.range.end);
  }

  /** An `anyType` element's content: its child elements as written, or its text. */
  private inner(el: ScannedElement): string {
    if (el.selfClosing) {
      return '';
    }
    if (el.children.length === 0) {
      return el.text?.value ?? '';
    }
    return this.source.slice(this.contentStart(el), this.closeStart(el)).trim();
  }

  /** Mixed content's text: the runs outside the child elements, each trimmed, joined by one space. */
  private mixedText(el: ScannedElement): string {
    if (el.selfClosing) {
      return '';
    }
    if (el.children.length === 0) {
      return (el.text?.value ?? '').trim();
    }
    const bounds = [this.contentStart(el), ...el.children.flatMap((child) => [child.range.start, child.range.end]), this.closeStart(el)];
    const runs: string[] = [];
    for (let at = 0; at + 1 < bounds.length; at += 2) {
      const raw = this.source.slice(bounds[at], bounds[at + 1]).replace(/<!--[\s\S]*?-->/g, '');
      const run = decodeEntities(raw).trim();
      if (run !== '') {
        runs.push(run);
      }
    }
    return runs.join(' ');
  }
}

/**
 * JSON for `xml` (one element, `target`'s) by the mapping of {@link jsonSchemaOf}, in reverse: arrays
 * from `maxOccurs` (one occurrence is still an array), numbers and booleans typed when lexically
 * valid, an element the schema does not declare kept as its XML text with a note.
 */
export function jsonFromXml(
  schemaSet: SchemaSet,
  target: BridgeTarget,
  xml: string,
  options: { readonly inScope?: Readonly<Record<string, string>> } = {},
): JsonFromXmlResult {
  const scanned = scanXml(xml, options.inScope ?? {});
  const root = scanned.elements[0];
  if (root === undefined) {
    return { value: undefined, notes: ['no element to read', ...scanned.problems] };
  }
  const reader = new Reader(schemaSet, xml);
  const decl = rootDecl(schemaSet, target);
  if (decl === undefined) {
    return { value: xml.slice(root.range.start, root.range.end), notes: [`${root.localName}: not in the schema; kept as its XML`] };
  }
  const named = schemaSet
    .substitutionsFor(decl.name)
    .find((candidate) => candidate.name.localName === root.localName && candidate.name.namespaceUri === root.namespaceUri);
  const value = reader.element(root, named ?? decl, root.localName);
  return { value, notes: reader.notes };
}
```

Add `ComplexType` to the `./model.js` type import if Task 1's list lacks it (it has it), and add `type JsonKind` usage (declared in Task 1).

In `packages/engine/src/index.ts`, extend Task 1's lines to:

```ts
export {
  createJsonSchemaWriter,
  jsonFromXml,
  jsonSchemaOf,
  MAX_FILL_ROUNDS,
  MAX_PROPERTY_DESCRIPTION,
  xmlFromJson,
} from './xsd/json-bridge.js';
export type {
  BridgeTarget,
  JsonFromXmlResult,
  JsonSchemaObject,
  JsonSchemaOfResult,
  JsonSchemaWriter,
  XmlFromJsonOptions,
  XmlFromJsonResult,
} from './xsd/json-bridge.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/xsd/json-bridge-xml.test.ts packages/engine/test/unit/xsd/json-bridge-schema.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/engine/src/xsd/json-bridge.ts packages/engine/src/xsd/xml-scan.ts packages/engine/src/index.ts packages/engine/test/unit/xsd/json-bridge-xml.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/xsd/json-bridge.ts packages/engine/src/xsd/xml-scan.ts packages/engine/src/index.ts packages/engine/test/unit/xsd/json-bridge-xml.test.ts
git commit -m "feat(engine): XML from JSON through the form model, and JSON back (#33)"
```

---

### Task 3: Engine — a SOAP operation's body as JSON

**Files:**
- Create: `packages/engine/src/soap/json-operation.ts`
- Modify: `packages/engine/src/soap/form-request.ts` (`findBody`, `namespacesInScope` exported)
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/test/unit/soap/json-operation.test.ts` (new)

**Interfaces:**
- Consumes: Task 1–2's `createJsonSchemaWriter`, `xmlFromJson`, `jsonFromXml`, `BridgeTarget`, `JsonSchemaObject`; `bindingContextFor`, `validateMessage`, `MessageDirection` (`validate/index.ts`); `buildEmptyRequest`, `RequestBuildInput`, `OperationRef` (`soap/request-builder.ts`); `createEnvelope`, `SoapEnvelopeVersion` (`soap/envelope.ts`); `findBinding`, `findMessage`, `findPortType` (`wsdl/model.ts`); `prefixForNamespace` (`xml/prefixes.ts`); `escapeAttribute` (`xsd/xml-writer.ts`); `scanXml`.
- Produces:
  - `interface OperationSchema { readonly schema: JsonSchemaObject; readonly notes: readonly string[] }`
  - `operationJsonSchema(input: RequestBuildInput, op: OperationRef, direction?: MessageDirection): OperationSchema`
  - `interface JsonEnvelope { readonly envelopeXml: string; readonly soapVersion: SoapEnvelopeVersion; readonly soapAction?: string; readonly notes: readonly string[]; readonly problems: readonly string[] }`
  - `envelopeFromJson(input: RequestBuildInput, op: OperationRef, args: Readonly<Record<string, unknown>>): JsonEnvelope`
  - `jsonFromEnvelope(input: RequestBuildInput, op: OperationRef, xml: string, direction?: MessageDirection): JsonFromXmlResult`
  - `faultDetailJson(input: RequestBuildInput, op: OperationRef, detailXml: string): JsonFromXmlResult | undefined`

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/soap/json-operation.test.ts
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { importWsdl } from '../../../src/soap/import.js';
import {
  envelopeFromJson,
  faultDetailJson,
  jsonFromEnvelope,
  operationJsonSchema,
} from '../../../src/soap/json-operation.js';
import type { WsdlImportResult } from '../../../src/soap/types.js';
import { bindingContextFor, validateMessage } from '../../../src/validate/index.js';
import { jsonSchemaOf } from '../../../src/xsd/json-bridge.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/json-bridge/service.wsdl', import.meta.url));
const BRIDGE = 'urn:wb:bridge';
const PLACE = { bindingName: { namespaceUri: BRIDGE, localName: 'BridgeSoap' }, operationName: 'PlaceOrder' };
const QUOTE = { bindingName: { namespaceUri: BRIDGE, localName: 'BridgeRpc' }, operationName: 'Quote' };

const ORDER = {
  '@channel': 'web',
  id: 7,
  customer: { name: 'Ada' },
  line: [{ sku: 'ABC-1', qty: 2 }],
  card: '4000',
  priority: 'LOW',
  placed: '2026-10-03',
  paid: true,
  total: 3,
};

let wsdl: WsdlImportResult;

beforeAll(async () => {
  wsdl = await importWsdl({ kind: 'file', path: FIXTURE });
});

describe('a SOAP operation as JSON', () => {
  it("takes a document/literal operation's arguments as its body element's content", () => {
    const { schema } = operationJsonSchema(wsdl, PLACE);
    const element = jsonSchemaOf(wsdl.schemaSet, { element: { namespaceUri: BRIDGE, localName: 'Order' } }).schema;
    expect(schema).toEqual(element);
  });

  it('takes an rpc operation\'s arguments as one property per part', () => {
    expect(operationJsonSchema(wsdl, QUOTE).schema).toEqual({
      type: 'object',
      properties: {
        item: { type: 'string' },
        count: { type: 'integer', minimum: -2147483648, maximum: 2147483647 },
      },
      required: ['item', 'count'],
      additionalProperties: false,
    });
  });

  it('builds an envelope the XSD check passes, with the binding transport', async () => {
    const built = envelopeFromJson(wsdl, PLACE, ORDER);
    expect(built.problems).toEqual([]);
    expect(built.soapVersion).toBe('1.1');
    expect(built.soapAction).toBe('urn:wb:bridge/PlaceOrder');
    const binding = bindingContextFor(wsdl.definition, PLACE, 'request');
    if (binding === undefined) throw new Error('no binding');
    const { problems } = await validateMessage({
      xml: built.envelopeXml,
      direction: 'request',
      schemaSet: wsdl.schemaSet,
      bundle: wsdl.bundle,
      binding,
    });
    expect(problems.filter((problem) => problem.severity === 'error')).toEqual([]);
    expect(jsonFromEnvelope(wsdl, PLACE, built.envelopeXml, 'request').value).toEqual(ORDER);
  });

  it('keeps a multi-line value exactly inside the envelope', () => {
    const built = envelopeFromJson(wsdl, PLACE, { ...ORDER, customer: { name: 'one\n  two' } });
    expect(built.envelopeXml).toContain('one\n  two');
  });

  it('wraps rpc parts in the operation element, in the binding namespace', () => {
    const built = envelopeFromJson(wsdl, QUOTE, { item: 'tea', count: 2 });
    expect(built.envelopeXml).toMatch(/<([A-Za-z][\w.-]*):Quote xmlns:\1="urn:wb:bridge:rpc">/);
    expect(jsonFromEnvelope(wsdl, QUOTE, built.envelopeXml, 'request').value).toEqual({ item: 'tea', count: 2 });
  });

  it('reads a response body as JSON', () => {
    const response =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
      '<r:OrderResult xmlns:r="urn:wb:bridge"><r:orderId>9</r:orderId><r:status>ok</r:status></r:OrderResult>' +
      '</soapenv:Body></soapenv:Envelope>';
    expect(jsonFromEnvelope(wsdl, PLACE, response)).toEqual({ value: { orderId: 9, status: 'ok' }, notes: [] });
  });

  it("reads a declared fault detail as JSON, and nothing else", () => {
    const detail = '<b:OrderFault xmlns:b="urn:wb:bridge"><b:reason>no stock</b:reason><b:code>4</b:code></b:OrderFault>';
    expect(faultDetailJson(wsdl, PLACE, detail)).toEqual({ value: { reason: 'no stock', code: 4 }, notes: [] });
    expect(faultDetailJson(wsdl, PLACE, '<other>1</other>')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/soap/json-operation.test.ts`
Expected: FAIL — `Cannot find module '../../../src/soap/json-operation.js'`.

- [ ] **Step 3: Implement**

In `packages/engine/src/soap/form-request.ts`, add `export` to `function findBody(` and `function namespacesInScope(` (bodies unchanged).

Create `packages/engine/src/soap/json-operation.ts`:

```ts
/**
 * A SOAP operation's body as JSON (#33 spec §3.1, §4.1, §5). One document/literal element part is
 * that element's content; any other shape is one property per part, inside the rpc wrapper element
 * for rpc. The envelope's transport (version, action) is the one a new request of the operation has.
 */
import type { MessageDirection } from '../validate/index.js';
import { bindingContextFor } from '../validate/index.js';
import { findBinding, findMessage, findPortType } from '../wsdl/model.js';
import type { QName } from '../wsdl/qname.js';
import { NS } from '../xml/namespaces.js';
import { prefixForNamespace } from '../xml/prefixes.js';
import { createJsonSchemaWriter, jsonFromXml, xmlFromJson } from '../xsd/json-bridge.js';
import type { BridgeTarget, JsonFromXmlResult, JsonSchemaObject } from '../xsd/json-bridge.js';
import { scanXml } from '../xsd/xml-scan.js';
import type { ScannedElement } from '../xsd/xml-scan.js';
import { escapeAttribute } from '../xsd/xml-writer.js';
import { createEnvelope } from './envelope.js';
import type { SoapEnvelopeVersion } from './envelope.js';
import { findBody, namespacesInScope } from './form-request.js';
import { buildEmptyRequest } from './request-builder.js';
import type { OperationRef, RequestBuildInput } from './request-builder.js';

export interface OperationSchema {
  readonly schema: JsonSchemaObject;
  readonly notes: readonly string[];
}

export interface JsonEnvelope {
  readonly envelopeXml: string;
  readonly soapVersion: SoapEnvelopeVersion;
  readonly soapAction?: string;
  readonly notes: readonly string[];
  /** Why no body could be written; nothing may be sent when any. */
  readonly problems: readonly string[];
}

const ANY_TYPE: QName = { namespaceUri: NS.XSD, localName: 'anyType' };

interface BodyPart {
  readonly name: string;
  readonly target: BridgeTarget;
}

interface BodyShape {
  /** One document/literal element part: the arguments are its content. */
  readonly single: boolean;
  readonly parts: readonly BodyPart[];
  /** rpc: the element the parts sit in. */
  readonly wrapper?: QName;
}

function bodyShape(input: RequestBuildInput, op: OperationRef, direction: MessageDirection): BodyShape | undefined {
  const binding = bindingContextFor(input.definition, op, direction);
  if (binding === undefined) {
    return undefined;
  }
  const parts: BodyPart[] = binding.parts.map((part) => ({
    name: part.name,
    target:
      part.element !== undefined
        ? { element: part.element }
        : { name: { namespaceUri: '', localName: part.name }, type: part.type ?? ANY_TYPE },
  }));
  const [first] = parts;
  if (binding.style === 'document') {
    return { single: parts.length === 1 && first !== undefined && 'element' in first.target, parts };
  }
  const operation = findBinding(input.definition, op.bindingName)?.operations.find(
    (candidate) => candidate.name === op.operationName,
  );
  const body = direction === 'request' ? operation?.input?.body : operation?.output?.body;
  return {
    single: false,
    parts,
    wrapper: {
      namespaceUri: body?.namespace ?? input.definition.targetNamespace,
      localName: direction === 'request' ? op.operationName : `${op.operationName}Response`,
    },
  };
}

const OBJECT_OF_NOTHING: JsonSchemaObject = { type: 'object', properties: {}, additionalProperties: false };

/** The JSON Schema of an operation's input (or output) body, `$defs` shared across its parts. */
export function operationJsonSchema(
  input: RequestBuildInput,
  op: OperationRef,
  direction: MessageDirection = 'request',
): OperationSchema {
  const shape = bodyShape(input, op, direction);
  if (shape === undefined) {
    return { schema: OBJECT_OF_NOTHING, notes: [`${op.operationName}: the binding has no SOAP operation of that name`] };
  }
  const writer = createJsonSchemaWriter(input.schemaSet);
  let schema: JsonSchemaObject;
  const [first] = shape.parts;
  if (shape.single && first !== undefined) {
    const content = writer.schemaOf(first.target);
    // A body element of simple type takes its value as `#text`.
    schema =
      content['type'] === 'object'
        ? content
        : { type: 'object', properties: { '#text': content }, required: ['#text'], additionalProperties: false };
  } else {
    schema = {
      type: 'object',
      properties: Object.fromEntries(shape.parts.map((part) => [part.name, writer.schemaOf(part.target)])),
      ...(shape.parts.length > 0 ? { required: shape.parts.map((part) => part.name) } : {}),
      additionalProperties: false,
    };
  }
  const defs = writer.defs();
  return { schema: defs === undefined ? schema : { ...schema, $defs: defs }, notes: writer.notes() };
}

/**
 * The request envelope for `args`: the body written through the form model, in an envelope with no
 * indentation (`createEnvelope` indents every line of the body, which would change a multi-line value).
 */
export function envelopeFromJson(
  input: RequestBuildInput,
  op: OperationRef,
  args: Readonly<Record<string, unknown>>,
): JsonEnvelope {
  const empty = buildEmptyRequest(input, op);
  const notes = empty.problems.map((problem) => problem.message);
  const transport = {
    soapVersion: empty.soapVersion,
    ...(empty.soapAction !== undefined ? { soapAction: empty.soapAction } : {}),
  };
  const shape = bodyShape(input, op, 'request');
  if (shape === undefined) {
    return { envelopeXml: '', ...transport, notes, problems: [`${op.operationName}: the binding has no SOAP operation of that name`] };
  }
  const problems: string[] = [];
  const write = (target: BridgeTarget, value: unknown): string => {
    const written = xmlFromJson(input.schemaSet, target, value);
    notes.push(...written.notes);
    problems.push(...written.problems);
    return written.xml;
  };
  const [first] = shape.parts;
  let bodyXml: string;
  if (shape.single && first !== undefined) {
    bodyXml = write(first.target, args);
  } else {
    const pieces = shape.parts.map((part) => write(part.target, args[part.name])).filter((piece) => piece !== '');
    const wrapper = shape.wrapper;
    if (wrapper === undefined) {
      bodyXml = pieces.join('\n');
    } else if (wrapper.namespaceUri === '') {
      bodyXml = [`<${wrapper.localName}>`, ...pieces, `</${wrapper.localName}>`].join('\n');
    } else {
      const prefix = prefixForNamespace(wrapper.namespaceUri, new Set());
      const name = `${prefix}:${wrapper.localName}`;
      bodyXml = [`<${name} xmlns:${prefix}="${escapeAttribute(wrapper.namespaceUri)}">`, ...pieces, `</${name}>`].join('\n');
    }
  }
  if (problems.length > 0) {
    return { envelopeXml: '', ...transport, notes, problems };
  }
  return { envelopeXml: createEnvelope(empty.soapVersion, { bodyXml }, { indent: '' }), ...transport, notes, problems };
}

function matches(element: ScannedElement, name: QName): boolean {
  return element.localName === name.localName && element.namespaceUri === name.namespaceUri;
}

/** An envelope's body read back as the JSON {@link envelopeFromJson} takes. */
export function jsonFromEnvelope(
  input: RequestBuildInput,
  op: OperationRef,
  xml: string,
  direction: MessageDirection = 'response',
): JsonFromXmlResult {
  const shape = bodyShape(input, op, direction);
  const body = findBody(scanXml(xml).elements);
  if (shape === undefined || body === undefined) {
    return { value: undefined, notes: ['the message has no SOAP Body this operation describes'] };
  }
  const inScope = namespacesInScope(xml).byPrefix;
  const read = (target: BridgeTarget, element: ScannedElement): JsonFromXmlResult =>
    jsonFromXml(input.schemaSet, target, xml.slice(element.range.start, element.range.end), { inScope });
  const [first] = shape.parts;
  const [child] = body.children;
  if (shape.single && first !== undefined) {
    if (child === undefined) {
      return { value: undefined, notes: ['the SOAP Body is empty'] };
    }
    const result = read(first.target, child);
    const isObject = typeof result.value === 'object' && result.value !== null && !Array.isArray(result.value);
    return isObject || result.value === undefined ? result : { value: { '#text': result.value }, notes: result.notes };
  }
  const holder = shape.wrapper === undefined ? body : child;
  if (holder === undefined) {
    return { value: undefined, notes: ['the SOAP Body is empty'] };
  }
  const value: Record<string, unknown> = {};
  const notes: string[] = [];
  for (const part of shape.parts) {
    const element = holder.children.find((candidate) =>
      'element' in part.target ? matches(candidate, part.target.element) : candidate.localName === part.name,
    );
    if (element !== undefined) {
      const result = read(part.target, element);
      value[part.name] = result.value;
      notes.push(...result.notes);
    }
  }
  return { value, notes };
}

/**
 * A fault's `detail` as JSON, when its first element is the element of a fault message part the
 * operation declares; undefined otherwise (the caller keeps the XML).
 */
export function faultDetailJson(
  input: RequestBuildInput,
  op: OperationRef,
  detailXml: string,
): JsonFromXmlResult | undefined {
  const binding = findBinding(input.definition, op.bindingName);
  const operation =
    binding === undefined
      ? undefined
      : findPortType(input.definition, binding.type)?.operations.find((candidate) => candidate.name === op.operationName);
  const declared = (operation?.faults ?? []).flatMap(
    (fault) => findMessage(input.definition, fault.message)?.parts.flatMap((part) => (part.element !== undefined ? [part.element] : [])) ?? [],
  );
  const first = scanXml(detailXml).elements[0];
  const element = first === undefined ? undefined : declared.find((name) => matches(first, name));
  if (first === undefined || element === undefined) {
    return undefined;
  }
  return jsonFromXml(input.schemaSet, { element }, detailXml.slice(first.range.start, first.range.end));
}
```

In `packages/engine/src/index.ts`, after `export type { RequestForm } from './soap/form-request.js';`, add:

```ts
export { envelopeFromJson, faultDetailJson, jsonFromEnvelope, operationJsonSchema } from './soap/json-operation.js';
export type { JsonEnvelope, OperationSchema } from './soap/json-operation.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/soap/json-operation.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/engine/src/soap/json-operation.ts packages/engine/src/soap/form-request.ts packages/engine/src/index.ts packages/engine/test/unit/soap/json-operation.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/soap/json-operation.ts packages/engine/src/soap/form-request.ts packages/engine/src/index.ts packages/engine/test/unit/soap/json-operation.test.ts
git commit -m "feat(engine): a SOAP operation's body as JSON arguments and results (#33)"
```

---

### Task 4: CLI — deriving the contract tools

**Files:**
- Create: `packages/cli/src/ops/contract-tools.ts`
- Create: `packages/cli/src/ops/rest-args.ts`
- Modify: `packages/engine/src/index.ts` (`validateJsonSchema` exported)
- Modify: `packages/cli/src/ops/operations.ts` (`tool` on rows; `byOrder` moves to `contract-tools.ts`)
- Modify: `packages/cli/src/commands/ops-output.ts` (`operationsText` shows the tool)
- Modify: `packages/cli/test/unit/ops/helpers.ts` (`manyOperationsOpenApi`)
- Modify: `packages/cli/test/unit/ops/operations.test.ts`
- Test: `packages/cli/test/unit/ops/contract-tools.test.ts` (new), `packages/cli/test/unit/ops/rest-args.test.ts` (new)

**Interfaces:**
- Consumes: Task 3's `operationJsonSchema`; Task 1's `JsonSchemaObject`; `validateJsonSchema`, `JsonSchemaProblem`; `summarizeSoapOperations`, `loadOpenApiDocument`; `ResolvedOperation`, `soapRef`, `restRef` (`ops/operation-refs.ts`); `readWsdl`, `clarkToQName`, `LoadedWsdl` (`ops/project.ts`); `Gates` (`ops/context.ts`); `OpsError`, `toOpsError`.
- Produces (`ops/contract-tools.ts`):
  - `FIXED_TOOL_NAMES: readonly OpName[]`, `CONTRACT_TOOL_CAP = 128`, `MAX_TOOL_NAME = 64`, `MAX_TOOL_DESCRIPTION = 1000`, `LARGE_SCHEMA_CHARS = 64 * 1024`
  - `byOrder<T extends { order: number; name: string }>(a: T, b: T): number`
  - `snakeName(text: string): string`, `toolBaseName(containerSlug: string, operationPart: string): string`, `assignNames(bases: readonly string[]): string[]`
  - `interface ContractEntry { name; kind: 'soap' | 'rest'; ref; container: { name; slug }; resolved?: ResolvedOperation; binding?: string; shared: boolean }`
  - `contractOperations(project: Project, projectDir: string, notes: string[], include?: (container: { name: string; slug: string }) => boolean): Promise<ContractEntry[]>`
  - `toolNamesByRef(project: Project, projectDir: string): Promise<ReadonlyMap<string, string>>` — key `soap:<ref>` / `rest:<ref>`
  - `type EnvironmentKey = 'environment' | 'wirebench_environment'`
  - `interface ToolSchema { inputSchema: JsonSchemaObject; environmentKey: EnvironmentKey; notes: readonly string[]; cookies: readonly string[] }`, `toolSchemaOf(resolved: ResolvedOperation): ToolSchema`
  - `describeTool(entry: ContractEntry, resolved: ResolvedOperation, gates: Gates, cookies: readonly string[]): string`
  - `dereferenced(schema: JsonSchemaObject): JsonSchemaObject`, `checkArgs(inputSchema: JsonSchemaObject, args: Readonly<Record<string, unknown>>): void` (throws `invalid-input`)
  - `interface ContractTool { name; ref; kind; container: string; description; inputSchema: JsonSchemaObject; environmentKey: EnvironmentKey }`
  - `interface ContractToolSet { tools: readonly ContractTool[]; counts: Readonly<Record<string, number>>; total: number; overCap: boolean; notes: readonly string[] }`
  - `interface DeriveOptions { projectDir: string; gates: Gates; containers?: readonly string[]; cap?: number }`, `deriveContractTools(project: Project, options: DeriveOptions): Promise<ContractToolSet>`, `capMessage(set: ContractToolSet): string`
- Produces (`ops/rest-args.ts`): `interface RestToolSchema { schema: JsonSchemaObject; notes: readonly string[]; cookies: readonly string[] }`, `restToolSchema(api: RestApi, operation: OpenApiOperation): RestToolSchema`, `authHeaderNames(api: RestApi): ReadonlySet<string>`, `jsonMediaType(operation: OpenApiOperation): string | undefined`.
- `OperationRow` (soap and rest) gains `readonly tool?: string`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/cli/test/unit/ops/helpers.ts`:

```ts
/** An OpenAPI file with `count` GET endpoints (`opN`), title `Many`: more than the tool cap allows. */
export async function manyOperationsOpenApi(count: number): Promise<string> {
  const paths = Array.from(
    { length: count },
    (_, index) => `  /r${String(index)}:
    get:
      operationId: op${String(index)}
      responses:
        '200':
          description: ok
`,
  ).join('');
  const file = join(await tempDir(), 'many.openapi.yaml');
  await writeFile(
    file,
    `openapi: 3.0.3
info:
  title: Many
  version: 1.0.0
servers:
  - url: http://127.0.0.1:9
paths:
${paths}`,
  );
  return file;
}
```

```ts
// packages/cli/test/unit/ops/contract-tools.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { loadProject } from '@wirebench/engine';
import {
  assignNames,
  capMessage,
  checkArgs,
  CONTRACT_TOOL_CAP,
  deriveContractTools,
  FIXED_TOOL_NAMES,
  snakeName,
  toolBaseName,
} from '../../../src/ops/contract-tools.js';
import { runOp } from '../../../src/ops/context.js';
import { OpsError } from '../../../src/ops/errors.js';
import { importOp } from '../../../src/ops/import.js';
import { OPS } from '../../../src/ops/index.js';
import {
  CALCULATOR_WSDL,
  emptyProject,
  manyOperationsOpenApi,
  removeTempDirs,
  restProject,
  soapProject,
  twoBindingWsdl,
  updateProject,
} from './helpers.js';
import type { Fixture } from './helpers.js';

afterEach(removeTempDirs);

const GATES = { write: false, send: true };

async function derive(fixture: Fixture, containers?: readonly string[]) {
  const { project } = await loadProject(fixture.dir);
  return deriveContractTools(project, {
    projectDir: fixture.dir,
    gates: GATES,
    ...(containers !== undefined ? { containers } : {}),
  });
}

describe('tool names', () => {
  it('are snake_case, split on case changes, with every other run of characters one underscore', () => {
    expect(snakeName('CalculatorService')).toBe('calculator_service');
    expect(snakeName('listPets')).toBe('list_pets');
    expect(snakeName('HTTPServer v2')).toBe('http_server_v2');
    expect(snakeName('get_/pets/{petId}')).toBe('get_pets_pet_id');
    expect(snakeName('--')).toBe('');
  });

  it('keep the operation part, cutting the container first and then the end, at 64 characters', () => {
    expect(toolBaseName('Pets', 'listPets')).toBe('pets_list_pets');
    const long = toolBaseName('A'.repeat(40), 'b'.repeat(40));
    expect(long).toHaveLength(64);
    expect(long.endsWith(`_${'b'.repeat(40)}`)).toBe(true);
    expect(toolBaseName('Pets', 'c'.repeat(80))).toBe('c'.repeat(64));
    expect(toolBaseName('***', '???')).toBe('contract_operation');
  });

  it('take a numeric suffix after a fixed tool or an earlier name', () => {
    expect(FIXED_TOOL_NAMES).toEqual(Object.keys(OPS));
    expect(assignNames(['send', 'a_b', 'a_b', 'a_b'])).toEqual(['send_2', 'a_b', 'a_b_2', 'a_b_3']);
    expect(assignNames(['x'.repeat(64), 'x'.repeat(64)])).toEqual(['x'.repeat(64), `${'x'.repeat(62)}_2`]);
  });
});

describe('deriveContractTools', () => {
  it('makes one tool per SOAP operation, its schema the body plus environment, its description the gate', async () => {
    const set = await derive(await soapProject());
    expect(set.overCap).toBe(false);
    expect(set.counts).toEqual({ CalculatorService: 1 });
    const [tool] = set.tools;
    expect(tool).toMatchObject({
      name: 'calculator_service_add',
      ref: 'CalculatorService/Add',
      kind: 'soap',
      container: 'CalculatorService',
      environmentKey: 'environment',
    });
    expect(Object.keys(tool?.inputSchema['properties'] as object)).toEqual(['environment', 'a', 'b', 'note']);
    expect(tool?.inputSchema['required']).toEqual(['a', 'b']);
    expect(tool?.description).toContain('"CalculatorService"');
    expect(tool?.description).toContain('--allow-send');
    expect(tool?.description).toContain('History');
  });

  it('names a REST endpoint by its operationId and builds path, query, headers and body', async () => {
    const set = await derive(await restProject());
    expect(set.tools.map((tool) => tool.name)).toEqual(['pets_list_pets', 'pets_create_pet', 'pets_show_pet']);
    expect(set.tools[2]?.inputSchema).toMatchObject({
      properties: {
        path: {
          type: 'object',
          properties: { petId: { type: 'integer' } },
          required: ['petId'],
          additionalProperties: false,
        },
      },
      required: ['path'],
    });
    expect(set.tools[1]?.inputSchema).toMatchObject({
      properties: { body: { type: 'object', required: ['name'] } },
      required: ['body'],
    });
    expect(set.tools[1]?.description.startsWith('Create a pet')).toBe(true);
  });

  it('makes two tools of one operation bound twice, the second suffixed and naming its binding', async () => {
    const fixture = await emptyProject();
    await runOp(importOp, { source: await twoBindingWsdl() }, fixture.base());
    const set = await derive(fixture);
    expect(set.tools.map((tool) => tool.name)).toEqual(['calculator_service_add', 'calculator_service_add_2']);
    expect(set.tools[1]?.description).toContain('CalculatorSoap12');
  });

  it('keeps only the containers --tools names, none for an empty list, and refuses an unknown one', async () => {
    const fixture = await restProject();
    await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());
    expect((await derive(fixture, ['Pets'])).tools.map((tool) => tool.kind)).toEqual(['rest', 'rest', 'rest']);
    // Names are the whole project's, whatever the filter.
    expect((await derive(fixture, ['CalculatorService'])).tools.map((tool) => tool.name)).toEqual([
      'calculator_service_add',
    ]);
    expect((await derive(fixture, [])).tools).toEqual([]);
    await expect(derive(fixture, ['Nope'])).rejects.toMatchObject({ code: 'container-not-found' });
  });

  it('withdraws every tool over the cap, and says how many each container has', async () => {
    const fixture = await emptyProject();
    await runOp(importOp, { source: await manyOperationsOpenApi(CONTRACT_TOOL_CAP + 2) }, fixture.base());
    const set = await derive(fixture);
    expect(set).toMatchObject({ overCap: true, tools: [], total: 130, counts: { Many: 130 } });
    expect(capMessage(set)).toContain('Many: 130');
    expect(capMessage(set)).toContain('--tools');
  });

  it('notes an interface with no cached definition rather than failing', async () => {
    const fixture = await emptyProject();
    await updateProject(fixture.dir, (project) => ({
      ...project,
      settings: { ...project.settings, cacheDefinitions: false },
    }));
    await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());
    const set = await derive(fixture);
    expect(set.tools).toEqual([]);
    expect(set.notes).toEqual([expect.stringContaining('CalculatorService')]);
  });
});

describe('checkArgs', () => {
  it('validates against the schema with $refs followed, and refuses ${', async () => {
    const [tool] = (await derive(await soapProject())).tools;
    const schema = tool?.inputSchema ?? {};
    expect(() => checkArgs(schema, { a: 1, b: 2 })).not.toThrow();
    const refused = (args: Record<string, unknown>): OpsError => {
      try {
        checkArgs(schema, args);
      } catch (error) {
        return error as OpsError;
      }
      throw new Error('not refused');
    };
    expect(refused({ a: 'x', b: 2 })).toMatchObject({ code: 'invalid-input', message: expect.stringContaining('/a') as unknown });
    expect(refused({ a: 1, b: 2, c: 3 }).code).toBe('invalid-input');
    expect(refused({ a: 1, b: 2, note: 'x ${#System#HOME}' }).message).toContain('${');
    expect(refused({ a: 1, b: 2, note: 'x ${#System#HOME}' })).toBeInstanceOf(OpsError);
  });

  it('follows a recursive $defs reference', () => {
    const schema = {
      type: 'object',
      properties: { tree: { $ref: '#/$defs/Tree' } },
      additionalProperties: false,
      $defs: {
        Tree: {
          type: 'object',
          properties: { label: { type: 'string' }, child: { type: 'array', items: { $ref: '#/$defs/Tree' } } },
          required: ['label'],
          additionalProperties: false,
        },
      },
    };
    expect(() => checkArgs(schema, { tree: { label: 'a', child: [{ label: 'b' }] } })).not.toThrow();
    expect(() => checkArgs(schema, { tree: { label: 'a', child: [{ label: 1 }] } })).toThrow(/child\/0\/label/);
  });
});
```

```ts
// packages/cli/test/unit/ops/rest-args.test.ts
import { describe, expect, it } from 'vitest';
import type { OpenApiOperation, RestApi } from '@wirebench/engine';
import { restToolSchema } from '../../../src/ops/rest-args.js';

const API = {
  auth: { type: 'api-key', name: 'X-Key', in: 'header', valueRef: 'key' },
} as unknown as RestApi;

describe('restToolSchema', () => {
  it('turns shared and recursive schema nodes into $defs, drops readOnly from a body, and leaves auth headers out', () => {
    const node: Record<string, unknown> = { type: 'object', title: 'Node', properties: {} };
    (node['properties'] as Record<string, unknown>)['next'] = node;
    const money = { type: 'number' };
    const operation = {
      method: 'post',
      path: '/nodes/{id}',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer' } },
        { name: 'X-Key', in: 'header', schema: { type: 'string' } },
        { name: 'X-Trace', in: 'header', required: true, schema: { type: 'string' } },
        { name: 'session', in: 'cookie', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['id', 'root'],
              properties: {
                id: { type: 'string', readOnly: true },
                root: node,
                price: money,
                cost: money,
                tag: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
    } as unknown as OpenApiOperation;

    const { schema, cookies } = restToolSchema(API, operation);
    expect(cookies).toEqual(['session']);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        path: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        query: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false },
        headers: {
          type: 'object',
          properties: { 'X-Trace': { type: 'string' } },
          required: ['X-Trace'],
          additionalProperties: false,
        },
        body: {
          type: 'object',
          required: ['root'],
          properties: {
            root: { $ref: '#/$defs/Node' },
            price: { $ref: '#/$defs/Schema1' },
            cost: { $ref: '#/$defs/Schema1' },
            tag: { type: ['string', 'null'] },
          },
        },
      },
      required: ['path', 'headers', 'body'],
      additionalProperties: false,
      $defs: {
        Node: { type: 'object', title: 'Node', properties: { next: { $ref: '#/$defs/Node' } } },
        Schema1: { type: 'number' },
      },
    });
  });

  it('takes a non-JSON body as a string sent with its media type', () => {
    const operation = {
      method: 'put',
      path: '/notes',
      parameters: [],
      requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } },
    } as unknown as OpenApiOperation;
    expect(restToolSchema(API, operation).schema['properties']).toEqual({
      body: { type: 'string', description: 'Sent as text/plain' },
    });
  });
});
```

In `packages/cli/test/unit/ops/operations.test.ts`, the first test's expected SOAP row gains the tool name:

```ts
          ref: 'CalculatorService/Add',
          tool: 'calculator_service_add',
          items: [SOAP_ITEM],
```

and the REST test's `toMatchObject` for `result.operations[0]` gains `tool: 'pets_list_pets',`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/contract-tools.test.ts packages/cli/test/unit/ops/rest-args.test.ts packages/cli/test/unit/ops/operations.test.ts`
Expected: FAIL — `Cannot find module '../../../src/ops/contract-tools.js'` (and `rest-args.js`); the operations rows have no `tool`.

- [ ] **Step 3: Implement**

In `packages/engine/src/index.ts`, after `export type { SampleOptions, SampleXmlOptions } from './json/schema/sample.js';`, add:

```ts
export { validateJsonSchema } from './json/schema-validate.js';
export type { JsonSchemaProblem, ValidateJsonOptions } from './json/schema-validate.js';
```

Then rebuild the engine for the CLI tests: `nice pnpm exec tsc -b packages/engine`.

Create `packages/cli/src/ops/rest-args.ts`:

```ts
/**
 * A REST operation's tool arguments (#33 spec §3.2, revision R2): `path`, `query`, `headers` and
 * `body`, each present only when the operation declares something for it. The loaded document's
 * schemas are a `$ref`-inlined, possibly cyclic, graph; a node reached more than once becomes one
 * `$defs` entry, so the published schema is a tree.
 */
import type { JsonSchema, JsonSchemaObject, OpenApiOperation, OpenApiParameter, RestApi } from '@wirebench/engine';

export interface RestToolSchema {
  readonly schema: JsonSchemaObject;
  readonly notes: readonly string[];
  /** Required cookie parameters: the tool cannot set them, and its description says so. */
  readonly cookies: readonly string[];
}

/** Headers the container's auth sets, lower-cased: never a tool argument. */
export function authHeaderNames(api: RestApi): ReadonlySet<string> {
  const names = new Set(['accept', 'content-type', 'authorization']);
  if (api.auth?.type === 'api-key' && api.auth.in === 'header') {
    names.add(api.auth.name.toLowerCase());
  }
  return names;
}

/** The JSON media type of the request body: `application/json`, or any `+json` type. */
export function jsonMediaType(operation: OpenApiOperation): string | undefined {
  return Object.keys(operation.requestBody?.content ?? {}).find((type) => {
    const bare = type.split(';')[0]?.trim().toLowerCase() ?? '';
    return bare === 'application/json' || bare.endsWith('+json');
  });
}

function childrenOf(node: JsonSchema): JsonSchema[] {
  return [
    ...Object.values(node.properties ?? {}),
    ...(node.items !== undefined ? [node.items] : []),
    ...(typeof node.additionalProperties === 'object' ? [node.additionalProperties] : []),
    ...(node.allOf ?? []),
    ...(node.oneOf ?? []),
    ...(node.anyOf ?? []),
  ];
}

/** Writes graph nodes as a tree: a node reached twice (shared, or inside itself) as a `$defs` entry. */
class SchemaTree {
  private readonly seen = new Map<JsonSchema, number>();
  private readonly names = new Map<JsonSchema, string>();
  private readonly definitions: Record<string, JsonSchemaObject> = {};
  private next = 1;

  /** The first pass, over every root before anything is written. */
  count(root: JsonSchema): void {
    const stack: JsonSchema[] = [root];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      const times = (this.seen.get(node) ?? 0) + 1;
      this.seen.set(node, times);
      if (times === 1) {
        stack.push(...childrenOf(node));
      }
    }
  }

  write(node: JsonSchema, dropReadOnly: boolean): JsonSchemaObject {
    return (this.seen.get(node) ?? 0) > 1 ? { $ref: `#/$defs/${this.defName(node, dropReadOnly)}` } : this.body(node, dropReadOnly);
  }

  defs(): JsonSchemaObject | undefined {
    return Object.keys(this.definitions).length === 0 ? undefined : this.definitions;
  }

  private defName(node: JsonSchema, dropReadOnly: boolean): string {
    const known = this.names.get(node);
    if (known !== undefined) {
      return known;
    }
    const title = node.title?.replace(/[^A-Za-z0-9_.-]/g, '') ?? '';
    let name = title !== '' ? title : `Schema${String(this.next++)}`;
    for (let n = 2; name in this.definitions; n += 1) {
      name = `${title !== '' ? title : 'Schema'}_${String(n)}`;
    }
    this.names.set(node, name);
    // Taken before it is written, so a recursive reference finds it.
    this.definitions[name] = {};
    this.definitions[name] = this.body(node, dropReadOnly);
    return name;
  }

  private body(node: JsonSchema, dropReadOnly: boolean): JsonSchemaObject {
    const out: JsonSchemaObject = {};
    const declared = node.type === undefined ? undefined : typeof node.type === 'string' ? [node.type] : [...node.type];
    if (declared !== undefined) {
      const types = node.nullable === true && !declared.includes('null') ? [...declared, 'null'] : declared;
      out['type'] = types.length === 1 ? types[0] : types;
    }
    if (node.title !== undefined) out['title'] = node.title;
    if (node.description !== undefined) out['description'] = node.description;
    if (node.format !== undefined) out['format'] = node.format;
    if (node.enum !== undefined) out['enum'] = node.nullable === true ? [...node.enum, null] : [...node.enum];
    if (node.const !== undefined) out['const'] = node.const;
    if (node.properties !== undefined) {
      const kept = Object.entries(node.properties).filter(([, property]) => !(dropReadOnly && property.readOnly === true));
      out['properties'] = Object.fromEntries(kept.map(([key, property]) => [key, this.write(property, dropReadOnly)]));
      const names = new Set(kept.map(([key]) => key));
      const required = (node.required ?? []).filter((key) => names.has(key));
      if (required.length > 0) out['required'] = required;
    } else if (node.required !== undefined && node.required.length > 0) {
      out['required'] = [...node.required];
    }
    if (node.items !== undefined) out['items'] = this.write(node.items, dropReadOnly);
    if (typeof node.additionalProperties === 'boolean') out['additionalProperties'] = node.additionalProperties;
    else if (node.additionalProperties !== undefined) out['additionalProperties'] = this.write(node.additionalProperties, dropReadOnly);
    for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
      const list = node[key];
      if (list !== undefined) out[key] = list.map((member) => this.write(member, dropReadOnly));
    }
    return out;
  }
}

const ANY_SCALAR: JsonSchemaObject = { type: ['string', 'number', 'integer', 'boolean'] };

function parametersIn(operation: OpenApiOperation, location: OpenApiParameter['in']): OpenApiParameter[] {
  return operation.parameters.filter((parameter) => parameter.in === location);
}

/** The tool's argument schema for one OpenAPI operation. */
export function restToolSchema(api: RestApi, operation: OpenApiOperation): RestToolSchema {
  const tree = new SchemaTree();
  const excluded = authHeaderNames(api);
  const path = parametersIn(operation, 'path');
  for (const name of [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? '')) {
    if (name !== '' && !path.some((parameter) => parameter.name === name)) {
      path.push({ name, in: 'path', required: true, schema: { type: 'string' } });
    }
  }
  const query = parametersIn(operation, 'query');
  const headers = parametersIn(operation, 'header').filter((parameter) => !excluded.has(parameter.name.toLowerCase()));
  const cookies = parametersIn(operation, 'cookie')
    .filter((parameter) => parameter.required === true)
    .map((parameter) => parameter.name);
  const jsonType = jsonMediaType(operation);
  const content = operation.requestBody?.content ?? {};
  const bodyType = jsonType ?? Object.keys(content)[0];
  const bodySchema = jsonType === undefined ? undefined : content[jsonType]?.schema;

  for (const parameter of [...path, ...query, ...headers]) {
    if (parameter.schema !== undefined) tree.count(parameter.schema);
  }
  if (bodySchema !== undefined) tree.count(bodySchema);

  const section = (parameters: readonly OpenApiParameter[], allRequired: boolean): JsonSchemaObject => {
    const required = parameters
      .filter((parameter) => allRequired || parameter.required === true)
      .map((parameter) => parameter.name);
    return {
      type: 'object',
      properties: Object.fromEntries(
        parameters.map((parameter) => [
          parameter.name,
          parameter.schema === undefined ? ANY_SCALAR : tree.write(parameter.schema, false),
        ]),
      ),
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
  };

  const properties: Record<string, JsonSchemaObject> = {};
  const required: string[] = [];
  if (path.length > 0) {
    properties['path'] = section(path, true);
    required.push('path');
  }
  if (query.length > 0) {
    properties['query'] = section(query, false);
    if (query.some((parameter) => parameter.required === true)) required.push('query');
  }
  if (headers.length > 0) {
    properties['headers'] = section(headers, false);
    if (headers.some((parameter) => parameter.required === true)) required.push('headers');
  }
  if (bodyType !== undefined) {
    properties['body'] =
      jsonType === undefined
        ? { type: 'string', description: `Sent as ${bodyType}` }
        : bodySchema === undefined
          ? {}
          : tree.write(bodySchema, true);
    if (operation.requestBody?.required === true) required.push('body');
  }
  const defs = tree.defs();
  return {
    schema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
      ...(defs !== undefined ? { $defs: defs } : {}),
    },
    notes: [],
    cookies,
  };
}
```

Create `packages/cli/src/ops/contract-tools.ts`:

```ts
/**
 * A project's contract operations as MCP tools (#33 spec §2, §3, §8): which operations, their
 * names, descriptions and input schemas, the `--tools` filter, the cap, and the check a call's
 * arguments pass before anything is built.
 */
import { loadOpenApiDocument, operationJsonSchema, summarizeSoapOperations, validateJsonSchema } from '@wirebench/engine';
import type { JsonSchemaObject, Project } from '@wirebench/engine';
import type { OpName } from '../args-ops.js';
import type { Gates } from './context.js';
import { OpsError, toOpsError } from './errors.js';
import { restRef, soapRef } from './operation-refs.js';
import type { ResolvedOperation } from './operation-refs.js';
import { clarkToQName, readWsdl } from './project.js';
import type { LoadedWsdl } from './project.js';
import { restToolSchema } from './rest-args.js';

/** The #32 tools, listed first and never renamed: a contract tool of one of these names is suffixed. */
export const FIXED_TOOL_NAMES: readonly OpName[] = [
  'import',
  'operations',
  'generate',
  'send',
  'validate',
  'query',
  'history_list',
  'history_diff',
];

export const CONTRACT_TOOL_CAP = 128;
export const MAX_TOOL_NAME = 64;
export const MAX_TOOL_DESCRIPTION = 1000;
/** A tool schema larger than this, as JSON, is served in full with a note on stderr. */
export const LARGE_SCHEMA_CHARS = 64 * 1024;

export const byOrder = <T extends { readonly order: number; readonly name: string }>(a: T, b: T): number =>
  a.order - b.order || a.name.localeCompare(b.name);

/** Lower-cased snake_case: camelCase split, every other run of characters one `_`, none at the ends. */
export function snakeName(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** `<container>_<operation>`, at most 64 characters: the container part is cut first, then the end. */
export function toolBaseName(containerSlug: string, operationPart: string): string {
  const container = snakeName(containerSlug) || 'contract';
  const operation = snakeName(operationPart) || 'operation';
  const full = `${container}_${operation}`;
  if (full.length <= MAX_TOOL_NAME) {
    return full;
  }
  const room = MAX_TOOL_NAME - operation.length - 1;
  if (room >= 1) {
    const kept = container.slice(0, room).replace(/_+$/, '');
    return kept === '' ? operation : `${kept}_${operation}`;
  }
  return operation.slice(0, MAX_TOOL_NAME).replace(/_+$/, '');
}

function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  for (let n = 2; ; n += 1) {
    const suffix = `_${String(n)}`;
    const candidate = `${base.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/** Unique names for `bases`, in order, none equal to a fixed tool's. */
export function assignNames(bases: readonly string[]): string[] {
  const taken = new Set<string>(FIXED_TOOL_NAMES);
  return bases.map((base) => {
    const name = uniqueName(base, taken);
    taken.add(name);
    return name;
  });
}

export interface ContractEntry {
  readonly name: string;
  readonly kind: 'soap' | 'rest';
  readonly ref: string;
  readonly container: { readonly name: string; readonly slug: string };
  /** Absent when the definition cannot be read: the operation has a name but no tool. */
  readonly resolved?: ResolvedOperation;
  /** SOAP: the binding's local name. */
  readonly binding?: string;
  /** SOAP: another binding of the interface has an operation of this name. */
  readonly shared: boolean;
}

type Pending = Omit<ContractEntry, 'name'> & { readonly base: string };

/**
 * Every contract operation of the project in `operations` order, named over the whole project (so a
 * name does not depend on `--tools`). `include` limits which containers' definitions are read, and
 * whose problems are noted; an API's document is read either way, since its operations take names.
 */
export async function contractOperations(
  project: Project,
  projectDir: string,
  notes: string[],
  include: (container: { readonly name: string; readonly slug: string }) => boolean = () => true,
): Promise<ContractEntry[]> {
  const pending: Pending[] = [];
  for (const iface of [...project.interfaces].sort(byOrder)) {
    let wsdl: LoadedWsdl | undefined;
    if (include(iface)) {
      try {
        wsdl = await readWsdl(projectDir, iface);
      } catch (error) {
        notes.push(`${iface.name}: ${toOpsError(error).message}; it adds no tools`);
      }
    }
    for (const operation of [...iface.operations].sort(byOrder)) {
      const ref = soapRef(iface, operation);
      pending.push({
        base: toolBaseName(iface.slug, operation.name),
        kind: 'soap',
        ref,
        container: { name: iface.name, slug: iface.slug },
        binding: clarkToQName(operation.bindingName).localName,
        shared: iface.operations.filter((candidate) => candidate.name === operation.name).length > 1,
        ...(wsdl !== undefined ? { resolved: { kind: 'soap', ref, iface, operation, wsdl } } : {}),
      });
    }
  }
  for (const api of [...project.apis].sort(byOrder)) {
    let document: Awaited<ReturnType<typeof loadOpenApiDocument>>;
    try {
      document = await loadOpenApiDocument(projectDir, api.slug);
    } catch (error) {
      if (include(api)) notes.push(`${api.name}: ${toOpsError(error).message}; it adds no tools`);
      continue;
    }
    if (document === undefined) {
      if (include(api)) notes.push(`${api.name}: no readable cached OpenAPI document; it adds no tools`);
      continue;
    }
    for (const operation of document.operations) {
      const ref = restRef(api, operation);
      pending.push({
        base: toolBaseName(api.slug, operation.operationId ?? `${operation.method}_${operation.path}`),
        kind: 'rest',
        ref,
        container: { name: api.name, slug: api.slug },
        shared: false,
        ...(include(api) ? { resolved: { kind: 'rest', ref, api, operation, document } } : {}),
      });
    }
  }
  const names = assignNames(pending.map((entry) => entry.base));
  return pending.map(({ base: _base, ...entry }, index) => ({ ...entry, name: names[index] ?? _base }));
}

/** The tool name of every operation that has a tool, keyed `soap:<ref>` or `rest:<ref>`. */
export async function toolNamesByRef(project: Project, projectDir: string): Promise<ReadonlyMap<string, string>> {
  const entries = await contractOperations(project, projectDir, []);
  return new Map(
    entries.flatMap((entry) => (entry.resolved !== undefined ? [[`${entry.kind}:${entry.ref}`, entry.name] as const] : [])),
  );
}

export type EnvironmentKey = 'environment' | 'wirebench_environment';

export interface ToolSchema {
  readonly inputSchema: JsonSchemaObject;
  /** `environment`, unless the operation has an argument of that name. */
  readonly environmentKey: EnvironmentKey;
  readonly notes: readonly string[];
  readonly cookies: readonly string[];
}

const ENVIRONMENT_PROPERTY: JsonSchemaObject = {
  type: 'string',
  minLength: 1,
  description: 'The environment to send under, by name; required when the project defines any',
};

/** The tool's input schema: the operation's arguments, with the environment argument first. */
export function toolSchemaOf(resolved: ResolvedOperation): ToolSchema {
  const operationSchema =
    resolved.kind === 'soap'
      ? {
          ...operationJsonSchema(resolved.wsdl, {
            bindingName: clarkToQName(resolved.operation.bindingName),
            operationName: resolved.operation.name,
          }),
          cookies: [],
        }
      : restToolSchema(resolved.api, resolved.operation);
  const { schema } = operationSchema;
  const properties = (schema['properties'] ?? {}) as Record<string, unknown>;
  const environmentKey: EnvironmentKey = 'environment' in properties ? 'wirebench_environment' : 'environment';
  return {
    inputSchema: { ...schema, type: 'object', properties: { [environmentKey]: ENVIRONMENT_PROPERTY, ...properties } },
    environmentKey,
    notes: operationSchema.notes,
    cookies: operationSchema.cookies,
  };
}

function documentationOf(resolved: ResolvedOperation): string | undefined {
  if (resolved.kind === 'soap') {
    return summarizeSoapOperations(resolved.wsdl.definition).find(
      (summary) =>
        summary.operationName === resolved.operation.name &&
        `{${summary.bindingName.namespaceUri}}${summary.bindingName.localName}` === resolved.operation.bindingName,
    )?.documentation;
  }
  const parts = [resolved.operation.summary, resolved.operation.description].filter(
    (text): text is string => text !== undefined && text.trim() !== '',
  );
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/** The contract's own text, cut at 1,000 characters, then what the tool does and which gate it needs. */
export function describeTool(
  entry: ContractEntry,
  resolved: ResolvedOperation,
  gates: Gates,
  cookies: readonly string[],
): string {
  const parts: string[] = [];
  const documentation = documentationOf(resolved)?.trim();
  if (documentation !== undefined && documentation !== '') {
    parts.push(documentation.slice(0, MAX_TOOL_DESCRIPTION));
  }
  if (entry.shared && entry.binding !== undefined) {
    parts.push(`Through the binding ${entry.binding}.`);
  }
  const where = `${resolved.kind === 'soap' ? 'the interface' : 'the API'} "${entry.container.name}"`;
  const environments =
    gates.environments !== undefined ? `, and one of the environments ${gates.environments.join(', ')}` : '';
  parts.push(
    `Sends a real ${resolved.kind === 'soap' ? 'SOAP' : 'REST'} request through ${where}, with its endpoint, ` +
      `auth and secrets, and records it in History. Needs --allow-send${environments}.`,
  );
  if (cookies.length > 0) {
    parts.push(`The operation needs the cookie parameter(s) ${cookies.join(', ')}, which this tool cannot set.`);
  }
  return parts.join('\n\n');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `schema` with every `#/$defs/…` reference replaced by its definition: a graph the validator walks (R1). */
export function dereferenced(schema: JsonSchemaObject): JsonSchemaObject {
  const defs = isRecord(schema['$defs']) ? schema['$defs'] : {};
  const resolved = new Map<string, Record<string, unknown>>();
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (!isRecord(node)) {
      return node;
    }
    const ref = node['$ref'];
    if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
      const key = ref.slice('#/$defs/'.length);
      const known = resolved.get(key);
      if (known !== undefined) {
        return known;
      }
      const target: Record<string, unknown> = {};
      resolved.set(key, target);
      const definition = walk(defs[key] ?? {});
      Object.assign(target, isRecord(definition) ? definition : {});
      return target;
    }
    return Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$defs').map(([key, value]) => [key, walk(value)]));
  };
  return walk(schema) as JsonSchemaObject;
}

/** The JSON Pointer of the first string holding `${`, or undefined. */
function placeholderIn(value: unknown, path: string): string | undefined {
  if (typeof value === 'string') {
    return value.includes('${') ? path || '/' : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = placeholderIn(item, `${path}/${String(index)}`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      const found = placeholderIn(item, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Spec §3.3 steps 1 and 2: the arguments against the tool's own schema, then no `${` anywhere.
 *
 * @throws OpsError `invalid-input`, listing each JSON Pointer and keyword
 */
export function checkArgs(inputSchema: JsonSchemaObject, args: Readonly<Record<string, unknown>>): void {
  const problems = validateJsonSchema(args, dereferenced(inputSchema), { redactValues: true });
  if (problems.length > 0) {
    throw new OpsError(
      'invalid-input',
      problems.map((problem) => `${problem.path || '/'} ${problem.keyword}: ${problem.message}`).join('; '),
      { problems: problems.map((problem) => ({ path: problem.path, keyword: problem.keyword })) },
    );
  }
  const placeholder = placeholderIn(args, '');
  if (placeholder !== undefined) {
    throw new OpsError(
      'invalid-input',
      `${placeholder}: arguments are sent as written and may not contain \${…} placeholders`,
      { path: placeholder },
    );
  }
}

export interface ContractTool {
  readonly name: string;
  readonly ref: string;
  readonly kind: 'soap' | 'rest';
  readonly container: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly environmentKey: EnvironmentKey;
}

export interface ContractToolSet {
  /** Empty when the count is over the cap. */
  readonly tools: readonly ContractTool[];
  /** Tools per container, counted before the cap. */
  readonly counts: Readonly<Record<string, number>>;
  readonly total: number;
  readonly overCap: boolean;
  /** For stderr: unreadable definitions, schema gaps, large schemas. */
  readonly notes: readonly string[];
}

export interface DeriveOptions {
  readonly projectDir: string;
  readonly gates: Gates;
  /** `--tools`: the containers to serve, by name or slug. Absent: all; empty: none. */
  readonly containers?: readonly string[];
  readonly cap?: number;
}

/**
 * The project's contract tools under `--tools`, with the cap verdict.
 *
 * @throws OpsError `container-not-found` for a `--tools` name no interface or API has
 */
export async function deriveContractTools(project: Project, options: DeriveOptions): Promise<ContractToolSet> {
  const wanted = options.containers;
  for (const name of wanted ?? []) {
    if (![...project.interfaces, ...project.apis].some((container) => container.name === name || container.slug === name)) {
      throw new OpsError('container-not-found', `--tools names "${name}", which is no interface or API of this project`, {
        container: name,
      });
    }
  }
  const include = (container: { readonly name: string; readonly slug: string }): boolean =>
    wanted === undefined || wanted.includes(container.name) || wanted.includes(container.slug);
  const notes: string[] = [];
  const entries = (await contractOperations(project, options.projectDir, notes, include)).filter((entry) =>
    include(entry.container),
  );
  const tools: ContractTool[] = [];
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const resolved = entry.resolved;
    if (resolved === undefined) {
      continue;
    }
    counts[entry.container.name] = (counts[entry.container.name] ?? 0) + 1;
    let schema: ToolSchema;
    try {
      schema = toolSchemaOf(resolved);
    } catch (error) {
      notes.push(`${entry.ref}: ${toOpsError(error).message}; no tool`);
      continue;
    }
    notes.push(...schema.notes.map((note) => `${entry.name}: ${note}`));
    const size = JSON.stringify(schema.inputSchema).length;
    if (size > LARGE_SCHEMA_CHARS) {
      notes.push(`${entry.name}: its input schema is ${String(Math.round(size / 1024))} KiB of JSON; it is served in full`);
    }
    tools.push({
      name: entry.name,
      ref: entry.ref,
      kind: entry.kind,
      container: entry.container.name,
      description: describeTool(entry, resolved, options.gates, schema.cookies),
      inputSchema: schema.inputSchema,
      environmentKey: schema.environmentKey,
    });
  }
  const total = tools.length;
  const overCap = total > (options.cap ?? CONTRACT_TOOL_CAP);
  return { tools: overCap ? [] : tools, counts, total, overCap, notes };
}

export function capMessage(set: ContractToolSet): string {
  const counts = Object.entries(set.counts)
    .map(([container, count]) => `${container}: ${String(count)}`)
    .join(', ');
  return (
    `${String(set.total)} contract operations is over the cap of ${String(CONTRACT_TOOL_CAP)} tools (${counts}); ` +
    'serve fewer with --tools <name,…>, or none with --tools none'
  );
}
```

`contractOperations` destructures `base` out of each pending entry; because `@typescript-eslint/no-unused-vars` flags an unused destructured name, it is used as the fallback (`names[index] ?? _base`), which `assignNames` never needs.

In `packages/cli/src/ops/operations.ts`:
- delete the local `byOrder` and import it: `import { byOrder, toolNamesByRef } from './contract-tools.js';`
- add `readonly tool?: string;` after `readonly ref: string;` in the `soap` and `rest` variants of `OperationRow`, with the doc comment `/** The MCP tool and \`wirebench call\` name, when the definition is readable. */`
- in `run`, after `const operations: OperationRow[] = [];`, add `const tools = await toolNamesByRef(project, context.projectDir);`
- in the SOAP push, after `ref: soapRef(iface, operation),`, add:

```ts
          ...(tools.has(`soap:${soapRef(iface, operation)}`)
            ? { tool: tools.get(`soap:${soapRef(iface, operation)}`) as string }
            : {}),
```

- in the REST push from the document, after `ref: restRef(api, operation),`, add:

```ts
          ...(tools.has(`rest:${restRef(api, operation)}`)
            ? { tool: tools.get(`rest:${restRef(api, operation)}`) as string }
            : {}),
```

In `packages/cli/src/commands/ops-output.ts`, `operationsText` shows the tool under its row:

```ts
function operationsText(result: OperationsResult): string {
  const out: string[] = [];
  for (const row of result.operations) {
    const detail =
      row.kind === 'soap' ? (row.soapAction ?? '') : row.kind === 'rest' ? (row.operationId ?? '') : row.url;
    out.push(detail.length > 0 ? `${row.ref}  (${detail})` : row.ref);
    if (row.kind !== 'websocket' && row.tool !== undefined) {
      out.push(`  tool: ${row.tool}`);
    }
    out.push(...row.items.map((item) => `  ${item}`));
  }
  out.push(...result.notes.map((note) => `note: ${note}`));
  return out.length === 0 ? lines('no operations') : lines(...out);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice pnpm exec tsc -b packages/engine && nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/contract-tools.test.ts packages/cli/test/unit/ops/rest-args.test.ts packages/cli/test/unit/ops/operations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/engine/src/index.ts packages/cli/src/ops/contract-tools.ts packages/cli/src/ops/rest-args.ts packages/cli/src/ops/operations.ts packages/cli/src/commands/ops-output.ts packages/cli/test/unit/ops/helpers.ts packages/cli/test/unit/ops/contract-tools.test.ts packages/cli/test/unit/ops/rest-args.test.ts packages/cli/test/unit/ops/operations.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/index.ts packages/cli/src/ops/contract-tools.ts packages/cli/src/ops/rest-args.ts packages/cli/src/ops/operations.ts packages/cli/src/commands/ops-output.ts packages/cli/test/unit/ops/helpers.ts packages/cli/test/unit/ops/contract-tools.test.ts packages/cli/test/unit/ops/rest-args.test.ts packages/cli/test/unit/ops/operations.test.ts
git commit -m "feat(cli): derive a tool per contract operation, with names, schemas and the cap (#33)"
```

---

### Task 5: CLI — calling a SOAP operation

**Files:**
- Create: `packages/cli/src/ops/call.ts`
- Modify: `packages/cli/src/ops/history-entry.ts` (`adHoc`)
- Modify: `packages/cli/src/ops/send.ts` (`failure` exported as `sendFailure`)
- Modify: `packages/cli/src/ops/errors.ts` (three codes)
- Test: `packages/cli/test/unit/ops/call.test.ts` (new)

**Interfaces:**
- Consumes: Task 3's `envelopeFromJson`, `jsonFromEnvelope`, `faultDetailJson`; Task 4's `toolSchemaOf`, `checkArgs`; `bindingContextFor`, `validateMessage`, `createRequest`, `runRequests`, `secretNeedsOf`, `appendHistory`, `createSecretMasker`, `createSecretBytesMasker`, `redactHeaders`, `redactStructuredBody`; `resolveOperation`; `environmentFor`, `openProject`, `clarkToQName`; `historyEntryFor`, `MAX_STORED_CHARS`; `historyFileFor`; `createEnvSecrets`; `cliSendHost`; `knownSecretIn`; `redactBody`; `cutText`.
- Produces:
  - `interface CallResult` (spec §5): `tool`, `operation`, `kind`, `status`, `statusText`, `ok`, `durationMs`, `headers`, `result?`, `fault?: { code; reason; detail? }`, `body?`, `bodyTruncated?`, `notes`, `historyId?`
  - `callOp` — `defineOp` named `call`, input `{ tool: string; ref: string; args: Record<string, unknown> }`; not in `OPS`
  - `sendFailure(result: RequestResult, needs: readonly LocatedSecretNeed[]): OpsError` exported from `ops/send.ts`
  - `HistoryEntryInput.adHoc?: { readonly requestName: string; readonly operationName: string }`
  - `USAGE_CODES` gains `operation-gone`, `no-endpoint`, `too-many-tools`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/ops/call.test.ts
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { callOp } from '../../../src/ops/call.js';
import { runOp } from '../../../src/ops/context.js';
import type { OpsBase } from '../../../src/ops/context.js';
import { historyFileFor } from '../../../src/ops/paths.js';
import { addEnvironment, removeTempDirs, SECRET, soapProject, startServer, updateProject } from './helpers.js';
import type { Fixture, Reply, TestServer } from './helpers.js';

const ADD_RESPONSE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  '<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>5</c:result></c:AddResponse>' +
  '</soapenv:Body></soapenv:Envelope>';

const fault = (reason: string): string =>
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault>' +
  `<faultcode>soapenv:Server</faultcode><faultstring>${reason}</faultstring>` +
  '<detail><x:why xmlns:x="urn:x">disk</x:why></detail></soapenv:Fault></soapenv:Body></soapenv:Envelope>';

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await removeTempDirs();
});

async function serving(fixture: Fixture, reply: Reply): Promise<TestServer> {
  const server = await startServer(() => reply);
  servers.push(server);
  await addEnvironment(fixture.dir, 'local', { CalculatorService: server.url });
  return server;
}

function call(fixture: Fixture, args: Record<string, unknown>, overrides: Partial<OpsBase> = {}) {
  return runOp(callOp, { tool: 'calculator_service_add', ref: 'CalculatorService/Add', args }, fixture.base(overrides));
}

async function historyLines(fixture: Fixture): Promise<Record<string, unknown>[]> {
  const text = await readFile(historyFileFor(fixture.historyDir, 'mcp-fixture'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('op call, SOAP', () => {
  it('refuses without --allow-send, and sends nothing', async () => {
    const fixture = await soapProject();
    const server = await serving(fixture, { body: ADD_RESPONSE });
    await expect(
      call(fixture, { environment: 'local', a: 1, b: 2 }, { gates: { write: false, send: false } }),
    ).rejects.toMatchObject({ code: 'send-not-allowed' });
    expect(server.received).toEqual([]);
  });

  it('refuses an operation that is gone, arguments the schema refuses, and ${', async () => {
    const fixture = await soapProject();
    await expect(
      runOp(callOp, { tool: 'x', ref: 'CalculatorService/Subtract', args: {} }, fixture.base()),
    ).rejects.toMatchObject({ code: 'operation-gone' });
    await expect(call(fixture, { a: 'two', b: 2 })).rejects.toMatchObject({
      code: 'invalid-input',
      message: expect.stringContaining('/a') as unknown,
    });
    await expect(call(fixture, { a: 1, b: 2, note: '${#System#HOME}' })).rejects.toMatchObject({
      code: 'invalid-input',
    });
  });

  it("follows send's environment rules", async () => {
    const fixture = await soapProject();
    await serving(fixture, { body: ADD_RESPONSE });
    await expect(call(fixture, { a: 1, b: 2 })).rejects.toMatchObject({ code: 'environment-required' });
    await expect(
      call(fixture, { environment: 'local', a: 1, b: 2 }, { gates: { write: false, send: true, environments: ['prod'] } }),
    ).rejects.toMatchObject({ code: 'environment-not-allowed' });
  });

  it('sends the envelope, returns the response as JSON, and records an ad-hoc History entry', async () => {
    const fixture = await soapProject();
    const server = await serving(fixture, { headers: { 'Content-Type': 'text/xml' }, body: ADD_RESPONSE });

    const result = await call(fixture, { environment: 'local', a: 2, b: 3, note: 'line one\n  line two' });

    expect(result).toMatchObject({
      tool: 'calculator_service_add',
      operation: 'CalculatorService/Add',
      kind: 'soap',
      status: 200,
      ok: true,
      result: { result: 5 },
      notes: [],
    });
    expect(result.historyId).toMatch(/^[0-9A-Z]{26}$/);
    const sent = server.received[0];
    expect(sent?.body).toMatch(/<(\w+):a>2<\/\1:a>/);
    expect(sent?.body).toContain('line one\n  line two');
    expect(String(sent?.headers['soapaction'])).toContain('urn:wirebench:calculator/Add');
    const [entry] = await historyLines(fixture);
    expect(entry).toMatchObject({
      id: result.historyId,
      kind: 'soap',
      requestName: 'Add (MCP)',
      interfaceName: 'CalculatorService',
      operationName: 'Add',
      tags: ['mcp'],
    });
    expect(entry).not.toHaveProperty('requestId');
  });

  it('returns a fault as a normal result, its undeclared detail as XML', async () => {
    const fixture = await soapProject();
    await serving(fixture, { status: 500, headers: { 'Content-Type': 'text/xml' }, body: fault('boom') });
    const result = await call(fixture, { environment: 'local', a: 1, b: 2 });
    expect(result).toMatchObject({
      status: 500,
      ok: false,
      fault: { code: 'soapenv:Server', reason: 'boom', detail: expect.stringContaining('disk') as unknown },
    });
    expect(result).not.toHaveProperty('result');
  });

  it("applies the interface's auth, and masks the secret it resolved", async () => {
    const fixture = await soapProject();
    await updateProject(fixture.dir, (project) => ({
      ...project,
      interfaces: project.interfaces.map((iface) => ({
        ...iface,
        auth: { type: 'basic', username: 'calc', passwordRef: 'calcPass', preemptive: true },
      })),
    }));
    const server = await serving(fixture, { status: 500, headers: { 'Content-Type': 'text/xml' }, body: fault(`bad ${SECRET}`) });

    const result = await call(fixture, { environment: 'local', a: 1, b: 2 }, { env: { WIREBENCH_SECRET_CALCPASS: SECRET } });

    expect(server.received[0]?.headers.authorization).toBe(`Basic ${Buffer.from(`calc:${SECRET}`).toString('base64')}`);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(await historyLines(fixture))).not.toContain(SECRET);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/call.test.ts`
Expected: FAIL — `Cannot find module '../../../src/ops/call.js'`.

- [ ] **Step 3: Implement**

In `packages/cli/src/ops/errors.ts`, add to `USAGE_CODES`, after `'query-failed',`:

```ts
  'operation-gone',
  'no-endpoint',
  'too-many-tools',
```

In `packages/cli/src/ops/send.ts`, rename `function failure(` to `export function sendFailure(` and its one use to `throw sendFailure(result, needs);`.

In `packages/cli/src/ops/history-entry.ts`, add to `HistoryEntryInput`:

```ts
  /**
   * A temporary request a contract tool built (#33): no saved request to point at, so no `requestId`;
   * the name History shows, and the operation it called.
   */
  readonly adHoc?: { readonly requestName: string; readonly operationName: string };
```

and in `historyEntryFor` change the `common` object and the REST `operationName`:

```ts
  const common = {
    id: generateHistoryId(),
    at: new Date().toISOString(),
    projectId: input.projectId,
    ...(input.adHoc === undefined ? { requestId: item.request.id } : {}),
    requestName: input.adHoc?.requestName ?? item.request.name,
    durationMs: input.durationMs,
    tags: [input.origin],
  };
```

```ts
      operationName: input.adHoc?.operationName ?? item.chain.map((folder) => folder.name).join(' / '),
```

Create `packages/cli/src/ops/call.ts`:

```ts
/**
 * A contract tool's call (#33 spec §4, §5): the operation resolved fresh, the arguments checked, a
 * temporary request built as a new request of the operation would be, sent through the engine as
 * `send` sends it (no scripts, assertions or captures, since none were saved), recorded in History as
 * an ad-hoc entry, and the response read back as JSON. Shared by MCP and `wirebench call`.
 */
import {
  appendHistory,
  bindingContextFor,
  createRequest,
  createSecretBytesMasker,
  createSecretMasker,
  envelopeFromJson,
  faultDetailJson,
  isWirebenchError,
  jsonFromEnvelope,
  redactHeaders,
  redactStructuredBody,
  runRequests,
  secretNeedsOf,
  validateMessage,
} from '@wirebench/engine';
import type { RequestResult, RestSelected, RunContext, SentExchange, SentRequest, SoapSelected } from '@wirebench/engine';
import { z } from 'zod';
import { createEnvSecrets } from '../env-secrets.js';
import { knownSecretIn } from '../secret-advice.js';
import { cliSendHost } from '../send-host.js';
import { defineOp } from './context.js';
import type { OpsContext } from './context.js';
import { checkArgs, toolSchemaOf } from './contract-tools.js';
import { cutText } from './cut.js';
import { OpsError } from './errors.js';
import { historyEntryFor, MAX_STORED_CHARS } from './history-entry.js';
import { resolveOperation } from './operation-refs.js';
import type { ResolvedOperation } from './operation-refs.js';
import { historyFileFor } from './paths.js';
import { clarkToQName, environmentFor, openProject } from './project.js';
import type { OpenedProject } from './project.js';
import { redactBody } from './redact.js';
import { sendFailure } from './send.js';

export interface CallResult {
  readonly tool: string;
  /** The operations reference. */
  readonly operation: string;
  readonly kind: 'soap' | 'rest';
  readonly status: number;
  readonly statusText: string;
  /** A 2xx status and no fault. */
  readonly ok: boolean;
  readonly durationMs: number;
  /** Lower-cased, sensitive ones redacted. */
  readonly headers: Readonly<Record<string, string>>;
  /** The response body as JSON. */
  readonly result?: unknown;
  readonly fault?: { readonly code: string; readonly reason: string; readonly detail?: unknown };
  /** The raw body, only when `result` could not be built. */
  readonly body?: string;
  readonly bodyTruncated?: boolean;
  /** Why `body` is raw, and what the schema could not type. */
  readonly notes: readonly string[];
  readonly historyId?: string;
}

const input = z.object({
  tool: z.string().min(1).describe('The tool name'),
  ref: z.string().min(1).describe('The operations reference the tool stands for'),
  args: z.record(z.string(), z.unknown()).describe("The tool's arguments, the environment argument included"),
});

type SoapResolved = Extract<ResolvedOperation, { kind: 'soap' }>;
type RestResolved = Extract<ResolvedOperation, { kind: 'rest' }>;
type HttpExchangeKind = Extract<SentExchange, { kind: 'soap' | 'rest' }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function requestNameFor(operationName: string, origin: 'cli' | 'mcp'): string {
  return `${operationName} (${origin === 'mcp' ? 'MCP' : 'CLI'})`;
}

/** The operation by its ref, read fresh; gone when the project no longer has it (spec §6). */
async function resolveFresh(
  opened: OpenedProject,
  projectDir: string,
  tool: string,
  ref: string,
): Promise<ResolvedOperation> {
  try {
    return await resolveOperation(opened.project, projectDir, ref);
  } catch (error) {
    if (error instanceof OpsError && (error.code === 'operation-not-found' || error.code === 'definition-cache-missing')) {
      throw new OpsError(
        'operation-gone',
        `The operation "${ref}" behind ${tool} is no longer in the project, or its definition is gone; list the tools again`,
        { tool, ref },
      );
    }
    throw error;
  }
}

/** Spec §4.1 SOAP: the envelope from the arguments, checked against the XSD, as a new request. */
async function prepareSoap(
  resolved: SoapResolved,
  args: Readonly<Record<string, unknown>>,
  origin: 'cli' | 'mcp',
): Promise<SoapSelected> {
  const { iface, operation, wsdl } = resolved;
  const op = { bindingName: clarkToQName(operation.bindingName), operationName: operation.name };
  const built = envelopeFromJson(wsdl, op, args);
  if (built.problems.length > 0) {
    throw new OpsError('invalid-input', built.problems.join('; '), { problems: built.problems });
  }
  const binding = bindingContextFor(wsdl.definition, op, 'request');
  if (binding !== undefined) {
    const { problems } = await validateMessage({
      xml: built.envelopeXml,
      direction: 'request',
      schemaSet: wsdl.schemaSet,
      bundle: wsdl.bundle,
      binding,
    });
    const errors = problems.filter((problem) => problem.severity === 'error');
    if (errors.length > 0) {
      throw new OpsError(
        'invalid-input',
        `the arguments do not make a valid ${operation.name} message: ` +
          errors.map((problem) => `${problem.path ?? `line ${String(problem.line ?? 0)}`}: ${problem.message}`).join('; '),
        { problems: errors.map((problem) => ({ ...(problem.path !== undefined ? { path: problem.path } : {}), message: problem.message })) },
      );
    }
  }
  const endpointId = iface.defaultEndpointId ?? iface.endpoints[0]?.id;
  const name = requestNameFor(operation.name, origin);
  const group = `${iface.name}/${operation.name}`;
  return {
    kind: 'soap',
    path: `${group}/${name}`,
    group,
    iface,
    operation,
    request: createRequest(name, {
      envelopeXml: built.envelopeXml,
      soapVersion: built.soapVersion,
      ...(built.soapAction !== undefined ? { soapAction: built.soapAction } : {}),
      ...(endpointId !== undefined ? { endpointId } : {}),
    }),
  };
}

/** Task 6 replaces this with the REST call. */
function prepareRest(resolved: RestResolved): RestSelected {
  throw new OpsError('unsupported-kind', `${resolved.ref}: REST operations cannot be called yet`, { ref: resolved.ref });
}

/** The engine could not tell where to send: no endpoint (SOAP) or no base URL (REST) — spec revision R4. */
function noEndpoint(result: RequestResult, container: string, environment: string | undefined): OpsError | undefined {
  const error = result.error;
  if (error === undefined) {
    return undefined;
  }
  const problems = error.details?.['problems'];
  const noHost =
    error.code === 'rest-url-incomplete' &&
    Array.isArray(problems) &&
    problems.some((problem) => isRecord(problem) && problem['code'] === 'no-host');
  if (error.code !== 'endpoint-unresolved' && !noHost) {
    return undefined;
  }
  const under = environment === undefined ? '' : ` under the environment "${environment}"`;
  return new OpsError(
    'no-endpoint',
    `"${container}" has no endpoint${under}; set one on the interface or API, or in the environment`,
    { container, ...(environment !== undefined ? { environment } : {}) },
  );
}

interface Sent {
  readonly result: RequestResult;
  readonly exchange: HttpExchangeKind;
  readonly mask: (text: string) => string;
  /** Every secret value the send resolved. */
  readonly secrets: readonly string[];
  readonly historyId?: string;
}

/** Spec §4.2: through `runRequests` as `send` sends, then History. */
async function sendItem(
  item: SoapSelected | RestSelected,
  opened: OpenedProject,
  environment: { readonly id: string; readonly name: string } | undefined,
  context: OpsContext,
  adHoc: { readonly requestName: string; readonly operationName: string },
  container: string,
): Promise<Sent> {
  const { project, workspace } = opened;
  const needs = secretNeedsOf([item], project, {}, workspace?.workspace);
  const secrets = createEnvSecrets(needs, context.env);
  const tokens = new Set<string>();
  const known = (): string[] => [...secrets.values(), ...tokens];
  const runContext: RunContext = {
    project,
    projectDir: context.projectDir,
    ...(workspace !== undefined ? { workspace } : {}),
    ...(environment !== undefined ? { environmentId: environment.id } : {}),
    overrides: {},
    host: cliSendHost({
      getSecret: secrets.getSecret,
      env: context.env,
      onSecretValue: (secret) => tokens.add(secret),
    }),
    containsKnownSecret: (text) => knownSecretIn(text, known()),
  };
  try {
    const seen: { sent?: SentRequest } = {};
    const run = await runRequests([item], runContext, {
      onSent: (_item, sent) => {
        seen.sent = sent;
      },
    });
    const [result] = run.requests;
    if (result === undefined) {
      throw new Error('the run returned no result');
    }
    const exchange = seen.sent?.exchange;
    if (exchange === undefined || (exchange.kind !== 'soap' && exchange.kind !== 'rest')) {
      throw noEndpoint(result, container, environment?.name) ?? sendFailure(result, needs);
    }
    const mask = createSecretMasker(known());
    let historyId: string | undefined;
    try {
      const entry = historyEntryFor({
        item,
        exchange,
        projectId: project.id,
        origin: context.origin,
        durationMs: result.durationMs ?? 0,
        mask,
        maskBase64: createSecretBytesMasker(known()),
        adHoc,
      });
      await appendHistory(historyFileFor(context.historyDir, project.id), entry, { keepAtLeastCurrent: true });
      historyId = entry.id;
    } catch (error) {
      context.warn(`History not written: ${isWirebenchError(error) ? `${error.code}: ${error.message}` : String(error)}`);
    }
    return { result, exchange, mask, secrets: known(), ...(historyId !== undefined ? { historyId } : {}) };
  } finally {
    for (const secret of known()) {
      context.revealed.add(secret);
    }
  }
}

/** What the response said, before redaction. */
interface Outcome {
  readonly result?: unknown;
  readonly fault?: { readonly code: string; readonly reason: string; readonly detail?: unknown };
  readonly body?: string;
  readonly bodyTruncated?: boolean;
  readonly notes: readonly string[];
}

function rawBody(
  text: string,
  contentType: string | undefined,
  mask: (text: string) => string,
  truncated: boolean,
): { readonly body: string; readonly bodyTruncated: boolean } {
  // Masked before it is cut, as `send` does.
  const masked = mask(redactBody(text, contentType));
  return { body: cutText(masked, MAX_STORED_CHARS), bodyTruncated: truncated || masked.length > MAX_STORED_CHARS };
}

function soapOutcome(resolved: SoapResolved, exchange: Extract<HttpExchangeKind, { kind: 'soap' }>, mask: (text: string) => string): Outcome {
  const op = { bindingName: clarkToQName(resolved.operation.bindingName), operationName: resolved.operation.name };
  const { http, response } = exchange.soap;
  const notes: string[] = [];
  const fault = response?.fault;
  if (fault !== undefined) {
    let detail: unknown;
    if (fault.detailXml !== undefined) {
      const read = faultDetailJson(resolved.wsdl, op, fault.detailXml);
      if (read === undefined) {
        detail = redactBody(fault.detailXml, 'text/xml');
      } else {
        detail = read.value;
        notes.push(...read.notes);
      }
    }
    return { fault: { code: fault.code, reason: fault.reason, ...(detail !== undefined ? { detail } : {}) }, notes };
  }
  if (response?.isSoap === true) {
    const read = jsonFromEnvelope(resolved.wsdl, op, response.envelopeXml);
    notes.push(...read.notes);
    if (read.value !== undefined) {
      return { result: read.value, notes };
    }
  }
  notes.push('the response is not a SOAP message this operation describes; its body is returned as text');
  const text = response?.envelopeXml ?? new TextDecoder().decode(http.body);
  return { ...rawBody(text, http.headers['content-type'], mask, http.truncated), notes };
}

/** A number or boolean, or a key, that holds a resolved secret, masked; strings are `runOp`'s step. */
function maskScalars(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value);
    const masked = mask(text);
    return masked === text ? value : masked;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskScalars(item, mask));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [mask(key), maskScalars(item, mask)]));
  }
  return value;
}

/** Spec §5 redaction: secret-key redaction over the JSON, then the resolved secrets wherever they are. */
function redactJson(value: unknown, secrets: readonly string[]): unknown {
  if (value === undefined || typeof value === 'string') {
    return value;
  }
  const redacted = JSON.parse(redactStructuredBody(JSON.stringify(value), 'application/json', { show: false })) as unknown;
  return maskScalars(redacted, createSecretMasker([...secrets]));
}

export const callOp = defineOp({
  name: 'call',
  title: 'Call a contract operation',
  description:
    'Calls one operation of an imported contract with JSON arguments: builds the request a new request of the ' +
    "operation would be, sends it under the container's endpoint, auth and secrets, records it in History, and " +
    'returns the response as JSON. Needs --allow-send.',
  input,
  async run(value, context): Promise<CallResult> {
    if (!context.gates.send) {
      throw new OpsError(
        'send-not-allowed',
        `This server was started without --allow-send; ${value.tool} sends a request and needs it`,
      );
    }
    const opened = await openProject(context);
    const resolved = await resolveFresh(opened, context.projectDir, value.tool, value.ref);
    const { inputSchema, environmentKey } = toolSchemaOf(resolved);
    checkArgs(inputSchema, value.args);
    const wanted = value.args[environmentKey];
    const environment = environmentFor(opened, typeof wanted === 'string' ? wanted : undefined, context.gates.environments);
    const args = Object.fromEntries(Object.entries(value.args).filter(([key]) => key !== environmentKey));
    const item = resolved.kind === 'soap' ? await prepareSoap(resolved, args, context.origin) : prepareRest(resolved);
    const operationName =
      resolved.kind === 'soap'
        ? resolved.operation.name
        : (resolved.operation.operationId ?? `${resolved.operation.method.toUpperCase()} ${resolved.operation.path}`);
    const container = resolved.kind === 'soap' ? resolved.iface.name : resolved.api.name;
    const sent = await sendItem(
      item,
      opened,
      environment,
      context,
      { requestName: requestNameFor(operationName, context.origin), operationName },
      container,
    );
    const { exchange } = sent;
    if (exchange.kind !== 'soap' || resolved.kind !== 'soap') {
      throw new Error(`a ${resolved.kind} call came back with a ${exchange.kind} exchange`);
    }
    const outcome = soapOutcome(resolved, exchange, sent.mask);
    const http = exchange.soap.http;
    return {
      tool: value.tool,
      operation: resolved.ref,
      kind: resolved.kind,
      status: http.status,
      statusText: http.statusText,
      ok: http.status >= 200 && http.status < 300 && outcome.fault === undefined,
      durationMs: sent.result.durationMs ?? 0,
      headers: redactHeaders(http.headers, { show: false }),
      ...(outcome.result !== undefined ? { result: redactJson(outcome.result, sent.secrets) } : {}),
      ...(outcome.fault !== undefined
        ? {
            fault: {
              ...outcome.fault,
              ...(outcome.fault.detail !== undefined ? { detail: redactJson(outcome.fault.detail, sent.secrets) } : {}),
            },
          }
        : {}),
      ...(outcome.body !== undefined ? { body: outcome.body, bodyTruncated: outcome.bodyTruncated === true } : {}),
      notes: outcome.notes,
      ...(sent.historyId !== undefined ? { historyId: sent.historyId } : {}),
    };
  },
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/call.test.ts packages/cli/test/unit/ops/send.test.ts`
Expected: PASS (the `send` tests are unchanged by the rename and the History change).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/cli/src/ops/call.ts packages/cli/src/ops/history-entry.ts packages/cli/src/ops/send.ts packages/cli/src/ops/errors.ts packages/cli/test/unit/ops/call.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/cli/src/ops/call.ts packages/cli/src/ops/history-entry.ts packages/cli/src/ops/send.ts packages/cli/src/ops/errors.ts packages/cli/test/unit/ops/call.test.ts
git commit -m "feat(cli): call a SOAP operation with JSON arguments, through the engine and History (#33)"
```

---

### Task 6: CLI — calling a REST endpoint

**Files:**
- Modify: `packages/cli/src/ops/rest-args.ts` (`restRequestOf`)
- Modify: `packages/cli/src/ops/call.ts` (`prepareRest`, `restOutcome`, the result's REST branch)
- Test: `packages/cli/test/unit/ops/rest-args.test.ts`, `packages/cli/test/unit/ops/call.test.ts`

**Interfaces:**
- Consumes: Task 4's `jsonMediaType`; `createRestRequest`, `entry`, `NO_BODY`, `RestRequestDef`, `RestBody`.
- Produces: `restRequestOf(operation: OpenApiOperation, args: Readonly<Record<string, unknown>>, name: string): RestRequestDef`; `callOp` calls REST endpoints.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/unit/ops/rest-args.test.ts` (and add `restRequestOf` to its import from `rest-args.js`):

```ts
describe('restRequestOf', () => {
  it('fills path rows (simple), query rows (form, exploded) and headers, raw values, and the JSON body', () => {
    const operation = {
      method: 'post',
      path: '/items/{id}',
      parameters: [],
      requestBody: { content: { 'application/vnd.item+json': { schema: { type: 'object' } } } },
    } as unknown as OpenApiOperation;
    const request = restRequestOf(
      operation,
      {
        path: { id: ['a b', 'c'] },
        query: { tag: ['x', 'y'], filter: { size: 2, color: 'red' }, q: 'a&b' },
        headers: { 'X-Trace': 7 },
        body: { name: 'Rex' },
      },
      'createItem (CLI)',
    );
    expect(request).toMatchObject({
      name: 'createItem (CLI)',
      method: 'POST',
      url: '/items/{id}',
      pathParams: [{ name: 'id', value: 'a b,c', enabled: true }],
      query: [
        { name: 'tag', value: 'x', enabled: true },
        { name: 'tag', value: 'y', enabled: true },
        { name: 'size', value: '2', enabled: true },
        { name: 'color', value: 'red', enabled: true },
        { name: 'q', value: 'a&b', enabled: true },
      ],
      headers: [{ name: 'X-Trace', value: '7', enabled: true }],
      body: { kind: 'raw', language: 'json', contentType: 'application/vnd.item+json', text: '{"name":"Rex"}' },
      auth: { type: 'inherit' },
      contract: { method: 'post', path: '/items/{id}' },
    });
  });

  it('sends a non-JSON body as written, and no body when none is given', () => {
    const operation = {
      method: 'put',
      path: '/notes',
      parameters: [],
      requestBody: { content: { 'text/plain': {} } },
    } as unknown as OpenApiOperation;
    expect(restRequestOf(operation, { body: 'hello' }, 'n').body).toEqual({
      kind: 'raw',
      language: 'text',
      contentType: 'text/plain',
      text: 'hello',
    });
    expect(restRequestOf(operation, {}, 'n').body).toEqual({ kind: 'none' });
  });
});
```

Append to `packages/cli/test/unit/ops/call.test.ts` (add `restProject` to the helpers import):

```ts
describe('op call, REST', () => {
  async function pets(reply: (request: { url: string; headers: Record<string, unknown> }) => Reply): Promise<{ fixture: Fixture; server: TestServer }> {
    const fixture = await restProject();
    const server = await startServer((request) => reply(request));
    servers.push(server);
    await addEnvironment(fixture.dir, 'local', { Pets: server.url });
    return { fixture, server };
  }

  const callRest = (fixture: Fixture, tool: string, ref: string, args: Record<string, unknown>, overrides: Partial<OpsBase> = {}) =>
    runOp(callOp, { tool, ref, args }, fixture.base(overrides));

  it('fills the path, parses a JSON response, and records the operationId in History', async () => {
    const { fixture, server } = await pets(() => ({
      headers: { 'Content-Type': 'application/json' },
      body: '{"id":3,"name":"Rex"}',
    }));
    const result = await callRest(fixture, 'pets_show_pet', 'Pets/GET /pets/{petId}', {
      environment: 'local',
      path: { petId: 3 },
    });
    expect(server.received[0]).toMatchObject({ method: 'GET', url: '/pets/3' });
    expect(result).toMatchObject({ kind: 'rest', status: 200, ok: true, result: { id: 3, name: 'Rex' }, notes: [] });
    const [entry] = await historyLines(fixture);
    expect(entry).toMatchObject({ kind: 'rest', requestName: 'showPet (MCP)', operationName: 'showPet' });
    expect(entry).not.toHaveProperty('requestId');
  });

  it('sends the JSON body with its media type, and refuses a body the schema refuses', async () => {
    const { fixture, server } = await pets(() => ({ status: 201, headers: { 'Content-Type': 'application/json' }, body: '{"id":1,"name":"Rex"}' }));
    await callRest(fixture, 'pets_create_pet', 'Pets/POST /pets', { environment: 'local', body: { name: 'Rex', tag: 'dog' } });
    expect(server.received[0]?.method).toBe('POST');
    expect(JSON.parse(server.received[0]?.body ?? '')).toEqual({ name: 'Rex', tag: 'dog' });
    expect(server.received[0]?.headers['content-type']).toContain('application/json');
    await expect(
      callRest(fixture, 'pets_create_pet', 'Pets/POST /pets', { environment: 'local', body: { tag: 'dog' } }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it("applies the API's key, and masks it where the server echoes it", async () => {
    const { fixture, server } = await pets((request) => ({
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ id: 1, name: 'Rex', echo: request.headers['x-api-key'] }]),
    }));
    await updateProject(fixture.dir, (project) => ({
      ...project,
      apis: project.apis.map((api) => ({
        ...api,
        auth: { type: 'api-key', name: 'X-Api-Key', in: 'header', valueRef: 'petsKey' },
      })),
    }));
    const result = await callRest(
      fixture,
      'pets_list_pets',
      'Pets/GET /pets',
      { environment: 'local' },
      { env: { WIREBENCH_SECRET_PETSKEY: SECRET } },
    );
    expect(server.received[0]?.headers['x-api-key']).toBe(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('returns a body that is not JSON as text, with a note', async () => {
    const { fixture } = await pets(() => ({ headers: { 'Content-Type': 'text/plain' }, body: 'hello' }));
    const result = await callRest(fixture, 'pets_list_pets', 'Pets/GET /pets', { environment: 'local' });
    expect(result).toMatchObject({ body: 'hello', bodyTruncated: false, notes: [expect.stringContaining('not JSON')] });
    expect(result).not.toHaveProperty('result');
  });

  it('refuses with no-endpoint when the API has no base URL', async () => {
    const fixture = await restProject();
    await updateProject(fixture.dir, (project) => ({
      ...project,
      apis: project.apis.map((api) => ({ ...api, baseUrl: '', servers: [] })),
    }));
    await expect(callRest(fixture, 'pets_list_pets', 'Pets/GET /pets', {})).rejects.toMatchObject({
      code: 'no-endpoint',
      message: expect.stringContaining('"Pets"') as unknown,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/rest-args.test.ts packages/cli/test/unit/ops/call.test.ts`
Expected: FAIL — `restRequestOf` is not exported; REST calls refuse with `unsupported-kind`.

- [ ] **Step 3: Implement**

Append to `packages/cli/src/ops/rest-args.ts` (and add `createRestRequest`, `entry`, `NO_BODY` to a value import from `@wirebench/engine`, and `KeyValueEntry`, `RestBody`, `RestRequestDef` to its type import):

```ts
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function lexical(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

/** OpenAPI's `simple` style: an array joined by `,`, an object as `k=v,k=v`. */
function simpleValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(lexical).join(',');
  if (isRecord(value)) return Object.entries(value).map(([key, item]) => `${key}=${lexical(item)}`).join(',');
  return lexical(value);
}

/** OpenAPI's `form` style, exploded: an array repeats the name, an object is one row per property. */
function formRows(name: string, value: unknown): KeyValueEntry[] {
  if (Array.isArray(value)) return value.map((item) => entry(name, lexical(item)));
  if (isRecord(value)) return Object.entries(value).map(([key, item]) => entry(key, lexical(item)));
  return [entry(name, lexical(value))];
}

function bodyOf(operation: OpenApiOperation, value: unknown): RestBody {
  const jsonType = jsonMediaType(operation);
  const bodyType = jsonType ?? Object.keys(operation.requestBody?.content ?? {})[0];
  if (value === undefined || bodyType === undefined) {
    return NO_BODY;
  }
  return jsonType !== undefined
    ? { kind: 'raw', language: 'json', contentType: jsonType, text: JSON.stringify(value) }
    : { kind: 'raw', language: 'text', contentType: bodyType, text: typeof value === 'string' ? value : JSON.stringify(value) };
}

/**
 * The temporary request for a REST tool's arguments (spec §4.1, revision R3): the rows hold the raw
 * values, since the engine percent-encodes path and query values when it sends. Auth is inherited
 * from the API, as for a new request.
 */
export function restRequestOf(
  operation: OpenApiOperation,
  args: Readonly<Record<string, unknown>>,
  name: string,
): RestRequestDef {
  const path = isRecord(args['path']) ? args['path'] : {};
  const query = isRecord(args['query']) ? args['query'] : {};
  const headers = isRecord(args['headers']) ? args['headers'] : {};
  return createRestRequest(name, {
    method: operation.method.toUpperCase(),
    url: operation.path,
    pathParams: Object.entries(path).map(([key, value]) => entry(key, simpleValue(value))),
    query: Object.entries(query).flatMap(([key, value]) => formRows(key, value)),
    headers: Object.entries(headers).map(([key, value]) => entry(key, simpleValue(value))),
    body: bodyOf(operation, args['body']),
    contract: { method: operation.method.toLowerCase(), path: operation.path },
  });
}
```

In `packages/cli/src/ops/call.ts`, add `import { restRequestOf } from './rest-args.js';`, then replace `prepareRest`:

```ts
/** Spec §4.1 REST: a new request of the endpoint, filled from the arguments, under the API. */
function prepareRest(
  resolved: RestResolved,
  args: Readonly<Record<string, unknown>>,
  operationName: string,
  origin: 'cli' | 'mcp',
): RestSelected {
  const name = requestNameFor(operationName, origin);
  return {
    kind: 'rest',
    path: `${resolved.api.name}/${name}`,
    group: resolved.api.name,
    api: resolved.api,
    chain: [],
    request: restRequestOf(resolved.operation, args, name),
  };
}
```

add the REST outcome beside `soapOutcome`:

```ts
function restOutcome(exchange: Extract<HttpExchangeKind, { kind: 'rest' }>, mask: (text: string) => string): Outcome {
  const { rest } = exchange;
  const contentType = rest.headers['content-type'];
  if (rest.text.trim() === '') {
    return { notes: ['the response has no body'] };
  }
  const looksJson = /json/i.test(contentType ?? '') || /^\s*[[{]/.test(rest.text);
  if (looksJson && !rest.truncated) {
    try {
      return { result: JSON.parse(rest.text) as unknown, notes: [] };
    } catch {
      // Returned as text below.
    }
  }
  return {
    ...rawBody(rest.text, contentType, mask, rest.truncated),
    notes: [`the response body is ${looksJson ? 'not valid JSON' : 'not JSON'}; it is returned as text`],
  };
}
```

and in `run`, move the `operationName` computation above the item and build the item, the outcome and the HTTP side for both kinds — replace from `const item = resolved.kind === 'soap' ? …` through `const http = exchange.soap.http;` with:

```ts
    const operationName =
      resolved.kind === 'soap'
        ? resolved.operation.name
        : (resolved.operation.operationId ?? `${resolved.operation.method.toUpperCase()} ${resolved.operation.path}`);
    const item =
      resolved.kind === 'soap'
        ? await prepareSoap(resolved, args, context.origin)
        : prepareRest(resolved, args, operationName, context.origin);
    const container = resolved.kind === 'soap' ? resolved.iface.name : resolved.api.name;
    const sent = await sendItem(
      item,
      opened,
      environment,
      context,
      { requestName: requestNameFor(operationName, context.origin), operationName },
      container,
    );
    const { exchange } = sent;
    let outcome: Outcome;
    if (exchange.kind === 'soap' && resolved.kind === 'soap') {
      outcome = soapOutcome(resolved, exchange, sent.mask);
    } else if (exchange.kind === 'rest' && resolved.kind === 'rest') {
      outcome = restOutcome(exchange, sent.mask);
    } else {
      throw new Error(`a ${resolved.kind} call came back with a ${exchange.kind} exchange`);
    }
    const http = exchange.kind === 'soap' ? exchange.soap.http : exchange.rest;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/rest-args.test.ts packages/cli/test/unit/ops/call.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/cli/src/ops/rest-args.ts packages/cli/src/ops/call.ts packages/cli/test/unit/ops/rest-args.test.ts packages/cli/test/unit/ops/call.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/cli/src/ops/rest-args.ts packages/cli/src/ops/call.ts packages/cli/test/unit/ops/rest-args.test.ts packages/cli/test/unit/ops/call.test.ts
git commit -m "feat(cli): call a REST endpoint with path, query, header and body arguments (#33)"
```

---

### Task 7: MCP — serving, watching and capping the contract tools

**Files:**
- Create: `packages/cli/src/mcp/contract-tools.ts`
- Modify: `packages/cli/src/mcp/server.ts` (rewritten: low-level `tools/list` and `tools/call`)
- Modify: `packages/cli/src/commands/mcp.ts` (start the host; `--tools`; the count line)
- Modify: `packages/cli/src/args-ops.ts` (`McpArgs.tools`, `--tools`)
- Test: `packages/cli/test/unit/mcp/contract-tools.test.ts` (new), `packages/cli/test/unit/args.test.ts`

**Interfaces:**
- Consumes: Task 4's `deriveContractTools`, `capMessage`, `ContractTool`, `ContractToolSet`; Task 5's `callOp`; `runOp`, `OPS`, `AnyOp`; `openProject`; `OpsError`, `toOpsError`, `exitCodeForError`.
- Produces:
  - `interface ProjectWatch { close(): void }`, `type WatchProject = (dir: string, onChange: () => void) => ProjectWatch`, `watchProjectDir: WatchProject`
  - `interface ContractToolsHost { current(): ContractToolSet; subscribe(listener: () => void): () => void; whenSettled(): Promise<void>; close(): void }`
  - `interface StartContractToolsOptions { containers?: readonly string[]; watch?: WatchProject; debounceMs?: number }`
  - `startContractTools(base: OpsBase, options?: StartContractToolsOptions): Promise<ContractToolsHost>` — throws `too-many-tools`, `container-not-found`
  - `createMcpServer(base: OpsBase, version: string, host?: ContractToolsHost): McpServer`
  - `McpArgs.tools?: readonly string[]` (`--tools none` is `[]`)

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/test/unit/mcp/contract-tools.test.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startContractTools } from '../../../src/mcp/contract-tools.js';
import type { ContractToolsHost, WatchProject } from '../../../src/mcp/contract-tools.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import type { OpsBase } from '../../../src/ops/context.js';
import { runOp } from '../../../src/ops/context.js';
import { importOp } from '../../../src/ops/import.js';
import {
  addEnvironment,
  emptyProject,
  manyOperationsOpenApi,
  PETS_OPENAPI,
  removeTempDirs,
  soapProject,
  startServer,
} from '../ops/helpers.js';

const TOOLS = ['import', 'operations', 'generate', 'send', 'validate', 'query', 'history_list', 'history_diff'];

const ADD_RESPONSE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  '<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>5</c:result></c:AddResponse>' +
  '</soapenv:Body></soapenv:Envelope>';

const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
  await removeTempDirs();
});

/** A watcher the test fires by hand. */
function fakeWatch(): { watch: WatchProject; fire(): void } {
  const listeners: (() => void)[] = [];
  return {
    watch: (_dir, onChange) => {
      listeners.push(onChange);
      return { close: () => undefined };
    },
    fire: () => {
      for (const listener of listeners) listener();
    },
  };
}

async function host(base: OpsBase, watch: WatchProject, containers?: readonly string[]): Promise<ContractToolsHost> {
  const started = await startContractTools(base, { watch, debounceMs: 10, ...(containers !== undefined ? { containers } : {}) });
  closers.push(() => started.close());
  return started;
}

async function connect(base: OpsBase, tools: ContractToolsHost): Promise<Client> {
  const server = createMcpServer(base, '0.0.0-test', tools);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'wirebench-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function payload(result: Awaited<ReturnType<Client['callTool']>>): { isError: boolean; json: unknown } {
  const [first] = result.content as { type: string; text: string }[];
  return { isError: result.isError === true, json: JSON.parse(first?.text ?? 'null') as unknown };
}

describe('contract tools over MCP', () => {
  it('lists the fixed tools first, then one tool per operation with its JSON Schema', async () => {
    const fixture = await soapProject();
    const base = fixture.base();
    const client = await connect(base, await host(base, fakeWatch().watch));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...TOOLS, 'calculator_service_add']);
    const add = tools.at(-1);
    expect(add?.inputSchema).toMatchObject({ type: 'object', required: ['a', 'b'] });
    expect(add?.description).toContain('--allow-send');
  });

  it('refuses a call without --allow-send as isError, and calls through with it', async () => {
    const fixture = await soapProject();
    const calculator = await startServer(() => ({ headers: { 'Content-Type': 'text/xml' }, body: ADD_RESPONSE }));
    closers.push(() => calculator.close());
    await addEnvironment(fixture.dir, 'local', { CalculatorService: calculator.url });

    const closed = fixture.base({ gates: { write: false, send: false } });
    const refused = await (await connect(closed, await host(closed, fakeWatch().watch))).callTool({
      name: 'calculator_service_add',
      arguments: { environment: 'local', a: 1, b: 2 },
    });
    expect(payload(refused)).toEqual({ isError: true, json: expect.objectContaining({ code: 'send-not-allowed' }) as unknown });

    const open = fixture.base();
    const called = await (await connect(open, await host(open, fakeWatch().watch))).callTool({
      name: 'calculator_service_add',
      arguments: { environment: 'local', a: 2, b: 3 },
    });
    expect(payload(called)).toMatchObject({ isError: false, json: { ok: true, result: { result: 5 } } });
  });

  it('answers an unknown tool with operation-gone, and bad arguments with invalid-input', async () => {
    const fixture = await soapProject();
    const base = fixture.base();
    const client = await connect(base, await host(base, fakeWatch().watch));
    expect(payload(await client.callTool({ name: 'nope', arguments: {} }))).toMatchObject({
      isError: true,
      json: { code: 'operation-gone' },
    });
    expect(payload(await client.callTool({ name: 'calculator_service_add', arguments: { a: 'x', b: 1 } }))).toMatchObject({
      isError: true,
      json: { code: 'invalid-input' },
    });
  });

  it('sends tools/list_changed after an import, and lists the new tools', async () => {
    const fixture = await soapProject();
    const base = fixture.base();
    const watcher = fakeWatch();
    const tools = await host(base, watcher.watch);
    const client = await connect(base, tools);
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changed += 1;
    });

    await runOp(importOp, { source: PETS_OPENAPI }, base);
    watcher.fire();
    await tools.whenSettled();

    await vi.waitFor(() => {
      expect(changed).toBe(1);
    });
    const { tools: listed } = await client.listTools();
    expect(listed.map((tool) => tool.name)).toContain('pets_show_pet');

    // A change that alters no tool sends nothing.
    watcher.fire();
    await tools.whenSettled();
    expect(changed).toBe(1);
  });

  it('refuses to start above the cap, and withdraws the tools when a change takes it over', async () => {
    const many = await emptyProject();
    await runOp(importOp, { source: await manyOperationsOpenApi(130) }, many.base());
    await expect(startContractTools(many.base(), { watch: fakeWatch().watch })).rejects.toMatchObject({
      code: 'too-many-tools',
      message: expect.stringContaining('--tools') as unknown,
    });
    expect((await host(many.base(), fakeWatch().watch, [])).current().tools).toEqual([]);

    const fixture = await soapProject();
    const base = fixture.base();
    const watcher = fakeWatch();
    const tools = await host(base, watcher.watch);
    await runOp(importOp, { source: await manyOperationsOpenApi(130) }, base);
    watcher.fire();
    await tools.whenSettled();
    expect(tools.current()).toMatchObject({ overCap: true, tools: [] });
    expect(fixture.warnings.some((line) => line.includes('--tools'))).toBe(true);
  });

  it('refuses a --tools name the project does not have', async () => {
    const fixture = await soapProject();
    await expect(startContractTools(fixture.base(), { watch: fakeWatch().watch, containers: ['Nope'] })).rejects.toMatchObject({
      code: 'container-not-found',
    });
  });
});
```

Add to `packages/cli/test/unit/args.test.ts`:

```ts
describe('parseCliArgs — mcp --tools', () => {
  it('reads a list of containers, and none', () => {
    expect(parseCliArgs(['mcp', '--tools', 'Pets, CalculatorService'])).toMatchObject({
      command: 'mcp',
      tools: ['Pets', 'CalculatorService'],
    });
    expect(parseCliArgs(['mcp', '--tools', 'none'])).toMatchObject({ command: 'mcp', tools: [] });
    expect(parseCliArgs(['mcp'])).not.toHaveProperty('tools');
  });

  it('refuses an empty list', () => {
    expect(() => parseCliArgs(['mcp', '--tools', ' , '])).toThrow(UsageError);
  });
});
```

(`UsageError` is imported in that file already; if not, import it from `../../src/usage-error.js`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/mcp/contract-tools.test.ts packages/cli/test/unit/args.test.ts`
Expected: FAIL — `Cannot find module '../../../src/mcp/contract-tools.js'`; `--tools does not apply to wirebench mcp`.

- [ ] **Step 3: Implement**

In `packages/cli/src/args-ops.ts`:
- `OP_OPTIONS` gains `tools: { type: 'string' },`
- `McpArgs` gains:

```ts
  /** `--tools a,b`: the interfaces and APIs whose operations are tools. Absent: all; `none`: `[]`. */
  readonly tools?: readonly string[];
```

- `MCP_FLAGS` becomes `['project', 'allow-write', 'allow-send', 'env', 'history-dir', 'http', 'tools']`
- in `parseMcp`, before `const historyDir`, add:

```ts
  const toolsFlag = str(values, 'tools');
  const tools =
    toolsFlag === undefined
      ? undefined
      : toolsFlag.trim() === 'none'
        ? []
        : toolsFlag
            .split(',')
            .map((name) => name.trim())
            .filter((name) => name.length > 0);
  if (toolsFlag !== undefined && toolsFlag.trim() !== 'none' && tools?.length === 0) {
    throw new UsageError('--tools needs at least one interface or API name, or none');
  }
```

  and add `...(tools !== undefined ? { tools } : {}),` to the returned object.
- `VERB_HELP.mcp`'s usage line gains ` [--tools <name,…|none>]`, its tool list sentence becomes "…validate, query, history_list, history_diff, and one tool per operation of the imported contracts.", and a flag line goes after `--http`:

```text
--tools <a,b|none>     The interfaces and APIs whose operations are tools (default: all, at most 128
                       tools); none serves the tools above only.
```

- `OPS_HELP_TEXT`'s `wirebench mcp` line gains ` [--tools <name,…|none>]`.

Create `packages/cli/src/mcp/contract-tools.ts`:

```ts
/**
 * The contract tools of one `wirebench mcp` process (#33 spec §6): derived at start (refused above
 * the cap), rebuilt when the project folder changes, and announced to every session when the names,
 * descriptions or schemas differ. Every session reads the same set.
 */
import { watch } from 'node:fs';
import type { OpsBase } from '../ops/context.js';
import { capMessage, deriveContractTools } from '../ops/contract-tools.js';
import type { ContractToolSet } from '../ops/contract-tools.js';
import { OpsError, toOpsError } from '../ops/errors.js';
import { openProject } from '../ops/project.js';

export interface ProjectWatch {
  close(): void;
}

export type WatchProject = (dir: string, onChange: () => void) => ProjectWatch;

/** Every change under the project folder, `.git` left out. */
export const watchProjectDir: WatchProject = (dir, onChange) => {
  const watcher = watch(dir, { recursive: true }, (_event, file) => {
    const name = typeof file === 'string' ? file : '';
    if (name.split(/[\\/]/)[0] !== '.git') {
      onChange();
    }
  });
  watcher.on('error', () => undefined);
  return { close: () => watcher.close() };
};

export interface ContractToolsHost {
  current(): ContractToolSet;
  /** Called after a rebuild that changed what `tools/list` shows; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Resolves once no rebuild is waiting or running. */
  whenSettled(): Promise<void>;
  close(): void;
}

export interface StartContractToolsOptions {
  /** `--tools`: absent for all, empty for none. */
  readonly containers?: readonly string[];
  readonly watch?: WatchProject;
  readonly debounceMs?: number;
}

const EMPTY: ContractToolSet = { tools: [], counts: {}, total: 0, overCap: false, notes: [] };

function signatureOf(set: ContractToolSet): string {
  return JSON.stringify(set.tools.map((tool) => [tool.name, tool.description, tool.inputSchema]));
}

/**
 * @throws OpsError `too-many-tools` above the cap, `container-not-found` for an unknown `--tools` name,
 *   and `openProject`'s codes
 */
export async function startContractTools(
  base: OpsBase,
  options: StartContractToolsOptions = {},
): Promise<ContractToolsHost> {
  const debounceMs = options.debounceMs ?? 500;
  const derive = async (): Promise<ContractToolSet> => {
    const { project } = await openProject(base);
    return deriveContractTools(project, {
      projectDir: base.projectDir,
      gates: base.gates,
      ...(options.containers !== undefined ? { containers: options.containers } : {}),
    });
  };
  let set = await derive();
  for (const note of set.notes) {
    base.warn(note);
  }
  if (set.overCap) {
    throw new OpsError('too-many-tools', capMessage(set), { counts: set.counts });
  }
  let signature = signatureOf(set);
  const listeners = new Set<() => void>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const rebuild = async (): Promise<void> => {
    try {
      const next = await derive();
      for (const note of next.notes) {
        base.warn(note);
      }
      if (next.overCap) {
        base.warn(`${capMessage(next)}. The contract tools are withdrawn until the count is under the cap.`);
      }
      set = next;
    } catch (error) {
      const failure = toOpsError(error);
      if (failure.code !== 'container-not-found') {
        // A project half-written: keep serving the last good set.
        base.warn(`contract tools not rebuilt: ${failure.code}: ${failure.message}`);
        return;
      }
      base.warn(`${failure.message}; no contract tools are served`);
      set = EMPTY;
    }
    const next = signatureOf(set);
    if (next !== signature) {
      signature = next;
      for (const listener of listeners) {
        listener();
      }
    }
  };

  const schedule = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      running = running.then(rebuild);
    }, debounceMs);
  };
  const watcher = (options.watch ?? watchProjectDir)(base.projectDir, schedule);

  return {
    current: () => set,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    whenSettled: async () => {
      while (timer !== undefined) {
        await new Promise<void>((resolve) => setTimeout(resolve, debounceMs));
      }
      await running;
    },
    close: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      watcher.close();
      listeners.clear();
    },
  };
}
```

Replace `packages/cli/src/mcp/server.ts` with:

```ts
/**
 * The ops, and the project's contract operations, as MCP tools (#32 spec §4, #33 spec §8). The
 * contract tools carry JSON Schema built at run time, which `registerTool` cannot take, so this
 * server answers `tools/list` and `tools/call` itself on the underlying `Server`: the fixed tools
 * first, with the schema the SDK would have listed for their zod input, then the contract tools.
 * A result is its JSON; a refusal is an `isError` result carrying `{ code, message }`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { callOp } from '../ops/call.js';
import { runOp } from '../ops/context.js';
import type { AnyOp, OpsBase } from '../ops/context.js';
import type { ContractTool } from '../ops/contract-tools.js';
import { errorPayload, OpsError, toOpsError } from '../ops/errors.js';
import { OPS } from '../ops/index.js';
import type { ContractToolsHost } from './contract-tools.js';

export const SERVER_INSTRUCTIONS =
  'Wirebench tools over one project. send takes its SOAP, REST and WebSocket requests. Start with ' +
  'operations to learn the references the other tools take. Every imported SOAP operation and REST endpoint is ' +
  'also a tool of its own, taking JSON arguments and returning the response as JSON. send, import and the ' +
  'operation tools may be refused: the user starts the server with --allow-send or ' +
  '--allow-write to allow them. Secrets come from the environment the server was started in, and a ' +
  'resolved secret is masked wherever it appears in a result. Other values are redacted by pattern: ' +
  'credential headers, URL credentials and credential-named URL parameters, the WS-Security Password, ' +
  'and values under secret-looking JSON or form keys. A value outside those patterns is returned as it is.';

function resultOf(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function refusalOf(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorPayload(toOpsError(error))) }] };
}

function fixedTool(op: AnyOp): Tool {
  return {
    name: op.name,
    title: op.title,
    description: op.description,
    inputSchema: z.toJSONSchema(op.input, { target: 'draft-7', io: 'input' }) as Tool['inputSchema'],
  };
}

function contractTool(tool: ContractTool): Tool {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema as Tool['inputSchema'] };
}

const FIXED: Readonly<Record<string, AnyOp>> = OPS;

export function createMcpServer(base: OpsBase, version: string, host?: ContractToolsHost): McpServer {
  const server = new McpServer(
    { name: 'wirebench', version },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: { listChanged: true } } },
  );
  const fixed = Object.values(OPS).map(fixedTool);
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...fixed, ...(host?.current().tools ?? []).map(contractTool)],
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name } = request.params;
    const args = request.params.arguments ?? {};
    try {
      const op = FIXED[name];
      if (op !== undefined) {
        return resultOf(await runOp(op, args, base));
      }
      const tool = host?.current().tools.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        throw new OpsError('operation-gone', `No tool is named "${name}"; list the tools again`, { tool: name });
      }
      return resultOf(await runOp(callOp, { tool: tool.name, ref: tool.ref, args }, base));
    } catch (error) {
      return refusalOf(error);
    }
  });
  if (host !== undefined) {
    const unsubscribe = host.subscribe(() => {
      server.sendToolListChanged();
    });
    server.server.onclose = unsubscribe;
  }
  return server;
}
```

In `packages/cli/src/commands/mcp.ts`:
- import `startContractTools` and `type ContractToolsHost` from `../mcp/contract-tools.js`
- `serveHttp` takes `host: ContractToolsHost` as a fifth parameter, passes it on (`createServer: () => createMcpServer(base, cliVersion(), host)`), and after its serving line writes the count line through a new helper:

```ts
function writeToolCount(io: Pick<CliIo, 'stderr'>, host: ContractToolsHost): void {
  const count = host.current().tools.length;
  if (count > 0) {
    io.stderr.write(`wirebench mcp: ${String(count)} contract tools\n`);
  }
}
```

- `mcpCommand` becomes:

```ts
export async function mcpCommand(args: McpArgs, io: CliIo, options: McpCommandOptions = {}): Promise<ExitCode> {
  const stdin = options.stdin ?? process.stdin;
  const base = mcpBaseFor(args, io);
  const refused = await checkProject(base, io);
  if (refused !== undefined) {
    return refused;
  }
  let host: ContractToolsHost;
  try {
    host = await startContractTools(base, args.tools !== undefined ? { containers: args.tools } : {});
  } catch (error) {
    const failure = toOpsError(error);
    io.stderr.write(`${failure.code}: ${failure.message}\n`);
    return exitCodeForError(failure);
  }
  try {
    if (args.httpPort !== undefined) {
      return await serveHttp(args.httpPort, base, io, options.stop, host);
    }
    const restoreConsole = keepConsoleOffStdout(io);
    try {
      const server = createMcpServer(base, cliVersion(), host);
      // Serving ends when stdin does, or when the transport closes itself (the SDK's stdio transport
      // does so for a line over 10 MiB). Calls still in flight at that point are dropped, as MCP's
      // shutdown semantics allow.
      const ended = new Promise<void>((resolve) => {
        stdin.once('end', resolve);
        stdin.once('close', resolve);
        const unsubscribe = server.server.onclose;
        server.server.onclose = () => {
          unsubscribe?.();
          resolve();
        };
      });
      server.server.onerror = (error) => {
        io.stderr.write(`mcp: ${error.message}\n`);
      };
      await server.connect(new StdioServerTransport(stdin as Readable, io.stdout as Writable));
      io.stderr.write(`wirebench mcp: serving ${base.projectDir} on stdio (${describeGates(base)})\n`);
      writeToolCount(io, host);
      await ended;
      await server.close();
      return ExitCode.Ok;
    } finally {
      restoreConsole();
    }
  } finally {
    host.close();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/mcp packages/cli/test/unit/args.test.ts`
Expected: PASS — the new file, and `server.test.ts` and `http.test.ts` unchanged (no host lists the eight fixed tools only).

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/cli/src/mcp/contract-tools.ts packages/cli/src/mcp/server.ts packages/cli/src/commands/mcp.ts packages/cli/src/args-ops.ts packages/cli/test/unit/mcp/contract-tools.test.ts packages/cli/test/unit/args.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/cli/src/mcp/contract-tools.ts packages/cli/src/mcp/server.ts packages/cli/src/commands/mcp.ts packages/cli/src/args-ops.ts packages/cli/test/unit/mcp/contract-tools.test.ts packages/cli/test/unit/args.test.ts
git commit -m "feat(cli): serve each contract operation as an MCP tool, kept current as the project changes (#33)"
```

---

### Task 8: CLI — `wirebench call`

**Files:**
- Create: `packages/cli/src/commands/call.ts`
- Modify: `packages/cli/src/ops/call.ts` (`findContractTool`)
- Modify: `packages/cli/src/args-ops.ts` (`CallArgs`, `parseCall`, flags, help)
- Modify: `packages/cli/src/args.ts` (`ParsedArgs`, dispatch)
- Modify: `packages/cli/src/main.ts`
- Test: `packages/cli/test/unit/call-verb.test.ts` (new), `packages/cli/test/unit/args.test.ts`

**Interfaces:**
- Consumes: Task 4's `contractOperations`, `toolSchemaOf`, `ContractTool`; Task 5's `callOp`, `CallResult`; `opsBaseFor`; `OPEN_GATES`; `openProject`.
- Produces:
  - `findContractTool(project: Project, projectDir: string, wanted: string): Promise<ContractTool>` (in `ops/call.ts`) — by `operations` ref first, then by tool name; throws `operation-not-found` or `definition-cache-missing`
  - `interface CallArgs { command: 'call'; operation: string; project: string; historyDir?: string; json: boolean; args?: string; environment?: string; schema: boolean }`, `parseCall(rest, values): CallArgs`
  - `callCommand(args: CallArgs, io: CliIo): Promise<ExitCode>`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/test/unit/call-verb.test.ts
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/main.js';
import type { CliIo } from '../../src/main.js';
import { addEnvironment, removeTempDirs, soapProject, startServer, tempDir } from './ops/helpers.js';
import type { Fixture, TestServer } from './ops/helpers.js';

const ADD_RESPONSE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  '<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>5</c:result></c:AddResponse>' +
  '</soapenv:Body></soapenv:Envelope>';

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await removeTempDirs();
});

async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: { write: (chunk: string) => ((stdout += chunk), true) } as unknown as CliIo['stdout'],
    stderr: { write: (chunk: string) => ((stderr += chunk), true) } as unknown as CliIo['stderr'],
    env: {},
  };
  const code = await main(argv, io);
  return { code, stdout, stderr };
}

async function calculator(fixture: Fixture): Promise<void> {
  const server = await startServer(() => ({ headers: { 'Content-Type': 'text/xml' }, body: ADD_RESPONSE }));
  servers.push(server);
  await addEnvironment(fixture.dir, 'local', { CalculatorService: server.url });
}

const where = (fixture: Fixture): string[] => ['--project', fixture.dir, '--history-dir', fixture.historyDir];

describe('wirebench call', () => {
  it('prints the input schema and sends nothing with --schema, by ref or by tool name', async () => {
    const fixture = await soapProject();
    for (const operation of ['CalculatorService/Add', 'calculator_service_add']) {
      const { code, stdout } = await run(['call', operation, '--schema', ...where(fixture)]);
      expect(code).toBe(0);
      expect(Object.keys((JSON.parse(stdout) as { properties: object }).properties)).toEqual(['environment', 'a', 'b', 'note']);
    }
  });

  it('calls with --args and -e, printing the result for a person or as JSON', async () => {
    const fixture = await soapProject();
    await calculator(fixture);
    const human = await run(['call', 'calculator_service_add', '--args', '{"a":2,"b":3}', '-e', 'local', ...where(fixture)]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('200');
    expect(human.stdout).toContain('"result": 5');

    const file = join(await tempDir(), 'args.json');
    await writeFile(file, '{"a":2,"b":3}');
    const json = await run(['call', 'CalculatorService/Add', '--args', `@${file}`, '-e', 'local', '--json', ...where(fixture)]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, result: { result: 5 }, historyId: expect.any(String) as unknown });
  });

  it('exits 2 for bad arguments or an unknown operation, and 3 when nothing answers', async () => {
    const fixture = await soapProject();
    expect(await run(['call', 'calculator_service_add', '--args', '{"a":"x","b":3}', ...where(fixture)])).toMatchObject({
      code: 2,
      stderr: expect.stringContaining('invalid-input') as unknown,
    });
    expect(await run(['call', 'calculator_service_add', '--args', '[1]', ...where(fixture)])).toMatchObject({ code: 2 });
    expect(await run(['call', 'nope', ...where(fixture)])).toMatchObject({
      code: 2,
      stderr: expect.stringContaining('operation-not-found') as unknown,
    });
    // The WSDL's own address, 127.0.0.1:9, refuses the connection.
    expect((await run(['call', 'calculator_service_add', '--args', '{"a":1,"b":2}', ...where(fixture)])).code).toBe(3);
  });
});
```

Add to `packages/cli/test/unit/args.test.ts`:

```ts
describe('parseCliArgs — call', () => {
  it('reads the operation, --args, -e, --schema and the common flags', () => {
    expect(parseCliArgs(['call', 'Pets/listPets', '--args', '{"a":1}', '-e', 'local', '--json'])).toEqual({
      command: 'call',
      operation: 'Pets/listPets',
      project: '.',
      json: true,
      args: '{"a":1}',
      environment: 'local',
      schema: false,
    });
    expect(parseCliArgs(['call', 'x', '--schema', '--history-dir', 'h'])).toMatchObject({ schema: true, historyDir: 'h' });
  });

  it('needs exactly one operation, and refuses flags it does not take', () => {
    expect(() => parseCliArgs(['call'])).toThrow(UsageError);
    expect(() => parseCliArgs(['call', 'a', 'b'])).toThrow(UsageError);
    expect(() => parseCliArgs(['call', 'a', '--allow-send'])).toThrow(UsageError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/call-verb.test.ts packages/cli/test/unit/args.test.ts`
Expected: FAIL — `unknown command "call"`.

- [ ] **Step 3: Implement**

In `packages/cli/src/ops/call.ts`, add (with `contractOperations` and `type ContractTool` imported from `./contract-tools.js`, `type Project` from `@wirebench/engine`, and `toolSchemaOf` already imported):

```ts
/**
 * The tool `wanted` names: an `operations` ref first, else a tool name. The cap does not apply here,
 * since one operation is called; neither does `--tools`, which is `wirebench mcp`'s.
 *
 * @throws OpsError `operation-not-found`, `definition-cache-missing`
 */
export async function findContractTool(project: Project, projectDir: string, wanted: string): Promise<ContractTool> {
  const entries = await contractOperations(project, projectDir, []);
  const entry = entries.find((candidate) => candidate.ref === wanted) ?? entries.find((candidate) => candidate.name === wanted);
  if (entry === undefined) {
    throw new OpsError(
      'operation-not-found',
      `No operation or tool matches "${wanted}"; wirebench operations lists the references and tool names`,
      { operation: wanted },
    );
  }
  if (entry.resolved === undefined) {
    throw new OpsError(
      'definition-cache-missing',
      `"${entry.container.name}" has no readable cached definition; import it again with definitions cached`,
      { container: entry.container.name },
    );
  }
  const schema = toolSchemaOf(entry.resolved);
  return {
    name: entry.name,
    ref: entry.ref,
    kind: entry.kind,
    container: entry.container.name,
    description: '',
    inputSchema: schema.inputSchema,
    environmentKey: schema.environmentKey,
  };
}
```

In `packages/cli/src/args-ops.ts`:
- `OP_OPTIONS` gains `args: { type: 'string' },` and `schema: { type: 'boolean' },`
- add:

```ts
export interface CallArgs {
  readonly command: 'call';
  /** An operations ref or a tool name. */
  readonly operation: string;
  readonly project: string;
  readonly historyDir?: string;
  readonly json: boolean;
  /** `--args`: JSON, or `@<file>` holding it. Absent: `{}`. */
  readonly args?: string;
  readonly environment?: string;
  readonly schema: boolean;
}

const CALL_FLAGS = ['project', 'json', 'args', 'env', 'schema', 'history-dir'];

/** @throws UsageError */
export function parseCall(rest: readonly string[], values: OptionValues): CallArgs {
  refuseForeign(values, CALL_FLAGS, 'wirebench call');
  const [operation, ...extra] = rest;
  if (operation === undefined || extra.length > 0) {
    throw new UsageError('usage: wirebench call <operation> [--args <json|@file>] [-e <env>] [--schema]');
  }
  const historyDir = str(values, 'history-dir');
  const args = str(values, 'args');
  const environment = str(values, 'env');
  return {
    command: 'call',
    operation,
    project: str(values, 'project') ?? '.',
    ...(historyDir !== undefined ? { historyDir } : {}),
    json: values['json'] === true,
    ...(args !== undefined ? { args } : {}),
    ...(environment !== undefined ? { environment } : {}),
    schema: values['schema'] === true,
  };
}
```

- `VERB_HELP` gains:

```ts
  call: `wirebench call <operation> [--args <json|@file>] [-e <env>] [--schema] [--project <dir>] [--history-dir <dir>] [--json]

<operation>            An operations reference (Interface/Operation, API/operationId, API/METHOD /path) or
                       the tool name operations shows.
--args                 The arguments as JSON, or @<file> holding them. Default: {}.
-e, --env <name>       The environment; required when the project defines any.
--schema               Print the arguments' JSON Schema and send nothing.
Builds the request from the arguments, sends it under the interface's or API's endpoint, auth and
secrets, records it in History, and prints the response as JSON. Exit 0 on any response, a fault
included; 2 for a refused call or bad arguments; 3 when nothing answered.`,
```

- `OPS_HELP_TEXT` gains, after the `send` entry:

```text
wirebench call <operation> [--args <json|@file>] [-e <env>] [--schema] [--project <dir>]
                       Calls one contract operation with JSON arguments, as its MCP tool does, records it
                       in History, and prints the response as JSON.
```

In `packages/cli/src/args.ts`: import `parseCall` and `type CallArgs` from `./args-ops.js`, re-export `CallArgs` beside `McpArgs`, add `| CallArgs` to `ParsedArgs`, and before `if (word === 'mcp')` add:

```ts
  if (word === 'call') {
    return parseCall(rest, values);
  }
```

In `packages/cli/src/main.ts`: import `callCommand` from `./commands/call.js` and add the case:

```ts
      case 'call': {
        return await callCommand(args, io);
      }
```

Create `packages/cli/src/commands/call.ts`:

```ts
/**
 * `wirebench call` (#33 spec §7): one contract operation from the terminal, through the same core as
 * its MCP tool. Not gated, as `send` from the terminal is not: the person typing it allowed it.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CallArgs } from '../args.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { callOp, findContractTool } from '../ops/call.js';
import type { CallResult } from '../ops/call.js';
import { OPEN_GATES, runOp } from '../ops/context.js';
import { exitCodeForError, OpsError, toOpsError } from '../ops/errors.js';
import { openProject } from '../ops/project.js';
import { opsBaseFor } from './ops.js';

async function readArgs(text: string | undefined): Promise<Record<string, unknown>> {
  if (text === undefined) {
    return {};
  }
  let json = text;
  if (text.startsWith('@')) {
    const path = resolve(text.slice(1));
    try {
      json = await readFile(path, 'utf8');
    } catch {
      throw new OpsError('file-not-found', `No readable file at ${path}`, { file: path });
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    throw new OpsError('invalid-input', `--args is not JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OpsError('invalid-input', '--args must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function callText(result: CallResult): string {
  const out = [`${String(result.status)} ${result.statusText} (${String(Math.round(result.durationMs))} ms)`];
  if (result.fault !== undefined) {
    out.push(`fault: ${result.fault.code}: ${result.fault.reason}`);
    if (result.fault.detail !== undefined) {
      out.push(typeof result.fault.detail === 'string' ? result.fault.detail : JSON.stringify(result.fault.detail, null, 2));
    }
  }
  if (result.result !== undefined) {
    out.push(JSON.stringify(result.result, null, 2));
  }
  if (result.body !== undefined) {
    out.push(result.body);
  }
  out.push(...result.notes.map((note) => `note: ${note}`));
  if (result.historyId !== undefined) {
    out.push(`history: ${result.historyId}`);
  }
  return `${out.join('\n')}\n`;
}

export async function callCommand(args: CallArgs, io: CliIo): Promise<ExitCode> {
  const base = opsBaseFor({ project: args.project, historyDir: args.historyDir, gates: OPEN_GATES, origin: 'cli' }, io);
  try {
    const { project } = await openProject(base);
    const tool = await findContractTool(project, base.projectDir, args.operation);
    if (args.schema) {
      io.stdout.write(`${JSON.stringify(tool.inputSchema, null, 2)}\n`);
      return ExitCode.Ok;
    }
    const given = await readArgs(args.args);
    const callArgs = args.environment !== undefined ? { ...given, [tool.environmentKey]: args.environment } : given;
    const result = await runOp(callOp, { tool: tool.name, ref: tool.ref, args: callArgs }, base);
    io.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : callText(result));
    return ExitCode.Ok;
  } catch (error) {
    const failure = toOpsError(error);
    io.stderr.write(`${failure.code}: ${failure.message}\n`);
    return exitCodeForError(failure);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/call-verb.test.ts packages/cli/test/unit/args.test.ts packages/cli/test/unit/ops-verbs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/cli/src/commands/call.ts packages/cli/src/ops/call.ts packages/cli/src/args-ops.ts packages/cli/src/args.ts packages/cli/src/main.ts packages/cli/test/unit/call-verb.test.ts packages/cli/test/unit/args.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/cli/src/commands/call.ts packages/cli/src/ops/call.ts packages/cli/src/args-ops.ts packages/cli/src/args.ts packages/cli/src/main.ts packages/cli/test/unit/call-verb.test.ts packages/cli/test/unit/args.test.ts
git commit -m "feat(cli): wirebench call runs one contract operation from the terminal (#33)"
```

---

### Task 9: Docs

**Files:**
- Modify: `docs/cli.md`
- Modify: `docs-site/src/content/docs/guides/agents-mcp.mdx`
- Modify: `docs/security.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/roadmap.md`

**Interfaces:**
- Consumes: the behaviour of Tasks 1–8, as built.
- Produces: no code. `pnpm check:banned-terms` and `pnpm check:doc-paths` (both in `pnpm check`) pass.

- [ ] **Step 1: `docs/cli.md`**

In "## Work with a project", the `wirebench operations` row's text gains, at its end: " Each SOAP and REST row also carries `tool`, the name of the operation's tool (see [Contract operations as tools](#contract-operations-as-tools)), when its definition is readable." Then add a row after the `wirebench send` row:

```markdown
| `wirebench call <operation> [--args <json\|@file>] [-e <env>] [--schema]` | Calls one operation of an imported contract with JSON arguments, as its MCP tool does: builds the request a new request of the operation would be, sends it under the interface's or API's endpoint, auth and `WIREBENCH_SECRET_*` secrets, records it in History tagged `cli`, and prints the response as JSON. `<operation>` is the `operations` reference or the tool name. `--args` takes JSON or `@<file>`; `--schema` prints the arguments' JSON Schema and sends nothing. A response is exit 0, a SOAP fault or a 4xx/5xx included. |
```

In "### Exit codes of the verbs", the last sentence's list ends "`definition-cache-missing`, `query-failed`, `operation-gone`, `no-endpoint` and `too-many-tools`." instead of "`definition-cache-missing` and `query-failed`."

In "## `wirebench mcp`", the usage line becomes:

```text
wirebench mcp [--project <dir>] [--allow-write] [--allow-send] [-e <a,b>] [--history-dir <dir>] [--http <port>] [--tools <name,…|none>]
```

the first paragraph's tool list ends "…`history_list` and `history_diff`, and one tool per operation of the project's imported contracts (below).", and the flags table gains, after the `-e, --env` row:

```markdown
| `--tools <a,b\|none>` | The interfaces and APIs, by name or slug, whose operations are tools (default: all). `none` serves the eight tools above only. A name the project does not have exits 2. |
```

Then add, before "### Streamable HTTP":

```markdown
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
```

- [ ] **Step 2: The "Agents (MCP)" guide**

In `docs-site/src/content/docs/guides/agents-mcp.mdx`, add before "## History":

```markdown
## Contract operations as tools

Besides the tools above, every imported operation is a tool of its own: each SOAP operation of an
interface and each endpoint of an OpenAPI-backed API. The agent calls it with typed JSON arguments and
gets the response back as JSON, so it can use a legacy SOAP service without writing XML. Each call
needs `--allow-send`, goes through the interface's or API's endpoint, auth and secrets, and lands in
History.

A tool is named after its container and operation, in snake_case: the `Add` operation of the
`CalculatorService` interface is `calculator_service_add`. `operations` shows each operation's tool
name, and `wirebench call <name> --schema` prints its arguments' schema.

An agent calls it like any tool:

~~~json
{ "name": "calculator_service_add", "arguments": { "environment": "local", "a": 2, "b": 3 } }
~~~

and reads:

~~~json
{
  "tool": "calculator_service_add",
  "operation": "CalculatorService/Add",
  "kind": "soap",
  "status": 200,
  "statusText": "OK",
  "ok": true,
  "result": { "result": 5 },
  "notes": [],
  "historyId": "01K6…"
}
~~~

A SOAP fault is a normal result with `ok: false` and a `fault`; arguments that do not fit the schema,
or a body the XSD refuses, are refused before anything is sent.

A server serves at most 128 of these tools. A larger project refuses to start until `--tools` names the
interfaces and APIs to serve (`--tools none` serves only the tools above). The server watches the
project, so after the agent imports a WSDL the new operations appear as tools without a restart.
```

The inner `~~~json` fences are valid Markdown and MDX fences; write them as they are (they keep this plan's own fence intact). In the Tools table's first paragraph after the table, "Every tool is always listed." stays; add after it: "That holds for the contract tools below as well: each one needs `--allow-send`."

- [ ] **Step 3: `docs/security.md`**

In "## The MCP server is gated, redacted and local", add a bullet after the "**The `send` body override is sent as written.**" bullet:

```markdown
- **Contract tools (#33).** Every imported operation is also a tool, gated by `--allow-send` like
  `send`. Its description carries the contract's own documentation (the WSDL's or the OpenAPI
  document's text, cut at 1,000 characters): text the user imported, shown to the agent as data, as
  `operations` already shows it. Its arguments are checked against the tool's JSON Schema, a string
  holding `${` is refused (it would expand against the server's environment), and a SOAP body is
  checked against the XSD before anything is sent; nothing in the arguments is ever expanded. An `xs:any`
  argument is an XML fragment inserted as written once a strict parser reads it whole. The request takes
  its endpoint, auth and secrets from the project, never from the arguments, and its result passes the
  same redaction as `send`'s, with every number or boolean that holds a resolved secret masked too.
  `--tools` limits which interfaces and APIs are served; at most 128 contract tools are served at once.
```

- [ ] **Step 4: `CHANGELOG.md`**

Under `## [Unreleased]`, at the top of its `### Added` list, add:

```markdown
- **Contract operations as MCP tools (#33).** `wirebench mcp` lists every imported SOAP operation and
  OpenAPI endpoint as a tool of its own, with a JSON Schema built from the XSD or the OpenAPI schemas.
  An agent calls it with JSON; Wirebench builds the envelope or request, sends it under the interface's
  or API's endpoint, auth and secrets, records it in History, and returns the response as JSON. The
  list follows the project as it changes, at most 128 tools are served, and `--tools` picks the
  interfaces and APIs. `wirebench call` runs the same from a terminal, and `operations` rows show each
  operation's tool name.
```

- [ ] **Step 5: `docs/roadmap.md`**

In row 4 of the table, replace "**shipped 2026-09-29** (#32); contract operations as tools (#33) next" with "**shipped 2026-09-29** (#32); contract operations as tools **shipped** (#33)".

In the "**MCP server** (item 4)" item, replace:

```markdown
  see [the CLI reference](cli.md#wirebench-mcp). Still to come, as a second step (#33): expose an imported contract's operations as MCP tools —
  one tool per operation, its input schema derived from the XSD or JSON Schema, auth and environment taken
  from the workspace, every call sent through the engine and recorded in history — so an agent can call a
  legacy SOAP service without writing XML; the cloud platforms generate MCP servers from REST definitions, none from a WSDL. Later, an
```

with:

```markdown
  see [the CLI reference](cli.md#wirebench-mcp). Second step done (#33): every imported operation is an MCP tool —
  one tool per operation, its input schema derived from the XSD or the OpenAPI schemas, auth and environment
  taken from the project, every call sent through the engine and recorded in History — so an agent can call a
  legacy SOAP service without writing XML, and `wirebench call` does the same from a terminal; see
  [Contract operations as tools](cli.md#contract-operations-as-tools). Later, an
```

- [ ] **Step 6: Check and commit**

```bash
pnpm exec prettier --write docs/cli.md docs-site/src/content/docs/guides/agents-mcp.mdx docs/security.md CHANGELOG.md docs/roadmap.md
pnpm -s check:banned-terms && pnpm -s check:doc-paths
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add docs/cli.md docs-site/src/content/docs/guides/agents-mcp.mdx docs/security.md CHANGELOG.md docs/roadmap.md
git commit -m "docs: contract operations as MCP tools, and wirebench call (#33)"
```

Before the push (not part of this task's commit): `pnpm test:perf`, unskipped, once.

---

## Spec coverage

| Spec section | Task |
| --- | --- |
| §1.1 bridge; §3.1 table, descriptions, prefixed keys, large schema note | 1 (schema), 2 (XML both ways), 4 (64 KiB note) |
| §2.1 which operations, `--tools`, cap | 4 (derivation, filter, verdict), 7 (refusal at start, withdrawal) |
| §2.2 names | 4 |
| §2.3 description | 4 |
| §2.4 gates, `environment` | 4 (argument), 5 (`send-not-allowed`, environment rules), 7 (listed whatever the gates) |
| §3.2 REST schemas (R2) | 4 |
| §3.3 checks (R1) | 4 (`checkArgs`), 5 (XSD check) |
| §4.1 temporary request (R3, R4, R5, R7, R8) | 2, 3, 5, 6 |
| §4.2 through the engine, History | 5 |
| §5 results, fault, fallback, redaction, errors | 3, 5, 6 |
| §6 kept current, `operation-gone`, list_changed, cap while serving | 5, 7 |
| §7 CLI: `call`, `--schema`, exit codes, `operations` `tool` (R6), `--tools` | 4, 7, 8 |
| §8 module layout, registration | 1–8 (registration ruling: Task 7) |
| §9 testing | each task's tests |
| §10 docs | 9 |
