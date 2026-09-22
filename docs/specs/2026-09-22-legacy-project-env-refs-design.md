# Legacy import: `${#Project#name}` follows the imported environments — design

Issue: #105 · Date: 2026-09-22 · Status: approved (owner decision via popup, 2026-09-21)

## Objective

A legacy SOAP project import brings environments across as Wirebench environments. In the source
tool environment values override project properties, so a request reading `${#Project#name}` changes
with the active environment. In Wirebench `${#Project#name}` only ever reads the project scope, so the
imported project silently behaves differently.

**Decision (owner):** when an imported environment defines `name`, rewrite `${#Project#name}` to
`${name}` during import, **silently** — no report line. `${name}` resolves Env → Project → Workspace →
Global (`project/properties.ts`), so where the active environment has no `name` it still reads the
project's value: the rewrite never changes a result the source tool would not also have changed.

## Behaviour

- A pure pre-pass `rewriteProjectRefsToEnv(project: LegacyProject): LegacyProject` in
  `packages/engine/src/soap/legacy-project/env-refs.ts`, run by `mapLegacyProject` before mapping.
- The set of names is the union of property names over **all** imported environments
  (`project.environments[*].properties[*].name`), compared exactly (case-sensitive, as expansion is).
- Pattern: `${#Project#<name>}` where `<name>` contains no `}`, `$` or `{`; only names in the set are
  rewritten, to `${<name>}`. Everything else — other scopes, names not in the set, nested or malformed
  expressions — is left byte-identical.
- Fields rewritten (every string that is expanded at send time):
  - each call's `envelope`, `endpoint`, and `credentials.username`;
  - each interface's `endpoints[]`;
  - each environment's endpoint override `url` and property `value`s;
  - project property `value`s.
  Rewriting the call endpoints and interface endpoints in the same pass keeps the mapper's
  endpoint-by-URL matching intact.
- No report item is added. Report counts are unchanged.
- Not rewritten: scripts (saved as is, never run), definition cache parts, names.

## Docs

`docs-site/src/content/docs/switching/legacy-soap-project.mdx`:
- the mapping row for `${#Project#name}` … says a `${#Project#name}` whose `name` an imported
  environment defines becomes `${name}`, so it follows the active environment; the others are kept;
- the "Environments and ${#Project#…}" caution is replaced by a short note saying the same, and that
  references typed after the import are not changed.

## Success criteria

- SC-1: an envelope `<a>${#Project#host}</a>` with an environment defining `host` imports as
  `<a>${host}</a>`; sending with that environment active uses the environment's value.
- SC-2: `${#Project#other}` (no environment defines `other`), `${#Env#host}`, `${#Global#host}` and
  `${#TestCase#host}` are unchanged.
- SC-3: all listed fields are rewritten; a call endpoint and the interface endpoint with the same
  templated URL still match (the request keeps its `endpointId`).
- SC-4: no report item mentions the rewrite; counts unchanged.
- SC-5: a project with no environments imports byte-identical to before.

## Boundaries

- No new dependency; engine only plus the docs page. No format change.
- Never name the source tool in code or docs (`pnpm check:banned-terms`).
