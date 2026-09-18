# Plan: gRPC live streaming and interactive bidirectional send

Builds `docs/specs/2026-09-18-grpc-live-streaming-design.md`. Every wave keeps
`WIREBENCH_SKIP_PERF=1 pnpm check` green; the engine ships first so each layer builds on a tested one.

## Wave 1 — Engine: the hooks and the handle

- `grpc/send.ts`: `onHeaders`, `onMessage` and `onOpen` on `GrpcSendInput`, and `GrpcStreamHandle`
  (`write` / `end` / `isOpen`). The messages actually sent — the input's, then whatever was pushed — become
  `exchange.request.messages` and the `rawRequest` bytes, so the record is the conversation rather than its
  opening. A write after a half-close throws `grpc-stream-closed`.
- `grpc/call.ts`: the same two hooks with the schema applied — `onMessage` decodes through the standalone
  `decodeResponseMessage`, `onOpen` hands over a handle whose `send` takes JSON text and encodes it against the
  request type, appending to `requestMessages`.
- `grpc/shape.ts`: the pure method-kind and target rules moved out of `model.ts` into a leaf with no imports, so
  `grpc/browser.ts` — the renderer's subpath — no longer reaches `project/paths.js` and `node:path` through it.
  `model.ts` re-exports them, so nothing else moved.
- `packages/engine/test/integration/grpc/streaming.test.ts`: every hook records whether the call had already
  resolved when it fired, so "the messages arrived before the call ended" is asserted as ordering rather than
  guessed from timing. The interactive tests drive the test server's existing `Chat` method, which already
  answers as messages arrive.

## Wave 2 — IPC: events out, invokes in

- `shared/wire-types.ts`: `grpcLiveEventSchema` (`open` / `headers` / `message` / `closed`, each carrying the
  `sendId`), the push request/response and the half-close pair, and `interactive` on the send request.
- `shared/ipc.ts`: `events.grpc.live`, `request.grpcPush`, `request.grpcHalfClose`.
- `main/engine-service.ts`: `grpcStreams`, the registry of open handles beside `sends`; `sendGrpcRequest` takes
  `onLive` and `interactive`; `pushGrpcMessage` and `halfCloseGrpc`.
- `main/engine-wire.ts`: `toGrpcResponseMessageWire` extracted, so a live message and a finished one are the same
  shape built by the same code.
- `main/ipc/request.ts`: `sendGrpcRequest` takes the `sender` it was discarding and emits `grpc.live`; the two new
  handlers registered.
- `apps/desktop/test/engine-grpc-stream.test.ts`: what a push and a half-close answer for a call that is not open.

## Wave 3 — Renderer

- `state/exchanges.ts`: `GrpcLiveState` on the gRPC exchange state; `applyGrpcLive` with the correlation guard;
  `sendGrpc(requestId, { interactive })`, `pushGrpcMessage`, `halfCloseGrpc`; `subscribeToGrpcLive`, wired once
  from `app-shell.tsx` beside the other subscriptions.
- `features/grpc-editor/response-pane.tsx`: the tab strip up while the call runs, live messages, the initial
  metadata before the trailers exist, and `StreamComposer` — one more message, or *Half-close*. `MessagesView`
  keyed by index and content, and pinned to the newest message only while the reader is at the bottom.
- `features/grpc-editor/call-bar.tsx`: *Open stream*, offered only for a method whose client streams.
- `apps/desktop/test/renderer/grpc-live-store.test.ts` and the live block in `grpc-response-pane.test.tsx`.

## Wave 4 — Docs, e2e and the gates

- `e2e/specs/grpc-streaming.spec.ts`: a server stream watched filling in (fewer messages on screen mid-call than
  at the end), and a second message pushed into an open bidirectional call.
- The spec and this plan; `docs/success-criteria.md` row SC-G8; `docs/roadmap.md` item 17; `CHANGELOG.md`; the
  gRPC spec's §9 boundaries striking interactive bidirectional streaming and streaming replies.
- `WIREBENCH_SKIP_PERF=1 pnpm check`, `pnpm build && xvfb-run -a pnpm test:e2e`, `pnpm test:perf` unskipped.
