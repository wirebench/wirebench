# Plan: import SSH hosts from an OpenSSH config file

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Spec:** `docs/specs/2026-10-09-ssh-config-import-design.md` (issue #364). The plan argues from the spec; read
both, and the SSH area design (`docs/specs/2026-10-08-ssh-area-design.md`, D2 and A1–A7) for the model.

**Goal:** **Hosts: Import from SSH Config…** reads `~/.ssh/config` or a picked file, shows a report of what
becomes which host and what is left out, and on Import adds the hosts to `hosts.yaml` in one new group, storing
private keys as workspace secrets only where the user chose to.

**Architecture:** Two pull requests. PR 1 is pure `packages/ssh` code under `src/openssh-config/`: a lexer, a
loader that follows `Include` one level through an injected `io`, an evaluator with OpenSSH's first-value-wins
rule, and `planSshConfigImport` / `applySshConfigImport` over the existing `HostsFile` model. PR 2 is the
desktop: an import service in main holding a preview per window, two channels, the dialog, the command and the
e2e.

**Tech stack:** TypeScript (ESM, Node ≥ 24), zod 4, vitest (root `vitest.config.ts` projects `ssh-unit` and the
desktop unit project), Electron 44, React + Radix dialog, Playwright `_electron` e2e.

## Global constraints

- `WIREBENCH_SKIP_PERF=1 pnpm check` green before every commit; one commit per task. `pnpm test:perf` before a
  push. e2e runs in CI only (`pnpm build && xvfb-run -a pnpm test:e2e`); local checks headless under `nice`.
- Never name the product that motivated this feature anywhere. Describe behaviour neutrally ("an OpenSSH client
  config"); `pnpm check:banned-terms` enforces part of this.
- Commits as Mohammed Naami; no `Co-Authored-By`, no `Claude-Session` trailer.
- `packages/ssh` imports neither `@wirebench/engine` nor Electron (A4's test in `scripts/engine-layers.test.ts`);
  `src/openssh-config/` does no file I/O itself: everything goes through `SshConfigIo`.
- No channel response, event, log line, report entry or error carries a key's bytes, a passphrase, or the value
  of a skipped or ignored config line (P7, P8). The renderer never sends a path (ADR-0005).
- Ids match `/^[a-z0-9][a-z0-9-]*$/`; secret names match `SSH_SECRET_NAME_PATTERN`; every written credential is
  a `${secret:NAME}` token.
- A new command id needs a `COMMAND_CATALOG` entry and a handler (`test/renderer/command-registry.test.ts`); run
  `pnpm docs:commands` after.
- Renderer code imports constants from `shared/ssh-defaults.ts`, never a value from `ssh-wire.ts` eagerly (the
  renderer CSP trap, `test/renderer-eager-imports.test.ts`).

## PR 1 — `packages/ssh`: parse, evaluate, plan, merge

### Task 1: Lexer

**Files:** create `packages/ssh/src/openssh-config/lex.ts`, `packages/ssh/src/openssh-config/lex.test.ts`.

- [ ] Test first: `lexSshConfig(text, file)` → `{ lines: SshConfigLine[], problems: { file, line, why }[] }`.
      Cases: `Host a b`, `HostName=x`, `Port = 22`, keyword case (`hOsTnAmE` → `hostname`), a double-quoted
      argument with spaces, `#` comment at line start and after whitespace, `#` inside a quoted argument kept,
      blank lines, CRLF, BOM, an unclosed quote → a problem `{ line, why: 'line could not be read' }` and no line.
- [ ] Marker test: the unclosed-quote line holds `MARKER-7f3`; assert it is absent from `JSON.stringify(result)`.
- [ ] Implement. Commit `feat(ssh): lex OpenSSH client config lines`.

### Task 2: Blocks and `Include`

**Files:** create `packages/ssh/src/openssh-config/load.ts`, `load.test.ts`; fixtures under
`packages/ssh/test/fixtures/openssh-config/`.

- [ ] Test first with an in-memory `SshConfigIo` (`home: '/home/u'`, a `Map` of files, `glob` over its keys):
      the global block before the first `Host`; `Host` and `Match` blocks with `at`; `Include conf.d/*` resolves
      to `/home/u/.ssh/conf.d/*` and splices lines in place, inside the current block; `Include ~/x` expands `~`;
      a missing target is a note; a read failure (io throws with `code: 'EACCES'`) is a warning with the errno;
      an `Include` inside an included file is reported and not followed; `file` is shown `~/`-relative.
- [ ] Implement `loadSshConfig(path, io) → SshConfigDocument`. Commit `feat(ssh): read OpenSSH config blocks and
      one level of Include`.

### Task 3: Evaluator

**Files:** create `packages/ssh/src/openssh-config/evaluate.ts`, `evaluate.test.ts`.

- [ ] Test first: `concreteAliases(doc)` (no `*`, `?`, `!`; document order; each once); `matches(patterns,
      alias)` with `*`, `?`, `!neg`, and a list where a negation excludes; `effective(doc, alias)` keeps the
      first value per keyword across `global` and matching `host` blocks, skips `match`, accumulates
      `identityfile`; `allHosts(doc)` from `*`-only blocks, with `Host *` both first and last in the file.
- [ ] Implement. Commit `feat(ssh): evaluate OpenSSH config per alias, first value wins`.

### Task 4: Plan — hosts, fields, group defaults, ids

**Files:** create `packages/ssh/src/openssh-config/plan.ts`, `plan.test.ts`, `index.ts`; export from
`packages/ssh/src/index.ts`.

- [ ] Test first, `planSshConfigImport({ document, existing, existingSecretNames })`:
  - P3 rows: `HostName` with `%h` and `%%`; another `%` token skips the host with a reason; no `HostName` →
    address = alias; `Port`, `User`, `ServerAliveInterval` (including `0`), `ConnectTimeout` (`none` → unset).
  - Ignored keywords counted once each under `ignored`; other keywords under `skipped` with file, line and
    keyword and no value (marker test across `ProxyCommand`, `SetEnv` and `LocalForward` values).
  - M1: `Host *` with `User deploy` → group `ssh.user: deploy`, hosts omit `user`; a host whose block sets
    `User root` before `Host *` writes `user: root`; `Host *` first in the file gives the same result when no
    specific block sets the field.
  - M2: `Web.Prod_1` → `web-prod-1`; `!!!` → `host`; a clash with `existing` and within the import → `-2`,
    `-3`, `idChangedFrom` set; the group id `ssh-config`, then `ssh-config-2` when taken.
  - M7: no user anywhere → the host is present and the merged file resolves it with `incomplete.field ===
    'user'`.
  - M8: a `Match` block is listed in `skipped` with its line count and changes no host.
  - `ssh-config-empty` when no concrete alias exists (an `SshModelError`; add the code to `errors.ts`).
- [ ] Implement with every key row defaulted to `agent`. Commit `feat(ssh): plan an OpenSSH config import into
      hosts.yaml`.

### Task 5: Plan — keys, jumps, duplicates

**Files:** modify `plan.ts`, `plan.test.ts`.

- [ ] Test first:
  - M4: one key row per distinct expanded `IdentityFile` path, with its hosts; the `ssh_key_id_ed25519`
    proposal; characters outside `[A-Za-z0-9_]` → `_`; a proposal clashing with `existingSecretNames` → `_2`; a
    `%r` token → not mapped, a note, its hosts fall back to the group auth; several `IdentityFile`s → the first
    is used, a note; the group auth is the `Host *` key row when `Host *` names a key, else `agent`; `ref`s are
    opaque (not paths).
  - M5: `ProxyJump bastion` → bastion's id; `ProxyJump a,b` → target.jump = b and b.jump = a;
    `ProxyJump u@gw.example.com:2222` → a `created-for-jump` host with user and port; a hop that already has a
    different jump → the target without a jump and a note naming the chain; `ProxyJump none` → no jump.
  - M6: `ProxyCommand ssh -W %h:%p bastion` and `ssh -q -W %h:%p bastion` → a jump; `nc -X …` → skipped with
    the "will probably not connect" note.
  - M3: an imported host with the same `(address, port, user)` as an existing one → `duplicate` with
    `duplicateOf`; a jump to that alias points at the existing id.
- [ ] Implement. Commit `feat(ssh): map keys, jump chains and duplicates in the config import plan`.

### Task 6: Apply

**Files:** create `packages/ssh/src/openssh-config/apply.ts`, `apply.test.ts`.

- [ ] Test first, `applySshConfigImport(plan, choices, existing)`: `existing` entries serialise identically
      after the merge; the group is appended last at top level with the chosen name; `importDuplicates` brings a
      duplicate in under its own id; key choices produce `{ agent: true }`, `{ key: '${secret:x}' }` and, for a
      key marked encrypted by the caller, `passphrase: '${secret:x_passphrase}'`; a choice naming an unknown
      `ref` throws; an `existing` changed since the plan so that an id now clashes → `ssh-import-stale`; every
      result passes `parseHostsFile(serializeHostsFile(result))` (a loop over the fixtures).
- [ ] Implement. Run `pnpm --filter @wirebench/ssh test` and the layer test. Commit `feat(ssh): merge a config
      import plan into hosts.yaml`.
- [ ] Open PR 1 (`feat/ssh-config-import-model`) referencing the issue; merge when green.

## PR 2 — desktop

### Task 7: Wire types and channels

**Files:** modify `apps/desktop/src/shared/ssh-wire.ts`, `apps/desktop/src/shared/ipc.ts`; tests beside the
existing ssh wire tests.

- [ ] Schemas: `sshImportPreviewRequestSchema` (`{ source: 'user-config' | 'pick' }`),
      `sshImportPreviewResponseSchema` (a preview or `{ cancelled: true }`; key rows **without** `path`),
      `sshImportApplyRequestSchema` (`previewId`, `groupName` min 1, `importDuplicates`, `keys: { ref, choice
      }[]`), `sshImportApplyResponseSchema` (the list-hosts answer plus `groupId`, `stored`). A test asserts a
      `path` on a key row does not survive the preview schema.
- [ ] Add the `ssh.importPreview` and `ssh.importApply` channels. Commit `feat(desktop): channels for the SSH
      config import`.

### Task 8: Import service in main

**Files:** create `apps/desktop/src/main/ssh-import.ts` and its unit test beside the other main ssh tests;
modify the ssh area's main registration to bind the two channels.

- [ ] Test first with fakes for `pickFile`, the file system, `HostsService`, `SshSecretsService` and a clock:
  - `user-config` reads `<home>/.ssh/config`; `pick` uses the picker; a cancelled pick → `{ cancelled: true }`.
  - File guard: not a regular file, over 1 MiB, unreadable → `ssh-config-unreadable` with the display path and
    errno.
  - A preview is held per `WebContents` for 10 minutes; another window's id or an expired id →
    `ssh-import-expired`; a new preview replaces the old.
  - Apply: an `agent` row never opens its key file (the fake fs records reads); a `store` row reads the key
    through the guard (realpath, regular file, ≤ 64 KiB, `-----BEGIN … PRIVATE KEY-----`) and hands the text
    only to `SshSecretsService.set`, and the text appears in no return value or thrown error (marker test); a
    `.pub` file → `ssh-key-unreadable`; an encrypted key sets the passphrase reference; a failed key → nothing
    written and `details.stored` lists what was stored; `hosts.yaml` changed between preview and apply so ids
    clash → `ssh-import-stale`; success writes once through `HostsService.save`.
- [ ] Implement; convert `SshModelError` with `asWirebenchError`. Commit `feat(desktop): preview and apply an SSH
      config import in main`.

### Task 9: Dialog, command, entry points

**Files:** create `apps/desktop/src/renderer/features/ssh/import-dialog.tsx` and its test; modify
`renderer/commands/register-ssh-commands.ts`, `shared/commands.ts`, `shared/command-catalog.ts`,
`features/ssh/hosts-view.tsx` (empty state and toolbar menu) and `features/ssh/hosts-store.ts` (select the new
group after an import).

- [ ] Component test first: step 1 offers the default and "Choose a file…"; step 2 renders the hosts (with the
      "changed" id mark and the duplicate switch), key rows defaulting to "Use the SSH agent" under the consent
      line, "Not imported" by keyword and `file:line`, and "Options Wirebench does not use" with counts; the
      secret name field refuses an invalid name; Import sends `ref`s only; `ssh-import-expired` and
      `ssh-import-stale` return to step 1 with a message.
- [ ] Command `ssh.importConfig`, "Hosts: Import from SSH Config…", category Hosts; registered only when the area
      is enabled (extend the existing switched-off test). Run `pnpm docs:commands`.
- [ ] Commit `feat(desktop): Hosts: Import from SSH Config dialog`.

### Task 10: e2e and docs

**Files:** create the e2e spec beside the existing SSH e2e; modify the Hosts docs (find them with
`grep -rl "hosts.yaml" site docs`).

- [ ] e2e (CI only): a temp home with `.ssh/config` (an alias pointing at the in-process `ssh2` fixture server,
      a `Host *` with `User`), a key generated in the test, `WIREBENCH_E2E_FILE_DIALOG_PATH` set. Run the command,
      choose "store" for the key, import, see the group and the host, open the host dialog and see key auth with
      the secret name, connect, trust, `echo hi` → `hi`.
- [ ] Docs: "Importing from an SSH config": the mapping table, what is skipped, how keys are handled. Run
      `pnpm check:banned-terms`.
- [ ] Commit `docs: importing hosts from an SSH config`. Open PR 2 (`feat/ssh-config-import-desktop`); merge when
      CI is green; move the issue to Done.

## Spec coverage

| Spec section | Tasks                 |
| ------------ | --------------------- |
| P1           | 1, 2                  |
| P2           | 3                     |
| P3, M1–M8    | 4, 5                  |
| P4           | 4, 5, 6               |
| P5           | 7, 8, 9               |
| P6           | 4, 6, 8               |
| P7, P8       | 1, 4, 8               |
| Testing      | every task; 10 is e2e |
| Docs         | 9, 10                 |
