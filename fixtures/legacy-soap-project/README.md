# Legacy SOAP project fixtures

Hand-written files in the legacy single-XML SOAP project format, for the import in
`packages/engine/src/soap/legacy-project/`. None of them was produced by, or copied from, another tool:
they were assembled from the format's published schema around this repository's own WSDLs
(`fixtures/wsdl/crafted/nested-imports/` and `fixtures/wsdl/crafted/wsi-compliant/`), so the cached
definitions match those files exactly. Every password in them is fake.

| File | What it exercises |
|---|---|
| `minimal.xml` | One interface with a four-part cached definition, one operation, one call |
| `full.xml` | Two SOAP interfaces, text and inline cache parts, credentials, a one-off URL, a timeout, a non-UTF-8 encoding, a gzip-compressed envelope, an operation missing from the definition, an operation with no calls, project properties, two environments, scripts at project, suite, case and mock level, and a REST service, test suite and mock service that v1 reports rather than maps |
| `no-cache.xml` | An interface with no cached definition, only its URL |
| `malformed.xml` | Not well-formed XML |
| `not-a-project.xml` | Well-formed XML in another namespace |

This folder is exempt from `pnpm check:banned-terms` (see `FORMAT_IDENTIFIER_PATHS` in
`scripts/check-banned-terms.ts`), because the format's namespace URI and root element name have to appear
verbatim. Keep product names out of anything that isn't one of those identifiers, this README included.
