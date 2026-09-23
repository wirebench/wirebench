# Secret scanning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Catch credential-shaped values in bodies, headers and properties on manual save and before a Sync commit, and move them into the secret store behind a `${secret:name}` token.

**Architecture:** Engine gets the token (expansion, resolution, masking, needs), exported redaction predicates, a pure `scanProjectForSecrets` and a pure `applySecretMoves`; main maps token names to store entries by label, scans on manual save/commit, holds automatic commits, keeps a per-session ignore set; the renderer shows one review dialog and a held-commit banner in the Sync panel.

**Tech Stack:** TypeScript, zod, vitest, React.

**Spec:** docs/specs/2026-09-22-secret-scanning-design.md

## Global Constraints

- No new dependency; no project format version bump; nothing new persisted in project files.
- Secret values never cross IPC to the renderer; wire findings carry `preview` only.
- `project-host.ts`, `wire-types.ts`, `sync-service.ts`: small, additive edits only (concurrent work).
- Gate before every commit: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`; `pnpm test:perf` unskipped before push.
- One commit per task; author Mohammed Naami <m.naami@outlook.com>; NO Co-Authored-By / Claude-Session trailers.
- Never name another product (`pnpm check:banned-terms`). No local Electron e2e. Don't edit `eslint.config.js`.
- TDD: failing test first.

---

### Task 1: `${secret:name}` in property expansion

**Files:** `packages/engine/src/project/properties.ts`; new `packages/engine/src/secrets/secret-token.ts`; export from `packages/engine/src/index.ts`; tests `packages/engine/test/unit/secrets/secret-token.test.ts`, properties tests.

**Produces:**
- `SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`; `secretToken(name): string`; `secretPseudoRef(name): string` (`secret:<name>`); `parseSecretPseudoRef(ref): string | undefined`; `secretEnvName(name): string` (upper-cased).
- `secretNamesIn(text: string, scopes?: PropertyScopes): string[]` — names in `${secret:…}` tokens, following `${name}` / scoped property values (cycle-safe, reuse the tokenizer).
- `PropertyScopes.secrets?: Readonly<Record<string, string>>`; `parseExpr` recognises `secret:`; missing name → `UnresolvedRef`, never `''`.

- [ ] Tests: expands with `secrets`; unresolved when absent or invalid name; `$${secret:x}` escape stays literal; nested property holding a token is found by `secretNamesIn`; cycles terminate.

### Task 2: Resolve, mask and report needs

**Files:** `packages/engine/src/run/prepare.ts`, the REST/gRPC/WS expand callers (`packages/engine/src/{rest,grpc,ws}/expand.ts` as needed), `packages/engine/src/secrets/resolve.ts`, `packages/engine/src/run/secret-needs.ts`, `packages/cli/src/env-secrets.ts`; tests (engine-unit + `packages/cli/test`).

**Produces:**
- `resolveSecretTokens(names, getSecret): Promise<Record<string,string>>` — throws `secret-missing` with `secretTokenMissingMessage(name)` for a missing value.
- `prepare` fills `scopes.secrets` before expanding and adds each value to the masker list it already returns.
- `secretNeedsOf` adds `{ ref: 'secret:<name>', envName: NAME, purpose: 'secret "name"' }` per token reached, merged into `usedBy`.
- `createEnvSecrets` handles pseudo-refs (reads `WIREBENCH_SECRET_<NAME>` first).

- [ ] Tests: run with env var sends the value and masks it in the report; missing → `secret-missing`; `secrets list` output names the variable; existing auth needs unchanged.

### Task 3: Redaction predicates and the scanner

**Files:** `packages/engine/src/redact/index.ts` (export `isSensitiveHeaderName`, `isSensitiveQueryParam`; sets unchanged); new `packages/engine/src/secrets/scan/{rules,walk,scan}.ts`; export; tests `packages/engine/test/unit/secrets/scan/*.test.ts`.

**Produces:**
- `SecretRule`, `SecretLocation`, `SecretFinding` exactly as the spec.
- `detectInText(text, context: { contentType?: string; fieldName?: string }): { rule; start; end }[]` — sensitive JSON keys / form fields / XML element local names via `SECRET_BODY_KEYS`, plus shape rules (JWT, Bearer, Basic, AWS, PEM, GitHub/Slack, high-entropy under a sensitive name). Credential part only (`Bearer ` prefix excluded). Ranges inside `${…}` skipped. First 1 MiB only.
- `scanProjectForSecrets(project: Project): SecretFinding[]` — walks project properties, environment properties, SOAP requests (headers, envelope), REST requests (URL, query, headers, body), gRPC (metadata, message), WS (headers, messages). Stable `id` = sha256(location + value) hex prefix 16. `label` display path.
- `maskedPreview(value): string`.

- [ ] Tests per rule (positive + near-miss negatives, e.g. `Bearer ${secret:x}`, `eyJ` not a JWT, low-entropy `password=changeme` under `password` still a sensitive-name finding); one per location kind; ids stable across calls and change with the value.
- [ ] Perf test `packages/engine/test/perf/secret-scan.perf.test.ts`: 2,000-request project < 100 ms (SC-7).

### Task 4: Applying moves

**Files:** new `packages/engine/src/secrets/scan/apply.ts`; export; tests.

**Produces:**
- `applySecretMoves(project: Project, moves: readonly { finding: SecretFinding; name: string }[]): { project: Project; stale: string[] }` — replaces each finding's value range with `secretToken(name)` (whole value for header/query/property, range for body/URL/message); several moves in one text applied right-to-left; a finding whose value no longer matches is skipped and its id returned in `stale`.
- `proposeSecretName(finding, taken: ReadonlySet<string>): string`.

- [ ] Tests: header `Bearer x` → `Bearer ${secret:n}`; two findings in one body; stale finding skipped; serialize round-trip leaves no value in any written file.

### Task 5: Main — store mapping, scan session, IPC

**Files:** `apps/desktop/src/main/secrets.ts` (`findByLabel(label): Promise<string | undefined>`), `apps/desktop/src/main/secret-resolver.ts` (pseudo-ref → label `wirebench-secret:<projectId>:<name>`), new `apps/desktop/src/main/secret-scan-session.ts`, new `apps/desktop/src/main/ipc/secret-scan.ts` registered in `main/index.ts`, `apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/shared/wire-types.ts` (additive), `apps/desktop/src/main/project-host.ts` (one hook to apply a mutation from main, if not already available); tests `apps/desktop/test/main/*`.

**Produces:**
- `SecretScanSession` per open project: `scan(): SecretFindingWire[]` (minus ignored), `keep(ids)`, `move(items: { id; name; replace?: boolean }[]): Promise<{ moved: string[]; stale: string[]; nameTaken: string[] }>`, `onChange` for hold release; cleared on close.
- Channels `secretScan.scan`, `secretScan.keep`, `secretScan.move`; schemas `secretFindingWireSchema` etc. (no `value` field).

- [ ] Tests: move stores the value under the label and rewrites the model; existing name without `replace` → `nameTaken`; keep hides the id until the value changes; the wire schema rejects an object with `value` (SC-6); desktop send resolves a token through the store.

### Task 6: Manual save flow

**Files:** `apps/desktop/src/renderer/state/project.ts` (`save()` path used by the command), `apps/desktop/src/renderer/commands/register-project-commands.ts`, new `apps/desktop/src/renderer/components/secret-review-dialog.tsx` (ConfirmDialog pattern), new `apps/desktop/src/renderer/state/secret-review.ts`; tests `apps/desktop/test/renderer/*`.

**Produces:**
- `reviewSecrets(mode: 'save' | 'commit'): Promise<'proceed' | 'cancel'>` — scans, shows the dialog when findings exist, applies Move/Keep, resolves `proceed` on "Save anyway"/"Commit anyway" or when nothing is left.
- Manual save calls it first; autosave / close / quit paths untouched (assert).

- [ ] Tests: dialog lists rows with preview (never the value), name editable and validated against `SECRET_NAME_PATTERN`; Move all; Save anyway writes; Cancel does not save; autosave never opens the dialog; keyboard: Escape = Cancel, focus trap.

### Task 7: Sync — manual commit review and held automatic commits

**Files:** `apps/desktop/src/main/sync/sync-service.ts` (dep `scanFindings(): number`, held state), `apps/desktop/src/shared/wire-types.ts` (`syncStatusWire.held?: { findings: number }`, additive), `apps/desktop/src/renderer/state/sync.ts`, `apps/desktop/src/renderer/features/sync/sync-panel.tsx`; tests.

**Produces:**
- Before an automatic commit (`afterSave` debounce, startup catch-up): if `scanFindings() > 0`, skip, set `held`, emit status; `SecretScanSession.onChange` → re-check, clear `held` and run the pending commit when 0.
- Manual commit in the renderer runs `reviewSecrets('commit')` before `sync.commit`.
- Sync panel banner "Commit held — N possible secrets" + Review button.

- [ ] Tests: commitOnSave with a finding holds (no `backend.commit` call); keep/move releases and commits once; catch-up holds too; manual Commit anyway commits with findings; banner renders and opens the dialog.

### Task 8: Docs and e2e

**Files:** `docs-site/src/content/docs/guides/secrets.mdx` (section "Secret tokens and scanning": token syntax, name rules, CI variable, what is detected, when it runs, Keep semantics, held commits), `docs-site/src/content/docs/guides/shared-workspaces.mdx` (held automatic commits; teammates set their own value), `docs-site/src/content/docs/guides/run-in-ci.mdx` (`WIREBENCH_SECRET_<NAME>` for tokens); `pnpm docs:commands` output if the command catalog changes; `e2e/specs/secret-scanning.spec.ts` (paste a JWT header, Ctrl+S, Move to secret, file has token) for CI only.

- [ ] Docs truthful to code (rules, 1 MiB, session-only Keep); name no other product.
- [ ] Don't run e2e locally; `pnpm typecheck` passes.
