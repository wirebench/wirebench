# JSON completion from the gRPC message descriptor

**Date:** 2026-09-18
**Status:** Built
**Builds on:** [`2026-09-16-wirebench-grpc-client-design.md`](2026-09-16-wirebench-grpc-client-design.md),
[`2026-09-18-grpc-live-streaming-design.md`](2026-09-18-grpc-live-streaming-design.md)

## 1. The problem

A gRPC request's message is JSON typed against a schema the app already holds, and the app gave the
user none of it. *Reset to sample* writes every field once with a zero value, which answers "what
does this message want?" exactly once — the moment before the first edit. After that the schema is
gone: adding a field means remembering its name and its spelling, and getting either wrong is not
caught until the server answers `INVALID_ARGUMENT`, or worse, silently ignores an unknown key.

The XML side has had schema-driven completion since the XSD work. gRPC had the schema and not the
completion.

## 2. What was built

Typing a key in the Message tab offers the fields of the message the cursor is in — not the
method's request type, the message *at that point in the document*, so a nested field's own fields
are offered inside it. Accepting one writes the key and an empty value of the right JSON shape: a
repeated field gets `[]`, a message or a map gets `{}`, a string, a 64-bit integer or an enum gets
`""`, and a bool or a 32-bit number gets a bare cursor. The suggestion carries the declared type
and the field's `.proto` comment, and an enum lists its values.

## 3. Engine: two pure halves

The work splits cleanly into a text half and a schema half, and neither knows about the other.

- **`json/cursor.ts`** — `jsonCompletionContextAt(text, offset)`, the counterpart of the XSD
  module's `completionContextAt`. It scans characters left to right keeping a stack of the
  containers it has entered, because a parse is the one thing a completion provider cannot rely
  on: the document it is asked about is half-typed by definition. It answers the path of object
  keys down to the cursor, the key typed so far, the range to replace, whether that range is inside
  quotes, and the keys the object already holds.

  Two rules in it are worth naming. **An array index is not a path segment**, because every item of
  a repeated field has the element type — `{"items": [{ | }]}` is at `["items"]`, the same place a
  singular message field would be, which also makes the client-streaming form (a JSON array of
  messages, or one per line) work with no special case. **A map key is a segment**, because only a
  schema knows a level of the document is a map rather than a nested message, so the text half
  reports it and the schema half consumes it.

- **`describeMessageAt(set, rootType, path)`** in `grpc/proto/describe.ts` — walks that path down
  through `describeMessage`, following a message field, stepping over a map's user-named key, and
  stopping at a scalar, an enum, or a name the message does not have. It accepts a field written
  under either its declared name or its lowerCamelCase JSON name, since protobuf's JSON mapping
  accepts both.

  It refuses to descend into a **well-known type**. A `Timestamp` is an RFC 3339 string in JSON and
  a wrapper is its bare value, so offering `seconds` and `nanos` would be offering a document the
  codec will not read back — the one case where the fields a message *has* are not the fields its
  JSON *holds*.

## 4. IPC: one channel, and a path that resolves to nothing is not an error

`api.grpcFields` takes `{apiId, type, path}` and answers the fields at that path. Main holds the
parsed `.proto` set, so the walk happens there; the renderer never sees a parser object.

A path that resolves to nothing answers `{fields: []}` rather than failing. The provider asks about
a document the user is in the middle of typing, where a key that names nothing is the normal case
and not a fault worth an error envelope. An unknown `type` still fails, because that is the
caller's own mistake rather than the user's half-finished sentence.

## 5. Renderer: registered per language, consulted per model

Monaco registers a completion provider per *language*, and this build has one JSON language that
every raw body in the app is edited in — a REST request body most of all. So the provider is
registered once for the language and consults a registry keyed by **model URI**: the Message tab
registers a source for its own model, and every other JSON editor is left exactly as it was. That
scoping is what the renderer tests are mostly about, since it is the part no pure function shows.

The source is keyed on the request type rather than set once at mount, because picking a different
method changes what the same editor is completing against without remounting it. Answers are cached
per path for the life of the source: the schema cannot change while the editor is open, and a user
typing inside one object asks about the same path on every keystroke.

Two fields are left out of what is offered. A key the object **already holds**, because JSON will
not let it repeat; and the rest of a **`oneof`** whose member is already written, because setting a
second member silently clears the first — a list offering both would hand the user a message they
did not mean.

## 6. What this does not do

- **No value completion.** An enum's values are shown in the suggestion's documentation, not
  offered as items after the colon. Keys are where the guessing happens.
- **No validation.** An unknown key is not marked; the pane does not go red. *Format* and the
  server's own answer remain where a malformed message is reported.
- **Nothing in the stream composer.** It is a plain textarea by the streaming design's own
  decision, and it stays one.
- **No completion for a REST body.** The registry makes that possible — a JSON Schema source would
  drop into it — but nothing registers one today.

## 7. Success criteria

See `docs/success-criteria.md`, row SC-G9.
