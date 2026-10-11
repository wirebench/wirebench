# Run control from scripts — plan

Spec: `docs/specs/2026-10-11-script-run-control-design.md`. Issue #335.

Each task is test-first and ends in one commit, made after
`NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check` is green.

## 0. Decision: spec, plan, ADR-0016 update

- The spec and this plan.
- ADR-0016 gets an update section for 2026-10-11 that records the decision and the new consequences.

## 1. Sandbox: `execution` and `control`

- `api/prelude.ts`:
  - `execution.setNextRequest` and `execution.skipRequest`;
  - `state.control`;
  - `__finish` hands back `control`;
  - validation and the post-phase refusal.
- `script/model.ts`: `ScriptControl`, and `control?` on the successful `ScriptOutcome`.
- `script/run.ts`: the zod schema for `control` (strict, `next` ≤ 256 or null). `control` is dropped on failure.
- `types/api.ts`: `declare const execution` in COMMON. Regenerate the API reference with `pnpm docs:script-api`.
- `api/postman.ts`: the three Postman calls are built on `execution`.
- Tests:
  - the prelude, `runScript` and the Postman layer;
  - escape tests: a forged `__finish` with extra keys, a non-string `next`, an over-long name, or `__proto__`;
  - a failing script hands back no control.

## 2. Session: carry or ignore directives

- `run/script-support.ts`:
  - `ScriptSessionOptions.runControl`;
  - the `ScriptSkipped` error;
  - `SentScripts.control`;
  - the ignore log line.
- `run/run.ts`: `deferredSession` passes `runControl`. `createRunSender` overrides take `runControl`.
- Tests:
  - the chain stops on skip;
  - last-wins across levels and phases;
  - with `runControl` off, the directive is ignored and a log line is written.

## 3. Runner: obey directives

- `runRequests` walks by index. It handles `ScriptSkipped`, `next` (forward, backward, null, unknown) and
  `RUN_CONTROL_LIMITS.jumps`.
- `RequestResult.control`.
- Error codes `script-next-unknown` and `script-jump-limit` in `errors.ts`.
- Tests:
  - every branch;
  - bail and abort inside a loop;
  - a name outside the selection sends nothing;
  - a loop of skips is held by the cap;
  - integration: a polling loop against a local server.

## 4. Reporters

- CLI, JSON, JUnit and HTML show `control`.
- Tests: one per reporter.

## 5. Importer and docs

- `rest/postman/map.ts`:
  - `runControlCalls` and its note;
  - the run-control calls are dropped from `UNSUPPORTED_CALLS`;
  - the `pm.sendRequest` wording.
- Docs:
  - `guides/scripts.mdx` gets a run control section;
  - `switching/postman.mdx` gets the row update;
  - `docs/cli.md` gets the report lines;
  - CHANGELOG.
- Tests: importer warnings and notes.
