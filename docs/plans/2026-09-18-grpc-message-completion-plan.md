# Plan: JSON completion from the gRPC message descriptor

Builds `docs/specs/2026-09-18-grpc-message-completion-design.md`. Every wave keeps
`WIREBENCH_SKIP_PERF=1 pnpm check` green; the engine ships first so each layer builds on a tested one.

## Wave 1 — Engine: the two pure halves

- `json/cursor.ts`: `jsonCompletionContextAt(text, offset)` — a character scan keeping a stack of
  containers, answering the path of object keys to the cursor, the partial key, the range to replace,
  whether it is quoted, and the keys already in the object. An array index is not a segment; a map key is.
  Exported on its own `@wirebench/engine/json` subpath, which imports nothing.
- `grpc/proto/describe.ts`: `describeMessageAt(set, rootType, path)` — the walk down that path, following a
  message field, consuming a map's user-named key, and refusing a well-known type whose JSON is its mapping
  rather than its fields.
- `packages/engine/test/unit/json/cursor.test.ts` and `test/unit/grpc/describe-at.test.ts`: every fixture a
  document no parser would accept, since that is the only kind the provider is ever asked about.

## Wave 2 — IPC: one channel

- `shared/wire-types.ts`: `apiGrpcFieldsRequestSchema` / `apiGrpcFieldsResponseSchema` and the field shape.
- `shared/ipc.ts`: `api.grpcFields`.
- `main/project-host.ts` `grpcFields`, through `project-router.ts` and `workspace-service.ts`; the handler in
  `main/ipc/api.ts`, where a path resolving to nothing answers no fields rather than an error.
- `apps/desktop/test/ipc-api.test.ts`: both of those answers.

## Wave 3 — Renderer

- `editor/json-completion.ts`: the registry keyed by model URI, `buildFieldCompletionItems` (the insert
  snippets, the detail, the documentation, and the two omissions — a key already held and the rest of a
  spoken `oneof`), and the once-guarded provider registration.
- `editor/grpc-completion-source.ts`: the `api.grpcFields` binding, with its per-path cache.
- `features/grpc-editor/message-tab.tsx`: registers for its own model, keyed on the request type so a method
  change follows; `grpc-editor.tsx` passes the API id.
- `apps/desktop/test/renderer/json-completion.test.ts` for the pure half, and
  `grpc-message-completion.test.tsx` driving the registered provider — which is the only way to show that a
  JSON editor with no source registered gets nothing.

## Wave 4 — Docs, e2e and the gates

- `e2e/specs/grpc-completion.spec.ts`, asking for Monaco's suggest overlay and falling back to the channel
  the provider itself calls, as `editor.spec.ts` does for XML.
- The spec and this plan; `docs/success-criteria.md` row SC-G9; `docs/roadmap.md`; `CHANGELOG.md`; the gRPC
  spec's §9 boundaries and the streaming spec's §6 note that completion was the next piece of work.
- `WIREBENCH_SKIP_PERF=1 pnpm check`, `pnpm build && xvfb-run -a pnpm test:e2e`, `pnpm test:perf` unskipped.
