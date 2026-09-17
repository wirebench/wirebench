# Spec: gRPC client

- Status: **implemented** (2026-09-16). Built by `docs/plans/2026-09-16-wirebench-grpc-client-plan.md`;
  evidence per criterion is in `docs/success-criteria.md`, rows SC-G1–SC-G6.
- Date: 2026-09-16
- Builds on: the REST client design (`docs/specs/2026-09-13-wirebench-rest-client-design.md`, whose §8 fixed the
  shapes this spec fills in), the v1 design (§4 protocol-neutral core, §12 boundaries), ADR-0003 (project folder
  format), ADR-0004 (secrets), ADR-0005 (path safety), ADR-0007 (APIs beside interfaces — updated by this spec),
  and `docs/roadmap.md` item 17.

## Assumptions I'm making

1. **gRPC is the third container, in the same project.** A gRPC API lives in `apis/<slug>/` beside REST APIs,
   with `kind: grpc` at the top of `api.yaml` and of every `*.request.yaml` under it, exactly as REST §8 anticipated.
   One workspace, one set of environments, one history, one search corpus, one shell.
2. **The definition is a set of `.proto` files, cached with the project.** Server reflection (added 2026-09-17) and
   gRPC-Web are not built (§9). The cache mirrors the import-path layout the compiler would see, so the same set reloads without a
   second resolution step.
3. **Messages are edited as JSON**, in the protobuf JSON mapping (int64 as strings, enums by name, bytes as base64,
   `Timestamp`/`Duration`/`Struct`/wrappers/`Any`/`FieldMask` in their JSON forms). A schema-driven Form view is
   not built.
4. **Every streaming shape is sent, none is interactive.** A client stream's messages are the JSON array (or
   newline-separated objects) in the editor, sent in order and then half-closed; a server stream's replies are
   collected until the trailers arrive and listed in order. Sending a message *while* a bidirectional call is open
   is left for later.
5. **The transport is Node's `http2` module, not undici.** undici does not surface HTTP/2 trailers, and a gRPC
   status lives in the trailers; the existing HTTP stack's TLS trust, keystores, `trustInvalid`, bind address and
   timings are reused as options rather than as a client.
6. **One runtime dependency, `protobufjs`,** for parsing `.proto` and encoding/decoding messages (REST §8 named this
   as ask-first; the dependency is recorded in `THIRD-PARTY-LICENSES.md`). Every JSON-mapping rule the editor relies
   on is applied in-house on top of it, so the canonical form is Wirebench's, not the library's.
7. **UI copy never names other tools.**

---

## 1. Objective

**What.** A gRPC client inside Wirebench: `.proto`-imported (or hand-built) APIs with folders and requests beside
SOAP interfaces and REST APIs; a request editor with the method, the target the call resolves to, a JSON message,
metadata, auth and settings; a response pane with the gRPC status, every response message, initial and trailing
metadata, timing, TLS and the raw HTTP/2 exchange; environments and property expansion shared with the other two;
history, search and a copyable command line.

**Why.** Estates that moved past SOAP did not all move to JSON over HTTP/1.1. The shell — projects in git, secrets in
the keychain, one environment switch, a keyboard-first IDE — is what a person comes for, and it applies unchanged.

## 2. Concepts

- **gRPC API** — the container: a name, a **target** (`host:port`, or a `grpc://`/`grpcs://`/`http(s)://` address),
  whether the target speaks **TLS**, default **metadata** sent with every call, default auth, and an optional
  cached **definition**.
- **Folder** — the same folder the REST container has; an import makes one per service.
- **gRPC request** — a service and method (with its streaming shape), a message text, metadata, auth and settings.
- **Status** — the sixteen gRPC status codes, by name. A non-OK status is a *result*, not an error.

## 3. Functional scope

### 3.1 Import

The unified Import dialog gains a **Protocol Buffers (gRPC)** format, auto-detected from `syntax = "proto3"`, a
`service`/`message` keyword, or a `.proto` file name. Sources: a URL (the root file and, transitively, the relative
imports beside it), a file (a `.proto` inside a project folder or picked through Browse…; its imports are read from
beside it and from the common ancestor directory), or pasted text. Bundled `google/protobuf/*` imports never need
to be on disk. The dialog takes an optional name, a target and a TLS toggle, and whether to cache the files. The
summary names the services, methods, files and deprecated methods. Each service becomes a folder; each method a
request seeded with a sample message of its input type.

### 3.2 Editor

A path line (Project / API / folder… / Request, with the streaming-shape badge), then a strip with the **method**
(a select grouped by service over the cached definition, or two plain fields for an API without one), the
**resolved target** with where it came from, and **Send**/**Cancel**. Tabs: **Message** (Monaco JSON, *Reset to
sample*, the input type and the one-or-many hint), **Metadata** (the request's rows, with the API's and the
transport's greyed under them), **Auth** (the shared form, inheriting request → folder → API), **Settings**
(deadline, max response size, property escaping, `trustInvalid`, bind address). `Mod+Enter` sends,
`Mod+S` saves the staged edits, Escape cancels an in-flight call.

### 3.3 Response

A status line — `OK (0) · 12 ms · 3 messages · 1.2 KB`, coloured by status, noting a trailers-only reply, an HTTP
status mapped to a gRPC one, or a deadline enforced locally — then **Messages** (each decoded reply with its size, or
its bytes and why it did not decode), **Metadata** (headers and trailers apart), **Timing**, **TLS** and **Raw**.

### 3.4 Send

`POST /<service>/<method>` over HTTP/2 with `content-type: application/grpc+proto`, `te: trailers`, `grpc-timeout`
when a deadline is set, and `accept-encoding` for gzip and deflate replies. Messages are length-prefixed frames;
the status is read from the trailers, or from the headers of a trailers-only reply, or mapped from a non-200 HTTP
status; a deadline that passes locally yields `DEADLINE_EXCEEDED` with source `local`. Metadata and message text
expand `${…}` property references (the escaping setting quotes an expanded value as JSON text). Auth adds an
`authorization` header for Basic, Bearer and OAuth2 and a header or a metadata entry for an API key; NTLM is
refused with a readable error.

### 3.5 Everywhere else

The explorer shows a gRPC API with a **gRPC** badge, folders and requests with `RPC`/`RPC↓`/`RPC↑`/`RPC↕` badges,
drag-and-drop inside the API, rename, duplicate and delete. The API tab edits the target, TLS, metadata, auth and
shows the cached files with view and export. Environments override a target under the API's slug, the same slot a
REST base URL uses. History records `kind: grpc` with the status, the request and response messages and the
trailers; search finds a request by service, method or message text; the Code slide-over and *Copy as Command*
produce a `grpcurl`-style line. Commands: `grpc.send`, `grpc.copyAsCommand`, `grpc.importProto`, `grpc.newApi`,
`grpc.newRequest`.

## 4. Data model and project format

```
apis/<slug>/
  api.yaml                          kind: grpc, name, target, tls, metadata, auth?, definition?
  definition/
    manifest.yaml                   kind: proto, source, fetchedAt, roots, files (path, size, sha256)
    protos/<import path>            every .proto, at the path the compiler would import it by
  <folder-slug>/folder.yaml
  <request-slug>.request.yaml       kind: grpc, service, method, methodKind, metadata, auth, settings, message (file)
  <request-slug>.body.json          the message text
```

In memory a `Project` carries `grpcApis: GrpcApi[]` beside `apis` and `interfaces`. That is a **deviation from
ADR-0007's single `apis` list**, made so the compiler forces a third branch everywhere the other two are handled
rather than letting a `kind` check be forgotten; ADR-0007 records it. `formatVersion` stays at 3: a version-3
project with no gRPC API is unchanged, and an older build that meets `kind: grpc` still refuses it by name.

## 5. Engine (`packages/engine/src/grpc/`)

`model.ts` (types and factories), `proto/load.ts` (a `.proto` set from in-memory sources with import resolution),
`proto/describe.ts` (services, methods, message shapes), `proto/sample.ts`, `proto/well-known.ts`, `codec.ts`
(JSON ↔ bytes), `framing.ts`, `status.ts`, `target.ts`, `send.ts` (`sendGrpc` over `node:http2`), `call.ts`
(`callGrpc`: encode, send, decode), `expand.ts`, `cache.ts`, `import.ts`, `command.ts`. The browser-safe subpath
`@wirebench/engine/grpc` exposes the model helpers, the status names and the target parser.

## 6. Main process

Channels `request.sendGrpc`, `request.preflightGrpc`, `api.importProto`, `api.grpcDefinition`, `api.grpcSample`;
`request.curl` and `request.cancel` dispatch on what the id names. `project.mutate` gains the `*-grpc-api` and
`*-grpc-request` changes; folder and move changes dispatch to the gRPC tree by id. The project host caches one loaded
`ProtoSet` per API and serves the definition-card channels from the proto cache. History gains `recordGrpcSend`.

## 7. Renderer

`features/grpc-editor/` (editor, call strip, message/metadata/settings tabs, response pane, badge),
`features/grpc-api/` (the API tab), explorer node kinds `grpc-api` and `grpc-request`, the `proto` import format,
history and search branches, and drafts staged per request like REST's.

## 8. Testing

Unit: framing, status, target parsing, `.proto` loading and description, sample generation, codec round trips over
every scalar, map, oneof, enum and well-known type, project format round trip and rename, import summary, command
line. Integration: an in-process HTTP/2 gRPC server speaking the greeter fixture — unary, server, client and
bidirectional streams, trailers-only errors, gzip, deadlines, TLS, metadata echo, cancellation. Desktop: mutations,
the send path, the editor, the response pane, the send store, explorer nodes and menus. e2e: import → call → files
on disk, and axe over the editor.

## 9. Boundaries

Not built: ~~server reflection~~ (built 2026-09-17, see
`docs/specs/2026-09-17-grpc-server-reflection-design.md`), gRPC-Web, interactive bidirectional streaming, a
schema-driven form view, streaming replies shown before the call ends, resend and diff from History for gRPC
entries, a Query view over messages.

## 10. Success criteria

1. **Model and format.** A project with a gRPC API, folders and requests saves and reopens byte-identically;
   renaming a request touches its two files; the `.proto` cache reloads to the same services.
2. **Codec.** Every field shape of the greeter fixture round-trips JSON → bytes → JSON; a wrong field or value is
   refused naming its path.
3. **Send.** Every streaming shape reaches the test server and back; a non-OK status is shown as a result with its
   message; deadlines, gzip, TLS, metadata and cancellation behave.
4. **Import.** The greeter fixture imports from a folder, a file, text and a URL with one folder per service and a
   sample per method; the cache is byte-identical.
5. **Shell.** The explorer, editor, API tab and import dialog work end to end and pass the axe gate; SOAP and REST
   suites are green unchanged.
6. **Everything else.** History, search, environments and the command line carry gRPC.
