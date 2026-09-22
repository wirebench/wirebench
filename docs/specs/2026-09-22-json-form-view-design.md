# JSON form view — design

Issue #46. A REST request whose body is raw JSON and whose operation is known from an OpenAPI
definition can be filled in as fields generated from the request-body schema. The form and the raw
editor edit the same text: switching between them loses nothing.

## Goals

- A JSON body filled in as fields: objects as groups, arrays as repeats, scalars as typed inputs
  (string, number, integer, boolean, enum as a select).
- Round-trips to the raw editor. The body text stays the source of truth; the form is a view of it.
- Optional properties can be added and removed; array items can be added and removed; `oneOf`/`anyOf`
  branches can be picked.

## Non-goals

- Validation messages in the form (response validation already exists; request validation is later).
- Form view for XML REST bodies, multipart or url-encoded bodies.
- Preserving comments or key order the schema does not know about beyond what `JSON.parse` keeps.

## Model (engine, pure, renderer-safe)

New module `packages/engine/src/rest/json-form.ts`, exported from the `./rest` subpath
(`src/rest/browser.ts`) and the main barrel.

```ts
type JsonFormKind = 'field' | 'object' | 'array' | 'choice' | 'any';
type JsonFormValueType = 'string' | 'number' | 'integer' | 'boolean' | 'null';

interface JsonFormNode {
  id: string;             // JSON pointer of the value, '' for the root
  kind: JsonFormKind;
  name: string;           // property name, array index, or '' for the root
  label: string;          // schema title ?? name
  description?: string;
  required: boolean;
  present: boolean;       // the value exists in the document
  valueType?: JsonFormValueType;  // field only
  format?: string;
  enum?: readonly JsonValue[];
  value?: JsonValue;      // field and any, when present
  children: readonly JsonFormNode[];   // object properties / array items / chosen branch
  choices?: readonly string[];         // choice: branch labels
  chosen?: number;                     // choice: index of the matching branch
  readOnly?: boolean;
  deprecated?: boolean;
}

buildJsonForm(schema: JsonSchema, value: JsonValue | undefined, options?: { maxDepth?: number }): JsonFormNode
applyJsonFormEdit(schema: JsonSchema, value: JsonValue | undefined, edit: JsonFormEdit): JsonValue
toWireSchema(schema: JsonSchema, maxDepth?: number): JsonSchema   // acyclic, depth-cut copy

type JsonFormEdit =
  | { kind: 'set-value'; id: string; value: JsonValue }
  | { kind: 'insert-optional'; id: string }        // fills from sampleFromSchema
  | { kind: 'remove'; id: string }                 // optional property or array item
  | { kind: 'add-item'; id: string }               // id of the array
  | { kind: 'select-choice'; id: string; index: number };
```

- Schemas are already dereferenced by `resolveRefs` and may be cyclic. `buildJsonForm` stops at
  `maxDepth` (default 8, same as `MAX_SAMPLE_DEPTH`) with a `kind: 'any'` node, which the view shows
  as a small JSON text field.
- `allOf` is merged the way `sampleFromSchema` merges it. `oneOf`/`anyOf` become a `choice`; the chosen
  branch is the first whose required properties and type match the value, else 0.
- Properties in the value that the schema does not declare are kept untouched and shown as `any`
  nodes when `additionalProperties` is not `false`.
- New values come from `sampleFromSchema` so the form and "generate body" agree.

## Getting the schema to the renderer

- `ProjectHost.restBodySchema(requestId): Promise<{ mediaType: string; schema: JsonSchema } | undefined>`
  uses the same lookup as `restContractFor` (contract link first, else `matchOperation`) and picks the
  first JSON media type (`application/json` or `*+json`). The schema passes through `toWireSchema`
  because a cyclic graph cannot cross IPC.
- New channel `request.restBodySchema` (`{ requestId }` → `{ mediaType, schema } | null`), wired through
  `project-router.ts` / `workspace-service.ts` the way `restContractFor` is.
- Additive only: nothing in `rest/openapi/update.ts` or the REST update-definition code changes.

## View (desktop)

- `BodyTab` gets a **Text / Form** switch next to the language picker, shown only when the body kind is
  raw, the language is JSON, and a schema came back.
- `JsonFormView` (`features/rest-editor/json-form-view.tsx`) parses the current text. If the text does
  not parse, it shows "The body is not valid JSON" with a button back to Text, and no fields.
- Every edit runs `applyJsonFormEdit`, then `JSON.stringify(value, null, 2)` and `onChange({ body })`.
  Text → Form → Text with no edits leaves the text byte-identical (the form never writes unless edited).
- The Text/Form choice is remembered per request in renderer editor state.
- Keyboard: every input is labelled by its property path; add/remove are buttons with accessible names.

## Tests

- Engine unit: `test/unit/rest/json-form.test.ts` — build over objects, arrays, enums, nested required,
  cycles (depth cut), `oneOf` choice detection, unknown properties kept; each edit kind; round-trip.
- Desktop main: `restBodySchema` lookup (contract link, URL match, no JSON media type, no definition).
- Renderer: `rest-json-form-view.test.tsx` — typing in a field updates the body text; add/remove
  optional; invalid JSON message; switch hidden without schema.
- e2e: `e2e/specs/rest-json-form.spec.ts` — import a small OpenAPI, open a POST, switch to Form, fill a
  field, switch back to Text and see it.
- Docs: "Request body" section of `guides/rest-client.mdx` describes the Form switch.
