# Success criteria — v1 evidence table

Spec §13 lists thirteen criteria that define "v1 is done". This page is the audit trail: one
row per criterion, the test files, specs and CI jobs that prove it, and an honest status.

- Spec: [`specs/2026-09-09-wirebench-v1-explore-and-send-design.md`](specs/2026-09-09-wirebench-v1-explore-and-send-design.md) §13
- Plan and its checkpoints: [`plans/2026-09-09-wirebench-v1-explore-and-send-plan.md`](plans/2026-09-09-wirebench-v1-explore-and-send-plan.md)
  (Checkpoint 0 → SC-free foundation; 1 → SC1–3; 2 → SC10–11; 3 → SC4; 4 → SC5–8; 5 → SC1, SC2,
  SC9; 6 → SC12–13 and a re-verification of all thirteen)

Every row's evidence runs in `pnpm check` (lint + typecheck + unit/integration + perf) or
`pnpm test:e2e` unless the row says otherwise. Both run on macOS, Windows and Linux in
[`ci.yml`](../.github/workflows/ci.yml). Every backticked repo path in this table's evidence
column is checked against the working tree by `scripts/check-doc-paths.ts`
(`pnpm check:doc-paths`, wired into `pnpm check`), so a renamed or deleted test file fails the
build here rather than going stale silently.

| # | Criterion | Evidence | Status |
|---|---|---|---|
| SC1 | **Import** — all public and crafted fixtures import cleanly from URL and file; nested imports resolve; cache is byte-identical; Update Definition keeps edited values | `packages/engine/test/unit/wsdl/{parse-wsdl,resolver,fetch,cache,cache-naming,update}.test.ts`, `packages/engine/test/unit/import.test.ts`, `packages/engine/test/integration/end-to-end.test.ts`, `e2e/specs/{walking-skeleton,update-definition,interface-editor}.spec.ts`; live contracts additionally in `packages/engine/test/interop/public-services.test.ts` | Met |
| SC2 | **Generate** — a sample request for 100% of fixture operations; doc/lit wrapped and bare, rpc/lit, rpc/encoded, SOAP 1.1 and 1.2; optional toggle, enum comments, `xsi:type`, header parts, SOAPAction | `packages/engine/test/unit/xsd/{sample-generator,form-model,schema-set}.test.ts`, `packages/engine/test/unit/soap/{request-builder,soap-action,envelope,prefixes,form-request}.test.ts` (golden snapshots under `packages/engine/test/unit/wsdl/__snapshots__`), `e2e/specs/form.spec.ts` | Met |
| SC3 | **Send** — status, duration, size, headers, raw bytes, timing breakdown; cancel mid-flight; readable timeouts and connection errors; local test server **and at least three live public services** | `packages/engine/test/unit/http/{raw-capture,timings,errors,decompress,dispatcher,proxy}.test.ts`, `packages/engine/test/integration/{send-encoding,send-compression}.test.ts`, `e2e/specs/{walking-skeleton,history,inspectors}.spec.ts`; the live half is `packages/engine/test/interop/public-services.test.ts` — four services | Met; the live-service half is network-gated (`WIREBENCH_NETWORK_TESTS=1`) and runs in [`nightly.yml`](../.github/workflows/nightly.yml), not on pull requests |
| SC4 | **Editors** — XML/Form/Outline/Raw round-trip; format, validate, find, go-to-line; layout toggles persist; Query view does XPath 3.1 and XQuery 3.1 with namespaces | `packages/engine/test/unit/xpath/{evaluate,evaluate-async,namespaces}.test.ts`, `packages/engine/test/unit/xml/*`, `apps/desktop/test/{ipc-xml,ipc-xpath,xml-model}.test.ts`, `e2e/specs/{editor,editor-actions,outline,form,response-views}.spec.ts` | Met |
| SC5 | **Headers and attachments** — custom headers override standard ones; MTOM and SwA round-trip byte-identically; inline `file:`/`cid:`; response attachments listed and openable | `packages/engine/test/unit/soap/mime/*`, `packages/engine/test/integration/mime.test.ts`, `apps/desktop/test/ipc-attachments.test.ts`, `e2e/specs/attachments.spec.ts` | Met |
| SC6 | **Auth** — Basic (preemptive and challenge) and NTLMv2 against the simulated challenge; endpoint override/complement | `packages/engine/test/unit/http/auth/*`, `packages/engine/test/integration/auth/*`, `apps/desktop/test/{engine-auth,send-auth,project-auth}.test.ts`, `e2e/specs/auth.spec.ts` | Met |
| SC7 | **WS-Security** — Timestamp, UsernameToken, Signature (all key identifiers, RSA-SHA256), Encryption (AES-256-GCM + RSA-OAEP) verified by `xmlsec1`; incoming verify/decrypt; PKCS#12 and PEM; **no passwords in project files** | `packages/engine/test/unit/wss/**`, `packages/engine/test/integration/wss/*`, `scripts/wss-xmlsec-check.ts` (`pnpm test:wss-xmlsec`), `e2e/specs/{wss,keystores,secrets}.spec.ts`, `apps/desktop/test/{secrets,secret-resolver,redact}.test.ts` | Met; the `xmlsec1` cross-check is proven **in CI** (`wss-xmlsec` job, Linux + macOS) and locally only where `xmlsec1`/`libxmlsec1` is installed — it is skipped otherwise unless `WIREBENCH_REQUIRE_XMLSEC=1` |
| SC8 | **WS-Addressing** — headers for both versions; auto-enabled from `wsaw:UsingAddressing`; visible in Raw | `packages/engine/test/unit/wsa/{headers,policy-detect}.test.ts`, `packages/engine/test/integration/wsa-send.test.ts`, `apps/desktop/test/project-wsa.test.ts`, `e2e/specs/wsa.spec.ts` | Met |
| SC9 | **Validation** — schema errors at the right line/column; WS-I subset report with assertion ids for compliant and non-compliant WSDLs; HTML report export | `packages/engine/test/unit/validate/**` (incl. `packages/engine/test/unit/validate/wsi/{wsdl,message,report-html}.test.ts`), `apps/desktop/test/{ipc-validate,ipc-wsi}.test.ts`, `e2e/specs/{validation,wsi}.spec.ts`, generated list in [`ws-i-assertions.md`](ws-i-assertions.md) (checked by `pnpm wsi:docs --check`) | Met |
| SC10 | **Project and environments** — save/open/recent; renaming one request touches exactly two files; environment switch changes the next send's endpoint; property expansion across scopes; unresolved expansions in Problems | `packages/engine/test/unit/project/**`, `apps/desktop/test/{project-service,project-mutations,project-watch,recent-projects,global-properties,expansion-preflight}.test.ts`, `e2e/specs/{project,environments}.spec.ts` | Met |
| SC11 | **History** — every send recorded; re-send and diff; survives restart; stored outside the project folder | `packages/engine/test/unit/project/history.test.ts`, `apps/desktop/test/history-service.test.ts`, `e2e/specs/history.spec.ts` | Met |
| SC12 | **IDE shell** — sidebar, tabs, details panel, console, status bar, complete command palette, default shortcuts, dark/light themes, keyboard-only import→send | `apps/desktop/test/renderer/**`, `e2e/specs/{app-smoke,keyboard,a11y,preferences}.spec.ts`, contrast gate `scripts/contrast-check.ts` (`pnpm contrast:check`, part of `pnpm check`) | Met; the theme **screenshot** comparison is macOS-only — only macOS snapshots are committed (`e2e/specs/__screenshots__`), and those two tests skip themselves on other OSes. Everything else in the suite runs on all three |
| SC13 | **Quality and release** — `pnpm check` green on three OSes in CI; engine coverage ≥ 85%; §11 performance budgets met; packaged installers for three OSes from a tag; README quick start under five minutes; LICENSE, CONTRIBUTING and ADR-0001..0003 present | [`ci.yml`](../.github/workflows/ci.yml) (`check` matrix on three OSes; `coverage` job runs `pnpm test:coverage` on Linux, gated by the 85% thresholds in `vitest.config.ts`), budgets in `packages/engine/test/perf/budgets.test.ts` + `e2e/specs/perf.spec.ts`, packaging in [`release.yml`](../.github/workflows/release.yml) + `e2e/specs/packaged.spec.ts`, [`README.md`](../README.md) quick start, [`LICENSE`](../LICENSE), [`CONTRIBUTING.md`](../CONTRIBUTING.md), [`adr/`](adr/) (0001–0005) | Partly met — see below |

## SC13, stated plainly

Three parts of SC13 are not fully demonstrated in this repository as it stands:

1. **Installers produced by CI from a tag.** `release.yml` exists, builds all three OSes and
   drafts a release, and `pnpm package:*` is exercised locally — but the repository has no
   remote, so no tag has ever driven that workflow end to end. Cutting `v1.0.0` (see
   [`release.md`](release.md)) is the step that proves it, and it is the user's to take.
2. **CI green on three OSes.** Asserted by the workflow, which has likewise never run on a
   remote. `pnpm check` and the full e2e suite are green locally on macOS.
3. **"Under five minutes."** The README quick start is written and illustrated to make that
   true, but it is a claim about a person, not something a test can assert. It is the one row
   in this table that wants a human to try it on a clean machine.

Everything else in SC13 is machine-checked: the `coverage` job in `ci.yml` fails below 85%,
the budgets fail below their limits, and the documents listed exist (ADR-0001 through 0003 as
the spec requires, plus 0004 and 0005 for two decisions that turned out to be load-bearing).
