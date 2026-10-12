# Branching in sequences — plan

Spec: `docs/specs/2026-10-11-sequence-branching-design.md`. Issue #347. One commit per task, each after
`NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check` is green.

1. **Model and file format** (`packages/engine/src/sequence/model.ts`, `file.ts`). `BranchRule`, `BranchCondition`,
   `SequenceStep.branches`, `SEQUENCE_VERSION = 2`, limits `branchesPerStep`, `branchMax`, `branchDelayMs`,
   `stepRuns`. Parse `branches` (max required for goto/repeat, forbidden on skip-next, goto target exists), read
   version 1 and 2, write 2 only with branches. Regenerate the project JSON Schemas.
   Tests: round-trip, invalid shapes, unknown target, version written, v3 refused.
2. **Runner** (`run.ts`, new `branch.ts`). Cursor loop; condition evaluation through `evaluateAssertions`; goto,
   repeat, skip-next; per-rule counts, limit reached, run limit, delay with abort; `attempt`, `retried`, `branch`,
   `skipped: 'branch'`; outcome over the last result of each step; branch wins over stop-on-failure.
   Tests: poll until ready, fallback on errored send, skip-next, limit reached carries on, run limit, cancel during delay.
3. **CLI** (`packages/cli/src/commands/sequence.ts`, reporters). Retried attempt → `skipped` + `retried`, attempt
   path suffix, `branch` text on the cli line, JSON and HTML fields.
   Tests: reporter output and summary counts for a polled step.
4. **Desktop wire and main** (`shared/wire-base.ts`, `main/project-sequence-mutations.ts`,
   `main/sequence-runner.ts`). Branch wire schema both ways, result fields, send id with attempt.
   Tests: mutation round-trip, runner wire mapping.
5. **Desktop run panel** (`state/sequence-runs.ts`, `features/sequence/run-panel.tsx`). Ordered results, attempt
   and path lines. Tests: renderer.
6. **Desktop editor** (`features/sequence/branch-list.tsx`, `sequence-tab.tsx`). Branches list, removal of
   dangling rules when a step is removed. Tests: renderer.
7. **Docs and changelog**. Sequences reference page, CHANGELOG `[Unreleased]` entry.

Before push: `pnpm build`, `pnpm test:perf`. No local Electron e2e.
