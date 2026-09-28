# Typed scripting — design

Issue: #63. Roadmap item 13. Builds on Sequences (#62, `docs/specs/2026-09-28-sequences-design.md`) and holds to
ADR-0015 (`docs/adr/0015-response-values-are-data.md`). The trust and sandbox rules are recorded in ADR-0016
(`docs/adr/0016-scripts-run-with-no-capabilities.md`).

## Goal

A saved SOAP, REST or unary gRPC request can carry a **pre-request script** and a **post-response script**, written in
TypeScript. The script's `request` and `response` are typed from the contract: the XSD for SOAP, the OpenAPI schema
for REST, the proto descriptor for gRPC. The editor completes a path in the message, and a wrong path is a type error
that stops the send before anything leaves the machine, in the app and in `wirebench run` alike.

Scripts run in a sandbox with no capabilities: no network, no files, no clock to wait on, no host objects. A script
can read and change its own request, read its response, record test results, set values for later requests and log.
Nothing else.

Collections imported from Postman keep their pre-request and test scripts. They are imported switched off, and once
someone has read and switched them on, they run through a `pm` compatibility layer over the same sandbox.

## Scope

In:

- A pre-request and a post-response script per SOAP, REST and unary gRPC request, as TypeScript files beside it.
- The script API (§API), with types generated per request from its contract (§Types).
- Type-checking before a send, in the app and the CLI. A request whose script has a type error is not sent.
- Script tests reported like assertions: in the response panel, sequence run panel, and every CLI reporter.
- Values a script sets, used by later requests as `${#Sequence#name}`, in a sequence, a CLI run, or an app session
  (§Values).
- A `pm` compatibility layer for imported Postman scripts (§Postman), and the importer keeping those scripts,
  switched off until enabled.
- Editing in Monaco: highlighting, completion, hover and diagnostics, served by a TypeScript language service in main.

Out, each its own later work:

- Scripts on a sequence step, a folder, an API or a project. Postman's collection and folder scripts are copied into
  each request's script when imported (§Postman), so nothing depends on them.
- Asynchronous scripts, timers, and a script that sends a request (`pm.sendRequest`).
- WebSocket and streaming gRPC requests.
- Script assertions in the YAML assertion list. A test in a post-response script is the way to write one.
- Scripts in mock services (#59).

## Storage

### Request files: `formatVersion: 6`

A request file gains an optional `scripts` key. ADR-0003 makes any additive field a version bump, because an older
build drops a key it does not know and would then delete it on its next save. It would also send the request
without its scripts, which is worse. `formatVersion` becomes 6, and the 5 → 6 migration is a stamp: no data moves.

```yaml
# apis/shop/requests/Checkout.request.yaml
kind: rest-request
# ... the request as today ...
scripts:
  pre: Checkout.pre.ts         # a file beside the request, required when `pre` is set
  post: Checkout.post.ts
  api: wirebench               # or `postman`; default wirebench
  enabled: true                # default true; the Postman importer writes false (§Postman)
  secrets: [signing-key]       # secrets the scripts may read (§Secrets); default none
  timeoutMs: 1000              # per script; default 1000, at most 10000
```

The same key sits in SOAP request files (`interfaces/<I>/operations/<Op>/<R>.request.yaml`) and gRPC request files.
A WebSocket request file does not read it, so a WebSocket request has no scripts.

- A script file lives beside its request and is named after it: `<R>.pre.ts` and `<R>.post.ts` for the `wirebench`
  API, `<R>.pre.js` and `<R>.post.js` for `postman`. Renaming or moving a request moves its scripts, as it moves its
  body sidecar today.
- A script runs only when the key names it. A file with a script's name beside a request whose key does not name
  it is never loaded. It is reported as a file that belongs to no request, and like a stray body file, the next save
  removes it.
- The loader always opens the name derived from the slug, never the name the key records, so a hand-edited name
  cannot point outside the request's directory.
- A named file that is missing is a load problem (`script-file-missing`) shown on the request, and the request
  refuses to send until it is fixed.
- A script file is at most 256 KiB (`script-too-large`).
- `enabled: false` keeps the scripts and their files, but none of them runs: the request is sent as if it had no
  scripts, and its result says the scripts were off (`scriptsOff: true`). A switched-off script is not type-checked
  either, so a switched-off script with errors never blocks a send.
- Save writes a script file only when its text changed, like a body sidecar. Removing a script removes its file.

### Project settings

None. Every setting is per request, so a request file says everything about how it runs.

## API

The API is the same for every protocol. Only `request` and `response` differ, and their types are generated
(§Types). A script is a module body: top-level statements, with no imports and no exports. The globals are:

```ts
// Both scripts
declare const vars: {
  get(name: string): string | undefined;          // this run's values (§Values)
  set(name: string, value: string | number | boolean, options?: { secret?: boolean }): void;
};
declare const props: { get(name: string): string | undefined };  // resolved non-secret properties, read-only
declare const secrets: { get(name: SecretName): string };        // only names in `scripts.secrets`
declare const crypto: {
  hash(algorithm: 'sha1' | 'sha256' | 'sha512' | 'md5', data: string, encoding?: 'hex' | 'base64'): string;
  hmac(algorithm: 'sha1' | 'sha256' | 'sha512', key: string, data: string, encoding?: 'hex' | 'base64'): string;
  randomUUID(): string;
};
declare const encoding: {
  base64(text: string): string; fromBase64(text: string): string;
  base64url(text: string): string; urlEncode(text: string): string;
};
declare function log(...values: unknown[]): void;

// Pre-request only
declare const request: Request;                     // generated; mutable

// Post-response only
declare const request: Readonly<SentRequest>;      // what was sent, after the pre-request script
declare const response: Response;                   // generated; read-only
declare function test(name: string, check: () => void): void;
declare function expect<T>(actual: T): Expectation<T>;
```

`expect` is small and typed: `toBe`, `toEqual` (deep), `toBeDefined`, `toBeUndefined`, `toBeNull`, `toBeTruthy`,
`toBeFalsy`, `toContain`, `toMatch`, `toBeGreaterThan`, `toBeLessThan`, `toHaveLength`, `toHaveProperty`, and
`.not`. A failed `expect` throws; inside `test`, that fails the test and the script goes on to the next statement.
Outside `test`, it fails the script.

`Date` and `Math.random` work. `JSON`, `RegExp`, `Map` and the rest of the ECMAScript library work. There is no
`setTimeout`, `fetch`, `require`, `import()`, `process`, `globalThis` host object, or `eval` of host code. `eval`
and `Function` inside the sandbox compile code in the sandbox, which gives a script nothing it did not already have.

### What a pre-request script can change

A pre-request script runs after property expansion and before configured auth, WS-Addressing, WS-Security,
compression and signing. That way a script's change is signed, and the script never sees the configured
credentials.

| Protocol | Can change | Cannot change |
| --- | --- | --- |
| REST | method, path, query, headers, body (`body.json` typed, or `body.text`) | scheme, host, port |
| SOAP | the SOAP body (`body` typed, or `envelope` text), SOAP headers, HTTP headers, SOAPAction | endpoint scheme, host, port |
| gRPC | the message (typed), metadata | target, method |

A change to the origin fails the send with `script-origin-change` (ADR-0016). A header or metadata value with CR, LF or
NUL fails with `script-value-invalid`. The body is serialised by the engine from the typed value, so a script cannot
break its structure. A script that sets `envelope` or `body.text` takes the text as written.

## Types

Types are generated per request, from the contract it is linked to, as a `.d.ts` beside the static API declarations.
Generation lives in the engine (`packages/engine/src/script/types/`) and is the same for the app and the CLI.

### REST (OpenAPI)

- `request.body.json` is typed from the operation's JSON request body schema. With no schema, it is `unknown`.
- `response` is a union with one arm per declared status, each with its own `json()` type.
  - Each arm's `status` is a set of literals: one code (`201`), or a range (`4XX`) minus the codes declared on their
    own. `default` takes every status left over.
  - A status the contract does not cover falls into a last arm whose `json()` is `unknown`.
  - Because every arm's status is literal, checking `response.status === 201` narrows `json()` exactly, and so does
    `response.status === 418` for a `4XX` arm. A plain `number` arm would stop that narrowing.
- JSON Schema maps to TypeScript like this:
  - `object` properties become fields, and fields not in `required` are optional.
  - `additionalProperties` becomes an index signature.
  - `enum` and `const` become literal unions.
  - `oneOf` and `anyOf` become unions, and `allOf` becomes an intersection.
  - `nullable` or `type: [.., 'null']` adds `| null`.
  - `format: int64` stays `number`, because JSON has nothing else.
  - A `$ref` becomes a named alias, so a cycle is fine.
  - A keyword the mapping does not know widens that node to `unknown` rather than guessing.
- A request that is not linked to an operation gets `unknown` bodies, and a comment in the generated file says so.

### SOAP (XSD)

- `request.body` is typed from the operation's input message element, and `response.body` from its output element.
  `response.fault` is typed from the operation's faults, plus `{ code: string; reason: string }` for any fault.
- XML maps to an object:
  - An element becomes a field named by its local name.
  - `maxOccurs > 1` becomes an array, and `minOccurs="0"` makes the field optional.
  - `nillable` adds `| null`.
  - Attributes are `"@name"` fields, and the text of an element with attributes is `"#text"`.
  - A choice makes each arm optional.
  - `xs:any` is `unknown`.
  - If two elements in one parent share a local name, both are keyed by their namespace, `"{urn:a}name"`. A schema
    names no prefixes, so the namespace is the only stable key.
- Simple types map to TypeScript like this:
  - `xs:boolean` is `boolean`.
  - `xs:int`, `xs:short`, `xs:byte`, `xs:float` and `xs:double` are `number`.
  - `xs:long`, `xs:integer` and `xs:decimal` are `string`, because a `number` would lose precision.
  - An enumeration is a literal union.
  - Everything else is `string`.
- The projection is built on the XSD form model (`xsd/form-model.ts`, `buildForm` / `applyForm`), which already walks a
  schema and an instance together. Setting `request.body` serialises in schema order with the operation's namespaces.
  Mixed content is not projected; a script edits it through `envelope`.
- `response.select(xpath, namespaces?)` returns strings, for anything the projection does not reach. It runs through
  the same evaluator as assertions.

### gRPC (proto)

- `request.message` and `response.message` are typed from the method's input and output messages (`describeMessage`).
- Proto maps to TypeScript like this:
  - Scalar fields map to `number`, `string` or `boolean`, except 64-bit integers, which are `string`, as the gRPC
    editor's JSON already shows them.
  - `bytes` is a base64 `string`.
  - An enum is a union of its names.
  - Every field is optional, since the JSON form leaves out a field at its default. A `oneof`'s fields are
    therefore optional like any other, rather than a union.
  - A `map` is a `Record<string, …>`, and `repeated` is an array.
  - A message becomes one alias, so a recursive message is fine.
  - The well-known types (`Timestamp`, `Duration`, wrappers, `Struct`) map to their JSON forms.
- `response.status` is `{ code: number; name: string; message: string }`. `response.metadata` holds the headers
  and `response.trailers` the trailers.

### Type-checking

Checking uses TypeScript 5.9 (§Owner decisions, 2) with `strict: true`, `noEmit`, `target: es2023`, no `lib.dom`, and
the generated file plus the API declarations as the only other files. It runs on a worker thread, which main uses in
the app and the CLI uses in a run:

- **App.** The editor asks main for diagnostics as the script changes. On a send, main checks the scripts first. If
  either script has an error, the send fails with `script-type-error`, listing each error's line and message, and
  nothing is sent.
- **CLI.** `wirebench run` checks every script of the selected requests (or of a sequence's steps) before it sends
  anything. Any error is a usage failure (exit 2), with the file, line and message on stderr. The same check applies
  with and without `--sequence`.
- A contract that changes (Update Definition) regenerates the types, so a script that no longer matches its contract
  fails the check before its next send.
- Postman scripts are JavaScript and are only parsed, never type-checked. A syntax error is `script-syntax-error`.

### Running TypeScript

The sandbox runs JavaScript, so types are stripped first, with Node's built-in `module.stripTypeScriptTypes` (type
stripping only). A script therefore uses only erasable syntax: no `enum`, `namespace`, parameter properties or
decorators. The checker enforces this (`erasableSyntaxOnly`), so the error appears in the editor, not at run time.
Stripping keeps positions, so a run-time error's line and column match the file.

`stripTypeScriptTypes` is still marked experimental in Node 24 and prints a warning, which the engine suppresses
for that one call. If a later Node changes it, the fallback is `transpileModule` from the `typescript` dependency
(§Owner decisions, 2), with a source map to keep positions. A test pins the stripped output of a fixture, so a change
shows up in CI rather than in a user's script.

## Sandbox

Scripts run in QuickJS, compiled to WebAssembly (`quickjs-emscripten-core` with the synchronous release build, MIT,
§Owner decisions, 1), inside a worker thread. Each script run gets:

- A fresh QuickJS runtime and context. Nothing survives between runs except what `vars.set` hands back.
- A memory limit of 64 MiB (`script-memory`), a stack limit of 1 MiB, and an interrupt handler that stops the script at
  its `timeoutMs` (`script-timeout`). As a backstop, the host terminates the worker at `timeoutMs + 1000` and replaces it.
- Only the API above, installed as plain functions that pass strings and JSON-shaped values across the boundary. No
  host object, function or prototype is reachable from the sandbox.
- Bounded output: at most 64 KiB of log text, 1000 log lines, 1000 tests, 100 `vars.set` values of at most 64 KiB each.
  Anything beyond that is cut off and reported.

The worker host follows `rest/contract-check-worker-host.ts`: one long-lived worker per process, jobs one at a time in
a bounded queue, and replaced on overrun. `crypto` and `encoding` are implemented in the worker with Node's `crypto`
and `Buffer`, and reach the sandbox as functions of strings.

The sandbox is the same in the app and the CLI: the engine owns it, and main and the CLI only call it.

## Values

`vars.set` puts a value in the run's value scope, which later requests read as `${#Sequence#name}`. What counts as
the run:

| Where | Values live | Shared with |
| --- | --- | --- |
| A sequence run (app or CLI) | the run | later steps of the run |
| `wirebench run` without `--sequence` | the run | the requests after it, in run order |
| A single send in the app | the project's session, in memory, never saved | later single sends in that project, until it closes |

The session scope is new (§Owner decisions, 5). It gives a log-in request's post-response script a place to keep the
token for the next request sent by hand, which is what people use Postman scripts for. The explorer shows the
session's values under the project, with a **Clear** action, and secret values show as `(secret)`.

Every value a script sets comes from a response or is derived from one, so all of ADR-0015 applies: it is literal,
never a name, explicit-only, escaped where it lands, never the origin, and masked when secret. A value that contains a
known secret is masked even when it is not marked secret. `vars.get` reads the same scope, and it is the only thing a
pre-request script sees of another request's response.

## Secrets

- Configured auth (basic, bearer, API key, OAuth2, WS-Security) is applied after the pre-request script. A script
  never sees those credentials.
- `${secret:name}` in the request's own text is resolved after the pre-request script too. The script sees the
  reference text, not the value.
  - After the script, only references that were already in the request's text are resolved.
  - A reference the script added, naming a secret the request's text did not name, fails the send with
    `script-secret-denied`. Otherwise a script could read any secret by writing a reference to it.
- `secrets.get(name)` returns a value only for a name in `scripts.secrets`, and the type `SecretName` is the union of
  those names. Otherwise it throws `script-secret-denied`. The list is in the request file, so adding a secret to it is
  a change a reviewer sees. Signing a body with an HMAC key is the use it is for.
- Every value a script reads through `secrets.get` is registered with the masker before the script runs. So a script
  that logs it, sets it with `vars.set`, or writes it into the request shows it masked in the log, History and every
  report.
- `props.get` never returns a secret, and returns `undefined` for one.

## Results

- **Pre-request script fails** (it throws, times out, runs out of memory, or changes the origin): the request is not
  sent. Its outcome is `error`, with the script error's code, message and position.
- **Post-response script fails**: the response is kept and shown, and the outcome is `error`.
- **Tests** are reported as assertions of type `script`, with the test's name, passed or failed, and the failure
  message. They count in the request's outcome like any assertion.
- **Logs** are masked and kept with the result:
  - in the app, on a **Script** tab of the response and in the HTTP Log row;
  - in the CLI, on stderr with `--verbose`;
  - in the JSON report, as `scriptLog` (optional field; `formatVersion` 1 stays).
- **In a sequence**, a script error fails its step, which then stops the run under **Stop on first failure**.
- History records the request as sent, after the pre-request script. The recorded request text never holds a secret
  value.

## Postman

The Postman importer stops dropping `event` scripts. For each request:

- The `prerequest` and `test` scripts of the collection, then each enclosing folder, then the request, are
  concatenated in that order into `<R>.pre.js` and `<R>.post.js`. A comment line marks where each part came from.
  `scripts.api: postman` is set.
- **Imported scripts are switched off** (`scripts.enabled: false`, §Owner decisions, 6). A collection from elsewhere is
  code nobody on the team has read yet, so it runs only once someone has. The request sends as if it had no scripts
  until then, and its result says the scripts were off.
- Switching them on is a change to the request file (`enabled: true`), so it shows in review like any other. It is
  done either per request, on the **Scripts** tab, or for many requests at once with **Switch on scripts…** on an
  API or a folder. That dialog lists each request with scripts and the unsupported calls found in them, and switches
  on the ones ticked.
- `pm.environment.set`, `pm.collectionVariables.set`, `pm.globals.set` and `pm.variables.set` all map to `vars.set`,
  and the matching `get` calls to `vars.get`, falling back to `props.get`. The import summary says so, since Wirebench
  keeps them in the run's values, not in an environment.
- The layer supports what imported collections mostly use:
  - `pm.test`;
  - `pm.expect(...)` with the common chai chains (`to.equal`, `to.eql`, `to.be.a`, `to.include`, `to.have.property`,
    `to.be.above`, `to.be.below`, `to.be.true`, `to.be.false`, `to.be.ok`, `to.exist`, `.not`);
  - `pm.response`: `code`, `status`, `headers.get`, `json()`, `text()`, `responseTime`, and `to.have.status`;
  - `pm.request`: `url`, `headers.add`, `headers.upsert`, `headers.remove`, and `body.raw`;
  - `pm.info.requestName`;
  - `console.log`;
  - `CryptoJS` hashes, HMACs and Base64, mapped to `crypto` and `encoding`;
  - `btoa` and `atob`.
- Anything else fails when it is called, with `script-unsupported` naming it. That includes `pm.sendRequest`,
  `pm.cookies.jar()`, `pm.visualizer`, `require`, `pm.execution.setNextRequest` and `postman.setNextRequest`.
- The import summary says how many requests came with scripts, that they are switched off, and which of them call
  something unsupported (found by a static scan for those names). The warning that scripts were not imported goes
  away.
- An imported script is not type-checked. It is editable and runs as JavaScript, and its user can rewrite it against
  the `wirebench` API at any time.

"Postman" is not a banned term (`scripts/check-banned-terms.ts`), and the importer and switching guide already name it.

## Desktop

- **Request editor.** A **Scripts** tab on SOAP, REST and gRPC requests has two editors, *Pre-request* and
  *Post-response*, and a secrets list. The tab shows a dot when either script is set.
  - A switched-off script shows a banner, "These scripts are off. Read them, then switch them on.", with a
    **Switch on** button.
  - **Switch on scripts…** on an API or folder switches on many requests at once (§Postman).
- **Monaco.** `monaco-core.ts` registers the TypeScript and JavaScript Monarch grammars from `basic-languages`. They
  are tokenisers only and start no worker. Completion, hover, signature help and diagnostics come from providers
  that ask main over IPC, the way XML completion does today.
  - The renderer keeps no TypeScript service, and the ban on `ts.worker` in `build-output.test.ts` and the 12 MB
    renderer budget stay as they are.
  - Main keeps one language service per open script model, on the script worker's sibling `typescript` worker, with
    the request's generated types.
- **Response panel.** A **Script** tab shows test results with the other assertions, and the log below them.
- **Session values.** A **Values** node under the project in the explorer, with **Clear**.
- **Commands.** `script.clearValues`.

## CLI

- Scripts run in `wirebench run`, with and without `--sequence`, whenever a selected request has them.
- Type-checking runs before any send (§Type-checking). A type error exits 2.
- Script test results appear in every reporter as assertions. Logs go to stderr with `--verbose`, and appear in the
  JSON report as `scriptLog`.
- No new flags.

## Security

ADR-0016 records the decision. In short:

- **A script is code from the project, and it runs with no capabilities.** A script from a teammate, a pull or an
  import can do nothing a declarative request could not already do, other than use CPU and memory within its limits.
  It cannot reach the network, a file, the keychain, another project, or the app.
- **The origin is fixed before the script runs.** So is the auth: credentials are applied after the script, bound to
  that origin as today.
- **A script reads a secret only when its request file lists it**, and every such value is masked.
- **What a script produces is data.** ADR-0015 holds for every value it sets, and the engine serialises the bodies it
  sets.
- **Every run is bounded:** time, memory, stack, log size, test count and values.
- **The renderer stays as it is:** no `unsafe-eval`, no `wasm-unsafe-eval`, and no language worker. The sandbox and
  the checker run in main (the app) or the CLI process, on worker threads.
- **Type stripping and QuickJS need no native module** (ADR-0001). The engine gains two runtime dependencies,
  `quickjs-emscripten-core` with its release build (MIT) and `typescript` 5.9 (Apache-2.0), listed in
  `THIRD-PARTY-LICENSES.md`.

`docs/security.md` gains a section, "A script runs with no capabilities".

## Error codes

| Code | Where | Meaning |
| --- | --- | --- |
| `script-file-missing` | load, send | The request names a script file that is not there |
| `script-too-large` | load | A script file over 256 KiB |
| `script-type-error` | send, CLI | The script fails the type check |
| `script-syntax-error` | send, CLI | A Postman script does not parse |
| `script-error` | send | The script threw; carries its message and position |
| `script-timeout` | send | The script ran past `timeoutMs` |
| `script-memory` | send | The script ran out of memory |
| `script-origin-change` | send | A pre-request script changed the scheme, host or port |
| `script-value-invalid` | send | A header or metadata value with CR, LF or NUL |
| `script-secret-denied` | send | A secret the request file does not list, or a reference the script added |
| `script-unsupported` | send | A Postman call the layer does not support |

## Testing

- **Engine unit tests:**
  - type generation per protocol, with fixtures covering cycles, unions, arrays, optional fields, attributes, name
    clashes and 64-bit numbers;
  - checker diagnostics, including an erasable-syntax violation;
  - stripping keeps positions;
  - sandbox limits: an infinite loop, a memory bomb, deep recursion, oversized logs, and every host global being absent;
  - the API per protocol;
  - origin, CR/LF and secret rules;
  - ADR-0015's hostile values set through `vars.set`;
  - the Postman layer against scripts from real collections, and `script-unsupported`.
- **Format tests:** a version-5 fixture migrates by stamp, and a version-6 project with scripts round-trips; renaming
  and moving a request moves its scripts; a missing file is reported; `enabled: false` sends without running or
  checking the scripts.
- **CLI integration**, against the demo server:
  - a log-in request's post-response script sets the token, and the next request uses it;
  - a pre-request script signs with an HMAC from a listed secret, and the signature is masked in every reporter;
  - a type error exits 2 before any send;
  - `--sequence` with scripts.
- **Desktop main:** the send order (script, then auth, then signing), the session values, and a secret read by a script
  masked in History and the log.
- **Renderer:** the Scripts tab, and the diagnostics and completion providers against a stubbed IPC.
- **e2e:** a log-in request's post-response script sets a token, and the next single send uses it. A type error shows
  in the editor and blocks the send.
- **Build:** `build-output.test.ts` still forbids `ts.worker`, and the renderer stays under budget.

## Docs

- A **Scripts** guide in the docs site.
- The **property syntax** page: session values under the Sequence scope.
- The **project format** page: version 6 and `scripts`.
- The **Postman** switching page: scripts are imported switched off, how to switch them on, what the layer supports,
  and what it does not.
- A **script API** reference page, generated from the API declarations.
- `docs/security.md` gains a section.
- Success criteria SC-S1 onwards.
- The roadmap and the CHANGELOG.

## Owner decisions

Accepted 2026-09-28. Decisions 1–5 are as recommended. Decision 6 took the alternative: imported scripts are switched
off until enabled (§Postman).

1. **Sandbox: QuickJS compiled to WebAssembly**, on a worker thread (`quickjs-emscripten-core` plus one release build,
   MIT, about 1.4 MB). It has hard memory and time limits, the same engine in the app and the CLI, and no native
   module. The alternatives each break something:
   - `node:vm` is not a security boundary;
   - `isolated-vm` is a native module, which ADR-0001 rules out;
   - SES shares the host heap and cannot limit memory or CPU.
2. **Type checker: TypeScript 5.9 as an engine runtime dependency**, run on a worker in main and in the CLI.
   - The editor gets completion, hover and diagnostics over IPC, the renderer stays lean, and the CLI checks the same
     way the app does.
   - It costs about 24 MB unpacked, in the app's `node_modules` (inside the asar) and in the CLI package.
   - TypeScript 7 is not an option: it ships a native binary per platform and speaks only LSP.
   - The alternative is Monaco's TypeScript worker in the renderer. That means lifting the `ts.worker` ban and the
     12 MB budget, and the CLI could not type-check.
3. **`formatVersion` 5 → 6** for the `scripts` key on request files. The migration is a stamp. As with every bump, an
   older build refuses a project this build has saved.
4. **Secrets need a listing.** A script reads a secret's value only when its request's `scripts.secrets` names it.
   Configured auth is applied after the script and is never visible to it.
5. **Session values.** In the app, values a single send's script sets live in the project's session, in memory, and
   `${#Sequence#name}` resolves from them outside a sequence run. The Sequences guide currently says such a reference
   is unresolved outside a run; that sentence changes.
6. **Imported Postman scripts are switched off until enabled** (accepted over the recommendation to run them).
   They are imported through the `pm` layer, with collection and folder scripts copied into each request's script,
   and written with `enabled: false`. Switching them on is a reviewable change to the request file.
