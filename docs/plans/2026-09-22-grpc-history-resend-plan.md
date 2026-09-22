# gRPC resend from History — plan

Spec: `docs/specs/2026-09-22-grpc-history-resend-design.md`.

Gate before each commit: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`.
Make one commit per task.

## Task 1: main-process `history.resendGrpc`

Files:
- `apps/desktop/src/shared/wire-types.ts` (additive)
- `apps/desktop/src/shared/ipc.ts`
- `apps/desktop/src/main/ipc/history.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/test/ipc-history.test.ts`

Interfaces:
- Add `historyResendGrpcRequestSchema = z.object({ id: z.string() })`.
- Add the channel `history.resendGrpc` of type `(historyResendGrpcRequestSchema) -> grpcExchangeSummarySchema`.
- Add `HistoryChannelDeps.grpc?: { send(request: RequestSendGrpcRequest, sender: WebContents): Promise<GrpcExchangeSummary> }`.
  `index.ts` wires it to `sendGrpcRequest(engineService, requestDeps, …)`.
- Add a pure helper that is exported and tested:
  `grpcResendDraft(entry): GrpcRequestPatchWire`, which returns `{ service, method, methodKind, message }`.
  - For client-streaming and bidi-streaming, `message` is `JSON.stringify(requestMessages.map(JSON.parse))`, pretty-printed.
  - For unary and server-streaming, `message` is the first message.
  - When there are no messages, `message` is `request.envelopeXml`.

Handler behaviour:
- An unknown id is refused with `unknown-history-entry`.
- An entry whose kind is not `grpc`, or that has no `grpc` block, is refused with `history-resend-unsupported`.
- An entry with no `requestId`, or whose saved request is gone (`project.grpcSend(requestId)` is undefined), is refused with `history-resend-orphan`.
- Otherwise the handler calls `deps.grpc.send({ sendId: randomUUID(), requestId, draft: grpcResendDraft(entry) }, sender)`. The call is not interactive.

Tests:
- The existing `it.each` in `history.resend` still refuses `grpc`, since that channel is SOAP-only.
- New tests:
  - unknown id
  - a SOAP entry refused
  - an orphan refused
  - unary: the draft carries the recorded message
  - client-streaming and bidi: the draft carries a JSON array of all messages in order
  - empty messages fall back to the envelope text
  - errors from `send` propagate

## Task 2: renderer buttons

Files:
- `apps/desktop/src/renderer/features/history/history-actions.ts`
- `history-view.tsx`
- `history-entry-view.tsx`
- `apps/desktop/test/renderer/ws-history.test.tsx`, plus the history-view and history-entry-view tests

Interfaces:
- `canResendHistoryEntry` returns true for `soap` and `grpc`.
- Add `resendHistoryEntry(entry): Promise<void>`. It dispatches to `history.resendGrpc` for gRPC entries and to `history.resend` otherwise.
- The row ↻ and the tab's Re-send button use `resendHistoryEntry`.
- `resendLastHistoryEntry` stays SOAP-only.

Tests:
- The ↻ and Re-send buttons are present on a gRPC row and tab, and they call `history.resendGrpc` with the id.
- They are still absent for REST and WebSocket entries.
- A failure shows a toast with the code.

## Task 3: docs

Files:
- `docs-site/src/content/docs/guides/history.mdx` (resend covers gRPC; how multi-message records replay; orphan refusal)
- `docs-site/src/content/docs/guides/grpc.mdx` (a short History section)
- `docs/roadmap.md` (item 17: the follow-up is done)
