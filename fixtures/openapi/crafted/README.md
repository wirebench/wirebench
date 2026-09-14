# Crafted OpenAPI fixtures

Hand-written documents, one folder per construct the importer has to get right. Each is deliberately
tiny but valid, and each is a golden input for `packages/engine/test/unit/rest/openapi/`.

- **parameters/** — every location: a path-level parameter the operation overrides, a required and an
  optional query parameter, a header, and a `cookie` one (which the import skips with a note).
- **bodies/** — one operation per media type: JSON with an `example`, JSON with `examples` (the first
  is taken), JSON with neither (a sample is generated), XML with an `xml` object, form, multipart with
  a binary part, `application/octet-stream`, and an operation offering several types at once so the
  JSON-first preference is visible.
- **schemas/** — `allOf` merged, `oneOf` taking its first branch, `format` placeholders, and a nested
  object and array with an `enum`.
- **security/** — every scheme type: `http` basic and bearer, `apiKey` in a header, a query and a
  cookie (skipped), both OAuth2 flows, and `openIdConnect` (skipped). A global requirement, two
  operations that override it, and one that opts out with `security: []`.
- **servers/** — a templated URL with variable defaults, a plain one, and one whose variable has no
  default so the template survives into the base URL.
- **deprecated/** — a current operation, a deprecated one under the same tag, and a deprecated one
  with no tag at all.
- **refs/** — a local `$ref`, a relative one into `shared/parameters.yaml` and `shared/schemas.yaml`
  (which itself has a local `$ref`), and one pointing at nothing, which is reported rather than fatal.
- **cycle/** — a schema that references itself directly and through an array, so resolution has to
  terminate.
- **v31/** — OpenAPI 3.1: a `type: [string, 'null']`, a `const`, `webhooks`, `callbacks` and two
  `x-` extensions, all of which are counted as skipped.
