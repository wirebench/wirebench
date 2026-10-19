# Spec: Convert imported scripts to Wirebench scripts

**Date:** 2026-10-18
**Status:** approved 2026-10-18; plan in `docs/plans/2026-10-18-convert-imported-scripts-plan.md`
**Milestone:** 6.1 — Team operations
**Scope:** phase 2 of imported scripts: a "Convert to Wirebench script" action that rewrites a level's
layered scripts (`postman`, `insomnia`, `bruno`, `hoppscotch` or `thunder-client`) into a typed
`wirebench` script.

Builds on:

- `docs/specs/2026-10-16-imported-script-layers-design.md`, the **layers spec** (phase 1,
  implemented). Its §8 is the outline this spec expands; its §14 lists the known limitations. Decision 7
  there puts Postman scripts in scope.
- `docs/adr/0016-scripts-run-with-no-capabilities.md`. A converted script runs in the same sandbox.
  Nothing here adds a capability.
- `packages/engine/src/script/api/`, the layers and `layer-parts.ts`. They define what each dialect
  call does today, and so what a rewrite must preserve.
- `docs-site/src/content/docs/reference/script-api.md`, the generated typed API, per protocol and
  phase. Every mapping in §6 is checked against it.

## 1. Objective

**Why.** An imported script runs through a layer: plain JavaScript, checked for syntax only, with
the client's names (`pm`, `bru`, `res`, `tc` …) over the typed API. That gets a team running on day
one. But the script never gets types from the contract, the editor cannot help with it, and every
call stays one step removed from what Wirebench actually does. Moving to the typed API by hand means
learning both APIs and rewriting every level one by one.

**What.** A "Convert to Wirebench script" action rewrites a level's layered scripts into one typed
`wirebench` script per phase. It rewrites the calls it can map one to one and marks everything else
with a `// TODO(convert):` comment naming the call. The user reviews a diff and accepts it. Only then
does the level switch to `api: 'wirebench'`, and the type check reports what is left.

**User stories.**

- My Bruno login request runs `bru.setVar("userId", res.body.id)` and a `tests` block with
  `expect(res.getStatus()).to.equal(201)`. I click Convert on its Scripts tab and see
  `vars.set("userId", (response.json() as any).id)` and `expect(response.status).toBe(201)` in a diff. I
  accept. The request now holds `create-user.post.ts`, the old `.js` sits under
  `imported-scripts/`, and the test still passes.
- A Postman collection imported 40 requests with scripts. I choose "Convert scripts…" on the API,
  review the list of levels with their diffs and TODO counts, untick the two that call
  `pm.sendRequest`, and accept the rest in one step.
- In CI I run `wirebench scripts convert ./project` to see what conversion would produce and how many
  TODOs are left, without writing anything. Then I run it with `--write` on a branch.

## 2. Decisions

Owner decisions, 2026-10-18:

| # | Question | Decision |
| --- | --- | --- |
| 1 | Where the action lives | On a level's Scripts tab, on a folder, API or SOAP interface ("Convert scripts…"), and project-wide. |
| 2 | How the rewrite works | Parse with the TypeScript parser the engine already ships, and match calls against a data table of mappings per dialect and protocol (§5). |
| 3 | Command line | The CLI gets it: `wirebench scripts convert` previews, and `--write` writes (§10). |
| 4 | The old `.js` file | Accepting moves it to `imported-scripts/<api>/<owner>.<phase>.js`, the folder phase 1 uses for text nothing runs (§7). |
| 5 | Async test callbacks | The "fail async script test callbacks" fix lands first, as PR 1 of this plan (§9). Convert needs no special case. |

Carried over from the task and the layers spec:

- The unit is a level, never a single script (§3).
- Bruno's post-response order is kept (§8).
- No usage data exists, so the first set of mappings comes from the crafted fixtures and the
  per-client tables in `guides/scripts.mdx` (§6).

## 3. The unit is a level

A request, folder, API or SOAP interface stores one `scripts` key: `pre`, `post`, and one `api`
for both (`RequestScripts`, `script/model.ts`). A level cannot be half `bruno` and half
`wirebench`. So Convert works on a level:

- It rewrites the level's pre-request and post-response scripts together, whichever exist.
- It switches the level's `api` to `wirebench` only when the user accepts the diff, in the same
  project edit that writes the new text.
- It keeps `enabled`, `secrets`, `timeoutMs` and `postResponseOrder` as they are. A switched-off
  script stays switched off after conversion. Converting never runs a script.
- A level whose `api` is already `wirebench` is not offered. A layered level with no script text (for
  example a Bruno API level that holds only `postResponseOrder`) converts to `wirebench` with no files.

A folder, API or project conversion is a set of level conversions. Each level is accepted or left
on its own. One level failing to convert never blocks another.

## 4. Where the action lives

### 4.1 Desktop

- **One level.** The Scripts tab of a layered level shows a **Convert to Wirebench script** button
  next to the dialect label. It opens the review (§4.2) for that level.
- **A folder, an API or a SOAP interface.** The tree's context menu gains **Convert scripts…**. It
  collects every layered level at or below it.
- **The project.** The command palette gains **Convert all imported scripts…**. It collects every
  layered level in every API.

### 4.2 The review

The review is one dialog for all three entry points:

- A list of the levels it would convert, each with its dialect, its path (`API / Folder / Request`),
  and its TODO count. Every row is ticked by default.
- For the selected row, a side-by-side diff of each phase: the layered `.js` text on the left, the
  proposed `.ts` on the right. It uses the Monaco diff editor the History diff already uses
  (`editor/diff-xml-editor.tsx`) with the `typescript` language.
- Under the diff, the type-check problems of the proposed `.ts`, from the same checker the Scripts
  tab uses, with the level's protocol and phase. They are shown, not enforced. A converted script
  with problems behaves like any typed script with problems today.
- **Accept** applies every ticked row in one project edit (§7). **Cancel** changes nothing.

The proposal is computed from the text the editor holds, not the file on disk. If a level's scripts
change between the review opening and Accept (another window, a file watcher reload), that row is
refused with "changed since the review opened" and the others go ahead. A row whose id another level
of the project also carries (ids are not checked unique; a copied request file keeps its id) is
refused with "another level has the same id", and no level with that id is switched.

## 5. How the rewrite works

### 5.1 Parse, match, splice

The engine already depends on `typescript` at run time (`script/check/service.ts`). Convert uses
`ts.createSourceFile` to parse each script as JavaScript, and nothing else from the compiler:

1. **Parse.** A script that does not parse is not converted. Its row says "has a syntax error at
   line N" and cannot be ticked. A script that cannot be converted for another reason (it nests too
   deeply to walk, or the converter hits an internal error) is reported the same way, with line 0
   and a message that starts "could not convert:", and cannot be ticked either; Convert never throws.
   A Hoppscotch script's `export {};` lines, which the runner blanks before it runs the script, are
   blanked first too: the line stays, empty, so the TODO line numbers hold, and the converted script
   does not fail on the `export` the typed runner would not blank.
2. **Find the dialect's roots.** A dialect has fixed global roots: `pm`, `postman`, `CryptoJS`,
   `btoa` and `atob` for `postman`; `insomnia` and `$` for `insomnia`; `bru`, `req`, `res`, `test`
   and `expect` for `bruno`; `pw`, `hopp` and `pm` for `hoppscotch`; and `tc`, `test` and `expect` for
   `thunder-client`. Insomnia, Hoppscotch's `pm` and Postman share one table of `pm`-shaped rows.
   A root the script declares itself (`const expect = …`, a parameter named `res`) is not a global.
   Convert skips every reference to it and adds one file-level TODO naming the shadowed root.
3. **Match.** Each call or property chain on a root is matched against the mapping table (§6), keyed by
   dialect, phase and protocol. A row matches on the qualified name (`pm.response.json`) and, where it
   says so, on the argument shape (an object literal with `key` and `value`, a string literal).
4. **Splice.** A match replaces exactly the node's text span. Everything else in the file stays
   byte for byte: comments, blank lines, formatting and unrelated code. Edits are applied from the
   end of the file backwards, so spans never shift.

The table is data (`script/convert/mappings.ts`), not code: one row per call, with the replacement
template per protocol. Adding a mapping later is one row and one test.

### 5.2 What is not mapped

A dialect call with no row, or with a row that has no template for this protocol or phase, is not
rewritten. The innermost statement holding it is commented out line by line, and one line goes above
it:

```ts
// TODO(convert): pm.sendRequest — a script cannot send requests; use a sequence step or OAuth2 auth
// pm.sendRequest(tokenRequest, (err, res) => {
//   pm.environment.set('token', res.json().access_token);
// });
```

- The TODO names the call as the layer names it, and adds the layer's reason when the call is one
  the layer refuses (`WHY` in `layer-parts.ts`), or "not converted yet" when the layer runs it but no
  mapping exists.
- Mapped calls inside a commented-out statement are not rewritten; the statement is kept exactly as
  written.
- A name declared in a commented-out statement and used later makes the type check report "Cannot
  find name". That is intended: the type check is the list of what is left.

### 5.3 The file header

The first line of each converted file names where it came from:

```ts
// Converted from a bruno script; the original is in imported-scripts/users-api/users-create-user.post.js.
```

### 5.4 What the rewrite never does

- It never changes what a mapped call does in the cases the layer handles. §6 notes each known
  difference.
- It never adds helpers, imports or new globals. The output uses only the typed API.
- It never touches text inside strings, template literals or comments.

## 6. The mapping table

### 6.1 How rows were chosen

No usage data exists. The first set is every call in the crafted fixtures (`fixtures/{postman,
postman-v3,insomnia,bruno,hoppscotch,thunder-client}`) and the most common rows of the per-client
tables in `guides/scripts.mdx`: variables, tests, status, JSON body, headers and run control. The
fixtures use `bru.setVar`, `res.body`, `res.status`, `res.getStatus`, `pm.test`, `pm.expect`,
`pm.response.code`, `pm.response.json`, `pm.environment.set`, `pm.variables.get`,
`pm.request.headers.add`, `insomnia.variables.set`, `insomnia.test`, `insomnia.expect`,
`insomnia.response.code`, `pw.test`, `pw.expect`, `pw.response.status`, `hopp.env.set`, `hopp.test`,
`hopp.expect`, `hopp.response.statusCode`, `tc.setVar` and `tc.response.json`. Every one is mapped
below.

### 6.2 How rows were checked

Each template was checked against the generated reference (`reference/script-api.md`) for every
protocol it claims, and against the layer that runs the call today. `—` means no template: the call
becomes a TODO for that protocol. `pre` and `post` mark a row that works in one phase only.

The `pm.*` rows also apply to `insomnia.*` / `$.*` and to Hoppscotch's `pm.*`. "Variable scopes" means
`environment`, `collectionVariables`, `globals` and `variables` (and Insomnia's `baseEnvironment`
and `parentFolders`).

### 6.3 Variables (every protocol, both phases)

| Dialect call | Wirebench |
| --- | --- |
| `pm.<scope>.set(a, b)`, `bru.setVar` / `setEnvVar` / `setGlobalEnvVar(a, b)`, `tc.setVar(a, b[, scope])`, `pw.env.set(a, b)`, `hopp.env[.active\|.global].set(a, b)`, `postman.setEnvironmentVariable` / `setGlobalVariable(a, b)` | `vars.set(a, b)` |
| `pm.<scope>.get(a)`, `bru.getVar` / `getEnvVar` / `getGlobalEnvVar` / `getCollectionVar` / `getFolderVar` / `getRequestVar(a)`, `tc.getVar(a)`, `pw.env.get(a)`, `postman.getEnvironmentVariable` / `getGlobalVariable(a)` | `(vars.get(a) ?? props.get(a))` |
| `hopp.env[.active\|.global].getRaw(a)` | `(vars.get(a) ?? props.get(a) ?? null)` |
| `pm.<scope>.has(a)`, `bru.hasVar(a)` | `(vars.get(a) ?? props.get(a)) !== undefined` |

Notes:

- **Reads.** Every layer reads `vars` first, then `props` (layers spec §3.3). The typed `vars.get`
  reads only the run's values, so a read maps to both. The parentheses keep the `??` safe inside any
  expression.
- **Writes.** A layer turns `null` and `undefined` into `''` and an object into its JSON. The typed
  `vars.set` takes a string, number or boolean and throws `script-value-invalid` otherwise. The type
  check reports a value whose type it cannot narrow to one of those. Convert does not wrap it in
  `JSON.stringify`, because the type check already names the line. A value read from the response
  body is the exception: the body is cast `as any` (§6.5), so `vars.set('id', response.json() as any)`
  or a field of it type-checks, and when the value is `null`, `undefined` or an object at run time
  `vars.set` throws `script-value-invalid` where the layer stored `''` or the JSON.
- **Not mapped:** `unset`, `clear` and `bru.deleteVar` (the typed API has no unset), `hopp.env.get`
  and `pw.env.resolve` (they expand `<<name>>`), `replaceIn`, `bru.interpolate` and `tc.replaceVars`.

### 6.4 Tests and expectations (every protocol, both phases)

| Dialect call | Wirebench |
| --- | --- |
| `pm.test(n, f)`, `pw.test(n, f)`, `hopp.test(n, f)`, Bruno's `test(n, f)` | `test(n, f)` |
| `tc.test(n, f)` with an `async` function literal | `test(n, f)` |
| `tc.test(n, f)` with any other function literal | `test(n, () => expect<unknown>((f)()).not.toBe(false))` |
| `tc.test(n, b)` with any other value | `test(n, () => expect(b).toBe(true))` |
| `pm.expect(x)`, `hopp.expect(x)`, `pw.expect(x)`, Bruno's and Thunder Client's `expect(x)`, `tc.expect(x)` | `expect(x)`, then the chain below |

The chai chain (`pm.expect`, `hopp.expect`, Bruno, Thunder Client). The filler words `to`, `be`,
`been`, `is`, `that`, `which`, `and`, `has`, `have`, `with`, `at`, `of` and `does` are dropped:

| Chain | Wirebench |
| --- | --- |
| `.equal(y)`, `.equals(y)`, `.eq(y)` | `.toBe(y)` |
| `.deep.equal(y)`, `.eql(y)`, `.eqls(y)` | `.toEqual(y)` |
| `.include(y)`, `.contain(y)` (and `includes`, `contains`) | `.toContain(y)` |
| `.property(n)`, `.property(n, v)` | `.toHaveProperty([n])`, `.toHaveProperty([n], v)`; a string literal without a dot is written `.toHaveProperty('n')` |
| `.lengthOf(n)`, `.length(n)` | `.toHaveLength(n)` |
| `.match(re)` | `.toMatch(re)` |
| `.above(n)`, `.gt(n)`, `.greaterThan(n)` | `.toBeGreaterThan(n)` |
| `.below(n)`, `.lt(n)`, `.lessThan(n)` | `.toBeLessThan(n)` |
| `.true`, `.false` | `.toBe(true)`, `.toBe(false)` |
| `.null`, `.undefined`, `.ok` | `.toBeNull()`, `.toBeUndefined()`, `.toBeTruthy()` |
| `.a(t)` / `.an(t)`, `t` a string literal `string`, `number`, `boolean`, `undefined` or `function` | `expect(typeof x).toBe(t)` |
| `.not` anywhere before the assertion | `.not` before the matcher |

The Jest-style matchers (`pw.expect`, `hopp.expect`):

| Matcher | Wirebench |
| --- | --- |
| `.toBe(y)`, `.toHaveLength(n)` | The same |
| `.toInclude(y)` | `.toContain(y)` |
| `.toBeType(t)` | `expect(typeof x).toBe(t)` |
| `.toBeLevel2xx()` to `.toBeLevel5xx()` | `expect(Math.floor(x / 100)).toBe(2)` (3, 4, 5) |
| `.not` | `.not` |

Notes:

- **Deep equality.** The chai layer compares two values by their JSON, so key order counts. The typed
  `toEqual` ignores key order and `undefined` keys. A converted check can pass where the layered one
  failed only on key order, never the reverse.
- **`.property` with a dotted name.** Chai reads `'a.b'` as one key, and the typed `toHaveProperty`
  splits a string on dots. The array form keeps chai's meaning.
- **`.include` on an object** (subset match) has no typed form. With the body cast `as any` the type
  check would not report it, and the typed `toContain` would fail at run time where chai passed, so
  `.include`, `.includes`, `.contain` or `.contains` given an object literal is a TODO.
- **`tc.test` with a function value** that is not a literal (a variable) is converted the same way,
  `(f)()`.
- **`tc.test` with an `async` function literal** becomes `test(n, f)`: the typed `test` settles the
  promise, so a rejection fails the test. Checking the promise with `.not.toBe(false)` would pass
  whatever it settled to.
- **Not mapped:** `.oneOf`, `.within`, `.least` / `.gte`, `.most` / `.lte`, `.keys`, `.empty`,
  `.exist`, `.NaN`, `.string`, `.a(t)` for `object`, `array`, `null` or a non-literal `t`, and Bruno's
  `.jsonSchema`. For `.jsonSchema`, the TODO points at the request's JSON Schema assertion.

### 6.5 The response (post-response only)

| Dialect call | REST | SOAP | gRPC | MCP |
| --- | --- | --- | --- | --- |
| `pm.response.code`, `res.status`, `res.getStatus()`, `pw.response.status`, `hopp.response.statusCode`, `tc.response.status` | `response.status` | `response.status` | `response.status.code` | — |
| `pm.response.json()`, `hopp.response.body.asJSON()`, `tc.response.json` | `response.json() as any` | — | `response.message` | — |
| `res.body`, `res.getBody()`, `pw.response.body` | `response.json() as any` | `response.text` | `response.message` | — |
| `pm.response.text()`, `hopp.response.body.asText()`, `tc.response.text` | `response.text` | `response.text` | `JSON.stringify(response.message)` | — |
| `pm.response.headers.get(n)`, `res.getHeader(n)`, `tc.response.getHeader(n)` | `response.headers.get(n)` | `response.headers.get(n)` | `response.metadata.get(n)` | — |
| `pm.response.responseTime`, `res.responseTime`, `res.getResponseTime()`, `hopp.response.responseTime`, `tc.response.time` | `response.durationMs` | `response.durationMs` | `response.durationMs` | `response.durationMs` |
| `pm.response.to.have.status(n)`, `n` a number | `expect(response.status).toBe(n)` | `expect(response.status).toBe(n)` | `expect(response.status.code).toBe(n)` | — |

Notes:

- **Status.** A REST and a SOAP `response.status` is a number. A gRPC `response.status` is
  `{ code, name, message }`; the layers read `.code`. An MCP response has no status, so the layers'
  `undefined` has nothing to map to.
- **A body that is not JSON.** Bruno's `res.body`, Hoppscotch's `pw.response.body` and Thunder
  Client's `tc.response.json` give the text, or `undefined`, when the body does not parse. The typed
  REST `response.json()` throws instead. A converted script on a non-JSON response therefore fails
  with `script-error` where it used to read the text or `undefined`. That failure is loud, and the
  docs say so.
- **An untyped body.** Without a contract the typed `response.json()` is `unknown`, and an imported
  request has none, so `res.body.id` would not type-check. The layers read the body untyped, and so
  does the converted script: `response.json() as any`, parenthesised wherever something binds to
  it — a property or element access, a call, an operator (`(response.json() as any).id`). Where
  that `(` opens a statement after a line with no semicolon, Convert writes a `;` before it, so the
  two lines are not joined. The cast is erased before the script runs. Linking the request to
  a contract later and deleting the cast types the body from it.
- **Repeated headers.** Bruno's `res.getHeader` joins repeated names with `, `. The typed
  `headers.get` gives the first one. The docs name the difference; `headers.getAll(n).join(', ')` is
  the exact form, and Convert does not write it.
- **Not mapped:** `pm.response.status` (the reason phrase; REST's `response.statusText` is close, but
  the layer falls back to the code), `responseSize`, `res.getSize`, `tc.response.size`,
  `tc.response.contentType`, the `pm.response.to.be.*` getters, `pm.response.to.have.header` /
  `jsonBody` / `body`, every MCP body, and a header read on an MCP response.

### 6.6 The request

| Dialect call | Phase | REST | SOAP | gRPC | MCP |
| --- | --- | --- | --- | --- | --- |
| `pm.request.headers.add({ key: k, value: v })` (object literal) | pre | `request.headers.add(k, v)` | `request.headers.add(k, v)` | `request.metadata.add(k, v)` | — |
| `pm.request.headers.upsert({ key: k, value: v })`, `req.setHeader(k, v)`, `hopp.request.setHeader(k, v)` | pre | `request.headers.set(k, v)` | `request.headers.set(k, v)` | `request.metadata.set(k, v)` | — |
| `pm.request.headers.remove(k)` (a string), `req.deleteHeader(k)`, `hopp.request.removeHeader(k)` | pre | `request.headers.delete(k)` | `request.headers.delete(k)` | `request.metadata.delete(k)` | — |
| `pm.request.headers.get(k)`, `req.getHeader(k)` | both | `request.headers.get(k)` | `request.headers.get(k)` | `request.metadata.get(k)` | — |
| `req.getUrl()` | both | `request.url` | `request.endpoint` | `request.target` | `request.url` |
| `pm.request.url.toString()` | both | `request.url` | — | `request.target` | `request.url` |
| `req.setUrl(u)` | pre | `request.url = u` | — | — | — |
| `req.getMethod()`, `pm.request.method` (read) | both | `request.method` | — | `request.method` | `request.method` |
| `req.setMethod(m)` | pre | `request.method = m` | — | — | — |

Notes:

- **Header values.** Every layer passes a header's name and value through `String(…)`. The typed
  writers take strings, so a `k` or `v` that is not a string literal is written `String(k)`,
  `String(v)`: the run is the same, and a variable read (`string | undefined`) or a number
  type-checks.
- **The URL on SOAP.** The `pm`-shaped layers read the URL as `String(request.url)`, which is
  `'undefined'` on SOAP, so `pm.request.url.toString()` is a TODO there. Bruno's `req.getUrl()` reads
  the endpoint.
- **Writes need a statement.** `request.url = u` and `request.method = m` are assignments. A
  `req.setUrl(u)` used as a value (rare) becomes a TODO.
- **Read-only in post-response.** The typed post-response `request` is read-only, as the layers'
  setters refuse there. A setter in a post-response script becomes a TODO with the layer's reason.
- **A SOAP request** has no method, and its endpoint cannot change from a script. An MCP request has
  no headers (`WbMcpTarget`). Those cells are `—`.
- **`pm.request` on gRPC.** The Postman and Insomnia layers and Hoppscotch's `pm` throw a plain
  `TypeError` there (layers spec §14). The gRPC templates read `request.metadata`, so a converted
  script works where the layered one failed. The equivalence tests (§12) list this as a documented
  difference.
- **Not mapped:** request bodies (`req.getBody`, `req.setBody`, `pm.request.body.raw`,
  `hopp.request.setBody`, `tc.request.setBody`), query parameters, `tc.request.*` and the other
  `hopp.request` setters, and `pm.request.url.getHost` / `getPath`. Bodies differ by protocol and
  kind (`WbRestBody.kind`, a SOAP envelope, a gRPC message), and no fixture uses them.

### 6.7 Run control, iteration, crypto (every protocol)

| Dialect call | Wirebench |
| --- | --- |
| `pm.execution.setNextRequest(n)`, `postman.setNextRequest(n)`, `bru.setNextRequest(n)` | `execution.setNextRequest(n)` |
| `pm.execution.skipRequest()`, `bru.runner.skipRequest()`, `tc.skipRequest()` (no argument) | `execution.skipRequest()` (pre only; a post-response call is a TODO with the layer's reason) |
| `bru.runner.stopExecution()` | `execution.setNextRequest(null)` |
| `pm.info.iteration`, `tc.info.currentIteration` | `iteration.index` |
| `pm.info.iterationCount`, `tc.info.totalIterations` | `iteration.count` |
| `pm.iterationData.get(c)` | `iteration.data.get(c)` |
| `btoa(x)`, `atob(x)` | `encoding.base64(x)`, `encoding.fromBase64(x)` |
| `CryptoJS.MD5` / `SHA1` / `SHA256` / `SHA512(x).toString()`, optionally `.toString(CryptoJS.enc.Hex \| Base64)` | `crypto.hash('md5' \| 'sha1' \| 'sha256' \| 'sha512', x[, 'base64'])` |
| `CryptoJS.HmacSHA1` / `HmacSHA256` / `HmacSHA512(data, key).toString(…)` | `crypto.hmac('sha1' \| 'sha256' \| 'sha512', key, data[, 'base64'])` |

Notes:

- **HMAC argument order.** CryptoJS takes `(data, key)`, the typed `crypto.hmac` takes `(key, data)`.
  The template swaps them, and a test pins it.
- **CryptoJS** is mapped only as the whole `CryptoJS.X(…).toString(…)` chain, with `x` passed as it
  is. A word array kept in a variable, `CryptoJS.enc.*.parse` and `.stringify` become TODOs.
- **`console.*`** is the same in both APIs and is left as written.
- **Not mapped:** `pm.info.requestName`, `pm.info.eventName`, `req.getName`, `tc.info.requestName` (the
  typed API has no request name), `pm.iterationData.toObject`, `bru.getEnvName`,
  `bru.getCollectionName`, and `tc.info`'s `undefined` fields.

### 6.8 Unsupported calls

A call the layer refuses (layers spec §3.4, `UNSUPPORTED_CALLS` in `import/scripts.ts`) is always a
TODO with the layer's reason (§5.2). The review counts those separately from "not converted yet",
because no later mapping can convert them.

## 7. Files and the project edit

Accepting a level does all of this in one project edit, through the same main-process path the
Scripts tab uses (`project-script-mutations.ts`):

1. **Back up the layered text.** Each phase's current text is written to
   `imported-scripts/<api-slug>/<owner>.<phase>.js`. `<owner>` is the level's path from the API
   down, slugified and joined with `-`, as `droppedApiScriptFiles` names files today. A name already
   taken gets `-2`, `-3` (`importedScriptPath`). The backup is written before the save. A save
   deletes a script file the level no longer uses (`project/managed-files.ts` claims both `.ts` and
   `.js`), so the order matters. Nothing in Wirebench reads `imported-scripts/`.
2. **Switch the level.** `scripts.api` becomes `'wirebench'` and the new texts replace `pre` and
   `post`. `enabled`, `secrets`, `timeoutMs` and `postResponseOrder` are kept.
3. **Save.** The save writes `<slug>.pre.ts` and `<slug>.post.ts`, because `scriptFileName` derives the
   name from the slug and the API. It deletes the old `<slug>.pre.js` / `.post.js` as a stale managed
   file.

If the save fails, the backups stay; they are harmless text. The report after Accept lists each
level, its backup paths and its TODO count. The project format does not change: `wirebench` is a
value every version reads, and `imported-scripts/` holds plain files.

## 8. Bruno order is kept

Bruno's `sandwich` flow sets the API's `postResponseOrder` to `inner-first` (layers spec §5). The
order is an API-level setting, read whatever the levels' `api` is (`postResponseLevels` in
`script/request-scripts.ts`). So:

- Converting the API level keeps `postResponseOrder` on it (§7 step 2). Post-response scripts run in
  the same order after conversion, whether some levels are converted and others are not.
- Converting a folder or request never touches the API's setting.
- A test converts every level of the crafted Bruno collection, runs it, and compares the order of
  the recorded tests before and after.

## 9. Async test callbacks: fixed first

The layers spec §14 records that `test(name, async () => …)` records a pass whatever the callback
does, because the sandbox never awaits the promise. The typed `test` has the same gap. The typed
`test` takes `check: () => void`, and an async function type-checks against that, so the type check
would not catch a converted async test either.

Decision 5: the fix lands first, as PR 1 of this plan. Its scope is the "fail async script test
callbacks" card: a `test` callback that returns a promise records a failure that says the callback
was async and was not awaited, in the typed `test` and in every layer's `test`. Convert then maps
`pm.test(n, async () => …)` to `test(n, async () => …)` like any other test, and the converted test
fails the same way the layered one does. No Convert code special-cases `async`.

## 10. The command line

```text
wirebench scripts convert <path> [selector…] [--write]
```

- `<path>` and the selectors work as in `wirebench run` and `wirebench secrets list`. With no
  selector, every layered level in the project is a candidate.
- **Without `--write`** it prints, per level, the path, the dialect, a unified diff of each phase,
  and the TODOs. Then it prints a total of levels, mapped calls and TODOs. Nothing is written.
- **With `--write`** it applies §7 to every level that converts, through the engine's own project
  save. A level whose script does not parse is listed and skipped.
- **Exit codes** (`exit-codes.ts`): `0` when it finished, whatever the TODO count; `2` for a usage
  error; `3` when the project could not be loaded or saved. TODOs are not failures: the type check
  owns what is left.
- The engine function the desktop uses is the one the CLI calls, so both produce the same text.

The MCP server does not get Convert. It rewrites files, and the MCP server's tools do not edit a
project's scripts today.

## 11. Docs

- `guides/scripts.mdx`: a "Convert to Wirebench scripts" section under "Scripts from other clients".
  It covers the three entry points, the review, the backup folder, the TODO comment, and the
  differences §6 notes (non-JSON bodies, repeated headers, deep equality and key order).
- The per-client tables in that guide gain a column saying whether Convert maps the call.
- The switching pages for each client link the new section.
- `docs/cli.md`: `wirebench scripts convert`.
- No change to the generated script API reference.

## 12. Testing

- **Mapping unit tests** (`packages/engine/test/unit/script/convert/`): one test per table row, per
  protocol cell, with input text and expected output text. Each `—` cell has a test that it becomes a
  TODO.
- **Equivalence tests.** For each mapped row, a script that uses it runs twice through `runScript`
  against the same request and response fixtures: once layered, once converted. Both must record the
  same tests and the same values. The only exceptions are the documented differences in §6, and each
  of those has its own test that pins the difference.
- **Parser edge cases:** a shadowed root, a mapped call inside a string or comment (left as is), a
  call inside a commented-out statement, nested `test` bodies, a concise arrow body, CRLF line ends,
  and a syntax error.
- **Fixtures end to end:** import each client's crafted fixture, convert every level, type-check the
  result with the real checker, then send against the local echo server. The tests and values must
  match the layered run.
- **Bruno order:** §8.
- **Files:** the backup path, collisions, the old `.js` gone after the save, and `enabled`,
  `secrets`, `timeoutMs` and `postResponseOrder` kept.
- **CLI:** the preview writes nothing, `--write` writes, and the exit codes.
- **e2e** (CI only): import the crafted Bruno collection, convert the API from the tree menu, accept,
  and see `.ts` scripts on the Scripts tab with no type-check problems.

## 13. Delivery

The plan is `docs/plans/2026-10-18-convert-imported-scripts-plan.md`. PRs:

1. **Async test callbacks** (§9): typed `test` and every layer. No Convert code.
2. **Engine converter:** `script/convert/` (parser, table, splice, TODOs), the §6 rows, the unit
   and equivalence tests.
3. **Project edit and CLI:** §7 in the engine and the main process, `wirebench scripts convert`, and
   the CLI docs.
4. **Desktop:** the button, the tree menu, the palette command, the review dialog, the guide section,
   and the e2e test.

## 14. Boundaries

- **Always:** keep ADR-0016; converted scripts use only the typed API. Convert never runs a script,
  never turns a script on, and never switches a level's `api` without the user accepting (or
  `--write`). Keep every layered text in `imported-scripts/` before its file is deleted. Keep the
  API's `postResponseOrder`.
- **Ask first:** a mapping that changes behaviour beyond the differences §6 names; a typed-API
  addition made only so a mapping exists (for example `vars.unset`); Convert in the MCP server.
- **Never:** convert one phase of a level without the other; rewrite text inside strings or
  comments; delete a layered script without a backup; name in docs or code which product inspired a
  feature (`pnpm check:banned-terms`). Naming the source client as the script's dialect is fine.

## 15. Success criteria

- Every call the crafted fixtures make converts with no TODO, and each converted fixture runs with the
  same tests and values as its layered run.
- Every §6 row has a unit test for each protocol cell, and every mapped row has an equivalence test.
- After Accept or `--write`, each converted level has `api: wirebench`, `.ts` files, no `.js` files,
  and a backup under `imported-scripts/` for each phase it had.
- A converted Bruno API with `inner-first` runs its post-response scripts in the same order as
  before.
- `WIREBENCH_SKIP_PERF=1 pnpm check` and `pnpm test:perf` are green on every PR.

## 16. Open questions

None. The five owner decisions in §2 settled them.
