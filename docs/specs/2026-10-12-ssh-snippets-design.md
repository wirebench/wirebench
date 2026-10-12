# SSH area slice 2: snippets — design

**Issue:** #356 · **Date:** 2026-10-12 · **Status:** approved in session 2026-10-12 (design sections signed
off, spec written from them)

Builds on: the SSH area design (`docs/specs/2026-10-08-ssh-area-design.md`, slice S2 in its table, the host
model D2, security D9 and the amendments A1–A7), the SFTP design (`docs/specs/2026-10-12-ssh-sftp-design.md`,
the slice built beside this one), the secret sources design (`docs/specs/2026-10-05-secret-sources-design.md`,
`${secret:name}` as the only way to point at a value),
[ADR-0021](../adr/0021-a-desktop-area-is-a-module-behind-one-interface.md) (a desktop area is a module),
[ADR-0002](../adr/0002-engine-in-main-process.md) (secrets and network work stay in main) and
[ADR-0004](../adr/0004-secrets-outside-project-files.md) (secrets outside project files).

## Objective

A workspace keeps the commands its team types again and again as **snippets**, in a file beside `hosts.yaml`,
grouped into packages. A user runs one in the terminal in front of them, or on several hosts, a group or a tag
at once: each host's terminal is reused or opened, and the script is typed into it as if the user had typed
it. A snippet can ask for values when it runs and can use `${secret:name}`; the secret's value is typed by the
main process, never reaches the renderer, and shows as `••••` on screen. Snippets are offered from ⌘K, ⌘P, a
picker inside the terminal, and as a suggestion while the user types a command a snippet starts with.

## Decisions (owner rulings, 2026-10-12)

| #   | Question                           | Ruling                                                                                                                                                                                                                                                             |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Where do snippets live?            | In `snippets.yaml` beside `hosts.yaml`, shared with the workspace (git or server sync). No per-machine personal store; personal snippets go in a personal workspace.                                                                                                 |
| R2  | How are they organised?            | One level of packages, plus snippets in no package. Tags on snippets for filtering. No nested folders.                                                                                                                                                              |
| R3  | Variables                          | `${name}` like the rest of Wirebench, but only names the snippet declares under `variables:` are replaced; any other `${…}` reaches the shell untouched. The run asks for the values, with defaults and the last value used.                                        |
| R4  | How does a snippet run?            | Typed into terminals only: the focused one, or each chosen host's terminal (an open one reused, else a new tab that connects first). No background (non-interactive) run in this slice. Broadcast typing into split panes stays with S4 (#358).                   |
| R5  | `${secret:name}` in a typed script | Main expands and writes it; the line is typed with a leading space so shells that skip such lines keep it out of history; the value is masked in that session's output for the rest of the session. The run dialog says history may still keep it on other shells. |
| R6  | When does a run ask first?         | When it targets two or more hosts, any protected host, or a snippet marked `confirm: true`. One unprotected terminal runs at once (after the variables form, when there is one).                                                                                   |
| R7  | Protected hosts                    | `hosts.yaml` gains `protected: true` on a group or a host, inherited like the other fields. A run touching a protected host always confirms and names it.                                                                                                          |
| R8  | Does a run press Enter?            | Per snippet: `enter` (default `true`). `enter: false` types the script and leaves it at the prompt.                                                                                                                                                                |
| R9  | In-terminal help                   | A picker on a key inside the terminal, and inline suggestions: a dimmed ghost of the rest of a snippet's first line when what the user typed is its start; Tab accepts while a ghost shows. A preference turns suggestions off.                                     |
| R10 | Layout                             | A fourth entry, **Snippets**, in the SSH menu, shown in the area's fixed first tab: packages as sections of rows, the editor in the right panel, as the Hosts view.                                                                                                 |
| R11 | Surfaces                           | Desktop only, as S1's R4. CLI and MCP wait for a separate ruling.                                                                                                                                                                                                  |

## Non-goals

- CLI and MCP surfaces (R11).
- Running a snippet in the background on many hosts with a results table (exit codes, collected output). R4
  keeps runs typed into terminals; a background run is a later ruling.
- Broadcast input to several panes at once (S4, #358). A multi-host run types the same script into several
  terminals once; it does not mirror further keystrokes.
- Nested packages, per-machine personal snippets, importing snippets from other clients.
- Shell quoting of variable or secret values: values are inserted as written; the script is responsible for
  quotes.
- Detecting the remote shell. Leading-space history skipping is a convention of bash (`ignorespace`) and zsh
  (`HIST_IGNORE_SPACE`); other shells may keep the line (R5).
- Audit entries: amendment A1 of the SSH area design still holds (no desktop activity log yet).

## Facts this design rests on

- `apps/desktop/src/main/hosts-service.ts` owns `hosts.yaml` (amendment A2): it reads `<tree>/hosts.yaml`,
  caches it per window, writes with `writeFileAtomic`, and reports a file that does not parse as a problem on
  the answer, not an exception. Secrets travel to the renderer as names only.
- `apps/desktop/src/main/ssh-service.ts` owns the sessions: one per terminal, owned by the `WebContents` that
  opened it; `write` refuses a foreign or dead session; `onData` becomes the `ssh.data` event (base64). The
  secret getter for a window is `deps.secretsFor(sender)`, the chain of amendment A5.
- The SSH sidebar (`renderer/features/ssh/hosts-view.tsx`) is a menu of `SshHomeView`
  (`'hosts' | 'keychain' | 'known-hosts'`, in `hosts-store.ts`); the entry is shown in the fixed first tab
  (`ssh-home.tsx`). Host details and edits use a push-layout right panel.
- The terminal tab (`renderer/features/ssh/terminal-tab.tsx`) uses `@xterm/xterm` 6 with
  `allowProposedApi: true`, a custom key handler (`attachCustomKeyEventHandler`), `onData` to `ssh.write`, and
  the paste guard (`paste-guard.ts`, `preferences.terminal.confirmMultilinePaste`). xterm reports whether the
  remote program turned on bracketed paste (`terminal.modes.bracketedPasteMode`) and whether the alternate
  screen is active (`terminal.buffer.active.type`).
- The palette has a host-picker mode (`command-palette.tsx`, `mode: 'hosts'`, from `ssh.connectPalette`) and
  ⌘P lists hosts beside operations and requests (`quick-open.ts`). SSH commands are registered in
  `renderer/commands/register-ssh-commands.ts`; ids live in `shared/commands.ts` and the catalog.
- `packages/engine/src/redact/literal.ts` has `createSecretBytesMasker`, which masks known values in a whole
  buffer; it keeps no state across chunks.
- `packages/ssh` parses `hosts.yaml` (`model.ts`) and resolves inheritance with provenance (`resolve.ts`); it
  has no engine import (amendment A4) and duplicates the `${secret:NAME}` grammar as one regex pinned by a test.

## Design

### D1. The file: `snippets.yaml`

`snippets.yaml` sits beside `hosts.yaml` in the workspace tree. Its schema, parser and serialiser live in
`packages/ssh/src/snippets.ts`, beside `model.ts`, with no engine import.

```yaml
version: 1
packages:
  - id: deploy
    name: Deploy
    snippets:
      - id: restart-api
        name: Restart API
        tags: [deploy]
        script: sudo systemctl restart api
        confirm: true
      - id: tail-log
        name: Tail service log
        description: Follows a unit's journal
        tags: [logs]
        variables:
          - name: service
            default: api
          - name: lines
            label: Lines to show
            default: '200'
        script: journalctl -u ${service} -n ${lines} -f
snippets:
  - id: call-health
    name: Health with token
    script: |
      curl -s -H "Authorization: Bearer ${secret:api_token}" https://localhost/health
      echo
    enter: true
```

Rules, each enforced by the schema with a `WirebenchError` code (D8):

- `id` (packages and snippets) follows the workspace id grammar `[a-z0-9][a-z0-9-]*` and is unique across the
  whole file (`snippet-duplicate-id`). `name` is free text, required, and can change.
- A snippet holds `id`, `name`, `script` (required, non-empty), and optional `description`, `tags` (strings),
  `variables`, `enter` (default `true`), `confirm` (default `false`). A package holds `id`, `name`,
  `snippets`.
- `variables` is a list of `{ name, label?, default? }`. `name` matches `[A-Za-z_][A-Za-z0-9_]*`, is unique in
  the snippet, and is not `secret` (`snippet-variable-invalid`). `default` is a string.
- In `script`, `${name}` for a declared name is a variable; `${secret:NAME}` is a secret (the duplicated grammar
  of the SSH area design's Boundaries); every other `${…}`, `$name` and `$(…)` is shell text and is never
  touched. A `${secret:…}` with a malformed name is refused (`snippet-secret-invalid`). A `default` may not hold
  a `${secret:…}` token (`snippet-secret-invalid`): a secret is written in the script, not passed as a value.
- Unknown keys are refused, as in `hosts.yaml`. `version` is `1`. The serialiser writes `script` as a block
  scalar when it holds a line break, so diffs stay readable.

`listSnippets(file)` returns a flat list `{ id, name, packageId?, packageName?, tags, firstLine, literalStart,
variables, secrets (names), enter, confirm, lineCount, revision }`, which is what the renderer works with.
`literalStart` is the first line up to its first `${` (what D7 matches); `revision` is a SHA-256 of the
snippet's canonical serialisation, so a run can tell that the snippet it showed is still the one saved.

**Expansion** is a pure function in the same file:

```ts
expandSnippet(snippet, values: Record<string, string>, secrets: Record<string, string>)
  → { text: string; secretValues: string[] }
```

It replaces each declared `${name}` with `values[name]` (falling back to `default`, refusing a missing one with
`snippet-variable-missing`; a value holding a line break or another control character is refused with
`snippet-value-invalid`, so a value can never type an extra command line) and each `${secret:NAME}` with `secrets[NAME]`, in one left-to-right pass so a value
that itself contains `${…}` is never expanded again. Line endings become `\n`; one trailing line break is
dropped.

### D2. `protected` hosts (R7)

`hosts.yaml` (SSH area D2) gains an optional boolean `protected` on a group and on a host. It is inherited root
to leaf like an `ssh` field: a nearer `protected: false` lifts a group's `true`. `resolveHost` reports it with
provenance (`ResolvedHost.protected: Provenance<boolean>`, default `false` from `'default'`). The host dialog
gains a **Protected** switch with the inherited value shown greyed with its source and an Override switch, as
the other inherited fields; the host card and the details panel show a small shield on a protected host. The
file stays `version: 1`: the field is optional and a file without it reads as before.

### D3. Main: `SnippetsService` and channels

`apps/desktop/src/main/snippets-service.ts`, created per window beside `HostsService` (same `treeDir`, same
cache and `invalidate` on a workspace switch, same atomic write, same "a file that does not parse is a problem
on the answer" stance; problems show in the Snippets view and the Problems tab with source `snippets`).

Channels, under `ssh.` in `shared/ipc.ts`, schemas in `shared/snippets-wire.ts`:

| Channel              | Request                                                      | Response / notes                                                                                                       |
| -------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `ssh.listSnippets`   | `{}`                                                         | `{ file, snippets, problems }`: the file as written and the flat list (D1). Scripts carry secret tokens, never values. |
| `ssh.saveSnippets`   | `{ file }`                                                   | Validates, writes `snippets.yaml` atomically, answers the reloaded model.                                              |
| `ssh.runSnippet`     | `{ sessionId, snippetId, revision, values, bracketed, enter?, skip? }` | Expands the **saved** snippet and writes it to the session (D4). `{}`.                                       |
| `ssh.previewSnippet` | `{ snippetId, values }`                                                | `{ text, revision }` with every secret shown as `••••`: what the run dialog shows. Never resolves a secret. |

`ssh.runSnippet` reads the snippet by id from the window's saved file; the renderer never sends script text to
be run, so main only ever types secrets into scripts the workspace holds. `enter` can only turn the snippet's
own setting off (an inline accept, D7, never presses Enter for the user). `revision` is the one the renderer
showed (from `ssh.previewSnippet` or `ssh.listSnippets`); a saved snippet whose revision differs (a pull or
another window changed it since) is refused with `snippet-changed` and nothing is typed, so a user never
confirms one script and runs another. `skip` is the number of characters
the user already typed (D7). The session must belong to the calling `WebContents` (`ssh-session-unknown`, as
`ssh.write`).

### D4. Typing a snippet into a session

`SshService` gains `runSnippet(sender, request)`:

1. Take the window's secret getter (`deps.secretsFor(sender)`), as a connect does; resolve each secret name the
   snippet uses. A missing one is `secret-missing` with the name, before anything is written.
2. `expandSnippet` (D1). Drop the first `skip` characters, refusing the run (`snippet-prefix-mismatch`) when
   they are not exactly the literal start of the text (D7 only offers literal starts; the check stops a stale
   suggestion from typing the wrong thing).
3. If the snippet uses a secret and `skip` is `0`, prefix one space (R5).
4. Frame the text: when `bracketed` (xterm says the remote program turned bracketed paste on), wrap it in
   `ESC[200~` … `ESC[201~`, so a multi-line script reaches the shell as one block and a line that waits for
   input (a `sudo` prompt) cannot swallow the lines after it. Without bracketed paste, lines are sent joined by
   `\r`, as a paste would be. Then `\r` when `enter` is on.
5. Add the snippet's secret values to the session's masker (D5) **before** writing, then `session.write` the
   bytes. Values are dropped from the closure once written; only the masker keeps them, for the session's
   life, and it is dropped with the session.

### D5. Masking a session's output

`packages/ssh/src/stream-masker.ts`: a per-session `StreamMasker` with `add(values)`, `push(chunk) → Uint8Array`
and `flush() → Uint8Array`. It masks every occurrence of every added value with `••••` (U+2022 × 4) in the
byte stream. A chunk's tail that is a strict prefix of a value is held back and joined to the next chunk; a
held tail is released, unmasked, when the next chunk shows it is not a value, or after 150 ms without data
(so a prompt that happens to end like the start of a secret is not stuck). Nothing is held while no value has
been added, so sessions that never ran a secret snippet pay nothing.

`SshService` pipes `onData` through the session's masker before the `ssh.data` event, so the terminal, its
scrollback, find (#406) and the reconnect replay only ever see masked bytes. Values of any length are
masked; the docs say that a very short secret masks that text everywhere in the session (the renderer never
knows a value's length, so it cannot warn).

Limits, said in the docs: a shell that redraws a long line in pieces (cursor movement inside the value) can
show parts of it; a program that transforms the value (base64, hex) is not masked.

### D6. Running on hosts (renderer)

`apps/desktop/src/renderer/features/ssh/snippets/run.ts` drives a run:

- **Targets** are terminals (session ids) and hosts. A group or a tag is expanded to its hosts when the run
  starts. A host with an open, connected terminal reuses it (the most recently focused one); otherwise a new
  terminal tab opens through the existing connect path (`connect.ts`: trust prompt, sign-in, reconnect rules
  unchanged).
- **Ready**: a new session is written to once it has produced output and then been quiet for 250 ms (the shell
  printed its prompt), or after 10 s, whichever comes first. An already-open terminal is written to at once.
- Each target gets its own `ssh.runSnippet` with that terminal's `bracketed` mode. Targets run in parallel; a
  host that fails to connect, or a run main refuses, is listed in one toast at the end ("Ran on 3 of 4 hosts ·
  api-4: authentication failed"); the others are unaffected.
- **Confirmation** (R6) is part of the run dialog (D9.4), never a second dialog.
- Last-used variable values and last targets are remembered per snippet on this machine
  (`snippets-prefs.ts`, local storage, as `hosts-prefs.ts`). Secret values are never stored.

### D7. Inline suggestions (R9)

`apps/desktop/src/renderer/features/ssh/snippets/suggest.ts` holds a pure line tracker and matcher;
`terminal-tab.tsx` wires them.

- **Tracking.** From the terminal's `onData` (what the user types, not what the host prints), the tracker keeps
  the printable text typed since the last Enter. Enter, Ctrl-C, Ctrl-U and Escape reset it to empty. Any other
  control or escape sequence (arrows, Home/End, Ctrl-A/E/W/R, Tab, Backspace past the start) marks the line
  **unknown** until the next Enter: the shell's line editor may now hold something the tracker cannot see, so
  no ghost is offered. Backspace inside the tracked text removes a character. A paste marks the line unknown.
- **No suggestions** while the alternate screen is active (an editor or pager), while the terminal is not
  connected, or when the preference is off.
- **Matching.** The candidate text of a snippet is the literal start of its script's first line, up to the
  first `${` token. A snippet matches when the tracked text has at least three characters and is a strict
  prefix of its candidate, compared exactly (case included). Ties go to the most recently run snippet, then by
  name.
- **Ghost.** The rest of the first line (tokens shown as written, e.g. `${service}`) is drawn dimmed after the
  cursor with an xterm decoration, with the snippet's name and `Tab` at the right edge. It moves or goes with
  the next keystroke.
- **Accept.** Tab while a ghost shows accepts; otherwise Tab goes to the shell as usual. Accepting runs the
  snippet in this terminal with `skip` set to the tracked text's length and `enter: false` (so the user sees
  the completed command and presses Enter): a snippet with variables first opens the variables form anchored
  to the terminal (D9.4). A multi-line snippet is typed whole, so the user sees all of it before pressing
  Enter. A protected host or `confirm: true` still asks first.
- **Preference** `preferences.terminal.snippetSuggestions` (default on), in the Terminal section of Settings.

### D8. Errors

| Code                       | When                                                              | The message says                                |
| -------------------------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| `snippet-duplicate-id`     | two packages or snippets share an id                              | both paths                                      |
| `snippet-variable-invalid` | a variable name is malformed, repeated or `secret`                | the snippet and the name                        |
| `snippet-secret-invalid`   | a `${secret:…}` name is malformed, or a default holds one         | the snippet and the field                       |
| `snippets-invalid`         | `snippets.yaml` does not parse, fails the schema or can't be read | the path inside the file, or the file and errno |
| `snippet-unknown`          | a run or preview names no saved snippet                           | the id                                          |
| `snippet-variable-missing` | a declared variable has no value and no default                   | the variable                                    |
| `snippet-value-invalid`    | a variable value holds a line break or control character          | the variable                                    |
| `snippet-changed`          | the saved snippet's revision differs from the one shown           | the snippet name                                |
| `snippet-prefix-mismatch`  | `skip` characters are not the literal start of the expansion      | nothing more                                    |

`secret-missing` and `ssh-session-unknown` keep their existing meaning. All are `WirebenchError`s with
`details`. No message ever holds a value.

### D9. Renderer: the Snippets view and dialogs

`apps/desktop/src/renderer/features/ssh/snippets/`.

1. **Menu entry.** `SshHomeView` gains `'snippets'`; the SSH menu lists **Snippets** with its count after Hosts.
2. **Snippets panel** (in the fixed first tab): a heading with the count, a filter box (name, description,
   script, tags, package) with ⌘F, tag chips, and **New snippet** (split button: New snippet, New package).
   Packages are collapsible sections with their counts, then **No package**. Each row: name, first script line
   dimmed, icons for variables, secrets and `confirm`, and on hover **Run** and **Insert** (Insert is Run with
   `enter: false`). Clicking a row opens the right panel; double-click runs. Row menu: Run…, Insert, Edit,
   Duplicate, Move to package…, Copy script, Delete. Package menu: Rename, Delete (refused while non-empty).
   Problems from `snippets.yaml` show above the list, as hosts problems do.
3. **Editor** (push-layout right panel, as host details): name, package picker (with "New package…"), tags,
   description, the script in the app's code editor with `${…}` tokens highlighted (declared variables,
   secrets, and undeclared shell text in three styles), the variables list (add, remove, label, default; a
   token in the script that looks like an undeclared variable offers "Declare `${x}` as a variable"), the
   **Press Enter** and **Always confirm** switches, a secret picker that inserts `${secret:NAME}` from the
   workspace's known secret names (`ssh.secretNames`) with the existing "new secret…" action, and Save / Run
   on…. Every save sends the whole file through `ssh.saveSnippets`; a run uses the saved snippet, so Run on…
   with unsaved changes asks to save first.
4. **Run dialog** ("Run on…"): the variables form (defaults, then last values); targets — the open terminals
   with checkboxes (the focused one ticked), then an "Add host, group or tag" picker whose chips show the hosts
   they expand to; the expanded script from `ssh.previewSnippet` (secrets as `••••`); a note when the snippet
   uses a secret ("Typed with a leading space so most shells keep it out of history; hidden on screen"); every
   protected target named with a warning and its source. The button reads **Run on N hosts**. With one
   unprotected terminal, no variables and no `confirm`, Run skips the dialog. When the snippet has variables
   and nothing else asks, a compact variables form anchored to the terminal is shown instead.
5. **Terminal picker** (`ssh.snippetPicker`, ⌘; inside a terminal tab): a small fuzzy list over the terminal,
   same matcher as ⌘K; Enter runs into this terminal, ⌥Enter inserts.

### D10. Commands and the palette

Ids in `shared/commands.ts` and the catalog, registered by the ssh renderer half: `view.showSnippets`,
`ssh.newSnippet`, `ssh.editSnippet` (takes an id), `ssh.runSnippet` (takes an id; runs into the focused
terminal or opens the run dialog), `ssh.runSnippetPalette`, `ssh.snippetPicker`.

- ⌘K gains **Run snippet…**, opening a second-level list (a new palette mode `'snippets'`, as `'hosts'`),
  fuzzy over name, package, tags and first line. Enter runs into the focused terminal when a terminal tab is in
  front (the dialog when R6 asks), else opens the run dialog.
- ⌘P lists snippets under a **Snippets** heading beside operations, requests and hosts; Enter does as ⌘K's
  list. A switched-off SSH area contributes none.

### D11. Security

- Secret values exist only in main: resolved at run time through the window's secret getter (A5), written to
  the session, kept only by that session's masker, and never in an answer, event, error, log line or the
  renderer's stores. `ssh.previewSnippet` never resolves a secret.
- Main types secrets only into scripts read from the saved `snippets.yaml`, by id, into a session the calling
  window owns. A renderer cannot send its own text to be expanded with secrets.
- Output masking (D5) covers everything the renderer receives from a session after a secret was typed into
  it, including what a reconnect replays.
- History (R5): the leading space is best effort and the run dialog says so.
- A shared workspace cannot run anything by itself: every run starts from a user action, and runs on several
  or protected hosts are confirmed with the targets and the script in view.
- `snippets.yaml` holds no secret values for `${secret:…}` by construction; a literal password pasted into a
  script is the author's mistake, which the existing secret scan reports like any other workspace file.

## Testing

- `packages/ssh` unit: schema accept/refuse for every D1 rule; `listSnippets`; `expandSnippet` (declared vs
  undeclared `${…}`, defaults, missing variable, one-pass substitution, secrets, line endings); `protected`
  inheritance and provenance; `StreamMasker` (value inside a chunk, split across two and three chunks, two
  overlapping values, a held prefix released by the next chunk and by the 150 ms timer, nothing held before
  `add`).
- `packages/ssh` integration: against the fixture's echoing shell, a value written through a masked session
  never appears unmasked in the collected output, in one chunk or byte by byte.
- Desktop unit: `SnippetsService` (missing file is empty, bad file is a problem, save round trip, switch
  invalidates); `runSnippet` (ownership, secret-missing before any write, leading space only with secrets and
  `skip` 0, bracketed framing and `\r` joining, `enter`, `skip` mismatch refused, masker fed before write);
  the line tracker (reset keys, unknown after cursor keys and paste, backspace) and matcher (three characters,
  strict prefix, up to the first token, tie order); target expansion and ready detection in `run.ts` with fake
  sessions.
- Desktop e2e (CI only, `xvfb-run`): against the fixture, create a package and a snippet with a variable in the
  Snippets view, run it into an open terminal and see its output; run a snippet using a secret and see `••••`
  where the value was echoed; run on two hosts and confirm; type the start of a snippet, see the ghost, press
  Tab, see the completed line; ⌘K "Run snippet…" lists it.

## Success criteria

- A workspace's snippets appear on a second machine with the workspace and run there once its secrets are set.
- A snippet using a secret runs without the value reaching the renderer: the renderer's stores, the IPC log
  and the screen show `••••`.
- Running one snippet on a group of hosts opens the missing terminals and types the script into each, once,
  after showing the hosts and the script.
- Typing the start of a known command offers it, Tab completes it, and nothing is offered after the user moved
  the cursor or in an editor.
- Switching the SSH area off removes the Snippets view, its commands, the palette entries and every snippet
  channel.

## Docs

- `site/` docs page "Hosts and terminals" gains a "Snippets" section: the file, variables, secrets and their
  limits (history, masking), running on hosts, protected hosts, suggestions.
- Command catalog regenerated (`pnpm docs:commands`).

## Delivery

Pull requests, in order, each green on `pnpm check` and each a working app:

1. `packages/ssh`: the `snippets.yaml` model, `listSnippets`, `expandSnippet`, `protected` on hosts, and the
   `StreamMasker`, with their tests.
2. `SnippetsService`, `ssh.listSnippets` / `ssh.saveSnippets`, the Snippets view (list, editor, packages), the
   Problems source, the protected switch in the host dialog.
3. `ssh.runSnippet` / `ssh.previewSnippet`, masking in `SshService`, Run and Insert into one terminal, the run
   dialog for one terminal with variables and secrets.
4. Running on several hosts, groups and tags: target expansion, opening terminals, ready detection, the
   confirmation, the result toast.
5. Palette (⌘K mode, ⌘P heading) and the terminal picker.
6. Inline suggestions with the preference.
7. Docs and the e2e.

## Boundaries

- `packages/ssh` stays free of the engine and Electron; the snippet model, expansion and masker are pure Node.
- The renderer never sees a secret value, a session socket or the file system; it names snippets by id.
- Snippets touch neither the hop dialler nor SFTP (S3), nor forwarding and workspaces (S4); a later slice
  extends the ssh module without editing the shell.
