# Plan: gRPC server reflection

Builds `docs/specs/2026-09-17-grpc-server-reflection-design.md`. Every wave keeps
`WIREBENCH_SKIP_PERF=1 pnpm check` green; the engine ships first so the desktop work builds on tested pieces.

## Wave 1 — Engine: the reflection client

- `packages/engine/src/grpc/reflection/proto.ts`: the service as an embedded `.proto` template, both packages, plus
  the partial `FileDescriptorProto`/`FileDescriptorSet` headers the client reads names and imports with.
- `packages/engine/src/grpc/reflection/descriptors.ts`: dependency ordering, `FileDescriptorSet` encoding without
  re-serialising, and `Root.fromDescriptor` through protobufjs's `ext/descriptor`.
- `packages/engine/src/grpc/reflection/client.ts`: `reflectServices` (the three rounds, the version fallback) and
  `reflectProtoSet` (resolve into a `ProtoSet`).
- `packages/engine/test/helpers/test-grpc-server.ts`: dispatch keyed by service so it can host reflection; the
  descriptors come from `test-grpc-reflection.ts`, which reads the greeter set back out with protobufjs's own
  `toDescriptor` and reconstructs the `dependency` edges it drops.
- Unit tests in `packages/engine/test/unit/grpc/reflection.test.ts`, integration in
  `packages/engine/test/integration/grpc/reflection.test.ts`.

## Wave 2 — Engine: model, cache, reconcile

- `grpc/model.ts`: `GrpcDefinitionRef.kind`, `reflectionVersion`, `trustInvalid`; `project/schema.ts`, `load.ts`
  and `serialize.ts` carry them, defaulting an absent `kind` to `proto`.
- `grpc/cache.ts`: `writeDescriptorDefinitionCache` / `readDescriptorDefinitionCache` beside the `.proto` pair, and
  `readGrpcDefinitionCache` to hand a caller whichever it found; each write removes the other form.
- `grpc/reconcile.ts` and `packages/engine/test/unit/grpc/reconcile.test.ts`.

## Wave 3 — Desktop main

- `shared/wire-types.ts`: the fifth `protoSource` member, the summary's `kind`, the definition response's `kind`,
  and the `api.grpcRefresh` request and response; the channel in `shared/ipc.ts`.
- `main/proto-import.ts`: the discriminated read result and the `reflection` branch, with the TLS material injected
  so a test needs no preferences.
- `main/project-host.ts`: `grpcProtoSetFor` and the definition readers branch on the cache kind; `addGrpcApi` takes
  a discriminated definition; `refreshGrpcDefinition` re-discovers, rewrites the cache and reconciles.
- `main/ipc/api.ts`, `project-router.ts`, `workspace-service.ts`, `main/index.ts`;
  `apps/desktop/test/proto-import-reflection.test.ts`, `project-grpc-reflection.test.ts`, `ipc-api.test.ts`.

## Wave 4 — Renderer

- The Import dialog's **Server** tab (address, version, trust), offered only for the gRPC format.
- `features/grpc-api/grpc-definition-card.tsx`: the imported card as before, or **Refresh from server** with its
  version selector and outcome line.
- `state/project.ts`: `refreshGrpcDefinition`.
- `apps/desktop/test/renderer/import-reflection-dialog.test.tsx`, `grpc-definition-card.test.tsx`.

## Wave 5 — Docs, e2e, gates

- This plan, the spec, `docs/success-criteria.md` row SC-G7, `docs/roadmap.md` item 17, `CHANGELOG.md`, and the
  gRPC spec's §9 boundaries line with server reflection struck from it.
- `e2e/specs/grpc-reflection.spec.ts`: discover the test server, then call a method off what was found.
- `WIREBENCH_SKIP_PERF=1 pnpm check`, then `pnpm build && xvfb-run -a pnpm test:e2e`, then `pnpm test:perf`.
