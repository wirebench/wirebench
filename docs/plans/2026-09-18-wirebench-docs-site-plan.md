# Plan: Documentation Site

Spec: `docs/specs/2026-09-18-wirebench-docs-site-design.md` · Issue #29 · Branch `feat/docs-site`.

The site is built in slices. Tooling and checks land first, so every content task after them is guarded
by `pnpm check`. There is one commit per task, each after `WIREBENCH_SKIP_PERF=1 pnpm check` passes.

## Phase 1 — Clean base

- [x] **T1. Strip the scaffold.** Remove Scalar, `public/specs/`, `Endpoint.astro`, `MethodBadge.astro`,
  `pages/reference/index.astro` and the "inspired by" wording in CSS and comments. Set `site` and
  `base: '/wirebench'`. Add `docs-site` to the root lint and prettier scope.
  - Verify: `pnpm docs:build` passes; `grep -ri scalar docs-site` is empty.
- [x] **T2. Link validator.** Add `starlight-links-validator` and wire it into `astro.config.mjs`.
  - Verify: a deliberately broken link fails `pnpm docs:build`, then remove it.

## Phase 2 — Generated reference and checks

- [x] **T3. Command catalog.** Move the static fields of every command (id, label, category, `shortcut`,
  `extraShortcuts`) into `apps/desktop/src/shared/command-catalog.ts`. The `register-*` files keep
  `run` and `when` and look the rest up by id. No behaviour change.
  - Verify: unit tests plus `e2e/specs/keyboard.spec.ts` in CI; a registry test asserts that every
    catalog id is registered exactly once.
- [x] **T4. `docs-commands.ts`.** Generate `reference/commands.md` from the catalog, grouped by category,
  with macOS and Windows/Linux keys. Add `--check` and put it into `pnpm check`. Delete
  `reference/shortcuts.md`.
  - Verify: unit tests for grouping, platform keys and stale `--check`.
- [x] **T5. Doc-path and banned-term coverage.** Extend `check-doc-paths.ts` to
  `docs-site/src/content/**`. Add a banned-terms test fixture under `docs-site/`.
  - Verify: unit tests; `pnpm check` passes.
- [x] **T6. Screenshot pipeline.** Add `e2e/specs/docs-screenshots.spec.ts`, which writes to
  `docs-site/public/images/<page>/`, reusing the capture helpers. Add `pnpm docs:screenshots`. Add
  `scripts/check-docs-images.ts` (missing or orphaned images) to `pnpm check`. Regenerate the existing
  pages' images and delete the hand-captured ones.
  - Verify: unit tests for the image check; the spec passes in CI e2e (not run locally with windows).

## Phase 3 — Publishing

- [x] **T7. Workflow.** Deploy on every push to `main` (no `paths` filter) and on `workflow_dispatch`.
  Add a PR job that runs `pnpm docs:build` when `docs-site/**` changes. Pin actions to major versions, like the other workflows.
  - Verify: `actionlint`, if available; the PR run passes on GitHub.

**Checkpoint A:** tooling complete. Push the branch and open a draft PR so CI runs e2e and the docs build.

## Phase 4 — Content (each task = pages + their screenshot cases in T6's spec)

- [x] **T8. Getting started.** Introduction, install and first run per OS, ten-minute walkthrough
  (install → SOAP request → REST request).
- [x] **T9. Protocol guides.** SOAP and WSDL, REST, gRPC (reflection, streaming, completion).
- [x] **T10. Importers guide.** WSDL, OpenAPI, cURL, legacy SOAP project.
- [x] **T11. Configuration guides.** Environments and properties, auth/OAuth 2/keystores, secrets,
  preferences and layout.
- [x] **T12. Observability guides.** HTTP Log, history.
- [x] **T13. Collaboration guide.** Workspaces and projects, shared workspaces and sync (share, join,
  pull, conflicts).
- [x] **T14. Reference and help.** Project folder format and property syntax refreshed, a WS-I link page,
  troubleshooting, FAQ. Final sidebar order.
  - Verify (T8–T14): `pnpm check` and `pnpm docs:build`; each claim checked against the current UI and
    the e2e specs for that area; screenshots come from CI.

**Checkpoint B:** every page in the spec's Content table exists; review the rendered site locally with
`pnpm docs:dev`.

## Phase 5 — Ship

- [ ] **T15. Close-out.** Update the roadmap entry, changelog and README link to the site. The owner
  switches Pages to "GitHub Actions". Merge with `gh pr merge --merge`, then confirm the deploy and
  search on the live URL.

## Risks

- **T3 touches every command file.** Keep it mechanical, with a registry test; no renames.
- **Screenshot flakiness in CI.** Reuse the masks and fixed window size from `screenshots.spec.ts`;
  images are committed, so a flaky run never breaks the deploy.
- **Rebased branch needs a force push.** `--force-with-lease` once, at Checkpoint A.
