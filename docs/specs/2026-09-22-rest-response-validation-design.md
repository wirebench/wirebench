# REST response validation against the OpenAPI response schema — design

Issue: #45 · Date: 2026-09-22 · Status: approved to build (owner: "go", 2026-09-22)

## Objective

A REST response that breaks its OpenAPI contract shows editor markers, the way a SOAP response that
breaks its XSD already does. The user sees at a glance, on every send of a request that came from an
OpenAPI document, whether the body matches the declared response schema, and where it does not.

## Decisions

1. **No new dependency.** The issue carried an `ajv` ask; #100 shipped a bounded in-house JSON Schema
   validator (`packages/engine/src/json/schema-validate.ts`) that already handles OpenAPI 3.0 `nullable`
   and both `exclusiveMinimum` forms. It is reused. The ask is withdrawn.
2. **Automatic, warning-level.** Every JSON response to a request linked to an operation is checked after
   the send; problems are warnings (never block, never change the send). No preference gate:
   `editor.autoValidateOnSend` is the SOAP "validate the envelope before sending" switch and stays so.
3. **Off the main thread, bounded.** The check runs in a `worker_threads` worker with a hard 1000 ms
   deadline, the same way #100 checks WebSocket frames; an overrun terminates and replaces the worker
   and the result is `not-checked`. Bodies over 1 MiB are `skipped`.
4. **Responses come from the cached definition.** The parser keeps each operation's `responses`
   (it discards them today); main derives them from the API's definition cache on project open, import
   and definition refresh, memoised per API and cleared on project close. An API without a cached
   definition has no contract to check against (`no-contract`), and nothing is fetched at send time.
5. **Request ↔ operation link.** Import writes `contract: { method, path }` on each REST request
   (optional, omitted when unset, so existing projects save byte-identical). A request without a link
   that belongs to an API with a definition is matched once per check by method and path template
   (the request URL's path after the API's base URL, `{name}` and `{{var}}` segments treated as
   parameters); an ambiguous or failed match is `no-contract`.

## Behaviour

- **Response selection:** exact status (`404`) → range (`4XX`, case-insensitive) → `default`. Then media
  type: exact (parameters ignored) → `+json` suffix match to `application/json` → `application/*` →
  `*/*`. No match → `no-schema` (a declared status with no content, e.g. `204`, and an empty body is
  `ok`; a declared empty response with a body is a violation "the contract declares no body").
  An undeclared status is `unmatched` ("the contract declares no 503 response").
- **Checked only when** the body language is `json` and the response is not a stream (SSE rows are not
  checked). A body that does not parse as JSON is a violation at the root ("not valid JSON").
- **OpenAPI adjustments** on top of JSON Schema: a property marked `writeOnly` present in a response is
  a problem; `readOnly` needs nothing; `discriminator` is informative only (`oneOf`/`anyOf` still decide);
  `format` is not asserted and is listed once as a note, like the other unsupported keywords.
- **Result** `RestContractResult`:
  `{ status: 'ok'|'violation'|'unmatched'|'no-schema'|'no-contract'|'skipped'|'not-checked', operation?: {method, path}, responseKey?: string, mediaType?: string, problems: {path, keyword, message}[], notes: string[] }`
  — problems capped at 50, messages at 300 characters.
- **Where it shows:**
  - a chip on the response status line (`Contract ✓`, `Contract: 3 problems`, `Not checked`, …), with a
    tooltip naming the operation and the response key used;
  - editor markers (warning) in the response body editor, located by mapping each JSON Pointer to a
    range in the shown text (`json/pointer-range.ts`, pure, handles pretty-printed and raw text); a
    pointer that cannot be located marks line 1;
  - the Problems panel group `contract:<requestId>:response`, each row revealing its marker.
- **History:** the entry stores the result (same caps) and the History view shows the chip.
- Nothing is checked for requests not imported from OpenAPI and with no API definition.

## Success criteria

- SC-1: a linked request whose 200 body matches the schema shows `Contract ✓`, no markers.
- SC-2: a body missing a required property / with a wrong type shows one marker per problem at the
  offending property (pretty-printed and minified bodies both), a Problems row per problem, and the chip
  count.
- SC-3: an undeclared status → `unmatched`; a declared `4XX`/`default` is used when no exact status.
- SC-4: a pathological schema pattern or huge body never blocks the main process: `not-checked` or
  `skipped` within the deadline.
- SC-5: SSE, XML, HTML, binary responses are not checked; unlinked requests on APIs without a definition
  show no chip.
- SC-6: History keeps the result; a project with no links saves byte-identical.
- SC-7: `pnpm test:perf` — checking a 256 KiB JSON body against a 50-property schema takes < 50 ms in
  the worker.

## Boundaries

- No new dependency; no project format version bump.
- Secrets never enter results (bodies are not copied into results; only pointers and messages).
- Never name another product in code or docs (`pnpm check:banned-terms`).
