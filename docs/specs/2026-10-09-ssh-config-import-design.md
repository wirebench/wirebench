# SSH area: import hosts from an OpenSSH config file — design

**Issue:** #364 · **Date:** 2026-10-09 · **Status:** draft (for owner review)

Builds on: the SSH area design (`docs/specs/2026-10-08-ssh-area-design.md`, the `hosts.yaml` model D2 and
amendments A1–A7), [ADR-0004](../adr/0004-secrets-outside-project-files.md) (secrets outside project files),
[ADR-0005](../adr/0005-renderer-path-safety.md) (renderer paths are containment-checked or dialog-proven) and
[ADR-0021](../adr/0021-a-desktop-area-is-a-module-behind-one-interface.md) (a desktop area is a module), and the
importer conventions of `docs/specs/2026-10-04-more-importers-design.md` (never overwrite, report everything
not mapped).

## Objective

Most people who would use the Hosts view already describe their machines in an OpenSSH client config file:
`~/.ssh/config`, or a file their current client can write in that format. Re-typing twenty hosts, their users,
ports, keys and bastions into the host dialog is the cost of trying the area. This design reads such a file,
shows what it would become and what it cannot carry, and, on the user's go-ahead, adds the hosts to the
workspace's `hosts.yaml` in one new group.

**User stories.**

- I run **Hosts: Import from SSH Config…**, keep the default `~/.ssh/config`, and see a table of my twelve
  hosts with their address, user, port, jump host and how they will authenticate, plus a list of what will not
  come across (a `Match` block, two `LocalForward` lines). I click Import and a group "SSH config" appears in
  the Hosts view with the twelve hosts; `bastion` is the jump host of the four that used `ProxyJump bastion`.
- My hosts use `~/.ssh/id_ed25519`. The import asks, per key file, whether to store the key as a workspace
  secret, use the SSH agent, or point at a secret I already have. I pick "store", and the hosts get
  `auth: { key: '${secret:ssh_key_id_ed25519}' }`; the key text went from my disk into the secret store and was
  never shown or sent to the window.
- I import the same file again a month later after adding two hosts. The ten already there are listed as
  "already in hosts.yaml, skipped"; only the two new ones are added.

## Decisions (proposed; the owner rules on the open ones in review)

| #   | Question                                   | Proposal                                                                                                                                                                                                       |
| --- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | Which source formats?                      | OpenSSH client config (`ssh_config(5)`) only. It is the format every SSH client on every platform reads or can write; no client-specific export format is parsed.                                              |
| I2  | Where does the parser live?                | `packages/ssh/src/openssh-config/`: pure, no Electron, no engine, file access injected. The desktop main process is the only consumer in this slice.                                                            |
| I3  | Which surfaces?                            | Desktop only: the command **Hosts: Import from SSH Config…** and an entry in the Hosts view's empty state and toolbar menu. No CLI and no MCP tool, per R4 of the SSH area design (they wait for the model). |
| I4  | Where do imported hosts go?                | Into one **new top-level group** per import, never into an existing group, never editing an existing entry.                                                                                                     |
| I5  | How are private keys handled?              | Asked per key file, never silent. Nothing is read until the user picks "store as secret" for that file and clicks Import. The key text goes main → secret store; it never crosses IPC.                            |
| I6  | Is anything written before the report?     | No. Preview first (read the config, build the plan, show the report); write only on Import.                                                                                                                    |
| I7  | What about the config's known-hosts files? | Not imported. Trust stays first-use with a click (D9); importing trust decisions from a file would bypass that. A later issue may offer it with its own review.                                                |

## Non-goals

- Writing an OpenSSH config from `hosts.yaml` (export), or keeping the two in sync.
- `Match` blocks, `ProxyCommand` beyond the one recognised form (M6), port forwarding options (S4 owns
  forwarding), agent forwarding, `CertificateFile`, `PKCS11Provider`, `KnownHostsCommand`, `CanonicalizeHostname`.
- Following `Include` more than one level deep.
- Importing the known-hosts files named by `UserKnownHostsFile` / `GlobalKnownHostsFile` (I7).
- Any client's own export format, cloud inventories, or a CLI `wirebench hosts import` (I3; a follow-up once R4
  is lifted, and cheap because the parser is in `packages/ssh`).

## Design

### P1. Reading the file

`loadSshConfig(path, io) → SshConfigDocument`, in `packages/ssh/src/openssh-config/load.ts`:

```ts
interface SshConfigIo {
  readonly home: string; // expands ~ and %d
  readFile(path: string): Promise<string>; // utf8; the caller enforces type and size (P7)
  glob(pattern: string): Promise<readonly string[]>; // for Include
}
interface SshConfigLine {
  readonly file: string; // as shown to the user: `~/.ssh/config`, `~/.ssh/conf.d/work`
  readonly line: number; // 1-based
  readonly keyword: string; // lower-cased
  readonly args: readonly string[];
}
interface SshConfigBlock {
  readonly kind: 'global' | 'host' | 'match';
  readonly patterns: readonly string[]; // for `host`; empty otherwise
  readonly lines: readonly SshConfigLine[];
  readonly at: { readonly file: string; readonly line: number };
}
interface SshConfigDocument {
  readonly blocks: readonly SshConfigBlock[];
  readonly report: SshConfigReport; // lexing and Include entries, merged into the plan's report
}
```

Lexing follows `ssh_config(5)`: one keyword and its arguments per line, keyword case-insensitive, `=` or
whitespace between them, double-quoted arguments may hold spaces, `#` starts a comment at the start of a line or
after whitespace, blank lines ignored. A line that does not lex (an unclosed quote) is skipped and reported by
file and line. Lines before the first `Host` or `Match` form the `global` block.

`Include` (case-insensitive, any number of arguments, globs allowed):

- Relative paths resolve against `~/.ssh/`, as `ssh` does for a user config; `~` expands to `io.home`.
- Followed from the chosen file only. An `Include` inside an included file is skipped and reported ("Include
  nested more than one level: not followed").
- The included file's lines take the place of the `Include` line, so an `Include` inside a `Host` block belongs
  to that block, as in `ssh`.
- A target that does not exist is not an error for `ssh` and is not one here (a note). A target that cannot be
  read is a report warning with its `errno`.
- Every target is read through the same guard as the main file (P7: regular file, size cap).

### P2. Evaluating a host the way `ssh` would

For each **concrete alias** (a `Host` pattern token with no `*`, `?` or leading `!`), compute the effective
value of each supported keyword with OpenSSH's rule: walk the blocks in file order, consider every `global`
block and every `host` block whose patterns match the alias (glob with `*` and `?`; a matching `!pattern`
excludes the block), and keep the **first** value obtained for each keyword. `IdentityFile` is the exception,
as in `ssh`: values accumulate in order. `match` blocks are skipped (M8).

`Host *` is evaluated by the same rule against a sentinel alias that only `*`-only patterns match, giving the
**all-hosts values**: what every alias gets unless an earlier, more specific block sets it. This is the input to
the group defaults (M1).

### P3. Mapping

| OpenSSH                                   | `hosts.yaml`                                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Host` alias (each concrete token)        | one host: `name` = the alias as written; `id` = slug (M2)                                                                                                      |
| `HostName`                                | `address`; `%h` is replaced by the alias, `%%` by `%`; any other `%` token → the host is skipped and reported. No `HostName` → `address` = the alias.           |
| `Port`                                    | `ssh.port`                                                                                                                                                     |
| `User`                                    | `ssh.user` (a `%` token other than `%%` → not mapped, reported; the host may end incomplete, M7)                                                              |
| `ProxyJump`                               | `ssh.jump` (M5); `none` → no jump                                                                                                                              |
| `ProxyCommand ssh [-q] -W %h:%p <hop>`    | treated as `ProxyJump <hop>` (M6); any other `ProxyCommand` → skipped, reported                                                                                |
| `IdentityFile`                            | `ssh.auth` from the user's choice for that key file (M4)                                                                                                       |
| `ServerAliveInterval`                     | `ssh.keepAlive` (seconds; `0` stays `0`)                                                                                                                       |
| `ConnectTimeout`                          | `ssh.connectTimeout` (seconds; `0` or `none` → not set)                                                                                                        |
| `Host *` and the global block             | the new group's `ssh` (M1)                                                                                                                                     |
| other `Host` patterns (`*.prod`, `web-?`) | not hosts; their values reach the concrete aliases they match through P2 and land on those hosts                                                              |
| `Match`                                   | skipped, reported with file and line (M8)                                                                                                                      |
| options with no meaning here¹             | ignored, listed once under "Options Wirebench does not use" with a count; no effect on the import                                                             |
| anything else                             | skipped, reported under "Not imported" by keyword, file and line, never the value (P8). Examples: `LocalForward`, `ForwardAgent`, `RemoteCommand`, `SendEnv`. |

¹ `IdentitiesOnly`, `IdentityAgent`, `AddKeysToAgent`, `UseKeychain`, `ServerAliveCountMax`,
`StrictHostKeyChecking`, `UserKnownHostsFile`, `HostKeyAlias`, `LogLevel`, `Compression`,
`PreferredAuthentications`.

**M1. Group defaults from `Host *`.** The import creates one group (I4): `id` `ssh-config` (uniqued as in M2),
`name` "SSH config" (editable in the dialog). For each supported field, the group's value is the all-hosts value
from P2, if there is one. A host then writes a field only when its effective value differs from the group's;
when it is the same it inherits. This reproduces `ssh`'s first-match result exactly, whatever order the file
puts `Host *` in, while turning the common case (`Host *` at the end with `User` and `IdentityFile`) into one
set of group defaults.

**M2. Ids.** `id` = the alias lower-cased, every run of characters outside `[a-z0-9]` turned into one `-`,
leading and trailing `-` removed; empty (an alias of only symbols) → `host`. A clash, with an id already in
`hosts.yaml` or earlier in the same import, appends `-2`, `-3`, … The report lists every changed id beside its
alias. `name` keeps the alias exactly, so ⌘P finds the host by the name the user types today.

**M3. Duplicates of existing hosts.** An imported host whose resolved `(address, port, user)` equals a host
already in `hosts.yaml` is a **duplicate**: by default it is not imported and the report lists it as "already in
hosts.yaml as <id>". The dialog has an "Import anyway" switch per duplicate. A jump that names a skipped
duplicate points at the existing host's id instead. Ids of existing entries are never changed and no existing
entry is edited (I4). A second import of the same file therefore adds only what is new, in a group
`ssh-config-2`.

**M4. Keys.** Each distinct `IdentityFile` path (after `~` and `%d` expansion; any other `%` token → that key
is "not mapped" and its hosts fall back to the group's auth) is one **key row** in the dialog, listing the hosts
that use it. The row offers exactly one of:

- **Use the SSH agent** → `auth: { agent: true }`. This is the row's **default** (open question 1), so nothing
  is read unless the user changes it.
- **Store as workspace secret** `<name>`: the name is proposed as `ssh_key_<basename>` with every character
  outside `[A-Za-z0-9_]` turned into `_` (so it satisfies `SECRET_NAME_PATTERN`), and is editable. A name that
  already resolves in the workspace (local, team or source, as `ssh.secretNames` reports) is never overwritten:
  the proposal takes `_2`, `_3`, …, and typing an existing name turns the row into "use existing".
- **Use an existing secret** (a picker over `ssh.secretNames`, as in the host dialog).

When `ssh` would try several `IdentityFile`s, the first is used and the report says the rest were not carried
(the model holds one key). A key the user chose to store is read at Import (P7). If it is encrypted (a PEM
`Proc-Type: 4,ENCRYPTED` header, or an OpenSSH key whose cipher is not `none`), `auth` gets
`passphrase: '${secret:<name>_passphrase}'` and the result tells the user to set that secret in the host dialog;
the import never asks for or stores a passphrase.

A host with no `IdentityFile` after P2 inherits the group's auth: the `Host *` key row's choice if `Host *` names
a key, else `{ agent: true }`, the closest equivalent of `ssh` offering the agent's keys by default. The report
says which hosts authenticate through the agent.

**M5. Jump hosts.** `ProxyJump a,b` means: reach `a`, from it reach `b`, from it reach the target. In
`hosts.yaml` the chain is followed through each hop's own `jump`, so the import writes `target.jump = b` and
needs `b.jump = a`.

- A hop that names an imported alias maps to that host's id. A hop that names nothing imported
  (`user@gw.example.com:2222`) becomes a new host in the same group: `id` from its host name (M2), `address`,
  and `user`/`port` when the hop gives them; the report lists it as "created for a jump".
- If a hop already has a different jump of its own (from its own `ProxyJump` or an earlier chain), the chain
  cannot be expressed: the target is imported **without** a jump and the report names the chain that did not
  fit. A result that would loop is refused the same way (the model's `ssh-jump-cycle` check runs on the merged
  file, P4).

**M6. `ProxyCommand`.** Only the form equivalent to a jump is recognised: `ssh [-q] -W %h:%p <hop>` (`-W` and
`-q` in either order, nothing else on the line), mapped as `ProxyJump <hop>`. Every other `ProxyCommand` is
skipped; the host is still imported without it and flagged in the report as "will probably not connect the way
it does today".

**M7. Incomplete hosts.** A host with no `User` after M1 (none on the host, none from `Host *`) is imported and
is incomplete in the model's sense (`incomplete: { field: 'user' }`); the Hosts view already marks such hosts and
the report lists them. The import does not fill in the local account name: `hosts.yaml` is shared, and the local
account name is a fact about this machine.

**M8. `Match`.** A `Match` block's lines are applied to no host, because its conditions (`exec`, `user`,
`localuser`, `canonical`, …) depend on runtime state. The report lists each `Match` block by file and line with
how many lines it held. Hosts it might have changed are imported from the other blocks alone.

### P4. The import plan

The pure core, in `packages/ssh/src/openssh-config/plan.ts`:

```ts
interface SshConfigImportInput {
  readonly document: SshConfigDocument;
  readonly existing: HostsFile; // the workspace's hosts.yaml as loaded
  readonly existingSecretNames: readonly string[];
}
interface SshConfigImportPlan {
  readonly group: GroupEntry; // the proposed new group with its hosts, every key row at its default
  readonly hosts: readonly PlannedHost[]; // one per alias and per created hop
  readonly keys: readonly PlannedKey[]; // one per distinct IdentityFile path
  readonly report: SshConfigReport;
}
interface PlannedHost {
  readonly alias: string;
  readonly id: string;
  readonly idChangedFrom?: string; // the plain slug, when M2 had to suffix it
  readonly status: 'new' | 'duplicate' | 'created-for-jump' | 'skipped';
  readonly duplicateOf?: string;
  readonly reason?: string;
}
interface PlannedKey {
  readonly ref: string; // opaque, stable within this plan; the renderer names keys by it, never by path
  readonly path: string; // absolute; stays in main (the wire form drops it)
  readonly display: string; // `~/.ssh/id_ed25519`, for the dialog
  readonly hosts: readonly string[];
  readonly proposedSecret: string;
}
interface SshConfigReport {
  readonly skipped: readonly { file: string; line: number; keyword: string; why: string }[];
  readonly ignored: readonly { keyword: string; count: number }[];
  readonly notes: readonly string[];
}

function planSshConfigImport(input: SshConfigImportInput): SshConfigImportPlan;
function applySshConfigImport(plan: SshConfigImportPlan, choices: SshConfigImportChoices, existing: HostsFile): HostsFile;
```

`applySshConfigImport` returns the merged file: `existing` unchanged plus the group with the user's choices
(group name, which duplicates to import anyway, each key row's auth), with duplicates and id clashes recomputed
against `existing`. The result goes through `parseHostsFile(serializeHostsFile(…))`, the same full validation
`HostsService.save` does, so a plan that would break the model (a cycle, a bad id) fails before any write.

### P5. Desktop: two channels, a dialog, a command

Channels, under `ssh.` in `shared/ipc.ts`, registered by the SSH area's main half:

| Channel             | Request                                                                          | Response                                                                                     |
| ------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ssh.importPreview` | `{ source: 'user-config' \| 'pick' }`                                            | `{ previewId, source, group, hosts, keys, report }` (keys without `path`), or `{ cancelled: true }` |
| `ssh.importApply`   | `{ previewId, groupName, importDuplicates: string[], keys: { ref, choice }[] }`  | the `ssh.listHosts` answer after the write, plus `{ groupId, stored: string[] }` (secret names set) |

- `source: 'user-config'` means main computes `join(os.homedir(), '.ssh', 'config')` itself; `'pick'` runs the
  native open-file picker (`pickFile` in `main/native-dialogs.ts`, which records the read pick and honours
  `WIREBENCH_E2E_FILE_DIALOG_PATH`). The renderer never sends a path (ADR-0005). `source` in the answer is the
  `~/`-relative display form.
- `previewId` names a plan held in main for the asking `WebContents` for 10 minutes; key `ref`s map to absolute
  paths only inside main. An unknown or expired id, or one from another window, is `ssh-import-expired`, and the
  dialog previews again. One preview per window; a new preview replaces the old.
- `choice` is `{ kind: 'agent' } | { kind: 'existing', secret: string } | { kind: 'store', secret: string }`.
  Secret names are checked against `SSH_SECRET_NAME_PATTERN` without echoing a bad one (as `ssh.setSecret`).
- Apply: re-read `hosts.yaml` (`HostsService.invalidate()` then load), merge (P4); if the plan's chosen ids now
  clash with the current file, fail with `ssh-import-stale` and the dialog previews again. Then read and store
  each `store` key (P7) through `SshSecretsService.set` (workspace scope, A5), and only then write the merged
  file through `HostsService.save`. Keys are stored first, so a written host never names a secret that failed
  to store; if a store fails, nothing is written and the secrets already stored by this apply are listed in the
  error's `details.stored` (they are not deleted: they hold the user's own keys).

Renderer, in `apps/desktop/src/renderer/features/ssh/`:

- `import-dialog.tsx`, a Radix dialog (A3's pattern). Step 1: "Read `~/.ssh/config`" (default) or "Choose a
  file…". Step 2, the report: the group name field; the hosts table (alias, id with a "changed" mark, address,
  user, port, jump, auth, status) with an "Import anyway" switch on each duplicate; the key rows (M4) under the
  line "Wirebench reads a key file only if you choose to store it, and only when you click Import"; "Not
  imported" (keyword, file:line, why); "Options Wirebench does not use" (keyword × count); notes. Buttons:
  **Import n hosts**, Cancel. Step 3: a toast with the count and stored secret names, and the new group expanded
  and selected in the tree.
- Command `ssh.importConfig`, label **Hosts: Import from SSH Config…**, category Hosts, added to
  `shared/commands.ts` and `COMMAND_CATALOG`; also offered on the Hosts view's empty state ("Import from SSH
  config") and its toolbar menu. Registered only while the `ssh` area is enabled.

### P6. Errors

| Code                    | When                                                                            | The message says                                 |
| ----------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------ |
| `ssh-config-unreadable` | the chosen config cannot be read, is not a regular file, or is over the cap     | the display path and the errno or reason         |
| `ssh-config-empty`      | no concrete `Host` alias anywhere                                               | that there was nothing to import                 |
| `ssh-import-expired`    | `previewId` unknown, expired or from another window                             | to preview again                                 |
| `ssh-import-stale`      | `hosts.yaml` changed since the preview so the plan's ids now clash              | to preview again                                 |
| `ssh-key-unreadable`    | a key chosen for storing cannot be read or fails P7's checks                    | the display path and reason; never any of its bytes |

A line that does not lex, an `Include` that cannot be read, or a host that cannot be mapped is not an error but
a report entry, and the rest imports. All codes are `WirebenchError`s with `details`; `SshModelError` from
`packages/ssh` crosses through `asWirebenchError`, as A7 describes for the existing codes.

### P7. Security

- **Consent for keys (I5).** Main reads a private key file only when its row's choice is `store` and the user
  clicked Import. The preview never opens a key file; it knows paths only.
- **Key handling.** The read checks, in order: `realpath`, then the target is a regular file, size ≤ 64 KiB, and
  the text starts with `-----BEGIN ` and names a `PRIVATE KEY` (PEM or `OPENSSH PRIVATE KEY`). A `.pub` file or
  anything else is `ssh-key-unreadable` ("not a private key"). The text goes straight to the secret store;
  Wirebench's code keeps no reference after the store call (A6's stance). No channel response, event, log line,
  report entry or error message carries key bytes, and an error never quotes the file.
- **Config handling.** The config and its includes: regular file after `realpath`, ≤ 1 MiB, UTF-8. A config can
  carry secrets in odd places (a password inside a `ProxyCommand`, a token in `SetEnv`), so the report shows
  **keyword, file and line only** for anything not imported, never its value. Mapped values (aliases, host
  names, users, ports) are shown because they are what lands in `hosts.yaml`. A lexer failure says "line N
  could not be read", not the line.
- **Paths (ADR-0005).** The renderer sends no path: the default is computed in main and any other file comes
  from the native picker. `Include` targets and `IdentityFile`s are paths the user's own config names; the
  dialog shows them in `~/`-relative form, and key files are read only with the consent above.
- **Secrets stay references (ADR-0004).** `hosts.yaml` gains only `${secret:NAME}` tokens and `agent: true`; the
  model still refuses a literal (`ssh-literal-secret`). An existing secret's value is never overwritten (M4).
- **No trust import (I7).** Host keys stay trust-on-first-use with a click.

### P8. What the report never contains

Values of skipped or ignored options, any text of a line that failed to lex, key file contents, and passphrases.
A unit test feeds a config whose skipped and malformed lines carry a marker string and asserts the marker
appears nowhere in the plan, the report, the wire answer or an error.

## Testing

- `packages/ssh` unit, `openssh-config/*.test.ts`: lexing (`=` separator, quotes, comments, case-insensitive
  keywords, an unclosed quote reported by line); `Include` (relative to `~/.ssh`, glob, inside a `Host` block, a
  missing target as a note, a nested Include not followed); evaluation (first value wins, `Host *` before and
  after specific blocks, `!` negation, `?` globs, `IdentityFile` accumulates); every row of P3; M1 factoring
  (fields equal to the group's are omitted, different ones written); M2 slugs and clashes; M3 duplicates and a
  jump redirected to an existing host; M5 chains (two hops, a hop created for a jump, a chain that does not fit, a
  loop); M6 recognised and unrecognised `ProxyCommand`; M7 incomplete hosts; the P8 marker test; every merged
  file passes `parseHostsFile`.
- Fixture configs under `packages/ssh/test/fixtures/openssh-config/`, hand-written with generic host names.
- Desktop unit: the import service (a preview is held per window and expires; another window's id is refused;
  `user-config` resolves under the home directory; an `agent` row never opens its key file; a `store` row reads
  it and hands the text only to the secret store; a key failure writes nothing; a stale `hosts.yaml` refuses the
  apply); the command is registered and catalogued.
- Desktop e2e (CI only): a temp home with `.ssh/config` and a throwaway key generated in the test, the picker
  answered by `WIREBENCH_E2E_FILE_DIALOG_PATH`. Run the command, see the report, store the key, import, see the
  group and its hosts, open one host's dialog and see key auth with the secret name, then connect that host to
  the existing in-process `ssh2` fixture server to prove the stored key works.

## Success criteria

- A typical `~/.ssh/config` (aliases, `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`, a `Host *` block)
  imports with no hand edits, and every imported host connects the way `ssh <alias>` does once its key is stored.
- Nothing is written, and no key file is opened, before the user clicks Import.
- Every line not carried across appears in the report with its file and line, and no value of such a line
  appears anywhere.
- Re-importing the same file adds nothing but a report of duplicates.

## Docs

- The Hosts docs (beside the `hosts.yaml` format) gain "Importing from an SSH config": the P3 table, what is
  skipped, and how keys are handled.
- Command catalog regenerated (`pnpm docs:commands`).

## Delivery

Two pull requests, each green on `pnpm check`:

1. `packages/ssh`: lexer, loader with `Include`, evaluator, `planSshConfigImport`, `applySshConfigImport`,
   fixtures and unit tests. No desktop change.
2. Desktop: the import service and the two channels, the dialog, the command and Hosts view entries, unit
   tests, the e2e and the docs.

## Open questions for the owner

1. Default key row choice: **agent** (proposed; nothing is read unless the user changes it) or **store** (fewer
   clicks, still behind the Import click)?
2. One new group per import (proposed), or also a "merge into an existing group" option for re-imports?
3. Should imported hosts carry a tag (`ssh-config`) so they stay findable after being moved between groups?
