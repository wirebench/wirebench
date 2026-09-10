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
  `ShortAmount`), a substitution group with an abstract head and a transitive member
  (`Vehicle` ← `Car` ← `Truck`), an abstract complex type with two concrete derivations
  (`AbstractShape`/`Circle`/`Square`), anonymous complex and simple types (`AnonRoot`),
  `enumeration`/`pattern`/`length`/`whiteSpace`/`minInclusive`/`maxExclusive` facets,
  `list` and `union` simple types (named and inline), `default`/`fixed` values, a recursive
  type (`Node`), `xs:any`/`xs:anyAttribute`/`xs:anyType`, `mixed` and empty content,
  `nillable="true"`, and a `soapenc:Array` restriction carrying `wsdl:arrayType`
  (`StringArray`). Ten `document/literal` operations expose the interesting elements so the
  sample-request generator can be driven from the same fixture.
