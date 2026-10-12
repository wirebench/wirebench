# Plan: SSH area slice 2 — snippets

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Spec:** `docs/specs/2026-10-12-ssh-snippets-design.md` (issue #356). The plan argues from the spec; read both,
and the SSH area design (`docs/specs/2026-10-08-ssh-area-design.md`, D2, D4, D9 and A1–A7) for the host and
session model.

**Goal:** Snippets kept in `snippets.yaml` beside `hosts.yaml`, in one level of packages, with declared
variables and `${secret:…}`; run (or inserted) into the focused terminal or several hosts, groups and tags with
a confirmation when it matters; secrets typed by main and masked on screen; offered from ⌘K, ⌘P, an
in-terminal picker and inline ghost suggestions.

**Architecture:** Seven pull requests, one implementation issue each, in the spec's delivery order. PR 1 is
`packages/ssh` only: the snippet model and expansion, `protected` on hosts, and a streaming masker. PR 2 adds
`SnippetsService` in main beside `HostsService` and the Snippets view. PR 3 types a snippet into one session
through `SshService` with output masking. PRs 4–6 are renderer: multi-host runs, palette and picker, inline
suggestions. PR 7 is docs and the e2e.

**Tech stack:** TypeScript (ESM, Node ≥ 24), `yaml` and zod 4 (as `model.ts`), vitest (root `vitest.config.ts`
projects `ssh-unit`, `ssh-integration` and the desktop unit project), Electron 44, React 19 + zustand + Radix,
`@xterm/xterm` 6 (decorations need `allowProposedApi`, already on), cmdk, Playwright `_electron` e2e.

## Global constraints

- `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check` green before every commit; one
  commit per task. `pnpm test:perf` before a push. e2e runs in CI only (`pnpm build && xvfb-run -a pnpm test:e2e`);
  local checks headless under `nice`.
- Never name the product that motivated this feature anywhere; `pnpm check:banned-terms` enforces part of this.
- Commits as Mohammed Naami <m.naami@outlook.com>; no `Co-Authored-By`, no `Claude-Session` trailer; PR
  descriptions end with their last section (no generated-by footer).
- `packages/ssh` imports neither `@wirebench/engine` nor Electron (`scripts/engine-layers.test.ts`).
- No channel response, event, log line, error message or renderer store ever holds a secret **value**. Scripts
  cross IPC with `${secret:NAME}` tokens only; `ssh.previewSnippet` never resolves a secret.
- `ssh.runSnippet` runs only a snippet read by id from the window's saved `snippets.yaml`, into a session that
  window owns, and only when the request's `revision` matches the saved one.
- The snippet channels are registered only while the SSH area is enabled; with `WIREBENCH_AREAS=ssh=off` none
  exists (extend `apps/desktop/test/areas-switch.test.ts`).
- A new command id needs a `COMMAND_CATALOG` entry and a handler (`test/renderer/command-registry.test.ts`); run
  `pnpm docs:commands` after.
- Renderer code never imports a value from `shared/snippets-wire.ts` eagerly (the renderer CSP trap,
  `test/renderer-eager-imports.test.ts`); constants it needs go in `shared/ssh-defaults.ts`. The renderer never
  imports `@wirebench/ssh`.
- Snippets are independent of the SFTP slice (#357, built in parallel: `dial.ts`, `sftp.ts`, `sftp-service.ts`,
  `ssh-connect.ts`) and of forwarding and workspaces (#358). Do not touch those files; rebase onto `main` when
  they land. Broadcast input belongs to #358.

## Review focus

1. **The snippet changes on disk between the confirmation and the run** (a git pull, another window): nothing
   is typed and the user sees `snippet-changed`. Tests in Tasks 2 and 9.
2. **A variable value with a line break** (`api\nrm -rf ~` pasted into the form): refused with
   `snippet-value-invalid` before anything is typed. Tests in Tasks 2 and 10.
3. **A secret value split across output chunks, byte by byte, or holding multi-byte UTF-8** (`pässwört`): never
   reaches the renderer unmasked; a prompt ending like the start of a value still shows within 150 ms. Tests in
   Tasks 4 and 9.
4. **A terminal that reconnected (#407) or closed between choosing targets and the write**: the write goes to the
   tab's current session or the target is reported as failed; no other host is affected. Test in Task 11.
5. **A multi-host run where one host needs a trust prompt or a sign-in**: the other hosts run at once; the
   prompted host runs after the click, or is reported failed when the prompt is dismissed. Test in Task 11.

---

## PR 1 — `packages/ssh`: snippet model, expansion, protected hosts, masker (issue: Snippets 1/7)

### Task 1: The `snippets.yaml` model

**Files:** create `packages/ssh/src/snippets.ts`, `packages/ssh/test/unit/snippets.test.ts`; modify
`packages/ssh/src/index.ts`, `packages/ssh/src/errors.ts`.

**Interfaces:**

- Produces:

  ```ts
  export interface SnippetVariable {
    readonly name: string;
    readonly label?: string;
    readonly default?: string;
  }
  export interface Snippet {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly tags: readonly string[];
    readonly variables: readonly SnippetVariable[];
    readonly script: string;
    readonly enter: boolean; // default true
    readonly confirm: boolean; // default false
  }
  export interface SnippetPackage {
    readonly id: string;
    readonly name: string;
    readonly snippets: readonly Snippet[];
  }
  export interface SnippetsFile {
    readonly version: 1;
    readonly packages: readonly SnippetPackage[];
    readonly snippets: readonly Snippet[];
  }
  export const EMPTY_SNIPPETS_FILE: SnippetsFile;
  /** @throws SshModelError snippets-invalid | snippet-duplicate-id | snippet-variable-invalid | snippet-secret-invalid */
  export function parseSnippetsFile(text: string): SnippetsFile;
  export function serializeSnippetsFile(file: SnippetsFile): string;
  export interface SnippetListItem {
    readonly id: string;
    readonly name: string;
    readonly packageId?: string;
    readonly packageName?: string;
    readonly description?: string;
    readonly tags: readonly string[];
    readonly firstLine: string;
    /** The first line up to its first `${` (spec D7). */
    readonly literalStart: string;
    readonly variables: readonly SnippetVariable[];
    /** Secret names the script uses, in order of first use, unique. */
    readonly secrets: readonly string[];
    readonly enter: boolean;
    readonly confirm: boolean;
    readonly lineCount: number;
    /** SHA-256 hex of the snippet's canonical serialisation. */
    readonly revision: string;
  }
  export function listSnippets(file: SnippetsFile): SnippetListItem[];
  export function findSnippet(file: SnippetsFile, id: string): Snippet | undefined;
  ```

- [ ] Tests first: the spec D1 example parses; an empty text (`''`, the missing file) is `EMPTY_SNIPPETS_FILE`;
      defaults `enter: true`, `confirm: false`, `tags: []`, `variables: []`; refused with the code and
      `details.path`: unknown key (`snippets-invalid`), `version: 2`, empty `script`, bad id `Deploy`, a snippet
      id equal to a package id or to another snippet in another package (`snippet-duplicate-id`, both paths in
      `details`), a variable named `secret`, `1x` or twice (`snippet-variable-invalid`), `${secret:bad-name}` in
      a script and `${secret:x}` in a default (`snippet-secret-invalid`); `serializeSnippetsFile` round-trips
      the example and writes a multi-line script as a `|` block; `listSnippets` gives `packageName`,
      `firstLine`, `literalStart` (`journalctl -u ` for the tail example, the whole line when there is no `${`),
      `secrets: ['api_token']`, `lineCount`, and a `revision` that changes when only that snippet's script
      changes and not when another snippet changes.
- [ ] Implement with `z.strictObject` and the `yaml` package as `model.ts` does; reuse the `SECRET_TOKEN`
      grammar from `model.ts` (one source; its pinned test already covers it). Add the codes to `errors.ts`.
      `revision` uses `node:crypto` `createHash('sha256')` over the snippet serialised alone.
- [ ] Commit `feat(ssh): snippets.yaml model`.

### Task 2: `expandSnippet`

**Files:** modify `packages/ssh/src/snippets.ts`, `packages/ssh/test/unit/snippets.test.ts`.

**Interfaces:**

- Consumes: `Snippet` (Task 1).
- Produces:

  ```ts
  export interface Expansion {
    readonly text: string;
    /** The secret values put into `text`, for the session masker. */
    readonly secretValues: readonly string[];
  }
  /** @throws SshModelError snippet-variable-missing | snippet-value-invalid */
  export function expandSnippet(
    snippet: Snippet,
    values: Readonly<Record<string, string>>,
    secrets: Readonly<Record<string, string>>,
  ): Expansion;
  /** The expansion with every secret as SECRET_MASK; needs no secret. */
  export function previewSnippet(snippet: Snippet, values: Readonly<Record<string, string>>): string;
  export const SECRET_MASK = '••••';
  ```

- [ ] Tests first: declared `${service}` replaced; undeclared `${HOME}`, `$HOME` and `$(date)` untouched;
      `values` beats `default`; no value and no default → `snippet-variable-missing` naming it; a value
      containing `\n`, `\r`, `\x1b` or `\x03` → `snippet-value-invalid` naming the variable (review focus 2); a
      value `${secret:x}` or `${other}` is inserted literally, never expanded again; `${secret:api_token}` gets
      the value and `secretValues` lists it once even when used twice; a secret absent from `secrets` throws a
      plain `Error` (main resolves before calling); `\r\n` becomes `\n` and one trailing newline is dropped;
      `previewSnippet` shows `••••` and needs no secrets. No error message or `details` ever contains a value
      (assert on `message` and `JSON.stringify(details)`).
- [ ] Implement as one left-to-right scan over `/\$\{(secret:)?([A-Za-z_][A-Za-z0-9_]*)\}/g`, replacing only
      declared names and secrets.
- [ ] Commit `feat(ssh): expand snippets with variables and secrets`.

### Task 3: `protected` on groups and hosts

**Files:** modify `packages/ssh/src/model.ts`, `packages/ssh/src/resolve.ts`,
`packages/ssh/test/unit/model.test.ts`, `packages/ssh/test/unit/resolve.test.ts`,
`apps/desktop/src/shared/ssh-wire.ts`, `apps/desktop/src/main/hosts-service.ts`,
`apps/desktop/test/hosts-service.test.ts`.

**Interfaces:**

- Produces: `HostEntry.protected?: boolean`, `GroupEntry.protected?: boolean`;
  `ResolvedHost.protected: Provenance<boolean>` (default `{ value: false, from: 'default' }`); the wire schemas
  gain the same fields (`HostEntryWire.protected?`, `GroupEntryWire.protected?`, `ResolvedHostWire.protected`).

- [ ] Tests first: a file without `protected` parses and serialises byte-identical to today; `protected: true`
      on a group makes every host under it `{ value: true, from: { group } }`; a nearer group or the host with
      `protected: false` lifts it; `protected: 'yes'` is refused with `details.path`; the desktop wire round
      trip keeps the field.
- [ ] Implement as one more inherited field, resolved the same way as `keepAlive`.
- [ ] Commit `feat(ssh): protected hosts inherited from groups`.

### Task 4: `StreamMasker`

**Files:** create `packages/ssh/src/stream-masker.ts`, `packages/ssh/test/unit/stream-masker.test.ts`; modify
`packages/ssh/src/index.ts`.

**Interfaces:**

- Produces:

  ```ts
  export interface StreamMasker {
    /** Values to mask from now on (empty strings ignored, duplicates kept once). */
    add(values: readonly string[]): void;
    /** Masked bytes safe to emit now; a tail that may start a value is held. */
    push(chunk: Uint8Array): Uint8Array;
    /** Releases the held tail as it is (the quiet timer or the session end). */
    flush(): Uint8Array;
    /** Whether a tail is held (the caller arms its 150 ms timer). */
    readonly holding: boolean;
  }
  export function createStreamMasker(): StreamMasker;
  ```

- [ ] Tests first: before `add`, `push` returns its input unchanged and never holds; a value inside one chunk
      becomes `••••` (the UTF-8 bytes of U+2022 × 4); a value split across two chunks, and byte by byte across
      many, is masked and no prefix of it is emitted before the end is seen (review focus 3); a multi-byte value
      (`pässwört`) split inside a character; two values where one is a prefix of the other mask the longer
      match; overlapping occurrences merge; a held tail released by a following chunk that diverges is emitted
      unmasked and in order; `flush()` releases it; `holding` is true only while a tail is held; the output
      bytes concatenated equal the input with each occurrence replaced.
- [ ] Implement on bytes (`Buffer.indexOf` per value over `held + chunk`), holding the longest tail that is a
      strict prefix of any value.
- [ ] Commit `feat(ssh): streaming masker for session output`.

## PR 2 — main: `SnippetsService` and the Snippets view (issue: Snippets 2/7)

### Task 5: `SnippetsService`, wire schemas and list/save channels

**Files:** create `apps/desktop/src/main/snippets-service.ts`, `apps/desktop/src/shared/snippets-wire.ts`,
`apps/desktop/test/snippets-service.test.ts`; modify `apps/desktop/src/shared/ipc.ts`,
`apps/desktop/src/main/areas/ssh.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/test/ipc-ssh.test.ts`,
`apps/desktop/test/areas-switch.test.ts`, and the Problems tab's source list (where `hosts` is listed).

**Interfaces:**

- Consumes: `parseSnippetsFile`, `serializeSnippetsFile`, `listSnippets` (Task 1); `asWirebenchError`
  (`main/hosts-service.ts`).
- Produces:

  ```ts
  export const SNIPPETS_FILE = 'snippets.yaml';
  export class SnippetsService {
    constructor(deps: { treeDir: () => string | undefined; onChanged?: () => void });
    invalidate(): void;
    current(): SnippetsFile | undefined;
    list(): Promise<SshListSnippetsResponse>; // { file, snippets, problems }
    save(file: SnippetsFileWire): Promise<SshListSnippetsResponse>;
  }
  export function windowSnippets(treeDir: () => string, onChanged: () => void): SnippetsService;
  ```

  Channels `ssh.listSnippets` (`z.undefined()` → response) and `ssh.saveSnippets` (`{ file }` → response);
  event `ssh.snippetsChanged {}`. Wire types `SnippetsFileWire`, `SnippetListItemWire`, `SnippetProblemWire`,
  `SshListSnippetsResponse` in `snippets-wire.ts`.

- [ ] Tests first, mirroring `hosts-service.test.ts`: no workspace → `workspace-not-open`; missing file → empty
      list, no problem; a malformed file → one problem with `code` and `path`, not a throw; an unreadable file →
      `snippets-invalid` with `errno`; save writes atomically, re-lists and calls `onChanged`; `invalidate`
      re-reads; a save of an invalid file is refused with its code as a `WirebenchError`. `areas-switch.test.ts`:
      both channels are absent with `ssh=off`.
- [ ] Implement as `HostsService`; create one per window next to `windowHosts` in `index.ts`, invalidated on the
      same workspace switch, emitting `ssh.snippetsChanged`. Problems show with source `snippets`.
- [ ] Commit `feat(desktop): snippets.yaml service and channels`.

### Task 6: Snippets menu entry and list panel

**Files:** create `apps/desktop/src/renderer/features/ssh/snippets/snippets-store.ts`,
`.../ssh/snippets/snippets-panel.tsx`, `apps/desktop/test/renderer/snippets-panel.test.tsx`; modify
`.../ssh/hosts-store.ts` (`SshHomeView` gains `'snippets'`), `.../ssh/hosts-view.tsx`, `.../ssh/ssh-home.tsx`.

**Interfaces:**

- Produces:

  ```ts
  interface SnippetsState {
    file: SnippetsFileWire;
    snippets: SnippetListItemWire[];
    problems: SnippetProblemWire[];
    refresh(): Promise<void>;
    save(file: SnippetsFileWire): Promise<{ ok: true } | { ok: false; error: WirebenchErrorWire }>;
    selectedId: string | undefined;
    select(id: string | undefined): void;
  }
  export const useSnippetsStore: UseBoundStore<StoreApi<SnippetsState>>;
  /** Pure: by text over name, description, first line, tags and package name; then by every chosen tag. */
  export function filterSnippets(
    items: readonly SnippetListItemWire[],
    text: string,
    tags: readonly string[],
  ): SnippetListItemWire[];
  ```

- [ ] Tests first: `filterSnippets` cases (case-insensitive text, tag AND); the panel renders packages as
      sections in file order with counts, then **No package**; a row shows the first line and icons for
      variables, secrets and `confirm`; tag chips filter; ⌘F focuses the filter; problems render above the list;
      the SSH menu shows **Snippets** with its count after Hosts and picking it shows the panel in the fixed tab.
- [ ] Implement; the store re-lists on `ssh.snippetsChanged`. The rows' Run and Insert actions arrive in Task 10.
- [ ] Commit `feat(desktop): Snippets view list`.

### Task 7: Snippet editor and package operations

**Files:** create `.../ssh/snippets/snippet-editor.tsx`, `.../ssh/snippets/snippet-edit.ts` (pure file edits),
`apps/desktop/test/renderer/snippet-edit.test.ts`, `apps/desktop/test/renderer/snippet-editor.test.tsx`; modify
`.../ssh/snippets/snippets-panel.tsx`.

**Interfaces:**

- Produces (pure, in `snippet-edit.ts`; each returns a new `SnippetsFileWire` or `{ file, id }`):

  ```ts
  export function upsertSnippet(file: SnippetsFileWire, packageId: string | undefined, snippet: SnippetWire): SnippetsFileWire;
  export function moveSnippet(file: SnippetsFileWire, id: string, packageId: string | undefined): SnippetsFileWire;
  export function removeSnippet(file: SnippetsFileWire, id: string): SnippetsFileWire;
  /** New id `x-copy`, then `x-copy-2`, …; placed after the original. */
  export function duplicateSnippet(file: SnippetsFileWire, id: string): { file: SnippetsFileWire; id: string };
  /** Id slugged from the name, made unique across the file. */
  export function addPackage(file: SnippetsFileWire, name: string): { file: SnippetsFileWire; id: string };
  export function renamePackage(file: SnippetsFileWire, id: string, name: string): SnippetsFileWire;
  /** @throws Error when the package still holds snippets. */
  export function removePackage(file: SnippetsFileWire, id: string): SnippetsFileWire;
  /** `${name}` tokens in the script that are neither declared nor `secret:`. */
  export function undeclaredTokens(script: string, variables: readonly { name: string }[]): string[];
  ```

- [ ] Tests first for every function above, including slug and copy-id collisions and `removePackage` on a
      non-empty package. Editor tests: editing the name and script then Save sends the whole file once; an
      undeclared `${service}` in the script shows "Declare `${service}` as a variable" and clicking it adds the
      variable; the secret picker inserts `${secret:NAME}` at the cursor from `ssh.secretNames`; a save refusal
      shows its message inline; **Press Enter** and **Always confirm** write `enter`/`confirm` (defaults left
      out of the file).
- [ ] Implement the push-layout right panel as host details; the script field is the app's code editor with
      declared variables, secrets and other `${…}` highlighted in three styles. Row menu: Edit, Duplicate, Move
      to package…, Copy script, Delete (asks). Package menu: Rename, Delete (disabled with a reason while
      non-empty). Split button New snippet / New package.
- [ ] Commit `feat(desktop): edit snippets and packages`.

### Task 8: Protected switch in the host dialog and markers

**Files:** modify `apps/desktop/src/renderer/features/ssh/host-dialog.tsx`, `.../ssh/inherited-field.tsx` (a
boolean variant if needed), `.../ssh/host-cards.tsx`, `.../ssh/host-details.tsx`; tests beside the existing
host dialog and card tests in `apps/desktop/test/renderer/`.

**Interfaces:**

- Consumes: `ResolvedHostWire.protected`, `HostEntryWire.protected`, `GroupEntryWire.protected` (Task 3).

- [ ] Tests first: a host under a protected group shows **Protected** on, greyed, "from Production"; Override on
      and off writes and removes `protected` on the host; a group's dialog sets it on the group; a protected
      host's card and details show a shield with the accessible label "Protected".
- [ ] Implement with the existing inherited-field pattern.
- [ ] Commit `feat(desktop): mark hosts and groups protected`.

## PR 3 — run a snippet in one terminal (issue: Snippets 3/7)

### Task 9: `runSnippet`, `previewSnippet` and output masking in `SshService`

**Files:** modify `apps/desktop/src/main/ssh-service.ts`, `apps/desktop/src/main/areas/ssh.ts`,
`apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/shared/snippets-wire.ts`, `apps/desktop/src/main/index.ts`;
tests in `apps/desktop/test/ssh-service.test.ts` (a new `describe('runSnippet')`),
`apps/desktop/test/areas-switch.test.ts` and `packages/ssh/test/integration/session.test.ts` (one masked round
trip).

**Interfaces:**

- Consumes: `findSnippet`, `listSnippets`, `expandSnippet`, `previewSnippet` (Tasks 1–2); `createStreamMasker`
  (Task 4); `SnippetsService.current()` and `list()` (Task 5).
- Produces:

  ```ts
  // shared/snippets-wire.ts
  type SshRunSnippetRequest = {
    sessionId: string;
    snippetId: string;
    revision: string;
    values: Record<string, string>;
    bracketed: boolean;
    enter?: false;
    skip?: number;
  };
  type SshPreviewSnippetRequest = { snippetId: string; values: Record<string, string> };
  type SshPreviewSnippetResponse = { text: string; revision: string };

  // SshServiceDeps gains
  readonly snippets: (sender: WebContents) => Pick<SnippetsService, 'current' | 'list'>;
  // SshService gains
  runSnippet(sender: WebContents, request: SshRunSnippetRequest): Promise<void>;
  previewSnippet(sender: WebContents, request: SshPreviewSnippetRequest): Promise<SshPreviewSnippetResponse>;

  /** Pure, exported for tests: the text to write (spec D4 steps 2–4). @throws WirebenchError snippet-prefix-mismatch */
  export function frameSnippet(
    text: string,
    opts: { leadingSpace: boolean; bracketed: boolean; enter: boolean; skip: number },
  ): string;
  ```

- [ ] Tests first (`frameSnippet`): without bracketed paste, lines are joined by `\r`, then `\r` with `enter`;
      bracketed gives `\x1b[200~…\x1b[201~` then `\r`; the leading space only when asked; `skip` drops that many
      characters, and a `skip` past a `${` boundary (more than the snippet's `literalStart` length) throws
      `snippet-prefix-mismatch`.
- [ ] Tests first (`runSnippet`, with the fake `open` the existing tests use): a foreign session →
      `ssh-session-unknown`; an unknown id → `snippet-unknown`; a stale `revision` → `snippet-changed` and
      nothing written (review focus 1); a missing secret → `secret-missing` and nothing written; a secret
      snippet is written with a leading space when `skip` is 0 and without one when `skip > 0`; a plain snippet
      never gets one; `enter: false` overrides; the masker is fed before the write, so the fake session echoing
      the write emits `••••` on `ssh.data`, also when the echo arrives one byte per chunk (review focus 3); a
      held tail is flushed after 150 ms (fake timers) and before `ssh.exit`; `previewSnippet` returns `••••`
      and the revision without calling the secret getter (a spy that is never called). `areas-switch.test.ts`:
      `ssh.runSnippet` and `ssh.previewSnippet` absent with `ssh=off`.
- [ ] Integration (`session.test.ts`): through the echoing fixture shell, a value added to a masker wrapped round
      `onData` and then written never appears in the collected output.
- [ ] Implement: each `Live` gains a `masker`; `onData` goes through `masker.push`, arming a 150 ms timer while
      `holding`; `onExit` flushes first. Secrets resolve through `deps.secretsFor(sender)` for the names
      `listSnippets` reports, before any write. Register both channels.
- [ ] Commit `feat(desktop): type snippets into a session with secrets masked`.

### Task 10: Run and Insert into one terminal

**Files:** create `.../ssh/snippets/run.ts`, `.../ssh/snippets/run-dialog.tsx`, `.../ssh/snippets/variables-form.tsx`,
`.../ssh/snippets/snippets-prefs.ts`, `apps/desktop/test/renderer/snippet-run.test.ts`,
`apps/desktop/test/renderer/snippet-run-dialog.test.tsx`; modify `.../ssh/snippets/snippets-panel.tsx`,
`.../ssh/snippets/snippet-editor.tsx`, `.../ssh/terminal-tab.tsx` (expose the focused terminal tab, its current
session id and `term.modes.bracketedPasteMode`).

**Interfaces:**

- Consumes: `ssh.runSnippet`, `ssh.previewSnippet` (Task 9); `useSnippetsStore` (Task 6).
- Produces:

  ```ts
  export interface TerminalTarget { readonly kind: 'terminal'; readonly tabId: string }
  export interface HostTarget { readonly kind: 'host' | 'group' | 'tag'; readonly id: string }
  /** Pure: what a run shows first (spec R6, D9.4). */
  export function needsDialog(
    item: SnippetListItemWire,
    targets: { terminals: number; hosts: number; anyProtected: boolean },
  ): 'none' | 'variables' | 'dialog';
  /** Pure: a value that would type an extra line or a control key. */
  export function invalidValue(value: string): boolean;
  /** Writes into one terminal tab's current session. */
  export function runInTerminal(
    tabId: string,
    item: SnippetListItemWire,
    values: Record<string, string>,
    opts?: { enter?: false; skip?: number },
  ): Promise<void>;
  // snippets-prefs.ts (local storage, as hosts-prefs.ts)
  export function lastValues(snippetId: string): Record<string, string>;
  export function lastTargets(snippetId: string): readonly HostTarget[];
  export function rememberRun(snippetId: string, values: Record<string, string>, targets: readonly HostTarget[]): void;
  export function recentSnippetIds(): readonly string[];
  ```

- [ ] Tests first: `needsDialog` (one unprotected terminal, no variables, no `confirm` → `none`; with variables
      → `variables`; `confirm`, a protected host or two targets → `dialog`); the variables form refuses a value
      for which `invalidValue` is true, before calling main (review focus 2); `runInTerminal` sends the tab's
      current session id, `bracketed` from xterm and the item's `revision`; a `snippet-changed` refusal shows
      "This snippet changed since it was shown" and refreshes the list; last values prefill the form; the
      dialog for one terminal shows the preview text and, for a secret snippet, the note "Typed with a leading
      space so most shells keep it out of history; hidden on screen".
- [ ] Implement Run and Insert on rows (hover) and in the editor; Run with unsaved editor changes asks to save
      first; double-click on a row runs. With no terminal in front, Run opens the dialog with no target yet
      (hosts arrive in Task 12).
- [ ] Commit `feat(desktop): run or insert a snippet in the focused terminal`.

## PR 4 — run on several hosts, groups and tags (issue: Snippets 4/7)

### Task 11: Target expansion, opening terminals and ready detection

**Files:** modify `.../ssh/snippets/run.ts`, `apps/desktop/src/renderer/features/ssh/connect.ts` (return the
opened or focused tab id; nothing else changes); tests in `apps/desktop/test/renderer/snippet-run.test.ts`.

**Interfaces:**

- Consumes: `runInTerminal`, `TerminalTarget`, `HostTarget` (Task 10).
- Produces:

  ```ts
  /** Pure: hosts for the chosen targets, de-duplicated, in tree order. */
  export function expandTargets(targets: readonly HostTarget[], hosts: readonly ResolvedHostWire[]): ResolvedHostWire[];
  /** Resolves when the session has printed and then been quiet for `quietMs`, or after `maxMs`. */
  export function whenReady(sessionId: string, opts?: { quietMs?: number; maxMs?: number }): Promise<void>; // 250, 10_000
  export interface RunReport {
    readonly ok: readonly string[];
    readonly failed: readonly { readonly hostId: string; readonly message: string }[];
  }
  export function runOnTargets(
    item: SnippetListItemWire,
    values: Record<string, string>,
    terminals: readonly TerminalTarget[],
    hosts: readonly HostTarget[],
  ): Promise<RunReport>;
  ```

- [ ] Tests first (fake connect, fake events, fake timers): a group expands to its hosts and nested groups' hosts;
      a tag to every host carrying it; a host in two chosen targets, or also chosen as an open terminal, runs
      once; a host with an open connected terminal reuses the most recently focused one; otherwise a new tab
      opens and the write waits for output then 250 ms quiet, or 10 s; targets run in parallel (one slow connect
      does not delay another's write); a host whose connect needs the trust prompt runs after the click and is
      reported failed when the prompt is dismissed, without holding back the rest (review focus 5); a terminal
      that reconnected since the targets were chosen gets the write on its new session, and one that closed is
      reported failed (review focus 4); the toast reads "Ran on 3 of 4 hosts · api-4: authentication failed".
- [ ] Implement over the existing connect path; trust, sign-in and reconnect behaviour are unchanged.
- [ ] Commit `feat(desktop): run a snippet on hosts, groups and tags`.

### Task 12: Targets and confirmation in the run dialog

**Files:** modify `.../ssh/snippets/run-dialog.tsx`; tests in `apps/desktop/test/renderer/snippet-run-dialog.test.tsx`.

**Interfaces:**

- Consumes: `expandTargets`, `runOnTargets` (Task 11); `lastTargets`, `rememberRun` (Task 10).

- [ ] Tests first: open terminals are listed with checkboxes, the focused one ticked; the "Add host, group or
      tag" picker adds chips that show the hosts they expand to; every protected target is named in a warning
      with its source ("api-2 is protected (from Production)"); the button reads **Run on N hosts**, N counting
      each host once; with no target it is disabled; last targets prefill; Escape cancels and nothing runs.
- [ ] Implement, using the palette's fuzzy matcher for the picker.
- [ ] Commit `feat(desktop): choose targets and confirm a snippet run`.

## PR 5 — palette, quick open and the terminal picker (issue: Snippets 5/7)

### Task 13: Commands, ⌘K mode and ⌘P heading

**Files:** modify `apps/desktop/src/shared/commands.ts`, `apps/desktop/src/shared/command-catalog.ts`,
`apps/desktop/src/renderer/commands/register-ssh-commands.ts`, `apps/desktop/src/renderer/shell/command-palette.tsx`,
`apps/desktop/src/renderer/shell/quick-open.ts`; tests `test/renderer/ssh-commands.test.ts`, a new
`test/renderer/palette-snippets.test.tsx`, `test/renderer/quick-open.test.ts`,
`test/renderer/command-registry.test.ts`.

**Interfaces:**

- Consumes: `needsDialog`, `runInTerminal` (Task 10); the run dialog (Task 12).
- Produces: command ids `view.showSnippets`, `ssh.newSnippet`, `ssh.editSnippet`, `ssh.runSnippet`,
  `ssh.runSnippetPalette`, `ssh.snippetPicker`; palette mode `'snippets'`;
  `quickOpenSnippetEntries(items: readonly SnippetListItemWire[]): QuickOpenEntry[]`.

- [ ] Tests first: ⌘K lists **Run snippet…**; choosing it switches to the snippets mode with an empty search,
      fuzzy over name, package, tags and first line; Enter with a terminal tab in front runs into it (or opens
      the dialog when `needsDialog` says so); without one it opens the dialog; ⌘P shows a **Snippets** heading;
      with the SSH area off neither appears; every new id has a catalog entry and a handler.
- [ ] Implement; run `pnpm docs:commands`.
- [ ] Commit `feat(desktop): snippets in the command palette and quick open`.

### Task 14: In-terminal picker (⌘;)

**Files:** create `.../ssh/snippets/terminal-picker.tsx`, `apps/desktop/test/renderer/terminal-picker.test.tsx`;
modify `.../ssh/terminal-tab.tsx` (key handler).

**Interfaces:**

- Consumes: `ssh.snippetPicker` (Task 13); `runInTerminal`, `needsDialog` (Task 10).

- [ ] Tests first: ⌘; (Ctrl+; on Windows and Linux) in a terminal tab opens the picker over the terminal and the
      key does not reach the shell; Enter runs into that terminal, ⌥Enter inserts (`enter: false`); Escape
      returns focus to the terminal; with no snippets it says how to add one.
- [ ] Implement with cmdk and the same matcher as Task 13.
- [ ] Commit `feat(desktop): snippet picker inside the terminal`.

## PR 6 — inline suggestions (issue: Snippets 6/7)

### Task 15: Line tracker and matcher

**Files:** create `.../ssh/snippets/suggest.ts`, `apps/desktop/test/renderer/snippet-suggest.test.ts`.

**Interfaces:**

- Produces:

  ```ts
  export interface LineTracker {
    /** Feed what the user typed (xterm `onData`); a paste is fed with `paste: true`. */
    input(data: string, opts?: { paste?: boolean }): void;
    /** The text typed since the last Enter, or undefined when unknown. */
    readonly line: string | undefined;
  }
  export function createLineTracker(): LineTracker;
  export function matchSnippet(
    line: string | undefined,
    items: readonly SnippetListItemWire[],
    recent: readonly string[],
  ): SnippetListItemWire | undefined;
  ```

- [ ] Tests first: printable input accumulates; `\r`, `\x03` (Ctrl-C), `\x15` (Ctrl-U) and a lone `\x1b` reset
      to `''`; arrows (`\x1b[A`…), Home/End, `\x01`, `\x05`, `\x17`, `\x12`, `\t` and a Backspace with nothing
      tracked make it `undefined` until the next `\r`; Backspace (`\x7f`) inside removes one code point; a paste
      makes it `undefined`; `matchSnippet` needs three characters and a strict prefix of `literalStart`, exact
      case; ties go to the earliest in `recent`, then by name; an `undefined` line never matches.
- [ ] Implement.
- [ ] Commit `feat(desktop): track the typed line for snippet suggestions`.

### Task 16: Ghost text, Tab to accept, preference

**Files:** create `.../ssh/snippets/ghost.ts` (the xterm decoration wrapper); modify `.../ssh/terminal-tab.tsx`,
`apps/desktop/src/shared/wire-base.ts` (`terminal.snippetSuggestions: z.boolean()` with a `true` default for
older files), `apps/desktop/src/renderer/state/preferences-defaults.ts`,
`apps/desktop/src/renderer/features/preferences/sections/terminal-section.tsx`; tests
`apps/desktop/test/renderer/terminal-tab.test.tsx` and the preferences schema test.

**Interfaces:**

- Consumes: `createLineTracker`, `matchSnippet` (Task 15); `recentSnippetIds`, `runInTerminal`, `needsDialog`
  (Task 10).

- [ ] Tests first (terminal-tab with the existing xterm fake): typing `jou` with the tail snippet shows the
      ghost `rnalctl -u ${service} -n ${lines} -f` and the snippet's name; the next key removes or moves it;
      Tab with a ghost opens the variables form, then sends `ssh.runSnippet` with `skip: 3` and `enter: false`,
      and the Tab never reaches the shell; Tab without a ghost goes to the shell; no ghost while the alternate
      screen is active, while disconnected, or with the preference off; a protected host or `confirm: true`
      opens the dialog first. An older preferences file without the key reads as `true`.
- [ ] Implement with `term.registerMarker` and `term.registerDecoration` at the cursor; feed the tracker from the
      same `onData` path as the paste guard (a held or confirmed paste is fed with `paste: true`).
- [ ] Commit `feat(desktop): inline snippet suggestions in the terminal`.

## PR 7 — docs and e2e (issue: Snippets 7/7)

### Task 17: Docs and end-to-end

**Files:** modify the `site/` "Hosts and terminals" page (a Snippets section) and the generated command catalog
(`pnpm docs:commands`); create `e2e/specs/ssh-snippets.spec.ts`; touch the e2e fixture helpers only as needed.

- [ ] Docs: the file format with an example, variables and the undeclared-`${…}` rule, secrets (typed by the
      app, masked on screen, the leading space and which shells honour it, the limits of masking including very
      short values), running on hosts, groups and tags, protected hosts, `enter` and `confirm`, ⌘K, ⌘P, ⌘; and
      inline suggestions with their preference. No product comparisons.
- [ ] e2e (CI only) against the fixture, as `ssh-terminal.spec.ts` does: create a package and a snippet with a
      variable in the Snippets view, run it into an open terminal and see its output; a snippet using a secret
      set through the keychain shows `••••` where the shell echoed it and the value is absent from the page
      text; run on two hosts through the dialog and see both terminals receive it; type the start of a snippet,
      see the ghost, press Tab, see the completed line; ⌘K **Run snippet…** lists it.
- [ ] Commit `docs(ssh): snippets`, then `test(e2e): snippets` (two commits, each green).
