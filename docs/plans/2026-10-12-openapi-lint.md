# OpenAPI linting — plan

Spec: `docs/specs/2026-10-12-openapi-lint-design.md` · Issue #342. Before each commit, run
`NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check`.

1. **Engine runner, hygiene rules and reference fence.** Add the dependencies (the telemetry package
   goes in `neverBuiltDependencies`), and add `rest/openapi/lint/{model,rules,run,resolver,hygiene}.ts`.
   Fixtures go in `test/fixtures/lint/` for 2.0, 3.0, 3.1 and 3.2 (clean and noisy). Tests cover each
   hygiene rule, the 1.x refusal, finding order and 1-based ranges. They also cover the fence: a
   traversal outside the folder, a file root reaching a remote host, and `allowRemoteRefs`.
   (Planned as two tasks; done as one, because the runner cannot run without the resolver.)
2. **OWASP rules.** Add `owasp.ts` with the five rules from spec §4, including the loopback
   exemption and 2.0 `schemes`, with a test for each.
3. **Project rule sets.** Add `ruleset.ts`: the zod schema, `builtin` selection, severity overrides,
   compiling targets and checks, patterns batched onto the regex worker, and the merge order. Tests
   cover each check, each kind of invalid file, and a pattern that backtracks.
4. **Reports.** Add `report.ts`: the JSON report, SARIF 2.1.0 and the summary counts, exported from
   the engine index. Tests check the SARIF shape against the 2.1.0 fields that code scanning needs.
5. **CLI `wirebench lint`.** Add the args (`args-lint.ts`), the command, help and `HELP_TOPICS`,
   `project:<name>`, `lint/` loading, the reporters and the exit codes. Tests use `main` with captured
   I/O.
6. **Desktop.** Add the `api.restLint` channel and its wire schema, the main handler (cache plus
   project `lint/`), the Problems store's `lint` source and breadcrumb, the `rest.lintDefinition`
   command and its catalog entry, and lint after an import or an applied update. Unit tests cover the
   store, the handler and the command gate; run `pnpm docs:commands`.
7. **Docs.** Update `docs/cli.md` (the verb, the rule tables and the rule-set format), the docs-site
   `run-in-ci.mdx` section, CHANGELOG [Unreleased] and THIRD-PARTY-LICENSES (`pnpm
   licenses:third-party`).

Then `pnpm build` (including the desktop, because of the "import" string trap) and `pnpm test:perf`,
then push and open the PR.
