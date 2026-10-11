# Code generation — plan

Spec: `docs/specs/2026-10-11-code-generation-design.md`. Issue #337. Each task is test-first and ends
with one commit, made after `WIREBENCH_SKIP_PERF=1 pnpm check` is green.

1. **Engine targets.** `http/codegen/` model, env markers, string helpers, `generateCode` and all eleven
   targets, over one shared fixture set with one snapshot file per target. (One task: the target
   registry types every id, so the targets cannot land apart.)
2. **REST and SOAP to CodeRequest.** `restCodeRequest`, `soapCodeRequest` and `secretTokensToEnv`, with
   unit tests, exported from the engine index.
3. **Main `request.code` channel.** Wire schema, handler (env-marker placeholder auth, Show secrets,
   redaction, notes), the cURL delegation, the `wirebench run` line, and main tests.
4. **Code panel.** The Language picker, the settings row, persisted per-user `codeTarget` and
   `codeSettings` (migrated from `codeShell`), and renderer tests.
5. **Docs and changelog.** The user docs page for the Code panel, and a CHANGELOG `[Unreleased]` entry.
