# Mock response templates

- Issue: [#323](https://github.com/wirebench/wirebench/issues/323) (follow-up of #59)
- Date: 2026-10-09
- Decision: [ADR-0022](../adr/0022-mock-response-templates-read-only-the-request.md)
- Builds on: `2026-10-08-mock-services-design.md`, ADR-0021 (stub files), ADR-0015 (values from the network)

## Problem

A stub body is sent byte for byte (ADR-0021). A client that checks an echoed order id or a correlation
header cannot be served by a mock without a script, and dispatch scripts pick a response; they do not
write one. Echoing is the most common reason a hand-written stub is not enough.

Echoing is also a new path from the network into text: whatever the request carries ends up in a body or
a header the mock sends. ADR-0015 governs response values that flow into the next request; this is the same
problem turned around, a request value flowing into a response.

## What a response file gains

A response opts in by naming the request values it reads, under `values`:

```yaml
id: 01J…
name: Echo order
status: 200
body: json
headers:
  - name: X-Correlation-Id
    value: '{{correlation}}'
values:
  orderId: { from: body, language: jsonpath, expression: $.order.id }
  correlation: { from: header, name: X-Correlation-Id }
```

```json
{ "id": "{{orderId}}", "state": "accepted" }
```

- **Sources.** Each value reads exactly what a match condition reads (`from: body | query | header | path`,
  same fields, no `equals`/`matches`/`exists`). The engine uses the same reader, so a value and a condition
  never disagree about what the request holds. `body` with `xpath` reads the first node's text, as matching
  does.
- **Names.** `[A-Za-z_][A-Za-z0-9_]*`, at most 64 characters; at most 20 values per response.
- **Placeholders.** `{{name}}` in the body file and in header values. Spaces inside the braces are not
  allowed: `{{ name }}` is plain text.
- **Nothing else is a template.** A response without `values` is sent byte for byte, as before.
- **Missing values** (header absent, XPath empty, body of the other language) insert the empty string.

## Load-time checks (`mock-file-invalid`)

- `values` in a mock whose `mock.yaml` is `version: 1` (the file shape needs version 2).
- A `{{name}}` whose `name` fits the name pattern but is not declared in `values` (a typo would otherwise be
  sent as text).
- In a `json` body, a placeholder that is not inside a JSON string literal. That way an inserted value can
  never become JSON structure, only string content.

Other `{{…}}` text (`{{ x }}`, `{{1}}`, `{{` alone) is left alone, so a body that happens to contain braces
still loads.

## Rendering (per request, after dispatch)

1. Read every declared value from the request.
2. Replace each placeholder in **one pass**: an inserted value is never scanned again, so a request that
   sends `{{orderId}}` gets that text back literally.
3. Escape for where it lands, exactly once:
   - `xml` body: all five XML entities (the escaper Sequences use), safe in text and attribute values;
   - `json` body: JSON string-content escaping (quote, backslash, control characters, and U+2028/U+2029);
   - `text` body: as is;
   - header value: must pass Node's header-value check (no CR, LF, NUL or other control characters, nothing
     above U+00FF). A value that fails makes the exchange fail with `mock-template-refused` (500, protocol
     fault shape via `contract.fail`) instead of sending a header the client did not expect.
4. The rendered body counts toward the exchange log like any other body; the log already redacts sensitive
   headers.

## Version

`MOCK_VERSION` becomes 2. `mock.yaml` is written as `version: 2` **only** when one of its responses has
`values`, and `version: 1` otherwise. A mock that does not use templates therefore stays readable by 5.0.0,
and one that does is refused by 5.0.0 as `mock-version-too-new` and left as it is, instead of being loaded,
served with literal `{{…}}` and saved back without its `values`.

## Not in scope

- Reading properties, environment values, secrets, the clock or random values. A template reads the request,
  nothing else (ADR-0022).
- Placeholders in the status, the delay or header names.
- Desktop editing of `values` (follow-up). The editor keeps `values` on every edit it makes.
- Recording templated stubs: the recorder still writes literal stubs.

## Tests

- File: round trip with `values`; version written as 2 only when needed; v1 + `values` refused; undeclared
  placeholder refused; JSON placeholder outside a string refused; limits.
- Template: one-pass substitution (value containing `{{name}}`), XML and JSON escaping of hostile values
  (`</a><b>`, `", "admin": true`, U+2028), missing values, text bodies, header refusal for CR/LF.
- Server: a templated REST stub echoes a path parameter and a header; a CRLF header value gives
  `mock-template-refused`.
- JSON Schemas regenerated (`pnpm schemas:project`).
