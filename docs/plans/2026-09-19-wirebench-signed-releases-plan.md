# Plan: Signed Releases, MSI and SBOM

Spec: `docs/specs/2026-09-19-wirebench-signed-releases-design.md` · Issue #28 · Branch `feat/signed-releases`.

The build changes come first, so each one can be rehearsed with `workflow_dispatch` before the docs
describe it. There is one commit per task, each after `WIREBENCH_SKIP_PERF=1 pnpm check` passes.

## Phase 1 — Artifacts

- [x] **T1. MSI target.** Add `msi` for x64 and arm64 in `electron-builder.yml`: per machine, with an
  artifact name that matches the NSIS naming and a fixed upgrade code. Add `*.msi` to the uploaded
  artifacts.
  - Verify: a rehearsal produces two `.msi` files.
- [ ] **T2. `update-metadata.ts`.** Rewrite `sha512` and `size` in `latest.yml` from the files beside it,
  and add `--check`.
  - Verify: Vitest (rewrite, other fields untouched, stale `--check` fails).
- [ ] **T3. Windows pipeline.** Split the Windows build into `win-unpacked`, `sign-app`,
  `win-installers`, `sign-installers` and `win-update-metadata`. The signing jobs pass the files
  through when `SIGNPATH_API_TOKEN` is unset.
  - Verify: a rehearsal with no secrets goes green, and its `latest.yml` passes `--check`.
- [ ] **T4. SBOM and attestations.** Add an `sbom` job that writes CycloneDX JSON. On tags, the
  `release` job attests every artifact and the SBOM (`id-token: write` and `attestations: write`, on
  that job only).
  - Verify: a rehearsal uploads the SBOM; the attestation steps are skipped off-tag.

## Phase 2 — Docs

- [ ] **T5. `docs/release.md`.** The SignPath setup (programme application, project, artifact
  configurations, secrets and variables, approval), the Apple steps end to end, the `latest.yml`
  rewrite, the SBOM and attestations.
  - Verify: `pnpm check:doc-paths`.
- [ ] **T6. Site: silent install, verification, policy.** Add silent installs for NSIS and MSI and
  `gh attestation verify` to **Install and first run**, an enterprise FAQ entry, and
  `help/code-signing-policy.md` in the sidebar.
  - Verify: `pnpm docs:build`.

## Phase 3 — Close-out

- [ ] **T7. Close-out.** Update the roadmap row and the changelog, tick the spec, and open the PR.
  SignPath's application and a signed rehearsal stay with the owner, and #28 stays open until the
  first signed release.
  - Verify: `pnpm check`; `pnpm test:perf`; a green rehearsal linked in the PR.
