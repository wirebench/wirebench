# Secret scanning before save and before a Sync commit — design

Issue: #39 · Date: 2026-09-22 · Status: approved to build (owner decisions A and B, 2026-09-22)

## Objective

A credential pasted into a request body, a header, a query parameter or a property is caught before it
reaches a project file that someone commits and pushes. A manual save or a manual Sync commit lists
what was found and offers to move each value into the keychain-backed secret store, leaving a
`${secret:name}` token in the file. Automatic Sync commits hold instead of committing a finding. The
rules that decide what a secret looks like are the ones the redaction helpers already use.

## Decisions

1. **A `${secret:name}` token (owner A).** Property expansion gains one form: `${secret:name}`. `name`
   matches `[A-Za-z_][A-Za-z0-9_]*` (a valid environment variable suffix). The value is never written
   to a project file; the file carries only the token.
2. **The token carries a name, not a ref.** `SecretStore.set` returns an opaque `sec_…` ref chosen by
   the machine that stored the value. A ref in the token would make the file meaningful on one machine
   only: a teammate who pulls a shared project would store the value under a new ref and rewrite every
   token, and those rewrites would conflict on every Sync. A name is stable across machines and is
   what CI needs anyway (`WIREBENCH_SECRET_<NAME>`). The name → ref mapping stays machine-local, in the
   store itself: the entry's `label` is `wirebench-secret:<projectId>:<name>`. No new file, no project
   format change, no ref in the project. A teammate without the value gets the standard
   `secret-missing` error naming the secret (`The secret "billing_key" is not on this machine — set it
   with Set Secret Token Value… (Secrets).`). #143 added that command: a dialog listing the project's
   tokens and setting a value by name (`secretScan.tokens` / `secretScan.setValue`).
3. **Resolution.** Expansion stays synchronous: `PropertyScopes` gains an optional
   `secrets?: Readonly<Record<string, string>>`. Before expanding, `prepare` collects the names the
   request uses (`secretNamesIn(text)` over every expandable field, following `${name}` property values
   so a property holding a token counts) and resolves each through the injected `GetSecret` with the
   pseudo-ref `secret:<name>`. Desktop's getter maps a `secret:` pseudo-ref to the labelled store entry
   for the open project; the CLI's `createEnvSecrets` reads `WIREBENCH_SECRET_<NAME>` (name
   upper-cased) through `envVariablesFor({ ref: 'secret:<name>', envName: NAME })`. An unknown name is
   refused at resolution with `secret-missing` (`details.ref` = `secret:<name>`, message from
   `secretTokenMissingMessage`), never sent as an empty string. Expansion itself, given no
   `secrets` value for a name, still reports it as an unresolved ref.
4. **Masking.** Every resolved secret value joins the send's `createSecretMasker` list, so it shows as
   `<redacted>` in the HTTP log, History, run reports and CLI output like any auth secret. Editors keep
   showing the token.
5. **Needs.** `secretNeedsOf` reports each token a selected request reaches as
   `{ ref: 'secret:<name>', envName: NAME, purpose: 'secret "name"' }`, so `wirebench secrets list` and
   `run` name the variable.
6. **Scanner in the engine, pure.** `scanProjectForSecrets(project): SecretFinding[]`. Values never
   leave main: the wire shape carries a masked preview only (first 3 characters, `…`, length). A value
   whose credential part is already a `${…}` expansion is not a finding.
7. **Rules reuse redaction.** `redact/index.ts` exports `isSensitiveHeaderName` and
   `isSensitiveQueryParam` over its existing private sets (unchanged), and the scanner uses them with
   `SECRET_BODY_KEYS` (JSON keys, form fields, XML element local names). A non-empty, non-token value
   under a sensitive name is a finding. Shape rules apply anywhere (body text, header and property
   values): JWT (three base64url segments starting `eyJ`), `Bearer <token>` / `Basic <base64>`, AWS
   access key ids (`AKIA`/`ASIA` + 16), PEM private key blocks, GitHub (`ghp_`, `gho_`, `ghs_`,
   `github_pat_`) and Slack (`xox[abpr]-`) tokens, and high-entropy strings (≥ 20 characters, Shannon
   entropy ≥ 3.5 bits/char) only under a name matching `secret|token|password|passwd|key|credential`.
8. **When scanning runs (owner B).**
   - Manual save (command, Ctrl+S) and a manual Sync commit scan first; findings open a review dialog.
   - Autosave, save-on-close and save-on-quit write without asking (the files are local).
   - Automatic Sync commits (`commitOnSave`, the startup catch-up) scan and are **held** while any
     unreviewed finding exists; the Sync panel shows "Commit held — N possible secrets" with a Review
     button that opens the same dialog. Once every finding is moved or kept the hold releases and the
     pending commit runs.
9. **Keep = this session.** "Keep" adds the finding's id to an in-memory, per-project ignore set in
   main, cleared on project close. Nothing persisted. A finding id hashes its location and value, so an
   edited value is found again.

## Behaviour

- **Finding** `SecretFinding` (engine):
  `{ id; location: SecretLocation; rule: SecretRule; label; valueStart; valueEnd; value }`;
  the wire shape `SecretFindingWire` is `{ id; location; rule; label; preview }`.
  `SecretLocation` is one of
  `{ kind: 'soap-header' | 'rest-header' | 'rest-query' | 'grpc-metadata' | 'ws-header'; requestId; name }`,
  `{ kind: 'soap-body' | 'rest-body' | 'rest-url' | 'grpc-message' | 'ws-message'; requestId }`
  (value range in the stored text), `{ kind: 'project-property'; name }`,
  `{ kind: 'env-property'; environmentId; name }`. `label` is the display path
  (`Billing API › GET /invoices › header Authorization`). `SecretRule` is
  `sensitive-name | jwt | bearer | basic | aws-key | private-key | vendor-token | high-entropy`.
- **Move to secret:** the dialog proposes a name (from the header, key or property name, sanitised and
  de-duplicated against the project's stored names) that the person can edit. Main stores the value
  (`set` with the label, or `replace` when the name exists and the person ticks "Replace the stored
  value"), then applies `applySecretMoves(project, moves)` — pure, engine — which replaces
  only the credential part (`Bearer eyJ…` → `Bearer ${secret:billing_token}`) and returns the new
  project, any stale finding ids, and `values` (finding id → value to store). The stored value is the
  replaced text exactly as found — still JSON-, XML- or URL-escaped when the text around it was —
  because expansion substitutes a secret verbatim, so the send is byte-for-byte the original. The host applies it as one undoable mutation; the save or commit then continues.
- **Dialog:** the `ConfirmDialog` modal pattern; one row per finding (label, rule, preview, name
  field, Move to secret / Keep). Footer: "Move all", "Save anyway" (or "Commit anyway"), Cancel.
  "Save anyway" writes with the findings still there and does not add them to the ignore set.
- **Scale:** bodies over 1 MiB are shape-scanned on their first 1 MiB only; a 2,000-request project
  scans in under 100 ms.

## Success criteria

- SC-1: a REST header `Authorization: Bearer eyJ…` and a SOAP `<Password>hunter2</Password>` are both
  listed on manual save; Move to secret leaves `Bearer ${secret:…}` and
  `<Password>${secret:…}</Password>` in the files and the values in the store only.
- SC-2: sending a request that uses `${secret:name}` sends the value; the HTTP log and History show
  `<redacted>`.
- SC-3: `wirebench run` resolves `${secret:billing_key}` from `WIREBENCH_SECRET_BILLING_KEY`;
  `wirebench secrets list` names that variable; a missing one fails with `secret-missing`.
- SC-4: autosave never prompts; with `commitOnSave` on, a finding holds the commit and the Sync panel
  shows it; reviewing releases it.
- SC-5: values already `${…}` are never findings; Keep suppresses a finding until its value changes or
  the project is reopened.
- SC-6: no value crosses IPC to the renderer (the wire schema has `preview` only; a test asserts it).
- SC-7: `pnpm test:perf` — scanning a generated 2,000-request project takes < 100 ms.

## Boundaries

- No new dependency; no project format version bump; nothing new persisted in project files.
- `project-host.ts`, `wire-types.ts` and `sync-service.ts` changes stay small and additive (other work
  edits them concurrently).
- Never name another product in code or docs (`pnpm check:banned-terms`).
