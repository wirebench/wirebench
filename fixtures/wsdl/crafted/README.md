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
