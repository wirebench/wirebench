# Plan: Dynamic variables (#333)

Spec: `docs/specs/2026-10-11-dynamic-variables-design.md`. One commit per task, each after
`WIREBENCH_SKIP_PERF=1 pnpm check` is green.

1. **Generators.** `packages/engine/src/project/dynamic.ts`: catalogue (names, aliases, default
   arguments, descriptions), argument parsing, generators, per-send memo. Tests first: every generator's
   shape, arguments, bad arguments, aliases, the memo.
2. **Expansion.** `properties.ts`: `Dynamic` scope, the `${$…}` short form, `bad-arguments` code (also
   in the desktop wire enum); `scopesFor` and `ProjectHost.scopesFor` attach a fresh memo. Tests: same
   value twice in one `expand`, across a REST send's URL and header, new value on the next send.
3. **Importers.** `rewriteMustache` maps known names; `.http` argument forms. Tests: mapped names, an
   unmapped one still warned.
4. **Desktop.** Catalogue re-exported from `@wirebench/engine/rest`; Get Data… Dynamic section; `${$` editor completion.
   Tests: the completion items and the dialog's entries.
5. **Docs.** `docs/cli.md` scopes section, CHANGELOG under [Unreleased].
