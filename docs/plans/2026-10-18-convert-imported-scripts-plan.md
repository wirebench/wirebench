# Convert Imported Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Convert to Wirebench script" action rewrites a level's layered scripts into a typed
`wirebench` script, behind a reviewed diff, from the desktop and from `wirebench scripts convert`.

**Architecture:** First, an async `test` callback fails instead of passing. Then a pure engine
converter (`script/convert/`) parses each script with the engine's own `typescript`, matches dialect
calls against a data table, splices replacements, and comments out the rest under `// TODO(convert):`.
A project edit backs up the `.js` text under `imported-scripts/`, switches the level to `wirebench`
and saves. The desktop gets a review dialog modelled on **Switch on scripts…**, and the CLI gets a
preview with `--write`.

**Tech Stack:** TypeScript, the TypeScript compiler API (`ts.createSourceFile` only), the QuickJS
sandbox, Vitest, React + Monaco `DiffEditor`, zustand, Astro docs.

**Spec:** `docs/specs/2026-10-18-convert-imported-scripts-design.md`, with owner decisions 1 to 5.

## Global Constraints

- **ADR-0016 holds.** Converted scripts use only the typed API. No new host function or capability.
- **Convert never runs a script, never turns one on, and never switches `api` without Accept or
  `--write`.** `enabled`, `secrets`, `timeoutMs` and `postResponseOrder` are kept (spec §3, §7).
- **The backup is written before the save.** The save deletes the stale `.js` (`managed-files.ts`).
- **The rewrite touches only matched node spans.** Text inside strings, template literals and
  comments is never touched (spec §5.4).
- **No project format bump.** `wirebench` is a known value and `imported-scripts/` holds plain files.
- **Layered behaviour is unchanged** except the async fix in PR 1. Every existing layer test passes
  unchanged.
- **Gates:** run `WIREBENCH_SKIP_PERF=1 NODE_OPTIONS=--max-old-space-size=12288 pnpm check` before
  every commit, and `pnpm test:perf` plus `pnpm --filter @wirebench/desktop build` before a push. Do
  not launch Electron locally; e2e runs in CI.
- **Commits** are made as Mohammed Naami, with no `Co-Authored-By` or `Claude-Session` trailer. Make
  one commit per task.
- **Wording:** no doc or code names the product that inspired a feature (`pnpm check:banned-terms`).
  Naming the source client as a dialect is fine.
- **Main bundle:** no string literal in `apps/desktop/src/main` may end with the word "import".
- **Delivery:** four PRs in order. Each branches from `main` after the one before it merges.

## Review Focus

1. **An async test callback never passes silently**, in the typed `test` and in every layer,
   including Thunder Client's wrapper, which drops the callback's return value today. The tests live
   in Task 1.
2. **Every mapped row behaves like the layer**, except the differences spec §6 names. The
   equivalence harness lives in Task 7.
3. **A failed save loses no script text.** The backup is on disk before the save, and a test fails
   the save between the two steps. The test lives in Task 9.
4. **A level edited after the review opened is refused, not overwritten.** The tests live in Tasks
   9 and 12.
5. **HMAC argument order** is swapped in the template and pinned by a test. The test lives in
   Task 5.

---

# PR 1: async test callbacks

Branch `fix/async-script-tests` from `main`.

### Task 1: Fail a test whose callback returns a promise

**Files:**
- Modify: `packages/engine/src/script/api/prelude.ts:198-208` (`define('test', …)`),
  `packages/engine/src/script/api/thunder-client.ts:91-94`
- Test: `packages/engine/test/unit/script/async-test.test.ts`

**Behaviour:** `test` looks at what `check()` returns. A value with a callable `then` records
`passed: false` with the message `the test callback is async, and a test cannot wait: make it
synchronous`. The promise is not awaited. The layer wrappers `(name, check) => test(name, () =>
check())` already pass the value through. The Thunder Client wrapper returns `outcome` when it is
thenable, so the same rule reaches it.

- [ ] **Step 1:** Write the failing tests, one `runScript` run per API:
  - `wirebench: an async test fails` (`test('a', async () => {})`)
  - `postman: an async pm.test fails`, and the same for `insomnia.test`, Bruno's `test`, `pw.test`,
    `hopp.test`, and `tc.test` with an async function
  - `a sync test that returns a non-promise value still passes`
  - `the script goes on after an async test` (a later `vars.set` lands)
- [ ] **Step 2:** Run `nice pnpm vitest run --project engine-unit test/unit/script/async-test.test.ts`.
  Expected: FAIL.
- [ ] **Step 3:** Implement as above.
- [ ] **Step 4:** Run the new file and `test/unit/script`. Expected: PASS, every layer test
  unchanged.
- [ ] **Step 5:** Commit `fix(engine): fail script tests whose callback is async`.

### Task 2: Docs for PR 1

- [ ] Add one sentence under **Tests** in `docs-site/src/content/docs/guides/scripts.mdx`: a test
  callback must be synchronous, and an async one fails. Replace the first §14 bullet of
  `docs/specs/2026-10-16-imported-script-layers-design.md` with a "fixed" note. Add a `Fixed` line
  to `CHANGELOG.md`. Run `pnpm check:docs`. Commit `docs: async test callbacks fail`.

---

# PR 2: the engine converter

Branch `feat/convert-scripts-engine` from `main`.

### Task 3: Converter skeleton (parse, roots, splice, TODOs)

**Files:**
- Create: `packages/engine/src/script/convert/index.ts`, `convert/roots.ts`, `convert/splice.ts`,
  `convert/todo.ts`
- Modify: `packages/engine/src/script/index.ts` (export), `packages/engine/src/script/api/layer-parts.ts`
  (export the `WHY` reasons as a TS record too, so a TODO's reason never drifts from the layer's)
- Test: `packages/engine/test/unit/script/convert/skeleton.test.ts`

**Interfaces:**

```ts
export type ConvertProtocol = 'rest' | 'soap' | 'grpc' | 'mcp'; // the protocol module ids
export interface ConvertTodo {
  readonly phase: ScriptPhase;
  readonly line: number; // 1-based, in the converted file
  readonly call: string; // as the layer names it, e.g. 'pm.sendRequest'
  readonly kind: 'unsupported' | 'not-mapped' | 'shadowed';
  readonly reason: string;
}
export type ConvertedLevel =
  | {
      readonly ok: true;
      readonly pre?: string;
      readonly post?: string;
      readonly todos: readonly ConvertTodo[];
      readonly mapped: number;
    }
  | { readonly ok: false; readonly phase: ScriptPhase; readonly line: number; readonly message: string };
export function convertLevelScripts(input: {
  readonly dialect: LayeredApi;
  readonly protocol: ConvertProtocol;
  readonly pre?: string;
  readonly post?: string;
  /** The backup path per phase, for the header line (spec §5.3). */
  readonly backups: { readonly pre?: string; readonly post?: string };
}): ConvertedLevel;
```

- [ ] **Step 1:** Write the failing tests:
  - `a syntax error is refused with its phase and line`
  - `a script with no dialect call is unchanged apart from the header`
  - `an unknown call on a root becomes a TODO, and its innermost statement is commented out`
  - `a root the script declares is skipped, with one shadowed TODO`
  - `text inside strings, templates and comments is untouched`
  - `CRLF line ends are kept`
  - `a call inside a commented-out statement is not rewritten`
  - `an unsupported call's TODO carries the layer's reason` (`pm.sendRequest`)
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement with `ts.createSourceFile(name, text, ScriptTarget.Latest, true,
  ScriptKind.JS)` only. Edits are `{ start, end, text }`, applied from the end backwards; an edit
  inside a commented-out span is dropped. The unsupported call names come from the same lists as
  `UNSUPPORTED_CALLS` in `import/scripts.ts`. If `pnpm check:engine-layers` refuses the new import
  edge, update `scripts/engine-import-graph.mjs` in this task.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): script converter skeleton`.

### Task 4: Mappings — variables, run control, iteration (spec §6.3, first half of §6.7)

**Files:**
- Create: `packages/engine/src/script/convert/mappings.ts`, `convert/match.ts`
- Test: `packages/engine/test/unit/script/convert/mappings-variables.test.ts`

**Interfaces:** a row is

```ts
interface MappingRow {
  readonly calls: readonly string[]; // qualified names, e.g. 'bru.setVar'
  readonly dialects: readonly LayeredApi[];
  readonly phase?: ScriptPhase; // absent: both
  readonly shape?: 'call' | 'property' | 'object-key-value' | 'string-literal';
  readonly to: Partial<Record<ConvertProtocol, (args: readonly string[]) => string>>;
}
```

- [ ] **Step 1:** Write one failing test per row and per protocol cell of §6.3, and of the run
  control and iteration rows of §6.7. Include `skipRequest in a post-response script is a TODO` and
  every `—` cell.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement the rows and the matcher. The `pm.*` rows list `postman`, `insomnia`
  (under the `insomnia.` and `$.` names) and `hoppscotch`.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): convert variable and run-control calls`.

### Task 5: Mappings — tests, expectations, crypto (spec §6.4, second half of §6.7)

**Files:**
- Create: `packages/engine/src/script/convert/chains.ts` (the chai chain and Jest matcher rewrite)
- Modify: `convert/mappings.ts`
- Test: `packages/engine/test/unit/script/convert/mappings-tests.test.ts`

- [ ] **Step 1:** Write the failing tests:
  - one per chai row and per Jest row
  - `.not` placement and the dropped filler words
  - `.property` with and without a dot
  - `.a('object')` becomes a TODO
  - `tc.test` with a boolean, a function literal and a variable
  - `CryptoJS` hashes and HMACs with Hex and Base64
  - `HMAC swaps data and key` (Review Focus 5)
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement. A chain is read from `expect(x)` outwards as a list of words and calls.
  Any word outside the tables makes the whole statement a TODO.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): convert tests, expectations and crypto calls`.

### Task 6: Mappings — response and request per protocol (spec §6.5, §6.6)

**Files:**
- Modify: `convert/mappings.ts`
- Test: `packages/engine/test/unit/script/convert/mappings-messages.test.ts`

- [ ] **Step 1:** Write one failing test per row and per protocol column (REST, SOAP, gRPC, MCP).
  Include every `—` cell, a setter in a post-response script, `req.setUrl(u)` used as a value, and
  `pm.request.headers.add` with a non-literal argument (a TODO).
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): convert response and request calls per protocol`.

### Task 7: Equivalence harness (Review Focus 2)

**Files:**
- Create: `packages/engine/test/unit/script/convert/equivalence.test.ts`,
  `packages/engine/test/unit/script/convert/equivalence-cases.ts`
- Use: `runScript` with the request and response snapshots `layers-protocols.test.ts` builds, and
  `test/unit/script/ts-check.ts` to type-check each converted text

- [ ] **Step 1:** Write one case per mapped row: a small layered script with its dialect, protocol
  and phase. The harness runs it layered, converts it, type-checks the result (expecting no
  problems), runs it typed, and compares `tests` and `values`.
- [ ] **Step 2:** Add each documented difference as its own case that asserts the difference: a
  non-JSON body throws, repeated headers, deep-equality key order, and `pm.request` on gRPC.
- [ ] **Step 3:** Run it. Expected: PASS. A failure here is a mapping bug: fix the row, not the
  harness.
- [ ] **Step 4:** Commit `test(engine): converted scripts behave like their layers`.

### Task 8: Fixtures end to end, and Bruno order

**Files:**
- Test: `packages/engine/test/integration/convert-fixtures.test.ts`
- Use: the echo server of `test/integration/echo-protocol-scripts.test.ts`, and the importers

- [ ] **Step 1:** Write the test. For each client's crafted fixture: import it, enable and run every
  level layered, convert every level, type-check, run again, and compare tests and values. Assert
  `no fixture call becomes a TODO` (spec §15).
- [ ] **Step 2:** Add `bruno inner-first order survives conversion`. It converts the crafted
  collection and compares the order of the recorded tests before and after (spec §8).
- [ ] **Step 3:** Run it. Expected: PASS. Fix any row it exposes.
- [ ] **Step 4:** Commit `test(engine): crafted fixtures convert with no TODOs`.

---

# PR 3: the project edit and the CLI

Branch `feat/convert-scripts-cli` from `main`.

### Task 9: Convert a set of levels in a project

**Files:**
- Create: `packages/engine/src/script/convert/project.ts`
- Modify: `packages/engine/src/import/scripts.ts` (a backup-path helper over `importedScriptPath`),
  `packages/engine/src/script/index.ts`
- Test: `packages/engine/test/unit/script/convert/project.test.ts`,
  `packages/engine/test/unit/workspace/convert-save.test.ts`

**Interfaces:**

```ts
export interface LevelProposal {
  readonly ownerId: string; // request, folder, API or interface id
  readonly path: readonly string[]; // API / Folder / Request names
  readonly dialect: LayeredApi;
  readonly before: { readonly pre?: string; readonly post?: string };
  readonly result: ConvertedLevel;
  readonly backups: readonly { readonly path: string; readonly source: string }[];
  readonly fingerprint: string; // sha256 of dialect and before texts
}
/** Every layered level at or below `rootId`, or in the whole project when it is absent. */
export function proposeConversions(
  project: Project,
  rootId?: string,
  takenBackups?: ReadonlySet<string>,
): LevelProposal[];
/** The project with each accepted level switched; a level whose fingerprint changed is refused. */
export function applyConversions(
  project: Project,
  accepted: readonly { readonly ownerId: string; readonly fingerprint: string }[],
): {
  readonly project: Project;
  readonly applied: readonly LevelProposal[];
  readonly refused: readonly { readonly ownerId: string; readonly reason: 'changed' | 'not-layered' | 'syntax' }[];
};
```

- [ ] **Step 1:** Write the failing tests:
  - `proposals cover request, folder, API and interface levels beneath the root`
  - `a wirebench level is not proposed`
  - `apply keeps enabled, secrets, timeoutMs and postResponseOrder`
  - `a level with no text switches api only`
  - `backup paths follow imported-scripts/<api>/<owner>.<phase>.js and avoid taken paths`
  - `a changed level is refused and the others apply` (Review Focus 4)
  - `a level that does not parse is never applied`
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement. The protocol is the API's protocol module id; a SOAP interface is
  `soap`.
- [ ] **Step 4:** Write the save test: write the backups, then save through an `FsLike` that fails.
  Assert the backups exist and no `.js` was deleted (Review Focus 3). Then save for real and assert
  the `.ts` files are written and the `.js` files are gone.
- [ ] **Step 5:** Run both. Expected: PASS.
- [ ] **Step 6:** Commit `feat(engine): convert a project's layered levels`.

### Task 10: `wirebench scripts convert`

**Files:**
- Create: `packages/cli/src/commands/scripts-convert.ts`
- Modify: `packages/cli/src/args.ts` (a `scripts-convert` command, `scripts` subcommand parsing as
  `secrets list` does, help text), `packages/cli/src/main.ts`
- Test: `packages/cli/test/unit/scripts-convert.test.ts`, the args tests

**Behaviour:** `wirebench scripts convert <path> [selector…] [--write]`. The selectors resolve
through `loadSelection` (`commands/run.ts`). The preview prints, per level, the path, the dialect, a
unified diff per phase and the TODOs, then a total. `--write` writes the backups (refusing a path
outside `imported-scripts/`), applies and saves. Exit `0` when done, `2` for usage, `3` when load or
save fails.

- [ ] **Step 1:** Write the failing tests:
  - arg parsing: an unknown subcommand, and `--write`
  - `the preview writes nothing`
  - `--write converts and backs up`
  - `a syntax error is listed and skipped`
  - `exit 3 when the project cannot be loaded`
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement. Reuse an existing line-diff helper if the engine or CLI has one;
  otherwise write a small one in `scripts-convert.ts`.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cli): wirebench scripts convert`.

### Task 11: CLI docs

- [ ] Add `wirebench scripts convert` to `docs/cli.md` and to the docs site's CLI page. Run
  `pnpm check:docs`. Commit `docs(cli): scripts convert`.

---

# PR 4: the desktop

Branch `feat/convert-scripts-desktop` from `main`.

### Task 12: Main-process change and wire types

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts`, near `enable-scripts` at line ~592. It gains a
  `convert-scripts` change carrying `{ ownerId, fingerprint }[]` (at most 10,000 entries), and a
  request that returns proposals for an owner or the whole project.
- Modify: `apps/desktop/src/main/project-script-mutations.ts`, `main/project-mutations.ts` (~263),
  `main/project-host.ts` (write the backups through `writeImportedScripts` before the change's save)
- Test: `apps/desktop/test/unit/main/convert-scripts.test.ts`

- [ ] **Step 1:** Write the failing tests:
  - `propose returns levels with diffs, TODO counts and type-check problems`
  - `apply writes the backups first, then switches and saves`
  - `a changed fingerprint is refused by name` (Review Focus 4)
  - `a backup path outside imported-scripts is refused`
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement. On Accept, main recomputes the proposals from its current model, and
  only fingerprints cross the wire, so the renderer never sends script text to be written. The
  review's type-check problems come from the checker in `main/script-host.ts`.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): convert scripts in main`.

### Task 13: The review dialog

**Files:**
- Create: `apps/desktop/src/renderer/features/scripts/convert-scripts-dialog.tsx`. It has a zustand
  store like `useEnableScriptsDialog`; a level list with checkboxes and TODO counts; a `DiffEditor`
  per phase (reuse `editor/diff-xml-editor.tsx` with `language="typescript"`) with the problems
  under it; and Accept and Cancel.
- Modify: `apps/desktop/src/renderer/state/project.ts` (`proposeConversions`, `convertScripts`),
  `renderer/features/explorer/explorer-view.tsx` (mount the dialog beside `EnableScriptsDialog`)
- Test: `apps/desktop/test/unit/renderer/convert-scripts-dialog.test.tsx`

- [ ] **Step 1:** Write the failing tests:
  - `rows are ticked by default`
  - `a syntax-error row cannot be ticked`
  - `accept sends only the ticked fingerprints`
  - `refused rows are reported in a toast`
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): review converted scripts`.

### Task 14: The three entry points

**Files:**
- Modify: `apps/desktop/src/renderer/features/scripts/scripts-tab.tsx` (a **Convert to Wirebench
  script** button next to the dialect label)
- Modify: `renderer/features/explorer/context-menu.tsx` (a **Convert scripts…** item beside
  `withScriptsGroup`, on an interface, API or folder with layered levels beneath it)
- Modify: `renderer/features/explorer/tree-nodes.ts` (a `scriptsLayered` list next to `scriptsOff`)
- Modify: `renderer/features/explorer/explorer-actions.ts`, `apps/desktop/src/shared/command-catalog.ts`
  (**Convert all imported scripts…**)
- Regenerate: `docs-site/src/content/docs/reference/commands.md` with `pnpm docs:commands`
- Test: the explorer context-menu and Scripts tab unit tests

- [ ] **Step 1:** Write the failing tests:
  - `the menu offers Convert scripts… only with layered levels beneath`
  - `the button shows only on a layered level`
  - `the palette command is in the catalog`
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it, plus `pnpm docs:commands --check`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(desktop): convert scripts from a level, the tree and the palette`.

### Task 15: Guide and e2e

**Files:**
- Modify: `docs-site/src/content/docs/guides/scripts.mdx`. Add a "Convert to Wirebench scripts"
  section covering the entry points, the review, the backup folder, the TODO comment and the §6
  differences, and add a Convert column to each per-client table. Also add a link on each client's
  switching page.
- Create: `e2e/convert-scripts.spec.ts`

- [ ] **Step 1:** Write the e2e test: import the crafted Bruno collection, choose **Convert
  scripts…** on the API, Accept, then see `.ts` scripts on the Scripts tab with no type-check
  problems. It runs in CI only.
- [ ] **Step 2:** Write the docs. Run `pnpm check:docs`.
- [ ] **Step 3:** Build with `pnpm --filter @wirebench/desktop build`, watching for the main-bundle
  "import" trap.
- [ ] **Step 4:** Commit `docs: convert imported scripts`, then `test(e2e): convert a Bruno API`.

---

## After PR 4

- Set the spec's status to `implemented`, and add a "Known limitations" section for anything the
  fixtures did not cover.
- Follow-up cards, outside this plan: request-body mappings (spec §6.6), `vars.unset` (ask first,
  §14), MCP response mappings, and Convert in the MCP server (ask first).
