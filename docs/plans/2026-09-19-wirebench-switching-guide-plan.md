# Plan: Switching Guide

Spec: `docs/specs/2026-09-19-wirebench-switching-guide-design.md` · Issue #54 · Branch `docs/switching-guide`.

The four importer fixes land first, so the pages describe behaviour that holds. There is one commit per
task, each after `WIREBENCH_SKIP_PERF=1 pnpm check` passes.

## Phase 1 — Fixes

- [x] **T1. Postman mapping gaps.** An OAuth 2 grant other than authorization code or client credentials
  maps to `none` with a warning instead of silently becoming client credentials. `{{var}}` in auth fields
  (username, token and auth URLs, client ID, scope, API key name) is translated to `${var}`.
  - Verify: engine unit tests in `packages/engine/test/unit/rest/postman/`.
- [x] **T2. Postman summary shows warnings.** The Postman summary in `import-dialog.tsx` lists
  `summary.warnings` with a Copy report button, reusing the legacy summary's list. Remove the wire
  schema's unused `skipped` field, or fill it.
  - Verify: renderer unit test; an e2e step in the Postman import spec asserts that a warning is shown.
- [x] **T3. cURL value-less flags, `--json`, `-G`.** Extend `BOOLEAN_FLAGS` in
  `packages/engine/src/rest/curl.ts`. Parse `--json` as a JSON body with its Content-Type and Accept
  headers. Make `-G` move the `-d` data into the query. Check the SOAP parser's flag handling for the same
  swallowing.
  - Verify: one unit test per flag, including `curl --ntlm -u u:p https://x`.
- [ ] **T4. cURL `-u` password reaches the keychain.** The import dialog stores the parsed password as a
  secret and passes `passwordRef`. The "set a password" toast only appears when none was given.
  - Verify: renderer or IPC unit test; e2e: paste `curl -u` and send against the Basic-auth test server
    without entering the password again.
- [ ] **T5. cURL preview follows the target.** For a REST target the preview shows method, URL, header
  names, body kind and auth, with REST problems only. For a SOAP target it stays as it is. After an import
  the problems are listed, not just counted.
  - Verify: unit tests for `curl-preview.ts` for both targets.

## Phase 2 — Pages

- [ ] **T6. Switching section and Postman page.** Add the sidebar section and
  `switching/postman.mdx`, following the page shape in spec §3, with a summary screenshot added to
  `docs-screenshots.spec.ts`.
  - Verify: `pnpm docs:build`; `pnpm check:docs-images`.
- [ ] **T7. Legacy SOAP project page.** `switching/legacy-soap-project.mdx`.
  - Verify: `pnpm docs:build`; `pnpm check:banned-terms`.
- [ ] **T8. OpenAPI and Swagger page.** `switching/openapi.mdx`.
  - Verify: `pnpm docs:build`.
- [ ] **T9. cURL page.** `switching/curl.mdx`.
  - Verify: `pnpm docs:build`.
- [ ] **T10. Importers guide corrections.** Fix the four contradictions from spec §3, link each source
  section to its switching page, and re-shoot the affected images.
  - Verify: `pnpm docs:build`; `pnpm check:doc-paths`.

## Phase 3 — Close-out

- [ ] **T11. Close-out.** Update the roadmap row for item 2 and the changelog, tick the spec's success
  criteria, and open the PR with `Closes #54`.
  - Verify: `WIREBENCH_SKIP_PERF=1 pnpm check`; `pnpm test:perf`.

## Risks

- T4 needs the secret-store path from the renderer. If the import IPC cannot write a secret, it should
  reuse the Auth tab's secret-setting call rather than add a new one.
- The screenshots in T6 and T10 open local Electron windows. The owner has approved local shooting for
  docs images.
