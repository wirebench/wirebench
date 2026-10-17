# Imported Script Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scripts imported from Insomnia, Bruno, Hoppscotch and Thunder Client are attached to their
requests switched off. Once turned on they run in their own dialect, the way Postman scripts do
today.

**Architecture:** `ScriptApi` gains one value per client. Each value gets a JavaScript layer built
only on the typed script API, and shares parts with the existing Postman layer. The importers stop
writing `imported-scripts/` files and attach the script text where it was, with `enabled: false`.
Bruno gains an API-level post-response order.

**Tech Stack:** TypeScript, the QuickJS sandbox (`quickjs-emscripten-core`), zod project schemas,
Vitest, Astro docs.

**Spec:** `docs/specs/2026-10-16-imported-script-layers-design.md`, with owner decisions 1 to 8.

## Global Constraints

- **ADR-0016 holds.** A layer uses only `vars`, `props`, `request`, `response`, `test`, `expect`,
  `crypto`, `encoding`, `iteration`, `execution` and `console`. No new host function and no new
  capability.
- **Every unsupported call** throws `ScriptUnsupported` with the client's own call name. The run
  reports it as `script-unsupported`.
- **Imported scripts are `enabled: false`.** No import runs a script.
- **Variable writes** from any layer go to `vars` only. Reads check `vars`, then `props` (spec
  §3.3).
- **The project format goes from 10 to 11 once.** Version 10 shipped in v6.1.0-rc.1, so it cannot be
  reused. All four new `ScriptApi` values and `postResponseOrder` land under 11.
- **Postman stays unchanged.** `postman-layer.test.ts`, `rest/postman/scripts.test.ts`, and the
  Postman, v3 and OpenCollection golden snapshots pass unchanged.
- **Gates:** run `WIREBENCH_SKIP_PERF=1 NODE_OPTIONS=--max-old-space-size=8192 pnpm check` before
  every commit, and `pnpm test:perf` plus `pnpm --filter @wirebench/desktop build` before a push. Do
  not launch Electron locally; e2e runs in CI.
- **Commits** are made as Mohammed Naami, with no `Co-Authored-By` or `Claude-Session` trailer. Make
  one commit per task.
- **Wording:** no doc or code names the product that inspired a feature (`pnpm check:banned-terms`).
  Naming the source client as a dialect is fine.
- **Main bundle:** no string literal in `apps/desktop/src/main` may end with the word "import".
- **Delivery:** one PR per client, in the order Insomnia, Bruno, Hoppscotch, Thunder Client. The
  branches stack, and each PR targets main once the one before it merges.

## Review Focus

1. **A project saved at format 11 and opened by an older build is refused, not run as
   `wirebench`.** Pin a migrate/load test showing that a file with `api: 'bruno'` fails to load
   under format 10 rules. That test lives in Task 1.
2. **A script turned on for a client whose layer has not shipped fails with a clear
   `script-unsupported`, never silently.** This happens between PRs, for example with
   `api: 'thunder-client'` before PR 4. The test lives in Task 1.
3. **A layered script that writes a variable named like a secret never reaches a project or
   environment file.** It stays in `vars`. Covered in Tasks 3, 9, 12 and 15.
4. **Joining two scripts of one phase at one level keeps both and keeps their order.** The case is
   Bruno's `script:post-response` plus `tests`. The test lives in Task 10.
5. **The post-response order change affects only APIs that set `inner-first`.** A project with no
   setting runs exactly as before. The test lives in Task 7.

---

# PR 1: shared groundwork and Insomnia

Branch `feat/script-layers-insomnia` from `main`.

### Task 1: Format 11 and the layered APIs

**Files:**
- Modify: `packages/engine/src/script/model.ts:11,119-121`, `packages/engine/src/project/schema-parts.ts:263`,
  `packages/engine/src/project/model.ts:38` (and the history comment above it),
  `packages/engine/src/project/migrate.ts`
- Modify: `packages/engine/src/script/run.ts:185-190`, `script/api/prelude.ts:262-264`,
  `script/check/service.ts:92,192`, `script/request-scripts.ts:221-224` (and the doc comment near line 242)
- Regenerate: `docs-site/public/schemas/v11/`, using `pnpm schemas:project`, plus the
  `project-format.md` markers
- Test: `packages/engine/test/unit/script/layered-api.test.ts`,
  `packages/engine/test/unit/project/scripts-format.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ScriptApi = 'wirebench' | 'postman' | 'insomnia' | 'bruno' | 'hoppscotch' | 'thunder-client';
  export type LayeredApi = Exclude<ScriptApi, 'wirebench'>;
  export function isLayeredApi(api: ScriptApi): api is LayeredApi;
  export const SCRIPT_LAYERS: Partial<Record<LayeredApi, string>>; // script/api/layers.ts
  ```
  `run.ts` looks the layer up in `SCRIPT_LAYERS`. A layered API with no entry fails before it runs,
  with `script-unsupported` and the message `<api> scripts are not supported yet`.

- [ ] **Step 1:** Write the failing tests:
  - `isLayeredApi is false only for wirebench`
  - `a layered api file is .js` (`scriptFileName('x', 'pre', 'bruno')` returns `'x.pre.js'`)
  - `a layered api is syntax-checked only`
  - `a layered api with no layer fails with script-unsupported`
  - `scriptsSchema accepts the four new apis`
  - `a format 11 project is refused by a reader limited to format 10` (Review Focus 1). Use the
    loader's existing newer-version refusal, with its maximum version injected.
  - `a format 10 project with api: bruno is refused` (the value did not exist at 10)
  - `a format 10 project migrates to 11 unchanged`
- [ ] **Step 2:** Run `nice pnpm vitest run --project engine-unit test/unit/script/layered-api.test.ts test/unit/project/scripts-format.test.ts`.
  Expected: FAIL.
- [ ] **Step 3:** Implement. Replace every `api === 'postman'` with `isLayeredApi(api)`, except the
  layer lookup. Bump `FORMAT_VERSION` to 11 as a stamp migration, following commit a89ed9a9. Run
  `pnpm schemas:project`, and add the CHANGELOG `Changed` line for format 11.
- [ ] **Step 4:** Run the two tests plus `test/unit/script` and `test/unit/project`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): project format 11 adds script APIs for other clients`.

### Task 2: Shared layer parts

**Files:**
- Create: `packages/engine/src/script/api/layer-parts.ts`
- Modify: `packages/engine/src/script/api/postman.ts`
- Test: `packages/engine/test/unit/script/layer-parts.test.ts`

**Interfaces:**
- Produces JavaScript source fragments as string constants. Each one defines exactly the names
  listed:
  - `PART_UNSUPPORTED` defines `unsupported`.
  - `PART_VARIABLES` defines `asValue` and `variables` (postman.ts lines 16-29).
  - `PART_EXPECT` defines `chain` and `chaiExpect` (lines 30-90; `pmExpect` becomes an alias of
    `chaiExpect`).
  - `PART_PAIRS` defines `pairs`.
  - `PART_CRYPTO` defines `CryptoJS`, `btoa` and `atob` (lines 185-224 plus 263-265).
- `POSTMAN_LAYER` is now `PART_UNSUPPORTED + PART_VARIABLES + PART_EXPECT + PART_PAIRS + PART_CRYPTO`
  plus its own `pmRequest`, `pmResponse`, `pmObject` and `define` calls.

- [ ] **Step 1:** Write the failing test `each part defines only its names`. It evaluates each part
  in the sandbox and lists the globals it adds.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Move the code without changing it.
- [ ] **Step 4:** Run `test/unit/script/postman-layer.test.ts`, `test/unit/rest/postman/scripts.test.ts`
  and the new test. Expected: PASS, with the two old files unchanged.
- [ ] **Step 5:** Commit `refactor(engine): share the Postman layer's parts`.

### Task 3: The Insomnia layer

**Files:**
- Create: `packages/engine/src/script/api/insomnia.ts`
- Modify: `packages/engine/src/script/api/layers.ts`
- Test: `packages/engine/test/unit/script/insomnia-layer.test.ts`. Copy the local `run` wrapper from
  `postman-layer.test.ts:42-55`.

**Interfaces:**
- Produces `INSOMNIA_LAYER: string`, registered as `SCRIPT_LAYERS.insomnia`. It defines `insomnia`
  and `$` as the Postman `pm` object plus `baseEnvironment`, `parentFolders` and `vault` (spec §4).

- [ ] **Step 1:** Write the failing tests:
  - `insomnia.test and expect report a passing test`, using the fixture text from
    `fixtures/insomnia/crafted/v4.json:100-101`;
  - `$ is insomnia`;
  - `insomnia.environment.set writes vars, read back in the post phase`;
  - `baseEnvironment.get reads props`;
  - `a secret-named write stays in vars` (Review Focus 3);
  - one `script-unsupported` test each for `insomnia.sendRequest`, `insomnia.require`, `require`,
    `insomnia.vault.get` and `insomnia.cookies.set`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): run Insomnia scripts`.

### Task 4: The Postman mapper writes any layered API

**Files:**
- Modify: `packages/engine/src/rest/postman/map.ts:65 (MapPostmanOptions), 146-157 (scriptsAt), 811 (importedScripts), 826-840 (unsupportedCalls)`
- Test: `packages/engine/test/unit/rest/postman/script-api-option.test.ts`

**Interfaces:**
- Produces:
  - `MapPostmanOptions.scriptApi?: LayeredApi`, which defaults to `'postman'`;
  - `importedScripts(events, api)`;
  - `unsupportedCalls(text, api)`, backed by `UNSUPPORTED_CALLS: Record<LayeredApi, readonly [RegExp, string][]>`.
    The Postman list is unchanged. Each other client's list starts empty, and its layer task fills it.
    Every regex must be linear, because of CodeQL.

- [ ] **Step 1:** Write the failing tests:
  - `scriptApi insomnia writes api insomnia, enabled false`;
  - `no scriptApi keeps postman`;
  - `the unsupported scan uses the api's list`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it with `test/unit/rest/postman` and `test/unit/import/collection-v3`. Expected:
  PASS, with the snapshots unchanged.
- [ ] **Step 5:** Commit `feat(engine): the Postman mapper attaches scripts in another client's API`.

### Task 5: Insomnia imports attach their scripts

**Files:**
- Modify: `packages/engine/src/import/insomnia/convert.ts` (emit v2.1 `event` per folder and request),
  `insomnia/map.ts:420-430,569` (drop `collectScripts` and the collector; pass `scriptApi: 'insomnia'`)
- Modify: `packages/engine/src/rest/postman/map.ts`, adding Insomnia's entries to `UNSUPPORTED_CALLS`
- Modify: `packages/cli/src/ops/import.ts`, only if the check below fails
- Update: `packages/engine/test/unit/import/insomnia/__snapshots__/golden.test.ts.snap`
- Test: `packages/engine/test/unit/import/insomnia/scripts.test.ts`,
  `packages/cli/test/unit/ops/import-clients.test.ts`

**Interfaces:**
- Consumes `MapPostmanOptions.scriptApi` (Task 4).
- The workspace-level pre and post scripts go on the API level.

- [ ] **Step 1:** Write the failing tests:
  - `a request script is attached with api insomnia, enabled false`;
  - `a folder script is attached at folder level`;
  - `no imported-scripts files are written`;
  - `the report says scripts were imported switched off and lists unsupported calls per request`;
  - CLI: `wirebench import of an Insomnia file writes the script beside its request`. If the CLI
    drops attached scripts today, make it write them the way the project save writes Postman
    scripts.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Withdraw the "never an `event`" rule only for this converter, and update
  the golden snapshot.
- [ ] **Step 4:** Run `test/unit/import/insomnia`, the CLI import tests and the desktop import tests.
  Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): attach Insomnia scripts switched off instead of saving text`.

### Task 6: Insomnia docs and an end-to-end run

**Files:**
- Modify: `docs-site/src/content/docs/guides/scripts.mdx:160-186`. Rename the section to "Scripts
  from other clients", keeping an `#postman-scripts` anchor on the Postman subsection.
- Modify: `scripts/docs-script-api.ts:35-36`, for the anchor and the layered-API sentence.
- Modify: `docs-site/src/content/docs/switching/insomnia.mdx`, at line 66 and the Scripts section at
  129.
- Modify: `docs-site/src/content/docs/guides/importers.mdx`, the Insomnia lines and the notes at 621
  and 635.
- Modify: `docs/cli.md` import section, and `CHANGELOG.md` `Added`.
- Test: `packages/engine/test/integration/run/client-scripts.test.ts`, against
  `startTestRestServer` `/echo`.

- [ ] **Step 1:** Write the integration test
  `an imported Insomnia script, turned on, sets a variable the next request sends`.
- [ ] **Step 2:** Run it. Expected: PASS. Tasks 1 to 5 already provide the code, so a failure here is
  a bug to fix in this task.
- [ ] **Step 3:** Write the docs: spec §3.3 and §3.4, and the Insomnia supported/unsupported table.
- [ ] **Step 4:** Run `pnpm docs:script-api` and the full gate.
- [ ] **Step 5:** Commit `docs: running imported Insomnia scripts`. Push, and open PR
  `feat: run imported Insomnia scripts (script layers 1 of 4)`.

---

# PR 2: Bruno

Branch `feat/script-layers-bruno`, stacked on PR 1.

### Task 7: Bruno's post-response order

**Files:**
- Modify: `docs/specs/2026-10-16-imported-script-layers-design.md` §5. Record what Bruno's source
  says.
- Modify: `packages/engine/src/project/schema-parts.ts:260-268` (`postResponseOrder`) and
  `script/model.ts:102-113` (`RequestScripts.postResponseOrder?: 'outer-first' | 'inner-first'`)
- Modify: `packages/engine/src/run/script-support.ts:194`, reversing the post loop when the API level
  says `inner-first`; `script/request-scripts.ts:~249` (check order, the same rule)
- Test: `packages/engine/test/unit/script/post-order.test.ts`

- [ ] **Step 1:** Read `usebruno/bruno` `packages/bruno-electron/src/ipc/network/prepare-request.js`
  near line 394, and the script runner it feeds. Pin the exact pre and post order for `sandwich` and
  `sequential`, with permalinks, in spec §5. If `sandwich` turns out to be outermost-first, stop here.
  Replace §5's paragraph with the finding, skip Steps 2 to 5, and make Task 10 set nothing.
- [ ] **Step 2:** Write the failing tests:
  - `inner-first runs request, folder, api post scripts in that order`;
  - `pre-request order never changes`;
  - `no setting runs outer-first` (Review Focus 5);
  - `only the api level's setting counts`.
- [ ] **Step 3:** Run them. Expected: FAIL.
- [ ] **Step 4:** Implement. The setting belongs to format 11, so no further bump is needed. Show it
  as a select in the API's Scripts settings in the desktop app, next to the existing enabled toggle.
- [ ] **Step 5:** Commit `feat(engine): an API can run post-response scripts innermost first`.

### Task 8: `.jsonSchema` spike

**Files:**
- Create: `packages/engine/test/unit/script/json-schema-spike.test.ts`, to keep or delete
- Modify: spec §5. Record the result.

- [ ] **Step 1:** Bundle the validator the assertions use into the sandbox as a layer part. Validate
  a 50-property schema against a 1 MB body inside the 64 MiB and 1 s limits.
- [ ] **Step 2:** If both limits hold, keep it as `PART_JSON_SCHEMA` and keep the test. If either
  fails, delete the test and mark `.jsonSchema` unsupported in spec §5 and in Task 9.
- [ ] **Step 3:** Commit `docs: record the .jsonSchema sandbox spike`, plus the part if it is kept.

### Task 9: The Bruno layer

**Files:**
- Create: `packages/engine/src/script/api/bruno.ts`
- Modify: `script/api/layers.ts`, and `rest/postman/map.ts` (`UNSUPPORTED_CALLS.bruno`, used by the
  OpenCollection scan)
- Test: `packages/engine/test/unit/script/bruno-layer.test.ts`

**Interfaces:**
- Produces `BRUNO_LAYER`, defining `bru`, `req`, `res`, `test` and `expect` as in spec §5.

- [ ] **Step 1:** Write the failing tests:
  - one per supported member in spec §5, using the text in
    `fixtures/bruno/crafted/basic/collection.bru:19` and `users/create-user.bru`;
  - `res.body is parsed JSON for a JSON response`;
  - `bru.runner.stopExecution ends the run`;
  - a secret-named write test (Review Focus 3);
  - spec §10 limits: one test each showing that a Bruno-layer script hits the time, memory and log
    limits with the same problem codes a Wirebench script gets;
  - one `script-unsupported` test per call in spec §5.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): run Bruno scripts`.

### Task 10: Bruno imports attach their scripts

**Files:**
- Modify: `packages/engine/src/import/opencollection/variables.ts:172`. `mapOcScripts` now returns
  attached `RequestScripts` per level, plus helper files for `module` items only.
- Modify: `import/opencollection/map.ts:865`, which consumes the attached scripts.
- Modify: `import/bruno/convert.ts:~570` `config()`, reading `scripts.flow` from `bruno.json`.
- Modify: `import/opencollection/parse.ts`, reading `extensions.bruno.scripts.flow`.
- Update: the Bruno and OpenCollection golden snapshots. OpenCollection files without Bruno scripts
  must stay unchanged.
- Test: `packages/engine/test/unit/import/bruno/scripts.test.ts`

**Interfaces:**
- Produces `mapOcScripts(...)`, returning
  `{ levels: Map<string, RequestScripts>; helpers: ImportedScriptFile[] }`, keyed by item id.

- [ ] **Step 1:** Write the failing tests:
  - `a request's pre and post scripts attach with api bruno, enabled false`;
  - `post-response and tests join, tests second` (Review Focus 4);
  - `a sandwich collection sets postResponseOrder inner-first`, unless Task 7 found otherwise;
  - `sequential sets outer-first`;
  - `a module helper is still saved under imported-scripts`;
  - `no other script file is written`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `test/unit/import/bruno`, `test/unit/import/opencollection` and the CLI import
  tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): attach Bruno scripts switched off instead of saving text`.

### Task 11: Bruno docs and e2e

**Files:**
- Modify: `guides/scripts.mdx` (the Bruno table and the order setting), `switching/bruno.mdx:71,122`,
  `guides/importers.mdx` (the Bruno lines), `CHANGELOG.md`
- Create: `e2e/specs/bruno-scripts.spec.ts`. Import `fixtures/bruno/crafted/basic`, turn on the
  create-user script, send, and assert that the next request uses `userId`.
- Test: an extra case in `test/integration/run/client-scripts.test.ts`

- [ ] **Step 1:** Write the integration case
  `an imported Bruno post script captures a value the next request sends`.
- [ ] **Step 2:** Run it. Expected: PASS.
- [ ] **Step 3:** Write the docs and the e2e spec. The e2e spec runs in CI only.
- [ ] **Step 4:** Run the full gate.
- [ ] **Step 5:** Commit `docs: running imported Bruno scripts`. Push, and open PR
  `feat: run imported Bruno scripts (script layers 2 of 4)`.

---

# PR 3: Hoppscotch

Branch `feat/script-layers-hoppscotch`, stacked on PR 2.

### Task 12: The Hoppscotch layer

**Files:**
- Create: `packages/engine/src/script/api/hoppscotch.ts`
- Modify: `layers.ts`, and `UNSUPPORTED_CALLS.hoppscotch`
- Test: `packages/engine/test/unit/script/hoppscotch-layer.test.ts`

**Interfaces:**
- Produces `HOPPSCOTCH_LAYER`, defining `pw`, `hopp` and `pm` (spec §6).
  - The jest matchers live in a new part, `PART_JEST_EXPECT`, in `layer-parts.ts`.
  - `hopp.expect` accepts both the chai chains and the jest matchers.

- [ ] **Step 1:** Write the failing tests:
  - the `pw` test from `fixtures/hoppscotch/crafted/legacy-v0.json:16`;
  - the `hopp` test and `hopp.env.set` from `v12-r17.json`;
  - `pm.environment.set in a Hoppscotch script writes vars`;
  - `hopp.request setters fail in the post phase`;
  - a secret-named write test (Review Focus 3);
  - one `script-unsupported` test per call in spec §6.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): run Hoppscotch scripts`.

### Task 13: Hoppscotch imports attach their scripts

**Files:**
- Modify: `packages/engine/src/import/hoppscotch/convert.ts:382-385,423`. Emit v2.1 events for
  collections, folders and requests, and pass `scriptApi: 'hoppscotch'`.
- Update: the Hoppscotch golden snapshot.
- Test: `packages/engine/test/unit/import/hoppscotch/scripts.test.ts`

- [ ] **Step 1:** Write the failing tests:
  - `a request's pre and test scripts attach with api hoppscotch, enabled false`.
    Request-level scripts must attach as well; the collection walk at line 382 covers only
    collections and folders.
  - `no imported-scripts files are written`;
  - `the report lists unsupported calls`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `test/unit/import/hoppscotch` and the CLI import tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): attach Hoppscotch scripts switched off instead of saving text`.

### Task 14: Hoppscotch docs

**Files:** `guides/scripts.mdx` (the Hoppscotch table), `switching/hoppscotch.mdx:62,96`,
`guides/importers.mdx`, `CHANGELOG.md`, and an integration case in `client-scripts.test.ts`.

- [ ] **Step 1:** Write the integration case `an imported Hoppscotch test passes against the echo
  server`, and run it. Expected: PASS.
- [ ] **Step 2:** Write the docs, and run the full gate.
- [ ] **Step 3:** Commit `docs: running imported Hoppscotch scripts`. Push, and open PR
  `feat: run imported Hoppscotch scripts (script layers 3 of 4)`.

---

# PR 4: Thunder Client

Branch `feat/script-layers-thunder`, stacked on PR 3.

### Task 15: The Thunder Client layer

**Files:**
- Create: `packages/engine/src/script/api/thunder-client.ts`
- Modify: `layers.ts`, and `UNSUPPORTED_CALLS['thunder-client']`
- Test: `packages/engine/test/unit/script/thunder-client-layer.test.ts`

**Interfaces:**
- Produces `THUNDER_CLIENT_LAYER`, defining `tc` (spec §7).

- [ ] **Step 1:** Write the failing tests:
  - the fixture script `fixtures/thunder-client/crafted/collection-1.2.json:83`;
  - `setVar with each scope writes vars`;
  - `skipRequest with no argument skips the current request`;
  - `skipRequest with a name is unsupported`;
  - a secret-named write test (Review Focus 3);
  - one `script-unsupported` test per call in spec §7.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): run Thunder Client scripts`.

### Task 16: Thunder Client imports attach their scripts

**Files:**
- Modify: `packages/engine/src/import/thunder/convert.ts`:
  - lines 467-468 (per request) become v2.1 events, with lines joined by `\n`;
  - line 576 (collection pre) moves to the API level;
  - the collector at lines 566-582 is removed;
  - pass `scriptApi: 'thunder-client'`.
- Update: the Thunder Client golden snapshot.
- Test: `packages/engine/test/unit/import/thunder/scripts.test.ts`

- [ ] **Step 1:** Write the failing tests:
  - `inlineScripts lines join into one attached script`;
  - `the collection pre-request script is on the API level`;
  - `declarative test rows are unchanged`;
  - `no imported-scripts files are written`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `test/unit/import/thunder` and the CLI import tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): attach Thunder Client scripts switched off instead of saving text`.

### Task 17: Thunder Client docs and wrap-up

**Files:**
- Modify: `guides/scripts.mdx`, the Thunder Client table.
- Modify: `switching/thunder-client.mdx:70,113`.
- Modify: `guides/importers.mdx`. No `imported-scripts` line may remain except for Bruno helpers.
- Modify: `CHANGELOG.md`.
- Modify: the spec's status line, which becomes "implemented".
- Add: an integration case in `client-scripts.test.ts`.

- [ ] **Step 1:** Write the integration case `an imported Thunder Client script sets a variable the
  next request sends`, and run it. Expected: PASS.
- [ ] **Step 2:** Write the docs, and run `rg imported-scripts docs-site`. Expected: Bruno helper
  lines only.
- [ ] **Step 3:** Run the full gate, `pnpm test:perf` and the desktop build.
- [ ] **Step 4:** Commit `docs: running imported Thunder Client scripts`. Push, and open PR
  `feat: run imported Thunder Client scripts (script layers 4 of 4)`.
