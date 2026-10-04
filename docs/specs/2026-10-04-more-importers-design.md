# Spec: More importers — Postman variables, HAR 1.2, `.http` files, OpenCollection YAML

**Date:** 2026-10-04
**Status:** draft (under review)
**Scope:** all of [#64](https://github.com/wirebench/wirebench/issues/64). This covers:

- Postman environment and globals exports, plus the collection and folder variables the
  collection importer drops today
- HAR 1.2, with a new persisted **response example** on REST requests
- `.http` request files and their JSON environment files
- OpenCollection YAML, as a single file or as a directory

The work ships as one plan and four pull requests, in that order (§10).

Builds on:

- `docs/specs/2026-09-14-postman-collection-import-design.md`: the collection importer, its
  `{{x}}` → `${x}` rewrite and its auth rules.
- `docs/specs/2026-09-18-legacy-soap-project-import-design.md`: the clash, script and report rules.
- `docs/specs/2026-09-12-wirebench-layout-and-environments-design.md`: scopes and environments.
- ADR-0003 (project folder format), ADR-0004 (secrets outside project files), ADR-0005 (renderer
  path safety), ADR-0017 (protocol modules).

## 1. Objective

**Why.** Moving to Wirebench costs about as much as re-creating what you already have elsewhere.
Today four common sources need hand work:

- **Variables.** The Postman collection importer rewrites `{{name}}` to `${name}`, but nothing
  defines those names afterwards. Environments, globals and collection variables are all re-typed
  by hand.
- **Recorded traffic** in a HAR file has no way in.
- **`.http` files**, the plain-text request format editors embed, and their environment files have
  no way in.
- **OpenCollection YAML**, an open, file-based collection format with environments, has no way in.

**What.** Each source goes through the one **Import…** dialog and ends in a report. Every
importer:

- keeps credentials out of project files
- never overwrites anything that already exists
- reports everything it could not map

**User stories.**

- I import my Postman "Staging" environment. A workspace environment "Staging" appears with every
  variable. Its secret token is in the secret store, and the environment shows
  a `${secret:…}` reference to it.
- I save a HAR from my browser's network panel and import it. I get one REST API per host, with
  the static assets left out. I choose to keep the recorded responses as examples, so each request
  shows what the server answered when I recorded it.
- I import `api.http`, with `http-client.env.json` and `http-client.private.env.json` beside it.
  I get an API with every request, the file's `@variables` as project properties, a workspace
  environment per env entry, and the private values in the secret store.
- I import an OpenCollection directory. Its HTTP, gRPC and WebSocket requests arrive with their
  folders and order. Its environments become workspace environments. Its scripts are saved as text
  and never run. Its status and body assertions become Wirebench assertions.

## 2. Decisions (owner, 2026-10-04)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Postman sources | Environment exports, globals exports and collection variables |
| 2 | Where an imported environment lands (every format) | A workspace environment, with no project picker |
| 3 | Secret values (every format) | Into the secret store; the property becomes `${secret:name}` |
| 4 | Environment name clash | The import gets a numbered name ("Staging 2"), noted in the report |
| 5 | HAR grouping | One REST API per origin; requests deduplicated; static assets skipped unless asked for |
| 6 | HAR responses | The dialog asks: **don't keep**, **record into History**, or **save as examples** |
| 7 | `.http` variables | `@var` → project properties; env JSON → workspace environments; private env values → secret store |
| 8 | OpenCollection layout | Single file **and** directory |
| 9 | OpenCollection kinds | HTTP, gRPC and WebSocket become requests; GraphQL becomes an HTTP POST until #77 |
| 10 | OpenCollection scripts and assertions | Scripts kept as text and never run; assertions mapped where they fit, the rest reported |
| 11 | Delivery | One plan, one PR per format: Postman variables → HAR → `.http` → OpenCollection |

Single-name clashes follow the legacy importer's rule. This covers Globals and project properties:
the existing value is kept, and the report names the one skipped.

## 3. Shared foundations

These land in the first PR, except the response example, which lands with HAR.

### 3.1 The variable plan

The new module `packages/engine/src/import/variables.ts` holds the one format-neutral shape that
every environment-bearing importer produces:

```ts
interface ImportedVariable {
  readonly name: string;
  /** Text with `{{x}}` already rewritten to `${x}`. Empty for a secret. */
  readonly value: string;
  readonly enabled: boolean;
  readonly secret: boolean;
  /** Only for `secret: true`, and only when the source carries the value. */
  readonly secretValue?: string;
}

interface ImportedVariableSet {
  readonly name: string;                  // environment name, or "Globals"
  readonly variables: readonly ImportedVariable[];
}

interface ImportedVariables {
  readonly environments: readonly ImportedVariableSet[];
  readonly globals?: ImportedVariableSet;
  readonly projectProperties?: ImportedVariableSet;
  readonly report: ImportReport;
}
```

Within a set, the first definition of a name wins. Later definitions are dropped and noted.

### 3.2 The report

`ImportReport` has the same shape for every format: `{ warnings: string[]; notes: string[] }`.

- **Warnings** are things that did not come across, or that need action.
- **Notes** are informational.

The dialog renders it with the layout the legacy importer already uses: counts, **Things to look
at**, **Notes** and **Copy report**.

### 3.3 Template rewriting

The new module `packages/engine/src/import/templates.ts` holds `rewriteMustache(text)`, extracted
from the Postman collection importer. It turns `{{x}}` into `${x}` and leaves every `{{$…}}`
dynamic variable exactly as written. This changes the collection importer, which today turns
`{{$guid}}` into `${$guid}`, a reference that never resolves. It returns the rewritten text and the dynamic names it saw,
for the report.

The Postman, `.http` and OpenCollection importers all use it. `.http` adds its own
`{{$processEnv X}}` rule (§6.4).

### 3.4 Credential rule

These rules apply to every format:

- **Request auth.** A literal credential in a request's auth or in an `Authorization` header is
  never written to a project file:
  - Basic keeps the username.
  - Bearer, API-key and OAuth 2 keep their shape without the secret.
  - The report lists each request whose credential was dropped.
- **Variable references.** A credential field whose whole value is one or more variable references
  is kept, rewritten to `${…}`.
- **Credential-looking names.** A plain variable whose name contains `token`, `password`, `secret`,
  `apikey` or `api_key` (any case) is imported as it is. One warning lists all such names and
  suggests marking them Secret.
- **Unsupported auth.** The supported auth types are none, basic, NTLM, bearer, API key and
  OAuth 2. Any other type (digest, AWS v4, OAuth 1, WSSE) becomes `none` with a warning naming it.

### 3.5 Applying a plan (desktop main)

The new module `apps/desktop/src/main/import-variables-apply.ts` takes an `ImportedVariables` plan.

**Environments.**

1. **Name.** A name already used by a workspace environment (case-insensitive) gets " 2",
   " 3" and so on.
2. **Secrets.** The secret store generates its own reference for each value
   (`SecretStore.set(value, { label })`), so callers cannot pick a name and an existing secret can
   never be overwritten. The label is `<environment name>/<variable>`.
3. **Secret values.** The value is written with the store's `set`, and the property becomes
   `${secret:<generated ref>}`.
4. **Secrets without a value.** A secret with no value (empty, or not carried by the source) gets
   an empty property and no store entry. The report lists it as needing a value.
5. **Saving.** The environment is added and saved. The active environment is never changed.

**Globals** merge into `main/global-properties.ts`. An existing name keeps its value. Disabled
names join `disabled`. Secrets follow step 2, with the label prefix `Globals`.

**Project properties** merge into the target project in the same way.

**Rollback.** When any save fails, every secret written by this import is deleted again, and the
error is rethrown.

**Renderer.** The renderer never receives a secret value. Main reads the files and writes the
store.

### 3.6 The dialog

`features/explorer/import-dialog.tsx` lists the new formats:

- **Postman environment**
- **Postman globals**
- **HAR**
- **`.http` file**
- **HTTP client environment file**
- **OpenCollection**

Auto-detect picks each one from the content or the file name (§4–7).

- Formats that target only the workspace hide the project picker: both Postman variable formats
  and the HTTP client environment file.
- Every format accepts a picked file. Paste is offered where the format is a single document.

### 3.7 Response examples (lands with HAR)

A REST request gains a list of saved responses, so a recorded answer can sit beside the request
that produced it:

```ts
interface RestResponseExample {
  readonly id: string;
  readonly name: string;            // e.g. "200 OK — recorded 2026-10-04"
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly KeyValueEntry[];
  readonly contentType?: string;
  /** Body stored beside the request, not inline. */
  readonly bodyFile?: string;
}
// RestRequestDef gains:  readonly examples?: readonly RestResponseExample[];
```

**Storage** (`rest/storage.ts`, ADR-0003). The `*.request.yaml` file gains an `examples:` list.
Each body is written to `<slug>.examples/<id>.body.<ext>` beside the request file. The field is
additive, so it bumps the project `FORMAT_VERSION` (`project/model.ts`) from 6, which shipped in
3.1.0, to 7.
Older files load with no examples.

**Redaction.** Example headers are written with the HAR exporter's redaction. Secret-bearing
headers are masked, and `Set-Cookie` and `Cookie` are dropped. A body is stored as it was
recorded.

**UI.** The REST response pane gets an **Examples** menu when the request has any. Choosing one
shows it read-only in the response viewer, marked as an example, with **Delete example**.

**Out of scope.** Creating an example from a live response, and editing one, are a follow-up
issue.

## 4. Postman environment and globals exports, and collection variables (PR 1)

### 4.1 Input

```json
{
  "name": "Staging",
  "values": [
    { "key": "baseUrl", "value": "https://staging.example.com", "type": "default", "enabled": true },
    { "key": "apiToken", "value": "…", "type": "secret", "enabled": true }
  ],
  "_postman_variable_scope": "environment"
}
```

A globals export has the same shape, with `"_postman_variable_scope": "globals"`.

- **`type`.** `default`, `secret`, or the older `text`, which is read as `default`. Anything else
  is read as `default` and noted.
- **`enabled`.** Defaults to `true`.
- **`value`.** A number or boolean is turned into a string. Any other non-string value is skipped
  and reported.
- **Entries.** An entry with no `key`, or an empty one, is skipped and reported.

### 4.2 Detection

Both rules are checked before the collection rule:

| Kind | Content (definite) | File name (probable) |
| --- | --- | --- |
| `postman-environment` | `values[]` and `_postman_variable_scope: "environment"` | `*.postman_environment.json` |
| `postman-globals` | `values[]` and `_postman_variable_scope: "globals"` | `*.postman_globals.json` |

`values[]` plus `name`, with no `_postman_variable_scope`, is detected as `postman-environment`
with **probable** confidence.

### 4.3 Mapping

**Engine.** `packages/engine/src/rest/postman/variables.ts` (pure) maps:

- an environment export to `ImportedVariables.environments[0]`
- a globals export to `ImportedVariables.globals`

**Errors** (`PostmanError` codes):

- `postman-not-variables`
- `postman-invalid-json`
- `postman-too-large`, with the 50 MB limit the collection importer already uses
- `postman-data-dump`, for a bulk data-dump archive, or for JSON with top-level `collections` and
  `environments` arrays. Its message asks for the environments to be exported one by one.

**Collection variables.** `apiFromPostmanCollection` gains a `projectProperties` set:

- every collection-level variable except the one used as the base URL
- then every folder-level variable, depth-first
- `disabled: true` adds the name to `disabledProperties`

This removes the warning "Collection and folder variables were not imported…".

**IPC.** Two new channels: `api.importPostmanEnvironment` and `api.importPostmanGlobals`.
`api.importPostman` applies `projectProperties` through §3.5.

**Commands.** **Import Postman Environment…** and **Import Postman Globals…**.

## 5. HAR 1.2 (PR 2)

### 5.1 Detection and input

| Rule | Confidence |
| --- | --- |
| JSON with `log.entries[]` and a `log.version` string | definite |
| File name `*.har` | probable |

- **Versions.** HAR 1.1 and 1.2 are read. Fields the format marks as custom (prefixed `_`) are
  ignored, except `_resourceType`.
- **Size.** The limit is **100 MB**. A recorded session carries its bodies, so it runs larger
  than a collection.
- **Engine.** The module is `packages/engine/src/rest/har/` (`model.ts`, `parse.ts`, `map.ts`,
  `import.ts`). It is pure, and its error class is `HarError`.

### 5.2 Which entries are kept

These are skipped, and each skip is counted in the report:

- **Non-HTTP URLs.** Any URL whose scheme is not `http` or `https` (`data:`, `blob:`, extension
  URLs and so on).
- **CORS preflights.** An `OPTIONS` request that carries `Access-Control-Request-Method`.
- **Static assets**, unless the dialog's **Include static assets** box is ticked (it starts
  unticked). An entry counts as a static asset when one of these holds:
  - its `_resourceType` is `image`, `font`, `stylesheet`, `script` or `media`
  - its response MIME type is `image/*`, `font/*`, `audio/*`, `video/*`, `text/css` or a
    JavaScript type
  - its path ends in one of the usual asset extensions

### 5.3 Grouping and deduplication

- **APIs.** Each origin (scheme + host + port) becomes one **REST API**. The API is named after
  the host and has the origin as its server. APIs are ordered by first appearance.
- **Requests.** Inside an API, entries are deduplicated on `method + path + sorted query-parameter
  names`.
- **Which entry wins.** The first entry defines the saved request. The others count as repeats of
  it. Their responses still feed History or examples (§5.5).
- **Names and order.** A request is named `METHOD /path`. Requests are ordered by first
  appearance, with no folders.
- **Target.** The dialog's usual project target applies: an existing project or a new one.

### 5.4 Request mapping

- **URL.** The path is relative to the API's server. `queryString` becomes `query`.
- **Headers.** These are dropped:
  - HTTP/2 pseudo-headers (`:authority` and the like)
  - `Host`, `Content-Length`, `Connection` and the other hop-by-hop headers
  - `Cookie`, counted in the report. The cookie jar (#44) handles cookies at send time.
- **`Authorization`.** It becomes auth under §3.4, and the header itself is removed.
- **`postData`**, by MIME type:

  | MIME type | Becomes |
  | --- | --- |
  | JSON | a raw JSON body |
  | `application/x-www-form-urlencoded` | a form body, from `params` or from parsing `text` |
  | `multipart/form-data` | multipart. Text parts are kept. A file part becomes a file part with an empty path, and the report notes it. |
  | anything else | a raw body with its content type |

### 5.5 Recorded responses

The dialog asks once per import, under **Recorded responses**. The default is **Don't keep**.

**Don't keep.** Responses are not stored. The report counts the statuses seen.

**Record into History.** Every kept entry becomes one `HistoryEntry`, repeats included:

- `kind: 'rest'`
- `at` is the entry's `startedDateTime`
- `durationMs` is its `time`
- the method, status and statusText
- `requestId` is the deduplicated saved request
- `tags: ['imported:har']`

The headers on both sides go through the HAR exporter's redaction before they are written. A body
encoded as base64 is decoded when its MIME type is textual, and otherwise left out and noted.
Bodies are subject to History's existing size limits. Entries are written in time order with the
existing `appendHistory`, so diff and resend (#42) work against them.

**Save as examples.** Each saved request gets one `RestResponseExample` (§3.7) per distinct
response status among its entries:

- The first entry with that status wins.
- A request keeps at most 5 examples.
- An example is named `"<status> <statusText> — recorded <date>"`.

**IPC and command.** The new channel is `api.importHar`. Its request carries the source, the
target, `includeStaticAssets` and `responses: 'drop' | 'history' | 'examples'`. The new command
is **REST: Import HAR…**.

## 6. `.http` files and their environments (PR 3)

### 6.1 Detection

| Kind | Rule | Confidence |
| --- | --- | --- |
| `http-file` | file name `*.http` or `*.rest` | definite |
| `http-file` | text whose first non-comment line is a request line, with `###` separators or more than one request line | probable |
| `http-env` | file name `http-client.env.json` or `http-client.private.env.json` | definite |
| `http-env` | a JSON object whose every value is an object of scalars, with no other format's markers | probable |

### 6.2 The grammar this slice reads

`packages/engine/src/rest/http-file/` (`parse.ts`, `map.ts`, `import.ts`) reads the following:

- **Separators.** A line starting with `###` ends one request and starts the next. Text after
  `###` names the next request.
- **Names.** `# @name x` or `// @name x` before a request names it. That wins over the `###`
  text.
- **Comments.** Other `#` and `//` lines are ignored.
- **File variables.** `@name = value`, before or between requests. They become project properties.
  A later definition is noted and the first one kept.
- **Request line.** `[METHOD] URL [HTTP/x.y]`. The method defaults to `GET`. Indented lines below
  it that start with `?` or `&` continue the query.
- **Headers.** One per line, up to the first blank line.
- **Body.** Everything after the blank line, up to the next separator or response-handler line.
  Its kind comes from `Content-Type`: JSON, XML and text become raw; form-urlencoded becomes a
  form. A multipart body is kept raw with its `Content-Type`, and the report notes it.
- **Body from a file.** A `< ./path` body becomes a binary body. The path is resolved against the
  `.http` file's folder and kept as a path, not copied. The report notes a missing file.
- **Response handlers.** Both handler forms, `> {% … %}` and `> ./handler.js`, are saved under
  `imported-scripts/<api-slug>/` and never run. The report lists them.
- **Output redirects.** `>>` and `>>!` lines are ignored and noted.
- **Directives.**
  - `# @no-redirect` becomes `followRedirects: false`.
  - `# @timeout N` becomes `timeoutMs`.
  - Any other `# @directive` is noted.
- **Other request kinds.** A `WEBSOCKET` request becomes a WebSocket request in a separate
  WebSocket API. Its message body, if any, becomes one saved message. `GRAPHQL` and `GRPC`
  requests are skipped and reported. GraphQL waits for #77, and gRPC needs a definition.

**Target.** One REST API per file, named after the file. When every request URL begins with the
same origin or the same leading `{{var}}`, that becomes the server. This is the collection
importer's base-URL inference.

**Limits.** The file is capped at 10 MB. More than 5,000 requests is refused with an
`HttpFileError`.

### 6.3 Environment files

```json
{
  "$shared": { "version": "v1" },
  "dev":  { "host": "http://localhost:8080", "user": "dev" },
  "prod": { "host": "https://api.example.com" }
}
```

- **Entries.** Every top-level key except `$shared` becomes a workspace environment (§3.5).
  Values that are strings, numbers or booleans become properties. An object value, such as a
  per-environment SSL configuration, is skipped and noted.
- **`$shared`.** It becomes project properties of the target project, which a matching
  environment variable outranks. When the file is imported on its own, with no project picked,
  `$shared` goes to the workspace properties instead.
- **The private file.** `http-client.private.env.json` has the same shape. Every value in it is a
  secret. When the public and private files define the same environment, they merge, and a name
  in both becomes the secret.

**Imported with a `.http` file.** When the picked `.http` file has either env file beside it, the
dialog shows **Also import N environments found beside the file**, ticked by default. Main reads
the env files from that folder, and only those two names. They go through the same path-access
check as the picked file. A pick vouches only for its exact path, so these reads go through a new
path-access rule, `checkedCompanionPaths`: exact relative names beside a picked file, no symbolic
links, nothing outside its folder. ADR-0005 gains a paragraph recording it.

**Imported on its own.** An env file can also be picked directly as the **HTTP client
environment file** format. It then targets the workspace only. When a private file sits beside
the picked file, it is merged in.

### 6.4 Variable syntax

- `{{x}}` becomes `${x}` (§3.3).
- `{{$processEnv X}}` becomes `${#System#X}`.
- `{{$dotenv X}}` and the other `{{$…}}` dynamic variables are left as written and reported.
- A request-chaining reference, `{{name.response.…}}`, is left as written. The report lists it
  as something that needs a script or a property capture.

**IPC and commands.** The new channels are `api.importHttpFile` and `api.importHttpEnv`. The new
commands are **REST: Import .http File…** and **Import HTTP Client Environments…**.

## 7. OpenCollection YAML (PR 4)

### 7.1 Detection and layout

| Rule | Confidence |
| --- | --- |
| YAML or JSON with a top-level `opencollection` string | definite |
| File name `opencollection.yml` or `opencollection.yaml` | probable |

The spec version read is **1.0.0**. Any other major version is refused, with a message naming the
version.

**Single file.** The root document carries an inline `items:` tree. It works from **File** and
from **Paste**.

**Directory.** The user picks the root `opencollection.yml` (there is no folder picker). Main
walks the folder that holds it, under the same companion-file rule as `.http` env files (§6.3):

- **Folders.** A subfolder is a folder. Its `folder.yml`, if present, holds the folder's
  `info`, request defaults and docs.
- **Items.** Every other `*.yml` or `*.yaml` file is one item.
- **Environments.** `environments/*.yml` files are environments, one per file.
- **Not followed.** Symbolic links, and anything outside the picked root (ADR-0005).
- **Limits.** 5,000 files, depth 64, 50 MB in total. Going past any of them is refused with an
  `OpenCollectionError`.

The walk lives in main, as `apps/desktop/src/main/opencollection-tree.ts`. It hands the engine a
map from relative path to text, so the engine stays pure:

`parseOpenCollection(root, files?)`.

### 7.2 Items

**Order.** Items are ordered by `info.seq`, then by array order or file name.

**Where items go.** One API is created per request kind present:

- HTTP and GraphQL items go to a REST API.
- gRPC items go to a gRPC API.
- WebSocket items go to a WebSocket API.

Each API is named after `info.name`. When more than one kind is present, the gRPC and WebSocket
APIs get " (gRPC)" and " (WebSocket)" after the name. Folders are rebuilt inside each API that
has items under them.

**HTTP items:**

- **Method and URL.** Taken as they are, with `{{x}}` rewritten. A `:param` path segment becomes
  `{param}`.
- **Params.** `type: query` params become `query`, and `type: path` params become `pathParams`.
  Headers carry over. Their `disabled` flags carry over too.
- **Body**, by type:

  | Type | Becomes |
  | --- | --- |
  | `json`, `text`, `xml` | raw, with that language |
  | `sparql` | raw text, with its content type |
  | `form-urlencoded` | form |
  | `multipart-form` | multipart. File parts keep their paths, resolved against the collection root. |
  | `file` | binary, from the selected entry |

  When the body is a list of variants, the selected one is used (else the first). The others are
  noted.
- **Auth.** `inherit` and the supported types map under §3.4. Collection and folder default auth
  becomes API and folder auth.
- **Default headers.** Collection and folder default headers are copied onto each request below
  them that does not already set the same name, and the report notes this.
- **Settings.** `timeout`, `followRedirects`, `maxRedirects` and `encodeUrl` map to the matching
  REST settings. The rest are noted.
- **Examples.** A request's `examples` become `RestResponseExample`s (§3.7).

**GraphQL items** become HTTP `POST` requests:

- The body is raw JSON: `{"query": …, "variables": …}`. When `variables` is a string, it is
  parsed. When it cannot be parsed, it is kept as a string.
- The content type is `application/json`.
- Each one gets a note: GraphQL support is tracked in #77.

**gRPC items:**

- The target and TLS come from the URL (`grpcs://` means TLS).
- `service` and `method` come from the `method` field: `/pkg.Service/Method` or
  `pkg.Service/Method`.
- `methodType` becomes `methodKind`. `metadata` and `message` carry over.
- **Definition.** In the directory form, `protoFilePath` is resolved against the root and run
  through the existing `.proto` import, so the API gets its `definition`. Otherwise the API has no
  definition, and the report says it still needs one (the same state as a reflection-less gRPC
  import).

**WebSocket items:**

- `url` and `headers` carry over.
- `message` becomes one saved message.
- `timeout` and `keepAliveInterval` map where `WsRequestSettings` has them. Otherwise they are
  noted.

**Skipped items.** `App` items and unknown `info.type` values are skipped and reported. A
`ScriptFile` item is saved as a script (§7.4).

### 7.3 Variables and environments

- **Collection and folder variables.** These are the `request.variables` lists. They become
  project properties: the first definition wins, and `disabled` is honoured.
- **Request variables.** The `runtime.variables` on a single request are not imported. The report
  lists them with the request's name, because Wirebench has no request-level property scope.
- **Environments.** From `config.environments` or from `environments/*.yml`. Each becomes a
  workspace environment (§3.5).
  - A variable with `secret: true` carries no value. It becomes `${secret:<storeName>}` with no
    store entry, and the report lists it as needing a value.
  - A variable whose value is a list of variants uses the selected variant.
  - Object values are skipped and noted.
  - `extends`, `externalSecrets`, `dotEnvFilePath` and `clientCertificates` are reported, not
    mapped.
- **Collection config.** `config.proxy` and `config.clientCertificates` are reported, not mapped.

### 7.4 Scripts and assertions

**Scripts.** Every `runtime.scripts[].code`, every collection and folder script, and every
`ScriptFile` item is written as it is to `imported-scripts/<api-slug>/<item-slug>.<type>.js`.
This follows the legacy importer's rule:

- The scripts are never read back or run.
- Each one is listed in the report.
- An existing file is never overwritten. A second import adds a number to the name.

**Assertions.** Each `runtime.assertions[]` entry is mapped when it fits:

| Expression | Operator | Becomes |
| --- | --- | --- |
| `res.status` | `equals` / `eq` | `status` assertion with that value |
| `res.body.<path>` | `equals` / `eq` | `match`, JSONPath `$.<path>`, `equals` |
| `res.body.<path>` | `isNull` / `isNotNull` | `match`, `exists: false` / `true` |
| `res.body.<path>` | `contains` | `match`, `matches` with the escaped value |
| `res.responseTime` | `lessThan` / `lt` | `sla`, `maxMs` |

A disabled assertion is skipped and noted. Anything else is listed in the report with its
expression, operator and value. Each importable assertion becomes one entry in the request's
`assertions`.

**IPC and command.** The new channel is `api.importOpenCollection`, with a source of `file`,
`folder` or `text`. The new command is **Import OpenCollection…**.

## 8. Docs

- **Switching guide.** In `switching/postman.mdx`, the rows for collection variables and for
  environment and globals exports, and the setup steps.
- **Importers guide.** `guides/importers.mdx` gains one section per new format, with its limits,
  plus a short "Response examples" note.
- **New switching pages:** `switching/http-files.mdx` and `switching/opencollection.mdx`. They are
  mapping tables in the style of `switching/postman.mdx`, and they describe each format neutrally.
- **REST guide.** `guides/rest-client.mdx` covers the **Examples** menu.
- **Commands reference.** `reference/commands.md` is regenerated.
- **CHANGELOG.** One entry per PR.

## 9. Testing

**Engine, unit.** Each format gets `parse` and `map` tests against crafted fixtures under
`fixtures/<format>/crafted/`. Each of the following has a case:

- every mapping row above
- every skip and report path
- every error code
- every detection rule, including a collection still detected as a collection

`templates.ts` and `variables.ts` get their own tests.

**Engine, format.** A request with examples round-trips save → load. An older request file loads
with no examples.

**Main, unit.** The tests use a temp folder and an in-memory secret store. They cover:

- environment and secret-name clash numbering
- an existing secret left untouched
- rollback on a failed save
- the Globals merge
- `$shared` routing
- reading the private env file
- the OpenCollection directory walk: its limits, refusing symbolic links, refusing to leave the
  root
- HAR History writes in time order, with redacted headers

**Renderer, unit.**

- Each new format's dialog route: the project picker shown or hidden, the **Recorded responses**
  and **Include static assets** controls, and **Also import N environments**.
- The **Examples** menu in the response pane.

**e2e** (one case per PR, in `e2e/specs/`):

- import a Postman environment
- import a HAR as examples and open one
- import a `.http` file with its env file
- import an OpenCollection directory

**Gates.** `WIREBENCH_SKIP_PERF=1 pnpm check` before each commit, including
`pnpm check:banned-terms`. `pnpm test:perf` before each push. Its perf case is a 100 MB HAR
fixture, generated at test time, which must import within the existing import budget.

## 10. Delivery

| PR | Content |
| --- | --- |
| 1 | §3.1–3.6 foundations, §4 Postman variables |
| 2 | §3.7 response examples, §5 HAR |
| 3 | §6 `.http` files and environments |
| 4 | §7 OpenCollection |

Each PR is green on its own, updates its docs, and ticks its box on #64.

## 11. Boundaries

- **Always:**
  - Keep engine parsing pure. Main does file access, secrets and saving.
  - Never overwrite an existing environment, global, project property, secret or script file.
  - Report every value that did not come across as it was.
  - Describe each format neutrally (CLAUDE.md, `check:banned-terms`).
- **Never:**
  - Run an imported script.
  - Activate an imported environment.
  - Write a secret value or a recorded credential into a project, workspace or History file.
  - Add a third-party dependency. The `yaml` package already in the engine parses OpenCollection.

## 12. Out of scope

- Postman's per-variable "current value" versus "initial value": the export carries one `value`.
- Postman bulk data dumps. They are refused (§4.3).
- Postman collection saved responses as examples. This is a follow-up issue that the §3.7 model
  makes cheap.
- Creating or editing a response example by hand.
- Environment variables kept in an editor's settings file, as opposed to the env JSON files.
- GraphQL as its own request kind (#77).
- Exporting to any of these formats.

## 13. Success criteria

- [ ] **Postman environments.** An environment export imports as a workspace environment, with
      its variables, disabled flags and secrets. Globals merge without changing an existing
      value. Collection and folder variables arrive as project properties.
- [ ] **HAR.** A HAR imports as one API per origin, with no static assets or preflights by
      default. The dialog asks for drop, History or examples, and each choice works.
- [ ] **Response examples.** REST requests persist examples, and the response pane shows them.
- [ ] **`.http` files.** A `.http` file imports with its file variables and, when present, its
      public and private environment files.
- [ ] **OpenCollection.** A single file or a directory imports with HTTP, GraphQL-as-POST, gRPC
      and WebSocket items, folders, order, environments, scripts kept as text, and assertions
      mapped where they fit.
- [ ] **Secrets.** No secret value and no recorded credential lands in a project, workspace or
      History file. No existing secret is overwritten.
- [ ] **Reporting.** Every format sits behind the one **Import…** dialog, and everything it
      cannot map is in its report.
- [ ] **Gates.** `WIREBENCH_SKIP_PERF=1 pnpm check` and `pnpm test:perf` pass.
