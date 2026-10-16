# Spec: Running scripts imported from Insomnia, Bruno, Hoppscotch and Thunder Client

**Date:** 2026-10-16
**Status:** draft (under review)
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
  - `interpolate`, through the run's resolver;
  - `setNextRequest`, mapped to `execution.setNextRequest`;
  - `runner.skipRequest`, mapped to `execution.skipRequest`;
  - `runner.stopExecution`, mapped to `execution.setNextRequest(null)`.
- **`req`:**
  - `getUrl` / `setUrl`, `getMethod` / `setMethod`, `getHeader` / `setHeader` / `deleteHeader` and
    `getBody` / `setBody`, over `request`;
  - `setTimeout` and the other request settings, which are unsupported.
- **`res`:**
  - `status`, `headers`, `body` (parsed as JSON when the response is JSON) and `responseTime`;
  - `getStatus`, `getBody` and `getHeader`.
- **`test` and `expect`:** the shared ones, plus `.jsonSchema`. That is checked against a schema in
  the script, with the same validator assertions use, if it can run in the sandbox. Otherwise it is
  unsupported.

Unsupported: `bru.sendRequest`, `bru.sleep`, `require`, `bru.cookies` and `.jsonSchema` if the
validator cannot run in the sandbox.

**Script order.** Bruno's `scripts.flow` defaults to `sandwich`. The research note says that runs
post-response scripts innermost first: request, then folder, then collection. Wirebench runs them
outermost first. See open question 1.

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

A later action on any layered script, Postman included (open question 3), rewrites it into a typed
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
  `runRequest`. Also ask before any change to level order (open question 1), or before turning
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

1. **Bruno post-response order.** Should Bruno's `sandwich` flow be honoured by adding an API-level
   `postOrder: 'outer-first' | 'inner-first'` to the script model, set to `inner-first` on Bruno
   imports? The alternative is to keep Wirebench's order and report the difference. The meaning of
   `sandwich` must first be confirmed in Bruno's source (`prepare-request.js:394`). Recommendation:
   confirm it, then add the setting, because a token captured in a folder post-script that a request
   post-script reads would otherwise break.
2. **Bruno `.jsonSchema`.** Can the assertion validator run inside the QuickJS sandbox within the
   64 MiB limit, or is it unsupported? This needs a spike in PR 2.
3. **Phase 2 scope.** Should "Convert to Wirebench script" also cover Postman scripts? Recommendation:
   yes, since the Postman layer is the largest and oldest.
4. **Milestone.** 6.1 (Team operations), or "Later — demand-driven"?
