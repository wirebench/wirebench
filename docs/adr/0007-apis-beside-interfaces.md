# ADR-0007: A REST API is a sibling container to a SOAP interface, not a second app

- Status: accepted; updated 2026-09-16 when gRPC landed (see *Update* below)
- Date: 2026-09-14
- Context: `docs/specs/2026-09-13-wirebench-rest-client-design.md` (spec §2, §8, §14), built by
  `docs/plans/2026-09-13-wirebench-rest-client-plan.md`; extends ADR-0003 (project folder format)
  and ADR-0006 (workspaces)

## Context

Wirebench shipped as a SOAP workbench: a project held **interfaces**, an interface held
operations, and an operation held requests. That shape came straight from WSDL, and the whole
app — the explorer, the tab host, history, search, environments, the send path — was written
against it.

REST has no WSDL. There is no operation layer, requests are grouped however a person finds
useful, a URL is edited as text rather than generated from a schema, and a document (OpenAPI) is
an optional convenience rather than the source of truth. Two designs were on the table:

1. **A second container beside the interface**, sharing the project, the workspace, the
   environments, history, search and the shell.
2. **A generalised "interface"** whose fields mean different things per protocol, with the
   existing tree bent to fit (an API pretending to have operations, a request pretending to have
   a binding).

gRPC is on the roadmap and would be a third protocol either way, so whichever shape was chosen
had to survive being extended once more.

## Decision

A project holds **APIs beside interfaces**, as a sibling container with its own model, its own
files and its own editor. Concretely:

- **The model.** `RestApi`, `RestFolder` and `RestRequest` live in `packages/engine/src/rest/
  model.ts`, separate from the SOAP `Interface`/`Operation`/`Request` types in
  `packages/engine/src/project/model.ts`. A `ProjectModel` carries both lists. Nothing in the
  SOAP model changed to accommodate REST.
- **A `kind` discriminator on every container and request**, spelled once, at the top of the
  file it is written into: `kind: rest` on an `api.yaml` and on a `*.request.yaml` under it,
  `kind: soap` on an interface. The union is `'soap' | 'rest'`, and `'grpc'` is **reserved**:
  the loader recognises it and refuses the file by name ("this build does not support gRPC")
  rather than reporting a schema mismatch or guessing (`packages/engine/src/project/
  schema.ts`). A project written by a later build that speaks gRPC therefore fails with a
  sentence a person can act on.
- **A parallel folder tree on disk**, `apis/` beside `interfaces/` — see the ADR-0003 update
  for the layout and the `formatVersion: 3` bump it forced.
- **Everything around the containers is shared, not duplicated.** One project, one workspace,
  one set of environments and endpoint overrides, one history file, one search corpus, one tab
  host, one Problems list, one HTTP dispatcher (keystores, TLS trust, proxy, timeouts), one
  secrets store. The send path branches on the request's `kind` at exactly one place per
  layer — `sendRest` beside `sendSoap` in the engine, one `request.send` handler in main that
  dispatches on what the id names — and nowhere else.
- **History records a discriminated union.** A `HistoryEntry` gained an optional
  `kind?: 'soap' | 'rest'` and `method?`; a line written before REST has neither and reads as
  SOAP, so no history file needed migrating. The response side stays a **single** message on
  purpose: a protocol that answers with several (a gRPC server stream) extends the union with
  its own shape instead of bending this one.

## Rationale

- **A shared container would have lied about both protocols.** An `Interface` whose
  `operations` are empty and whose `bindingName` is meaningless is worse than two types: every
  reader of the code has to know which fields apply, and the type system stops helping. Two
  models cost some duplication in the serializers and pay for it everywhere else.
- **The value of the tool is the shell, not the protocol.** Environments, properties, history,
  search, TLS trust, the proxy, secrets in the keychain and the IDE layout are what a person
  came for; they are protocol-neutral already (v1 spec §4 was written that way deliberately).
  Sharing them is the whole point of adding REST to Wirebench rather than shipping a separate
  tool.
- **`kind` on disk, not inferred from the directory.** A file says what it is. A reader — a
  human, `grep`, a future migration — does not have to know that `apis/` implies REST, and a
  file moved or copied by hand still identifies itself.
- **Reserving `grpc` now costs one union member and one error message**, and it means the third
  protocol is a new container and a new send function rather than a format break: the shape this
  ADR chooses is the one that survives it.

## Consequences

- **Two serializers to keep deterministic.** `apis/` has its own writer, its own path-safety
  pass (ADR-0005 applies unchanged: an API named `../../etc` must not escape the project) and
  its own byte-stability test. A change to the shared YAML conventions has to land in both.
- **`formatVersion: 3`, and it is a one-way door.** A project that has ever been saved by this
  build carries version 3, and a 1.1.0 build refuses it with its "created by a newer version of
  Wirebench" error — even if the project holds no APIs at all. See the ADR-0003 update.
- **Every protocol-neutral surface now needs a `kind` branch**, and a new one is easy to forget:
  the explorer row, the tab host, history rendering, search, the Code slide-over, the command
  palette. The mitigation is that each branch is a single `switch` over the union rather than a
  scattered `if (request.envelopeXml)` test, so a third member makes the compiler point at every
  place that needs a decision.
- **A REST request is edited as text, and that is a deliberate asymmetry.** A SOAP request's
  body is generated from a schema and validated against it; a REST body is whatever the user
  types, with an OpenAPI document used only to *seed* it at import. Response validation against
  a document is on the roadmap, not in this decision.
- **Resend and diff from History remain SOAP-only for now.** The history record carries enough
  to show a REST send, but `history.resend` rebuilds a SOAP envelope; replaying a REST entry
  needs a REST rebuild path. Recorded in `docs/success-criteria.md` (SC-R6) and on the roadmap.

## Update (2026-09-16): gRPC landed as the third container

`docs/specs/2026-09-16-wirebench-grpc-client-design.md` built the protocol this ADR reserved. What it kept, and the
one place it deviated:

- **Kept.** A gRPC API is written to `apis/<slug>/` beside the REST ones, with `kind: grpc` at the top of `api.yaml`
  and of every request file; the `.proto` set is cached under `definition/` with a manifest like an OpenAPI
  document's; folders are the same folder; auth, environments (a target overrides under the API's slug, the same
  slot a base URL uses), history, search, the tab host and the send dispatcher branch on `kind` at exactly one place
  per layer, as this ADR asked. `formatVersion` stayed at 3: an older build meets `kind: grpc` and refuses it by
  name, exactly as reserved.
- **Deviation: a separate `grpcApis` list in memory.** This ADR's `ProjectModel` carried one `apis` list whose
  members were told apart by `kind`. The gRPC model is a different type (`GrpcApi` has a target and TLS flag, no
  base URL or servers; `GrpcRequestDef` has a service, method and message, no URL or body), and putting both in one
  list would have made every REST reader narrow on `kind` before touching a field. A second list — `Project.grpcApis`
  beside `Project.apis` — means the compiler points at every place that handles APIs and has no gRPC branch yet,
  which is the mitigation the *Consequences* section hoped for. The on-disk shape is unchanged; only the in-memory
  and wire shapes have the third list.
- **History.** `HistoryEntry.kind` gained `'grpc'` and an optional `grpc` record holding the status, both message
  lists and the trailers — the "several messages" extension this ADR left room for, added beside the single-message
  REST shape rather than by bending it.

## Update (2026-09-19): WebSocket landed as the fourth container

`docs/specs/2026-09-19-websocket-request-kind-design.md` built the fourth protocol this ADR's shape was chosen to
survive. What it kept, the deviation it repeats, and what is new:

- **Kept.** A WebSocket API is written to `apis/<slug>/` beside the REST and gRPC ones, with `kind: websocket` at
  the top of `api.yaml` and of every request file; `formatVersion` stayed at 3, so an older build meets
  `kind: websocket` and refuses it by name, exactly as this ADR reserved for a protocol it did not yet know the
  shape of. Environments, history, search, the tab host and the send dispatcher each branch on `kind` at exactly
  one place per layer, as before.
- **Deviation, repeated.** The gRPC update's `grpcApis` list beside `Project.apis` set the precedent this protocol
  follows rather than breaks: `Project.wsApis` is a fourth list, because `WsApi`/`WsRequestDef` (a URL, headers,
  subprotocols, no method or body) would have forced every REST and gRPC reader to narrow on `kind` before touching
  a field shared by neither. The compiler points at every place that handles APIs and has no WebSocket branch yet,
  the same mitigation the *Consequences* section hoped for.
- **New: a request owns several sibling files.** A REST or gRPC request is one file; a WebSocket request's saved
  messages are siblings of its own — `<name>.msg-<message>.json` for text, `<name>.msg-<message>.b64` for binary
  (saved binary content is base64, never raw bytes on disk) — tracked and swept the way a REST raw body or a gRPC
  message file already are, so a removed message, a renamed request or a message whose format changed leaves no
  orphan behind.
- **New: History's `ws` record is a capped transcript, not a single message or a short list.** A session can run
  far longer than a request/response pair or a bounded gRPC stream, so the renderer holds at most 5 000 live
  frames, and what History keeps is a *sample* rather than the whole run: the first 400 frames plus the last 100,
  capped at 1 MB — enough to show how a session opened and how it ended without keeping an unbounded log per entry.
  Re-send from History stays offered for a SOAP entry only; a WebSocket entry's HTTP Log row is named after its
  request with Resend off, the same as REST and gRPC.
- **New: the transport is container-agnostic on purpose.** Nothing in `packages/engine/src/ws/` reads from
  `project/` — the seam the plan's §6 left for whatever comes after WebSocket (a request/response protocol that
  wants the same session machinery) to reuse the transport without reusing the project model.
