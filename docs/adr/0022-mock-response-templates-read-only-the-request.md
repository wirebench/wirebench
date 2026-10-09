# ADR-0022: Mock response templates read only the request, and every value is escaped where it lands

- Status: accepted
- Date: 2026-10-09
- Context: issue #323; `docs/specs/2026-10-09-mock-response-templates-design.md`. Amends ADR-0021 ("Stubs are
  literal data") and applies ADR-0015 to the reverse direction.

## Context

ADR-0021 made a stub literal: no `${…}` expanded, no property or secret read. It left echoing request values
to a later decision, because a template is a new path from the network into text a client reads, and a
`version: 2` response field was named as the place for it.

ADR-0015 says a value a server chose is data, never a template: literal, never a name, escaped where it
lands, never able to change where a request goes. A mock template is the same situation with the roles
swapped: the client chooses the value, and the mock's reply is where it lands. The mock also runs in CI and
inside containers, where the project's properties and the process environment hold credentials.

## Decision

- **Syntax.** A response declares named `values`, each read from the request exactly as a match condition
  reads it (`body` by XPath or JSONPath, `query`, `header`, `path`). The body and header values use
  `{{name}}`. The syntax is deliberately not `${…}`, so nothing a property expander does can apply to it and
  a reader can tell the two apart.
- **Request values only.** There is no source for properties, environment values, secrets, scripts, the
  clock or randomness. Adding one is a new decision, not a new `from`.
- **Opt in, per response.** Only a response with `values` is rendered. Every other response is sent byte for
  byte, as ADR-0021 says.
- **Literal, one pass.** Each placeholder is replaced once; inserted text is never scanned again, so a
  request cannot smuggle in a placeholder, and no value can name another.
- **Declared names only.** An undeclared `{{name}}` is refused at load, so a typo never reaches a client.
- **Escaped where it lands, exactly once.** XML bodies get all five entities. JSON bodies get string-content
  escaping, and a placeholder in a JSON body must sit inside a string literal (checked at load), so a value
  can never add a field. Text bodies are sent as read. A header value that would carry CR, LF, NUL or any
  character a header may not hold fails the exchange (`mock-template-refused`) rather than being trimmed.
- **Versioned.** The `values` field belongs to mock version 2. `mock.yaml` is written as version 2 only
  when a response uses it, so a mock without templates stays readable by builds that know only version 1,
  and a build that knows only version 1 refuses a templated mock whole instead of serving and saving it
  without its `values`.

## Consequences

- A templated stub cannot compute anything (no arithmetic, dates, ids). That is what dispatch scripts are
  for, and a later feature may let a script produce a body under ADR-0016.
- The JSON-string rule refuses `"count": {{n}}`. A number has to be echoed as a string, or the response
  must be text. That costs some realism and buys a guarantee that a client value never becomes structure.
- Echoed values appear in the reply as the client sent them (escaped). The mock is never the origin of a
  secret, so masking adds nothing here; the exchange log redacts headers as before.

## Alternatives considered

- **Inline sources (`{{header.X-Id}}`, `{{query.id}}`).** Shorter for the common case, but a body source
  needs a language, an expression and namespaces, which do not fit in a placeholder. One declared form for
  every source keeps one reader and lets the loader check names.
- **`${…}` with a new scope.** It would put request values one typo away from the property expander and its
  recursion, which ADR-0015 exists to rule out.
- **A general template language (conditionals, loops, helpers).** Each helper is a new input surface.
  Scripts already cover logic.
- **A version on the response file alone.** A build that knows only version 1 never checks a response
  file's version, so it would load the stub, ignore `values` and drop them on the next save.
