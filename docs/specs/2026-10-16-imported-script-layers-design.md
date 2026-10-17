# Spec: Running scripts imported from Insomnia, Bruno, Hoppscotch and Thunder Client

**Date:** 2026-10-16
**Status:** decisions settled (under review)
**Milestone:** 6.1 — Team operations
**Scope:** making the scripts that the #588 importers save as text runnable. This spec also outlines
a later "Convert to Wirebench script" action.

Builds on:

- `docs/specs/2026-10-15-other-clients-import-design.md` (#588), the **client-import spec**. §3.5 and
  decision 1 save every client's scripts as text under `imported-scripts/`. This spec replaces that
  decision for new imports.
- `docs/adr/0016-scripts-run-with-no-capabilities.md`. Scripts run in a QuickJS worker with no
  network, file system, timers, `require` or environment access. Nothing here adds a capability.
- `packages/engine/src/script/api/postman.ts`, the **Postman layer**. It is JavaScript that runs
  before a `postman` script and builds `pm.*`, `postman.*`, `CryptoJS`, `btoa` and `atob` on the
  typed script API. Unsupported calls throw `script-unsupported`. Each layer in this spec follows
  that pattern.
- `docs-site/src/content/docs/guides/scripts.mdx`: the typed script API, level order (API, then
  each folder outermost first, then the request), limits and secrets.

## 1. Objective

**Why.** Today a Postman script arrives attached to its request, switched off, and runs once
turned on. A script from Insomnia, Bruno, Hoppscotch or Thunder Client arrives as a text file
nothing reads, and the docs tell the user to port it by hand. For a team leaving one of those
clients, token capture, status checks and header signing all stop working after the move. Those are
the scripts collections actually carry.

**What.**

1. Phase 1 adds one runtime layer per client. Imported scripts are attached where they were, in the
   client's own dialect, switched off until reviewed. Once turned on they run, and a call the
   sandbox cannot honour fails with a named `script-unsupported` problem.
2. Phase 2, outlined in §8, adds a "Convert to Wirebench script" action. It rewrites a layered
   script into a typed Wirebench script.

**User stories.**

- I import a Bruno collection whose login request runs `bru.setVar("token", res.body.token)`. The
  script is on the request and switched off, and the report lists it. I read it, turn it on, send
  the login, and the next request's `${#Sequence#token}` resolves.
- I import an Insomnia v5 collection with `insomnia.test('201', () =>
  insomnia.expect(insomnia.response.code).to.eql(201))`. After I turn it on, a send shows a passing
  test named `201`.
- I import a Hoppscotch collection with old `pw.expect(pw.response.status).toBe(200)` tests. They run
  without edits.
- A Thunder Client script calls `tc.runRequest(...)`. The import report names it, and running it
  fails with `script-unsupported: tc.runRequest`. The rest of my scripts work.

## 2. Decisions

Owner decisions, 2026-10-16:

| # | Question | Decision |
| --- | --- | --- |
| 1 | Approach | Both: runtime layers first (phase 1), then a "Convert to Wirebench script" action (phase 2). |
| 2 | State on import | Scripts are attached switched off until reviewed, as Postman scripts are today. |
| 3 | Clients | All four: Insomnia, Bruno, Hoppscotch and Thunder Client. |
| 4 | Projects imported before this ships | Re-import only. Existing `imported-scripts/` folders are left as they are, and the docs say to re-import. |
| 5 | Bruno post-response order | An API-level order setting honours Bruno's `sandwich` flow, after its meaning is confirmed in Bruno's source (§5). |
| 6 | Bruno `.jsonSchema` | A spike in the Bruno PR runs the validator in the sandbox; if it does not fit the limits, the call is unsupported. |
| 7 | Phase 2 scope | "Convert to Wirebench script" covers Postman scripts too. |
| 8 | Milestone | 6.1 — Team operations. |

## 3. Shared design

### 3.1 One more value per client

`ScriptApi` (`script/model.ts`) is `'wirebench' | 'postman'` today. It gains `'insomnia'`,
`'bruno'`, `'hoppscotch'` and `'thunder-client'`. Every place that branches on `api === 'postman'`
now asks whether the API is not `'wirebench'`, through one helper, `isLayeredApi(api)`:

- `script/run.ts` picks the layer from a table, `SCRIPT_LAYERS: Record<LayeredApi, string>`.
- `script/api/prelude.ts` injects the layer for any layered API.
- `script/check/service.ts` uses a syntax-only JavaScript check for a layered API.
- `scriptFileName` gives a layered API the `.js` extension.
- `request-scripts.ts` (line ~222) skips the typed declarations for every layered API, as it does
  for `postman` today.

The project file stores the value in `scripts.api`. The project format version goes up once, because
an older Wirebench must refuse a file whose `api` it does not know rather than run it as
`wirebench`. A run of `pnpm schemas:project` regenerates the schema.

### 3.2 Layers share their parts

The Postman layer's chai-style `expect`, its variable store (every scope aliased to the run's `vars`
over `props`), `unsupported(name)` and `CryptoJS` move to `script/api/layer-parts.ts`. They are
exported as JavaScript source fragments that each layer concatenates. The Postman layer is rebuilt
from them, and its tests must pass unchanged. Each client layer lives in
`script/api/<client>.ts` and holds only that client's API shape.

Layers are built only on the typed API (`vars`, `props`, `request`, `response`, `test`, `crypto`,
`encoding`, `iteration`, `execution`, `console`). A layer never reaches past it. Layers therefore
inherit the sandbox's limits, and no new path out of the sandbox exists.

### 3.3 Variable scopes

Every client has more variable scopes than Wirebench's two, the run-scoped `vars` and the read-only
`props`. Each layer follows the Postman layer:

- a **read** checks `vars` first, then `props`;
- a **write** goes to `vars`, so it lasts for the run and is never written to a project or
  environment file.

The docs state this once, for all five layers. A script that relied on a write persisting after the
app closed loses that persistence, and the switching pages say so.

### 3.4 Unsupported calls

A call the sandbox cannot honour throws `ScriptUnsupported` with the client's own name for it, for
example `tc.runRequest`. It surfaces as `script-unsupported`, as in the Postman layer. The importer
scans each script for these names with the same scanner the Postman importer uses. It lists them per
request in the report, so the user knows before turning a script on.

The categories below are unsupported in every layer. Each layer's table in §4–7 names the concrete
calls.

| Category | Why |
| --- | --- |
| Sending requests (`sendRequest`, `runRequest`) | No network (ADR-0016). |
| Modules (`require`, `loadModule`, top-level `import`) | No `require`. |
| Files and processes (`readFile`, `exec`, `loadFromPath`) | No file system. |
| Waiting (`sleep`, `delay`) | No timers. |
| Cookies and vault | No cookie or vault access from scripts. |

### 3.5 Import attaches instead of saving text

- **Insomnia, Hoppscotch and Thunder Client** convert to a Postman v2.1 document. Their converters
  stop calling `ScriptCollector`. They emit v2.1 `event` entries (`prerequest` and `test`) carrying
  the script text, and the document carries the dialect. `importedScripts` in
  `rest/postman/map.ts` takes the `ScriptApi` to write from a mapper option. It defaults to
  `'postman'`, so Postman imports do not change. The client-import spec's rule that "the v2.1 document never carries
  an `event`" is withdrawn for these three.
- **Bruno** goes through the OpenCollection mapper. `mapOcScripts` writes `api: 'bruno'`, enabled
  false, instead of saving text.
- **The level a script was on is kept.** Request, folder and collection scripts become request,
  folder and API-level scripts.
- **Two scripts of one phase at one level are joined,** as the Postman importer does, for example a
  Bruno `script:post-response` and a `tests` block. The tests block comes second.
- **Report.** The one-line warning "Scripts on … were imported switched off" and the per-request
  unsupported list replace the dialect warning and the "saved to `imported-scripts/`" notes.
- **What still goes to `imported-scripts/`:** only Bruno's `.js` helper files, which a script would
  `require`. They stay text, because `require` is unsupported.

### 3.6 The command line

`wirebench import` attaches scripts switched off, the same way. Running is unchanged. A switched-off
script never runs from `wirebench run` or the MCP server.

## 4. Insomnia (PR 1)

Insomnia's API is deliberately Postman-shaped (research note §4.7). The layer defines `insomnia` and
`$` as the Postman layer's `pm` object, plus the members `pm` lacks:

- `baseEnvironment` and `parentFolders`. They read through `props`, and writes go to `vars` (§3.3).
- `vault`, which is unsupported.

`insomnia.test` and `insomnia.expect` are the shared ones. A legacy unit-test suite stays reported,
not run (client-import spec §4.5), because it targets a request by id outside any script.

Unsupported: `insomnia.sendRequest`, `insomnia.require`, `require`, `insomnia.cookies` writes and
`insomnia.vault`.

## 5. Bruno (PR 2)

The layer defines these:

- **`bru`:**
  - `getEnvVar` / `setEnvVar`, `getVar` / `setVar`, `getCollectionVar`, `getFolderVar` and
    `getRequestVar`, all through §3.3;
  - `interpolate`, which resolves `{{name}}` through vars then props (§3.3), for a string, and for the
    string leaves of an array or plain object; dynamic `{{$…}}` and `{{process.env.X}}` stay literal;
  - `hasVar` and `deleteVar`;
  - `setNextRequest`, mapped to `execution.setNextRequest`;
  - `runner.skipRequest`, mapped to `execution.skipRequest`;
  - `runner.stopExecution`, mapped to `execution.setNextRequest(null)`.
- **`req`:**
  - `getUrl` / `setUrl`, `getMethod` / `setMethod`, `getHeader` / `setHeader` / `deleteHeader` and
    `getBody` / `setBody` and `getHeaders`, over `request`;
  - `setTimeout`, `getTimeout`, `setMaxRedirects`, `onFail` and `disableParsingResponseJson`, which
    are unsupported.
- **`res`:**
  - `status`, `headers` (lower-cased keys, repeated names joined with `, `), `body` (parsed as JSON when the response is JSON) and `responseTime`;
  - `getStatus`, `getBody`, `getHeader` (case-insensitive) and `getResponseTime`.
- **`test` and `expect`:** the shared ones, plus `.jsonSchema` (decision 6), which checks the
  value against the schema in the script.

**`.jsonSchema` in the sandbox (spike result).** The validator the response assertions use is the
engine's own (`json/schema-validate.ts`), so `.jsonSchema` needs no new dependency; the validator
the engine has only as a development dependency is not used. It now lives in one self-contained
function, `jsonSchemaValidator`, and `PART_JSON_SCHEMA` embeds its `toString()`. So the sandbox
runs the same code, with no copy and no build step. It compiles nothing at run time (no
`new Function` or `eval`). Its unit tests run twice, once against the module and once against that
source in a fresh realm, so a reference outside the function fails a test. Measured in QuickJS
under the real limits, on a developer laptop:

- A 1 MiB body that is one 50-property object checks in 13.7 ms in all. Parsing the JSON takes
  13.2 ms of that, the check about 0.5 ms. With the input, the body and its parse held, the runtime
  uses 2.1 MiB.
- The part adds 1.2 ms (1.5 ms against 0.3 ms) and 38 KiB to every run of a layer that includes it,
  called or not. Loading it lazily would gain nothing.
- The node cap holds in scripts too: the validator stops after 10,000 schema nodes with one `budget`
  problem. In a one-off measurement that no test repeats, a 1 MiB array of 1,253 rows of 50
  properties got that `budget` problem after about 200 rows, in 66 ms; without the cap it checked
  in full in 277 ms, still inside 1 s.

So `.jsonSchema` is supported. The tests assert these bounds:

- `test/unit/script/json-schema-spike.test.ts`: the 1 MiB object checks with no problems in the
  real sandbox at the default 1 s and 64 MiB limits; the sandbox finds the same problems as the
  host validator; and the check succeeds with the memory limit halved to 32 MiB.
- `test/perf/json-schema-part.perf.test.ts` (perf project, gate scaled for CI): the part adds under
  10 ms and under 1 MiB to a run, and the 1 MiB check takes under 100 ms.

A `budget` problem makes the expectation fail, and its message says the check could not finish and
names the node cap; it never passes silently, and scripts have no higher cap. Any other problems fail
the expectation and list path, keyword and message, at most the validator's 20. `.jsonSchema` works
anywhere in a chain, including after `.not`, `.deep` and `.property(...)`; only the Bruno layer has it.

Unsupported: `bru.sendRequest`, `bru.sleep`, `bru.cookies`, `require` and the request settings
`req.setTimeout`, `req.getTimeout`, `req.setMaxRedirects`, `req.onFail` and
`req.disableParsingResponseJson`.

**Script order (decision 5).** Bruno's `scripts.flow` defaults to `sandwich`; Wirebench runs
post-response scripts outermost first. Bruno's source (commit `1b932553`, 2026-10-17) confirms both
flow values:

- `prepare-request.js` reads `collection.brunoConfig.scripts.flow`, defaulting to `'sandwich'`, and
  hands it to `mergeScripts` ([prepare-request.js:395-399](https://github.com/usebruno/bruno/blob/1b932553772cb671f9932dcbea0bde003489707a/packages/bruno-electron/src/ipc/network/prepare-request.js#L395-L399)).
- `mergeScripts` always runs pre-request scripts collection, then folders (outermost first), then the
  request ([collection.js:384-392](https://github.com/usebruno/bruno/blob/1b932553772cb671f9932dcbea0bde003489707a/packages/bruno-electron/src/utils/collection.js#L384-L392)).
- With `sequential`, post-response scripts run in that same order: collection, folders, request
  ([collection.js:395-405](https://github.com/usebruno/bruno/blob/1b932553772cb671f9932dcbea0bde003489707a/packages/bruno-electron/src/utils/collection.js#L395-L405)).
- With anything else, so `sandwich` and an absent flow, they run innermost first: request, then the
  folders reversed, then the collection ([collection.js:406-418](https://github.com/usebruno/bruno/blob/1b932553772cb671f9932dcbea0bde003489707a/packages/bruno-electron/src/utils/collection.js#L406-L418)).
  Tests follow the same rule ([collection.js:433-455](https://github.com/usebruno/bruno/blob/1b932553772cb671f9932dcbea0bde003489707a/packages/bruno-electron/src/utils/collection.js#L433-L455)).

So `sandwich` differs from Wirebench's order, and the setting is added:

- The API-level script settings gain `postResponseOrder: 'outer-first' | 'inner-first'`. It is
  optional, and `outer-first` is the default, so existing projects do not change. Pre-request
  scripts always run outermost first.
- The post-response loop and the type-check order (`run/script-support.ts`,
  `script/request-scripts.ts`) reverse the levels when the API's setting is `inner-first`. Only the
  API's setting counts; a folder's or a request's is ignored.
- A Bruno import sets `inner-first` when the collection's flow is `sandwich` or absent, and
  `outer-first` for `sequential`.
- The setting is shown as a select in the API's Scripts settings, next to the enabled toggle. The
  format version bump in §3.1 covers it.

## 6. Hoppscotch (PR 3)

Hoppscotch scripts carry no language marker and may mix `pw.*`, `hopp.*` and Hoppscotch's own
`pm.*`. The one `hoppscotch` layer defines all three:

- **`pw`:** `env.get` / `set` / `unset` / `resolve`, `response.status` / `body` / `headers`, `test`,
  and `expect` with the jest-style matchers `toBe`, `toBeType`, `toInclude`, `toBeLevel2xx` to
  `toBeLevel5xx` and `toHaveLength`.
- **`hopp`:** `env.*`; `request.*`, whose setters work only in the pre-request phase; `response`
  `statusCode`, `headers` and `body.asJSON()` / `asText()`; and `test` and `expect`. Its `expect`
  takes both the chai chains and the jest matchers.
- **`pm`:** the Postman layer's object, minus what Hoppscotch itself does not support.

Unsupported: `hopp.cookies`, top-level `import`, and anything Hoppscotch's own sandbox refuses.

## 7. Thunder Client (PR 4)

The layer defines `tc`:

- `getVar` and `setVar(name, value, scope)`. Every scope (`local`, `global`, `request`) writes
  `vars` (§3.3).
- `replaceVars`, through the run's resolver.
- `request.*` and `response.{status, json, text, headers, time}`.
- `test`.
- `skipRequest`, which maps to `execution.skipRequest` only for the current request. A name argument
  for another request is unsupported.

Thunder Client stores scripts as arrays of lines. The converter joins them with `\n`. Declarative
test rows keep going through `thunder/tests.ts`; this spec does not change them.

Unsupported: `tc.runRequest`, `tc.retryRequest`, `tc.loadModule`, `tc.loadFromPath`, `tc.readFile`,
`tc.exec`, `tc.delay` and `require("thunder-tests/...")`.

## 8. Phase 2: "Convert to Wirebench script" (outline)

A later action on any layered script, Postman included (decision 7), rewrites it into a typed
Wirebench script.

- **Mechanical calls are rewritten** when the layer maps them one to one, for example
  `bru.setVar(a, b)` to `vars.set(a, b)` and `pm.response.code` to `response.status`.
- **Other lines are kept as comments** with a `// TODO(convert):` line naming the call.
- **The result** is a `.ts` file beside the old one, and the request switches to `api: 'wirebench'`
  only after the user accepts the diff. The type check then reports what is left.

Phase 2 gets its own spec once phase 1 has shipped and real imported scripts show which calls
matter.

## 9. Docs

- `guides/scripts.mdx`: the "Postman scripts" section becomes "Scripts from other clients". It covers
  §3.3, §3.4, one table per client of what is supported and what is not, and how to turn an imported
  script on.
- The switching pages for Insomnia, Bruno, Hoppscotch and Thunder Client replace "never run; rewrite
  what you need" with "attached switched off", a link to that section and the re-import note
  (decision 4).
- `guides/importers.mdx`: replace the "saved as text under `imported-scripts/`" lines.
- `docs/cli.md`: the import section says scripts arrive switched off.
- The generated script API reference (`pnpm docs:script-api`) lists the layered APIs.

## 10. Testing

- **Layer unit tests,** one file per client in `packages/engine/test/unit/script/`. They run real
  scripts through `runScript` against fixed request and response fixtures. Each covers every
  supported call in §4–7, every unsupported call (the `script-unsupported` code and name), and
  variable reads and writes across phases (§3.3).
- **Postman layer:** its existing tests pass unchanged after §3.2 moves the shared parts.
- **Importers:** each importer's golden snapshot shows scripts attached with the right `api`,
  level, phase and `enabled: false`. No `imported-scripts/` entries appear, except Bruno helpers.
  The importer tests also check the report's unsupported list.
- **Fixtures:** the existing crafted script fixtures for each client run end to end. Parse, map,
  enable, then send against a local echo server with the real worker.
- **Limits:** a layered script hits the same time, memory and log limits as a Wirebench script. One
  test per limit uses the Bruno layer.
- **e2e,** CI only: import the Bruno crafted collection, turn the login script on, send, and see the
  captured variable used by the next request.

## 11. Delivery

One plan, one PR per client in the order Insomnia, Bruno, Hoppscotch, Thunder Client. PR 1 also
carries §3.1, §3.2 and the format version bump. Each PR updates its client's switching page and the
shared scripts guide table.

## 12. Boundaries

- **Always:** keep ADR-0016. Layers use only the typed API, and every unsupported call throws a
  named `script-unsupported`. Imported scripts are switched off. Postman behaviour and tests stay as
  they are.
- **Ask first:** any new sandbox capability, including a request-sending bridge for `sendRequest` or
  `runRequest`. Also ask before any change to level order beyond decision 5, or before turning
  imported scripts on by default.
- **Never:** run a script on import. Write a script's variable to a project or environment file. Load
  npm modules or files from a script. Name in docs or code which product inspired a feature
  (`pnpm check:banned-terms`). Naming the source client as the script's dialect is fine.

## 13. Success criteria

- The crafted fixture scripts for all four clients run once switched on and give the expected tests
  and variables, with no edits to the script text.
- Every unsupported call in §4–7 fails with `script-unsupported` and its client name, and the
  import report lists it before the user turns the script on.
- New imports write no `imported-scripts/` files, except Bruno helper modules.
- The Postman layer's tests and the Postman, v3 and OpenCollection golden snapshots are unchanged.
- `WIREBENCH_SKIP_PERF=1 pnpm check` and `pnpm test:perf` are green on every PR.

## 14. Open questions

None. Decisions 5 to 8 settled the four questions the first draft raised.
