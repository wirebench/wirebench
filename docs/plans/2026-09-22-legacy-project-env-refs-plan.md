# Legacy import `${#Project#name}` → `${name}` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Imported requests follow the active environment for project references an imported environment defines.

**Architecture:** A pure pre-pass over the parsed `LegacyProject`, called at the top of `mapLegacyProject`.

**Tech Stack:** TypeScript, vitest.

**Spec:** docs/specs/2026-09-22-legacy-project-env-refs-design.md

## Global Constraints

- Silent rewrite: no report item (owner decision).
- Only `${#Project#<name>}` with `<name>` in the union of imported environment property names; everything else byte-identical.
- Gate: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check` before commit; one commit per task; author Mohammed Naami <m.naami@outlook.com>; no Co-Authored-By / Claude-Session trailers.
- Never name the source tool anywhere.

---

### Task 1: Rewrite pre-pass, wiring, docs

**Files:**
- Create: `packages/engine/src/soap/legacy-project/env-refs.ts`
- Modify: `packages/engine/src/soap/legacy-project/map.ts` (call the pre-pass first in `mapLegacyProject`)
- Test: `packages/engine/test/unit/soap/legacy-project/env-refs.test.ts`, plus one case in `map.test.ts`
- Modify: `docs-site/src/content/docs/switching/legacy-soap-project.mdx` (mapping row line ~37, caution ~63-68)

**Interfaces:**
- Produces: `export function rewriteProjectRefsToEnv(project: LegacyProject): LegacyProject` (returns the same object when nothing changes).

- [ ] Step 1: failing tests for SC-1…SC-5 (spec). SC-1 end to end: map the project, then `expand` the envelope with the environment active and check the environment's value comes back (use the existing expansion API in `project/properties.ts`).
- [ ] Step 2: implement: collect names; `replace(/\$\{#Project#([^${}]+)\}/g, (m, n) => names.has(n) ? '${' + n + '}' : m)` over the listed fields; immutable copies.
- [ ] Step 3: call it at the top of `mapLegacyProject`.
- [ ] Step 4: docs row + replace the caution with a note (spec §Docs).
- [ ] Step 5: gate green, commit `feat(legacy-import): project references follow the imported environments`.
