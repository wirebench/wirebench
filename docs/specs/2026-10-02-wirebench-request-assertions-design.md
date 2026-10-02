# Wirebench: request assertions for every protocol, WebSocket included — design

Date: 2026-10-02 · Status: approved; refined at planning (§10) · Issue #192.

- Builds on:
  - The one-send-path spec (`docs/specs/2026-10-01-wirebench-one-send-path-design.md`), §5.2 and §13:
    a WebSocket run sends its saved messages, waits for a reply, and checks the received messages as
    a JSON array; its rows were unasserted because `WsRequestDef` had no `assertions`.
  - The sequences spec (`docs/specs/2026-09-28-sequences-design.md`): the step `AssertionTable` and
    the `update-sequence` save path.
  - The assertion engine (`packages/engine/src/assert/`): `Assertion`, `assertionsSchema`,
    `evaluateAssertions`, `AssertionSubject`.
- Decisions recorded here (owner, 2026-10-02):
  - **An Assertions tab on every request editor**: REST, SOAP, gRPC and WebSocket. Today no request
    editor has one; request assertions are written in the file by hand.
  - **A WebSocket message that is valid JSON is checked as its value**; any other message stays a
    string.
  - **Every editor Send checks the request's assertions** and shows the results.
  - **One shared path** (approach A): one engine check used by every send path, one save change for
    every protocol, one shared table component.

## 1. Scope

In:

- `WsRequestDef.assertions` and its storage, in project format 6 (§2.3).
- The WebSocket subject parses JSON messages.
- An engine function that checks a request's own assertions, used by runs and the desktop.
- One `set-request-assertions` save change for the four protocols.
- The shared `AssertionTable`, and an Assertions tab on the REST, SOAP, gRPC and WebSocket editors.
- Assertion results on editor Sends, in a response-pane Assertions tab.
- Tests and docs.

Out:

- **Header assertions on requests.** `header` stays a step-only kind; the request `Assertion` union
  is unchanged.
- **Assertion results in History.** They show in the response pane only.
- **Checking on History and Log resends and on multi-environment sends.** These are replays and
  comparisons.
- **Waiting for callbacks on an editor Send.** Callback assertions are checked in runs and sequences
  only.
- **Assertions on binary WebSocket frames.**

## 2. Model and storage

### 2.1 The field

`WsRequestDef` (`packages/engine/src/ws/model.ts`) gains `readonly assertions: readonly Assertion[]`.
The field is required, as on REST and SOAP. Every place that builds a `WsRequestDef` sets it: new
request, duplicate, import, and test fixtures. Each of those sets `[]` unless it copies an existing
request.

### 2.2 The file

- **Schema:** `wsRequestFileSchema` (`packages/engine/src/ws/files.ts`) gains
  `assertions: assertionsSchema.default([])`.
- **Load and save:** `packages/engine/src/ws/storage.ts` follows REST (`rest/storage.ts`):
  - On load, a `callback` assertion goes through `toCallbackAssertion` and any other through
    `exact<Assertion>`.
  - On save, the key is written only when the list is not empty, each entry as `compact({...a})`.
- **A file without the key** loads as `[]`.

### 2.3 Format version

- `FORMAT_VERSION` stays 6. Version 6 is unreleased, and unreleased changes share it
  (`packages/engine/src/project/model.ts`).
- The version comment gains: "`assertions` on a WebSocket request (#192)".
- A file without the key loads as before (§2.2).

### 2.4 Kinds that cannot apply

A saved `soap-fault` or `schema` assertion on a REST, gRPC or WebSocket request is not refused at
load. When checked, it reports `errored`, as the evaluators already do for a protocol mismatch. The
editor never offers those kinds there (§5.3).

## 3. The WebSocket subject

`wsSubject` (`packages/engine/src/ws/run.ts`) builds `bodyText` from the received text messages, in
order:

- **Valid JSON:** a message whose text parses with `JSON.parse` goes into the array as that value.
  So `{"type":"ready"}` becomes an object, `123` becomes the number 123, and `"hi"` (with quotes)
  becomes the string `hi`.
- **Not JSON:** any other message goes in as its raw text.
- **Left out:**
  - binary, ping, pong and close frames;
  - sent messages.
- **Unchanged:**
  - `status` is the handshake status: 101, or 0 for a refused handshake;
  - `headers` are the handshake response headers;
  - `bodyKind` stays `json`;
  - `durationMs` is the session's duration.

Example: received `{"type":"ready"}`, then `pong`, then `{"id":7}`. The subject is
`[{"type":"ready"},"pong",{"id":7}]`, so `$[0].type` equals `ready` and `$[2].id` equals `7`.

`wsSubject` becomes part of the engine's exports, alongside `restSubject` and the others.

## 4. The shared engine check

New module `packages/engine/src/assert/check.ts`, exported from the package index:

```ts
/**
 * A request's own assertions checked against a subject, in order. The default SLA is added when
 * the request has none of its own. Callback assertions are left out: a run waits for them.
 */
export function checkRequestAssertions(
  subject: AssertionSubject,
  assertions: readonly Assertion[],
  options?: { readonly defaultSlaMs?: number },
): Promise<AssertionResult[]>;
```

- **The subject** is the engine's `SentRequest.subject`, which every protocol's send already sets
  (`restSubject`, `grpcSubject`, `wsSubject`, and for SOAP `soapSubject`, which adds contract
  validation). No separate subject picker is needed. The desktop sequence runner's `describe()`
  keeps its own switch; changing it is out of scope.
- **`runOne`** (`packages/engine/src/run/run.ts`) replaces its inline default-SLA and callback filter
  with `checkRequestAssertions`. The callback wait (`sendAwaitingCallbacks`) and the script results
  are unchanged, and so are run results for REST, SOAP and gRPC.
- **WebSocket in runs:** `assertionsOf` already reads `request.assertions`, so once §2 lands:
  - a WebSocket request with assertions is checked;
  - its row is no longer `unasserted`;
  - `--require-assertions` sends it.
- **CLI and MCP `send`** take the run path, so they report WebSocket assertion results with no
  further change.

## 5. Saving, and the Assertions tab

### 5.1 Wire

- **New schema:** `requestAssertionWireSchema` (`apps/desktop/src/shared/wire-types.ts`) is
  `stepAssertionWireSchema` without the `header` variant.
- **Request views:** the view each editor receives gains `assertions: RequestAssertionWire[]`.
  This applies to the SOAP request, the REST request, the gRPC request and the WebSocket request.

### 5.2 One save change

`{ kind: 'set-request-assertions', requestId, assertions }` on `project.mutate`. The main process:

1. finds the request, whichever protocol (`unknown-entity` otherwise, as every request change does);
2. converts the wire assertions as `update-sequence` does, and parses them through the engine's
   `assertionsSchema`;
3. refuses a value that does not parse with `request-assertions-invalid`, listing the issues as an
   invalid sequence does. Two examples: a regex that does not compile, and a `match` with none or more than one of
   `equals`, `matches` and `exists`;
4. replaces the request's `assertions` and writes it through that protocol's storage.

The existing per-protocol update changes keep leaving `assertions` untouched.

### 5.3 The shared table

- **Location:** `AssertionTable` moves from `renderer/features/sequence/assertion-table.tsx` to
  `renderer/features/assertions/assertion-table.tsx`.
- **New props:**
  - `kinds`: the kinds the kind picker offers;
  - `testIdPrefix`: defaults to `sequence`, so the sequence screen keeps its `sequence-assertion-*`
    ids. The request tab passes `request`.
  - `emptyText`: what the table says when there are no assertions.
- **Kinds offered:**

  | Editor                    | Kinds                                                                |
  | ------------------------- | -------------------------------------------------------------------- |
  | Sequence step             | all, as today (`header` included)                                    |
  | SOAP request              | status, body match, response time, SOAP fault, schema, callback      |
  | REST, gRPC and WebSocket  | status, body match, response time, callback                          |

### 5.4 The tab

- **Where:** each of the four request editors gains an Assertions tab, after Scripts. The WebSocket
  editor has no Scripts tab, so there it goes after Auth.
- **Label:** the tab shows a count when the request has assertions.
- **Saving:** an edit saves through `set-request-assertions` the same way that editor saves its
  other fields.
- **A refused save** shows the refusal message under the table and leaves the saved assertions as
  they were.

## 6. Results on an editor Send

- **Source:** main reads the request's saved assertions by `requestId`. Because the tab saves each
  edit, these are the assertions the tab shows.
- **When they are checked:** once, with `checkRequestAssertions` over `sent.subject`:
  - a unary REST, SOAP or gRPC Send is checked when its response arrives;
  - an interactive WebSocket session, or a streaming gRPC call, is checked when it ends, against
    everything it received.
- **No response, no results:** a send that fails without a response shows its error and no
  assertion results. That covers a network error, a timeout, and a refusal before the call. A
  refused WebSocket handshake that an interactive session returns as a result is checked, with
  status 0.
- **Not checked:** History and Log resends, multi-environment sends, preflight and cURL.
- **Wire:** each protocol's send summary gains `assertions?: RequestAssertionResultWire[]`. The
  field is absent when nothing was checked. Every string in it is masked as the sequence runner's
  `toWire` masks step results. `RequestAssertionResultWire` is the sequence assertion result wire
  shape with one more outcome, `not-checked`, which only the desktop produces; the engine's
  `AssertionResult` is unchanged.
- **Callback assertions** are not waited for. Each one appears as a `not-checked` row labelled
  "checked in runs". A `not-checked` row counts towards neither passed nor failed.
- **The response pane** gains an Assertions tab:
  - its label shows `passed/checked` (`not-checked` rows left out of both), and turns to the failure colour when any assertion failed or
    errored;
  - each row shows the label, the outcome, and the expected, actual and message fields when
    present.
- **With no assertions,** the tab reads "No assertions".

## 7. Errors

| Case                                          | Result                                                      |
| --------------------------------------------- | ----------------------------------------------------------- |
| `set-request-assertions`, unknown request     | refused, `unknown-entity`                                   |
| `set-request-assertions`, invalid assertion   | refused, `request-assertions-invalid`; nothing written      |
| Inapplicable kind found in a file             | loads; reports `errored` when checked                       |
| Assertion check throws                        | that assertion reports `errored`; the send result still shows |

## 8. Tests

- **Engine:**
  - a WebSocket request file round-trips its assertions, and a file without the key loads `[]`;
  - `wsSubject` with JSON messages, non-JSON messages and binary frames;
  - `checkRequestAssertions` with the default SLA and callbacks;
  - a WebSocket run that passes, and one that fails;
  - `--require-assertions` sends a WebSocket request with assertions;
  - existing run tests unchanged.
- **CLI and MCP:** `send` on a WebSocket request with assertions reports their results.
- **Desktop main:**
  - `set-request-assertions` for each protocol, including the refusals;
  - editor-Send results for REST and WebSocket, with masking;
  - the sequence runner tests unchanged.
- **Renderer:**
  - the shared `AssertionTable`, with `kinds` and `testIdPrefix`;
  - an editor's Assertions tab;
  - the response pane's Assertions tab.
- **e2e (CI):** add a status assertion to a REST request and a JSONPath assertion to a WebSocket
  request, Send each, and see the result in the response pane.

## 9. Docs

- **`docs-site/.../guides/assertions.mdx`:** the editor tab, WebSocket assertions with the JSON
  example from §3, and checking on Send.
- **`docs/cli.md`:** remove the lines saying a WebSocket request has no assertions (around 182–186).
- **`docs-site/.../reference/project-format.md`:** `assertions` on WebSocket requests, part of
  version 6.
- **The comment in `packages/cli/src/commands/sequence.ts:142`.**
- **`CHANGELOG.md` `[Unreleased]`:**
  - Added: the Assertions tab, WebSocket assertions, results on Send.
  - Changed: the WebSocket subject parses JSON messages, with a before and after example.
- **Issue #192:** retitled to "Request assertions for every protocol, WebSocket included".

## 10. Refined at planning (2026-10-02)

The plan is `docs/plans/2026-10-02-wirebench-request-assertions-plan.md`.

1. **The format stays 6.** Version 6 is unreleased, and unreleased changes share it (§2.3). The
   move to 7 is withdrawn.
2. **No `subjectOf`.** `SentRequest.subject` is already each protocol's subject, and for SOAP a
   stronger one than the desktop's `describe()` builds (§4).
3. **Codes.** An unknown request is refused with `unknown-entity`, and an invalid list with
   `request-assertions-invalid` (§5.2, §7).
4. **Shared helpers.** The request-walking helpers of the scripts change move to a shared module.
   That module reaches WebSocket requests only when asked, so a scripts edit never touches one.
5. **History.** Assertion results are added to a send's result after History is written.
