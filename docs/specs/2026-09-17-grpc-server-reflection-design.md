# Spec: gRPC server reflection

- Status: **implemented** (2026-09-17). Built by `docs/plans/2026-09-17-grpc-server-reflection-plan.md`; evidence
  per criterion is in `docs/success-criteria.md`, row SC-G7.
- Date: 2026-09-17
- Builds on: the gRPC client design (`docs/specs/2026-09-16-wirebench-grpc-client-design.md`, whose §9 listed
  server reflection as deliberately not built and whose transport this reuses unchanged), ADR-0003 (project folder
  format), ADR-0005 (path safety), ADR-0007 (APIs beside interfaces), and `docs/roadmap.md` item 17.

## Assumptions I'm making

1. **A discovered schema is the same thing as an imported one.** What a server sends is the compiler's own output —
   `FileDescriptorProto`s — rather than `.proto` text, but once resolved it is a `ProtoSet` like any other, so
   `describeServices`, the codec, the sample generator and `apiFromProtoSet` are reused unchanged and a discovered
   API is indistinguishable downstream from an imported one.
2. **Both protocol versions are spoken, and the choice is the user's.** `grpc.reflection.v1` is the stable package;
   `grpc.reflection.v1alpha` is what servers shipped for years, and many still serve only that. The default is
   automatic — v1, falling back to v1alpha on `UNIMPLEMENTED` — and the version is recorded on the API so a later
   refresh asks the same way. Pinning one is for a server that answers both and answers one of them badly.
3. **The batch transport is enough.** `ServerReflectionInfo` is declared as a bidirectional stream, but the exchange
   is request/response per message and the client always knows what to ask for before it asks, so the whole
   discovery resolves as a short sequence of ordinary `sendGrpc` calls. No transport change (§3).
4. **A discovery is a call.** It goes through the same target parsing, TLS trust, credentials and deadline a send
   does, because a server that needs a private CA or a header to answer a call needs the same to describe itself.
5. **Nothing is ever deleted on a refresh.** A method the server no longer declares keeps its saved request, badged
   orphaned, exactly as "Update Definition" treats a vanished WSDL operation.
6. **UI copy never names other tools.**

---

## 1. Objective

**What.** Point Wirebench at a running gRPC server and get the same API an import of its `.proto` files would give:
a folder per service, a request per method, each seeded with a sample message, and a schema the editor and the
codec can work against. Then ask the server again whenever it has moved on.

**Why.** Without it, a user who does not have the `.proto` files cannot start at all — and not having them is the
common case for a server someone else runs.

**Not this.** gRPC-Web, reflection over a non-gRPC transport, and a discovery that replaces the user's edits.

## 2. The rounds

One `sendGrpc` call per round, each opening its own stream:

1. `list_services` — the service names the server exposes. Reflection's own services are dropped from the result:
   an API with a folder for `ServerReflection` would be noise.
2. One `file_containing_symbol` per service, all on one stream. A well-behaved server answers each with the file
   declaring the service *and* its transitive dependencies.
3. Whatever dependency is still missing, by `file_by_filename`, until nothing new arrives or a round cap is
   reached — so a server that answers one dependency with another cannot keep the client asking forever.

What comes back is kept exactly as sent. A file's own name and its `dependency` list are read out of each
descriptor with a partial message declaring only fields 1 and 3: protobuf's unknown-field rule makes that a cheap,
complete read of a header, so the engine needs no copy of `descriptor.proto` to key a file and follow its imports.

## 3. Engine

- `grpc/reflection/proto.ts` — the reflection service as an embedded `.proto` string, one template with the package
  substituted so the two versions cannot drift, loaded through the same `loadProtoSet` a user's own files go
  through. A string constant rather than a shipped file: the engine builds with `tsc -b` alone and has no asset
  copy step.
- `grpc/reflection/client.ts` — `reflectServices` drives the rounds; `reflectProtoSet` resolves what they collected
  into a loaded schema. Both take the transport half of `GrpcSendInput`, so trust, credentials, deadline and
  cancellation behave exactly as they do for a call the user sends by hand.
- `grpc/reflection/descriptors.ts` — `FileDescriptorSet` handling: ordering files so every file follows the ones it
  imports (protobufjs resolves as it adds), wrapping them without re-serialising a byte, and `Root.fromDescriptor`
  from protobufjs's `ext/descriptor` extension.
- `grpc/reconcile.ts` — `reconcileGrpcApi` brings an existing API in line with a schema it has been given again:
  adds a request for a method it does not have, badges one whose method is gone, un-badges one that came back,
  corrects a streaming shape that changed, and touches nothing the user edited. Not reflection-specific; a
  re-import from files will want the same function.

## 4. Cache and model

`GrpcDefinitionRef` gains `kind: 'proto' | 'reflection'`, absent meaning `proto` so every project written by the
current build still loads, plus the reflection version and the trust decision a refresh has to repeat.

A discovered schema is cached as one binary `FileDescriptorSet` beside a manifest saying `kind: descriptors` — a
sibling of the `.proto` cache rather than a variant of it, on the same contract: nothing is re-serialised, the
SHA-256 is recorded so corruption is noticed rather than parsed, and an export is byte-identical to what the server
sent. Writing either cache removes the other: an API has one definition.

## 5. Desktop and UI

Reflection reuses the whole import pipeline rather than adding a parallel one. `protoSourceSchema` gains a fifth
member carrying the target, TLS, version and trust decision; `ProtoImportService.read` returns a discriminated
result — sources or descriptors — and `run` picks `importProto` or `apiFromProtoSet`, so the token, the progress
events, cancellation and the summary screen all work unchanged.

The Import dialog's gRPC format gains a **Server** tab: an address, the version, and "ask even if the certificate
does not verify". The gRPC API tab's Definition card has two forms — an imported API reads and exports its files as
before; a discovered one offers **Refresh from server** and the version it asks with, and says afterwards what
changed.

## 6. One consequence handled

`grpcToCommand` names `.proto` files with `-proto`. A discovered API has none on disk, and grpcurl uses reflection
by default, so that branch drops the flags and the note says why rather than naming files that do not exist.

## 7. Testing

The in-process test server's dispatch is keyed by service so it can host reflection beside the greeter fixture, in
either version or both, and answer from descriptors protobufjs produced rather than from the client's own code.
Integration tests cover both versions, the automatic fallback, a server that withholds its transitive dependencies,
a round cap, and a server that refuses reflection. Desktop tests cover the import service, the descriptor cache,
the refresh and the channel; renderer tests cover the dialog tab and the card; e2e discovers a server and calls a
method off what it found.

## 8. Boundaries

Not built: gRPC-Web, reflection over a connection the user did not name, `all_extension_numbers_of_type`, a preview
of what a refresh would change before it is applied, and reading a discovered schema back as `.proto` text — there
is no printer for that, so the card exports the descriptor set instead.

## 9. Success criteria

1. **Discovery.** A server that speaks either reflection version yields the same folder-per-service,
   request-per-method API an import of the same files yields; the automatic default resolves to the version that
   answered; a server that speaks neither is refused by name.
2. **Dependencies.** A server that answers with a file alone is chased for its imports until the set resolves; one
   that never supplies them is reported naming the files that are missing.
3. **Cache.** The descriptor set is stored byte-identical beside a `kind: descriptors` manifest, reloads to the
   same services after a reopen, and leaves no `.proto` cache behind.
4. **Refresh.** Asking again reconciles the tree without deleting anything, and an API imported from files says
   plainly that there is no server to ask.
5. **Shell.** The Import dialog's Server tab and the API tab's card work end to end; the grpcurl line names no
   files that do not exist.
