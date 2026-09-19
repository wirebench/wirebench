# Spec: Signed Releases, MSI and SBOM

- Status: **approved** (2026-09-19).
- Plan: `docs/plans/2026-09-19-wirebench-signed-releases-plan.md`.
- Date: 2026-09-19.
- Issue: [#28](https://github.com/wirebench/wirebench/issues/28) · Roadmap item 1 · Milestone 2.2.
- Branch: `feat/signed-releases`, from `main`.

## Rulings (2026-09-19)

1. **Windows signing goes through SignPath Foundation's open-source programme.** It is free. Users see
   **SignPath Foundation** as the publisher, not Wirebench, and every release waits for an approval in
   SignPath.
2. **The macOS setup is already in place, but there is no Apple Developer account yet.** The release
   workflow already signs and notarises when the `CSC_*` and `APPLE_*` secrets exist
   (`docs/release.md`). This work documents how to get them. It does not change the macOS path.
3. **The MSI comes from electron-builder's `msi` target**, not a custom WiX project.

## Assumptions

1. SignPath is wired in so that it is **off until configured**: without its secrets, the workflow
   produces unsigned Windows artifacts, the same way macOS behaves today.
2. SignPath signs twice:
   - first the unpacked app's executables, before the installers are built around them, so the
     installed `Wirebench.exe` is signed too;
   - then the NSIS and MSI installers themselves.
3. Signing an installer changes its bytes, so the `sha512` and `size` in `latest.yml` must be
   recomputed after signing. Otherwise auto-update rejects the signed installer.
4. The MSI installs per machine and does not auto-update. Fleet tools such as Intune push new versions.
   The NSIS installer stays the default download and keeps auto-update.
5. The SBOM is CycloneDX JSON, made by `anchore/sbom-action` (Syft) over the installed dependency tree.
   There are no new npm dependencies.
6. Build attestations (`actions/attest-build-provenance`) and an SBOM attestation are made on tag
   builds only. A `workflow_dispatch` rehearsal builds everything but attests and publishes nothing.

## 1. Objective

**What.** Releases that managed fleets can install:
- signed on Windows;
- signed and notarised on macOS, once the Apple account exists;
- an MSI for Intune;
- documented silent installs;
- a CycloneDX SBOM and build provenance on every release.

**Who.** IT teams who deploy Wirebench to managed Macs and Windows machines, and the security reviews
they run first.

**Why.** Managed fleets block unsigned apps, and procurement asks for an SBOM. Nothing else matters if
IT cannot install it.

## 2. Workflow shape (`.github/workflows/release.yml`)

```
check ─► build (mac, linux)                                   ─┐
      └► win-unpacked ─► sign-app ─► win-installers ─► sign-installers ─► win-update-metadata ─┤
                                                                           sbom ─┤
                                                                                 └► release (tags: attest + draft release)
```

- **`win-unpacked`** runs `electron-builder --win --dir` for x64 and arm64 and uploads the unpacked
  apps.
- **`sign-app`** runs only when the SignPath secrets are set. It submits the unpacked apps to SignPath
  (`signpath/github-action-submit-signing-request`), waits, and uploads the signed apps. Without
  secrets it passes the unsigned apps through.
- **`win-installers`** runs `electron-builder --win --prepackaged <dir>` for `nsis` and `msi`, from the
  apps that `sign-app` returned.
- **`sign-installers`** does the same as `sign-app`, for the `.exe` and `.msi` installers.
- **`win-update-metadata`** runs `scripts/update-metadata.ts`, which rewrites `sha512` and `size` in
  `latest.yml` from the final installers. `--check` verifies them.
- **`sbom`** writes `wirebench-<version>.cdx.json`.
- **`release`**, on tags only, attests every artifact and the SBOM, then creates the draft release with
  them all, as today.

Secrets: `SIGNPATH_API_TOKEN`, `SIGNPATH_ORGANIZATION_ID`; project and policy slugs as repository
variables. Actions are pinned to major versions, like the existing workflows.

## 3. Documentation

- `docs/release.md`:
  - the SignPath setup: applying to the Foundation programme, the project and the two artifact
    configurations, the secrets and variables, and the per-release approval;
  - the Apple steps, from enrolment to a `.p12` in `CSC_LINK`;
  - the `latest.yml` rewrite, and why it exists.
- Docs site, **Install and first run**, plus a short enterprise section in the FAQ:
  - silent installs: NSIS `/S`, `/allusers`, `/currentuser` and `/D=`, and MSI `msiexec /i … /qn`;
  - what the MSI does not do (auto-update);
  - how to verify a download with `gh attestation verify`.
- A code-signing policy page. The Foundation requires one: who can release, how a release is
  approved, and which artifacts are signed.

## Commands

```
Package (local, unsigned):  pnpm package:win   # now nsis + msi
Metadata:                   node scripts/update-metadata.ts <dir> [--check]
Rehearsal:                  gh workflow run release.yml --ref feat/signed-releases
Gate:                       WIREBENCH_SKIP_PERF=1 pnpm check
```

## Project structure

```
.github/workflows/release.yml        the pipeline above
apps/desktop/electron-builder.yml    msi target and options
scripts/update-metadata.ts           latest.yml rewrite + --check
docs/release.md                      signing, notarisation, SBOM, attestations
docs-site/src/content/docs/getting-started/installation.mdx   silent install, verify a download
docs-site/src/content/docs/help/code-signing-policy.md         policy page
```

## Code style

The script follows `scripts/wsi-docs.ts`: a top doc comment saying what it writes and what `--check`
does, `node:` imports, and no new dependencies. The workflow follows `release.yml`: comments say why
each step exists, and jobs get least-privilege permissions (only `release` writes).

## Testing strategy

- Vitest for `update-metadata.ts`: it rewrites the hash and size, leaves other fields alone, and
  `--check` fails on a stale file.
- `workflow_dispatch` rehearsal on the branch, with no signing secrets:
  - every job passes, and the Windows jobs pass the unsigned apps through;
  - the artifacts include an `.msi` per architecture and the SBOM;
  - `latest.yml` passes `--check`.
- A signed rehearsal once SignPath is approved. That is outside this branch, and the plan's last task
  records it.

## Boundaries

- **Always:** keep the workflow producing working unsigned artifacts when no secrets are set. Run
  `WIREBENCH_SKIP_PERF=1 pnpm check` before each commit, with one commit per task.
- **Ask first:** new npm dependencies; publishing a release; changing the NSIS installer's defaults
  (per-user, not one-click).
- **Never:** put a certificate, token or password in the repository; publish automatically (releases
  stay drafts); sign with a self-made certificate.

## Success criteria

- [x] A rehearsal with no secrets builds signed-ready artifacts: NSIS and MSI for x64 and arm64, macOS
      and Linux as today, and a CycloneDX SBOM.
- [x] `latest.yml` matches the final Windows installers (`update-metadata.ts --check`).
- [ ] With SignPath secrets set, the app executable and both installers are signed. Verified on the
      first signed rehearsal.
- [ ] Tag builds attest every artifact and the SBOM, and `gh attestation verify` passes on a download.
- [x] Silent install for NSIS and MSI, and download verification, are documented on the site.
- [x] `docs/release.md` covers the SignPath and Apple setups end to end.

## Open questions

None.
