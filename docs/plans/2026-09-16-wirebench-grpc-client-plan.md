# Plan: gRPC client

Builds `docs/specs/2026-09-16-wirebench-grpc-client-design.md`. Every wave keeps `WIREBENCH_SKIP_PERF=1 pnpm check`
green; the engine ships first so the desktop work builds on tested pieces.

## Wave 1 — Engine: model, `.proto` loading, codec

- `packages/engine/src/grpc/model.ts`, `status.ts`, `framing.ts`, `target.ts`.
- `packages/engine/src/grpc/proto/{load,describe,sample,well-known}.ts` on `protobufjs` with in-memory import
  resolution and the bundled `google/protobuf/*`.
- `packages/engine/src/grpc/codec.ts`: canonical JSON both ways; validation names the field path.
- Fixtures under `fixtures/proto/crafted/`; unit tests under `packages/engine/test/unit/grpc/`.

## Wave 2 — Engine: transport

- `send.ts` over `node:http2` (framing, trailers, trailers-only, HTTP status mapping, deadlines, compression, TLS
  capture, cancellation); `call.ts` ties codec and transport together.
- `packages/engine/test/helpers/test-grpc-server.ts`: an in-process server speaking the greeter fixture, shared
  with the e2e suite; integration tests under `packages/engine/test/integration/grpc/`.

## Wave 3 — Engine: project format, import, history, command line

- `project/schema.ts` accepts `kind: grpc`; `load.ts`/`serialize.ts`/`save.ts` read and write the third container;
  `history.ts` records it; `send-options.ts` resolves the ladder for a gRPC send.
- `cache.ts`, `import.ts` (folder per service, request per method), `expand.ts`, `command.ts`;
  `import-detect.ts` recognises `.proto`.

## Wave 4 — Desktop main

- Wire types and channels; `project-grpc-mutations.ts`; `grpc-send.ts`; `proto-import.ts`; project host, router
  and workspace service; history, search and unsaved drafts carry gRPC; `request.curl` dispatches on the id.

## Wave 5 — Desktop renderer

- Stores (project mirror, drafts, exchanges, editors, tabs); explorer nodes, menus, drag-and-drop and actions;
  `features/grpc-editor/` and `features/grpc-api/`; commands; the `proto` import format; history, search, Code
  panel and endpoints table branches.

## Wave 6 — Docs, e2e, gates

- This plan and its spec; ADR-0007 update; `docs/success-criteria.md` rows SC-G1–SC-G6; roadmap item 17; README;
  changelog. `e2e/specs/grpc.spec.ts` and the gRPC case in `e2e/specs/a11y.spec.ts`. `pnpm check` and
  `pnpm test:perf` green before the push.
