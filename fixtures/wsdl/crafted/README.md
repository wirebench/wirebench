# Crafted WSDL/XSD fixtures

Hand-written fixtures exercising the import resolver (`packages/engine/src/wsdl/resolver.ts`).
Each is deliberately tiny but structurally valid.

- **nested-imports/** — `service.wsdl` (`wsdl:import` → `types.wsdl`) → `types.wsdl`
  (`wsdl:types/xs:schema` with `xs:import namespace="urn:wb:common" schemaLocation="schemas/common.xsd"`) →
  `schemas/common.xsd` (`xs:include schemaLocation="base.xsd"`) → `schemas/base.xsd`.
  A 4-document chain (wsdl → wsdl → xsd → xsd). The root's `Echo` operation uses an element
  (`common:EchoRequest`) defined in `common.xsd` whose type (`BaseType`) is defined in `base.xsd`.

- **chameleon-include/** — `service.wsdl` has an inline schema with `targetNamespace="urn:wb:chameleon"`
  that `xs:include`s `chameleon.xsd`, which declares no `targetNamespace` of its own (a chameleon
  include): it adopts the including schema's namespace. `chameleon.xsd` defines the `PingCode`
  simpleType used by the WSDL's `Ping` element.

- **cycle/** — `a.wsdl` imports `b.wsdl`; `b.wsdl` imports `a.wsdl` back. Exercises cycle detection:
  each document is fetched exactly once and the merged definition contains both `MessageA` and
  `MessageB`.

- **schema-constructs/** — a two-namespace fixture for the XSD schema set
  (`packages/engine/src/xsd/`). `service.wsdl` (`urn:wb:sc`) carries an inline schema with
  `elementFormDefault="qualified"` that `xs:import`s `schemas/other.xsd` (`urn:wb:sc:other`,
  `elementFormDefault="unqualified"`), so local-element qualification and cross-namespace
  references are both exercised. Between them the two schemas cover every construct the
  schema set parses: `sequence`/`choice`/`all` with nested compositors and occurrence
  constraints, named `xs:group` + `group ref`, `xs:attributeGroup` + ref, a three-deep
  `complexContent extension` chain with an attribute at each level (`Level1`..`Level3`),
  a `complexContent restriction` that prohibits an inherited attribute
  (`Level3Restricted`), `simpleContent` extension and restriction (`Amount`,
  `ShortAmount`), a `simpleContent` extension and restriction that each inherit an
  unrestated base attribute (`TaxedAmount`, `TaxedAmountRestricted`, both extending
  `Amount` without repeating `currency`), a `complexContent restriction` that
  inherits `mixed` without restating it (`MixedTextRestricted`, restricting
  `MixedText`) and one that inherits `anyAttribute` without restating it
  (`AnyHolderRestricted`, restricting `AnyHolder`), a substitution group with an
  abstract head and a transitive member
  (`Vehicle` ← `Car` ← `Truck`), an abstract complex type with two concrete derivations
  (`AbstractShape`/`Circle`/`Square`), anonymous complex and simple types (`AnonRoot`),
  `enumeration`/`pattern`/`length`/`whiteSpace`/`minInclusive`/`maxExclusive` facets,
  `list` and `union` simple types (named and inline), `default`/`fixed` values, a recursive
  type (`Node`), `xs:any`/`xs:anyAttribute`/`xs:anyType`, `mixed` and empty content,
  `nillable="true"`, and a `soapenc:Array` restriction carrying `wsdl:arrayType`
  (`StringArray`). Ten `document/literal` operations expose the interesting elements so the
  sample-request generator can be driven from the same fixture.

- **rpc-literal/** — a `rpc/literal` SOAP 1.1 binding (`urn:wb:rpclit`) with one operation,
  `Multiply(a: xsd:int, b: xsd:int, opts: tns:Options) → result`. The port-type operation
  declares `parameterOrder="b a"`, deliberately reversing the message's part order and omitting
  `opts`, so the request builder's accessor ordering (parameter-order first, remaining parts in
  message order) is observable. `opts` is typed by an inline `complexType`, exercising a
  complex-typed rpc accessor. The binding sets `soapAction` and a `soap:body namespace`.

- **rpc-encoded/** — a `rpc/encoded` SOAP 1.1 binding (`urn:wb:rpcenc`) with one operation,
  `Sum(values: tns:ArrayOfInt, label: xsd:string) → total`. `ArrayOfInt` is the SOAP 1.1
  section-5 array shape: a `complexContent restriction` of `soapenc:Array` whose
  `soapenc:arrayType` attribute reference carries `wsdl:arrayType="xsd:int[]"`. `soap:body`
  declares `use="encoded"` plus the SOAP encoding `encodingStyle`, so the builder emits the
  `encodingStyle` wrapper attribute, `xsi:type` on simple accessors and a `soapenc:arrayType`
  array accessor.

- **attachments/** — the two attachment shapes a binding can declare (`urn:wb:attachments`).
  `Upload` binds its input as a `mime:multipartRelated` whose first `mime:part` is the SOAP
  envelope (`soap:body parts="body"`) and whose second is a binary
  `mime:content part="file" type="application/octet-stream"`. `SendRef` uses the WS-I
  Attachments Profile 1.0 shape instead: a plain `soap:body` whose `SendRef` element has a
  `ref:swaRef`-typed `doc` child, so the reference to the attachment travels inside the
  envelope. An inline schema defines `swaRef` (a restriction of `xsd:anyURI`) so the fixture
  resolves without network access.

- **soap-headers/** — a `document/literal` **SOAP 1.2** binding (`soap12:binding`,
  `urn:wb:headers`). `Echo` restricts its `soap12:body` to the `body` part and adds two
  `soap12:header`s: `auth` (an `AuthHeader` element part of the *same* input message, carrying a
  `soap12:headerfault`) and `trace` (a `TraceHeader` part of a separate `TraceMessage`). A second
  operation, `Legacy`, has a document-style part declared with `type` instead of `element` (a
  non-WS-I shape seen in the wild), exercising the builder's type-part branch.

- **ws-addressing/** — the three WS-Addressing declaration shapes a WSDL can carry
  (`urn:wb:wsa`), over one `WsaPortType` whose `Echo` input declares
  `wsam:Action="urn:wb:wsa:EchoAction"` and whose `Ping` input declares none.
  `WsaBinding` carries `wsaw:UsingAddressing` directly; `WsaPolicyBinding` carries a
  `wsp:PolicyReference URI="#AddressingPolicy"` to a top-level `wsp:Policy` holding
  `wsam:Addressing` (and its operations set an empty `soapAction`, so the default-action
  fallback runs all the way to `<tns>/<portType>/<operation>Request`); `PlainBinding`
  declares nothing at all, so detection must stay off for it; `WsaOptionalBinding` carries an
  inline `wsp:Policy` whose `wsam:Addressing` is `wsp:Optional="true"` — the WSDL only offers
  addressing, so detection reports `usingAddressing: false, optional: true` rather than
  auto-enabling.

- **wsi-compliant/** — a minimal `document/literal` SOAP 1.1 description (`urn:wb:wsi`) that
  conforms to every WS-I Basic Profile 1.1 assertion implemented in
  `packages/engine/src/validate/wsi/assertions/`. One `Echo` operation with a `soap:header`, a
  `wsdl:fault` bound by a `soap:fault`, and a `soap:address` with an absolute location, so the
  catalogue reports `passed` or `notApplicable` and never a failure.

- **wsi-violations/** — one WSDL per assertion (`R2xxx.wsdl`), each the `wsi-compliant` document
  with exactly the construct that assertion forbids changed; the leading comment names the
  violation. `not-a-description.xml` is pulled in by R2001's `wsdl:import` (a document that is
  neither WSDL nor schema), `imported.xsd` by R2002's (a schema imported the wrong way) and
  `other.xsd` by the misplaced/mismatched `xs:import`s of R2003/R2005. The table-driven test
  (`packages/engine/test/unit/validate/wsi/wsdl.test.ts`) asserts each file produces exactly one
  finding for its own assertion **and trips no other assertion**, so every fixture stays a
  single-violation document.

- **versioned/** — the `v1` → `v2` pair driving Update Definition
  (`packages/engine/src/wsdl/update-definition.ts`). Both are single, self-contained documents
  (`versioned/v1/service.wsdl`, `versioned/v2/service.wsdl`) so the e2e test SOAP server, which
  serves only a fixture's root WSDL, can serve either. `v2` adds the `Subtract` operation, adds an
  optional `note` child to the `Echo` input element, removes the `Legacy` operation and adds a
  second port (`VersionedAltPort`) with a second `soap:address` — one instance of every
  `UpdatePlan` category.
