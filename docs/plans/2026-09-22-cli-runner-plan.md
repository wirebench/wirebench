# Plan: CLI runner slice S7 — gRPC unary and OAuth2 client credentials

Spec: `docs/specs/2026-09-22-cli-runner-design.md`. One commit per task, each after
`NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check` is green.
Engine changes are additive only.

## Task 1 — gRPC status in the assertion catalogue

- Files: `packages/engine/src/assert/model.ts`, `assert/schema.ts`, `assert/status.ts`,
  unit tests beside the existing assertion tests.
- Interfaces: `AssertionSubject['protocol']` gains `'grpc'`; `statusValue` accepts int 0–16 and a
  gRPC status name (the values of `GRPC_STATUS_NAMES`); `evaluateStatus` compares a gRPC subject's
  code against numbers and names, errors on a name for a SOAP/REST subject.
- Tests: pass/fail by code, by name, mixed list, name on REST errors, schema rejects an unknown
  name and 17.

## Task 2 — OAuth2 client-credentials token source for runs

- Files: new `packages/engine/src/run/oauth2-token.ts`; `run/prepare.ts` (REST path),
  `run/run.ts`, `run/index.ts` / `src/index.ts` exports; unit tests.
- Interfaces: `createRunTokenSource({ getSecret, send?, now?, onSecretValue? })` →
  `accessTokenFor(config: OAuth2Auth, opts: { scopes, tls?, proxy?, timeoutMs?, signal? })`;
  `RunContext` gains optional `onSecretValue` and `fetchToken`. The token source is created once per
  `runRequests` call and reaches `prepareSend` through the context. Client-credentials →
  bearer token via `resolveAuthConfig(…, { accessToken })`; authorization-code keeps
  `auth-grant-unsupported`.
- Tests: fetch + bearer header, cache hit (one token request for two sends), re-fetch after expiry,
  failed fetch not cached, `secret-missing` for the client secret, token URL expanded,
  `onSecretValue` called with the token.

## Task 3 — gRPC unary requests in selection, preparation and the run

- Files: `run/select.ts`, `run/effective-auth.ts`, `run/secret-needs.ts`, `run/prepare.ts`,
  `run/run.ts`; unit + integration tests using `test/helpers/test-grpc-server.ts`.
- Interfaces: `SelectedRequest` grpc member; `grpcEffectiveAuth`; `PreparedSend` grpc member;
  `RequestResult['protocol']` gains `'grpc'`; per-run proto set cache via `readGrpcDefinitionCache`
  + `loadProtoSet` / `protoSetFromDescriptorSet`; `grpcSubject` (status = gRPC code, body = decoded
  JSON); OAuth2 through Task 2's token source.
- Tests: selection order/paths/unary-only/orphaned; secret needs; passing call; failing status;
  JSONPath match; `grpc-definition-missing`; `--timeout`; client-credentials on a gRPC call.

## Task 4 — CLI: reporters, masking, fixture, docs

- Files: `packages/cli/src/commands/run.ts`, `src/reporters/*.ts` (protocol type), fixture project
  (`test/fixtures/runner-project/apis/…` gRPC API with cached proto, OAuth-protected REST request),
  `test/integration/*.test.ts`, `packages/cli/README.md`, `CHANGELOG.md`,
  `docs/specs/2026-09-18-cli-runner-design.md` status line, `docs/architecture/` runner page if one
  exists.
- Interfaces: `onSecretValue` feeds the masker's value set.
- Tests: exit 0 all-pass run including gRPC; exit 1 on a failing gRPC assertion; token and client
  secret absent from stdout, stderr and every report; JSON report shows `protocol: "grpc"`.
