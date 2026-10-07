# Plan: Policy-driven WS-Security configuration

Spec: [`docs/specs/2026-10-07-wss-policy-config-design.md`](../specs/2026-10-07-wss-policy-config-design.md)
Issue: [#58](https://github.com/wirebench/wirebench/issues/58)

**Goal:** Read a WSDL's WS-SecurityPolicy, propose an outgoing WS-Security configuration in one click, and
show whether the request satisfies the policy.

**Architecture:** engine `wss/policy/detect.ts` (DOM → `WssPolicy` per operation, at import) and
`wss/policy/plan.ts` (pure propose + check + describe). The policy travels on
`OperationSummaryWire.wssPolicy`; main answers `wss.policyStatus`; the Auth inspector renders summary,
Apply and badge.

## Global constraints

- Gate before every commit: `WIREBENCH_SKIP_PERF=1 pnpm check`; `pnpm test:perf` before the push.
- One commit per task, as Mohammed Naami <m.naami@outlook.com>, no trailers.
- No local Electron windows; CI runs e2e.
- #57 (WS-Security debugger) runs in parallel: touch only the files named here.

## Tasks

### Task 1 — Fixture and policy detection

- `fixtures/wsdl/crafted/ws-security-policy/service.wsdl`: bindings `TransportUtBinding` (TLS + hashed
  UsernameToken, timestamp), `AsymmetricBinding` (X509 thumbprint, Basic256Sha256, signed Body + header,
  encrypted Body, policy by `#id`; operation `Secure` adds an input-level `EncryptBeforeSigning` policy),
  `AlternativesBinding` (ExactlyOne), `SymmetricBinding`, `PlainBinding`.
- `packages/engine/src/xml/namespaces.ts`: `SP`, `SP_2005`.
- `packages/engine/src/wss/policy/model.ts`: `WssPolicy` types (pure).
- `packages/engine/src/wss/policy/detect.ts`: `detectWssPolicy(definition, binding, operation)` and
  `summarizeWssPolicy(definition)` → `Record<key, WssPolicy>`.
- `soap/types.ts` + `soap/import.ts`: `WsdlImportResult.wssPolicy`. Export from `index.ts`.
- Tests: `packages/engine/test/unit/wss/policy-detect.test.ts`.

**Done:** each fixture binding yields the expected summary; plain yields none.

### Task 2 — Proposal and check

- `packages/engine/src/wss/policy/plan.ts`: `proposeWssEntries(policy)` → `{ entries, notes }`;
  `checkWssPolicy(policy, entries, endpointUrl)` → `{ satisfied, results[] }`.
- Exported from the engine's main entry.
- Tests: `packages/engine/test/unit/wss/policy-plan.test.ts` (each suite mapping, order, parts, every
  unmet reason, proposal of a policy checks as satisfied once keystores are filled).

**Done:** proposal of each fixture policy, with keystores filled, satisfies its own check.

### Task 3 — Wire

- `apps/desktop/src/shared/wire-types.ts`: `wssPolicyWireSchema`; optional `wssPolicy` on the operation
  summary.
- `apps/desktop/src/main/engine-wire.ts`: copy `result.wssPolicy[key]` onto each operation.
- Test in the existing engine-wire unit test.

### Task 4 — Inspector: summary, Apply, badge

- `wss.policyStatus` channel: `ProjectHost.wssPolicyInputs` (policy, selected entries, endpoint), routed
  through `ProjectRouter`/`WorkspaceService`; `main/ipc/wss.ts` runs describe/check/propose.
- `apps/desktop/src/renderer/features/request-editor/wss-policy.ts`: `applyWssPolicy(requestId, proposal)` (D4) and
  `mergeProposal(existing, proposed)`.
- `apps/desktop/src/renderer/features/request-editor/inspectors/wss-policy-panel.tsx`: summary, notes,
  Apply button, badge with unmet list; rendered in the Auth inspector above the WSS selectors when the
  request's operation has a policy.
- Tests: channel handler unit test; merge unit test; panel component test (render, apply calls the store,
  badge flips).
- Docs: user docs page for WS-Security gets a "From the WSDL's policy" section; CHANGELOG entry.

**Done:** `pnpm check` green; PR opened.
