# Spec: Importers for Insomnia, Bruno `.bru`, Hoppscotch and Thunder Client

**Date:** 2026-10-15
**Status:** decisions settled (under review)
**Scope:** all of [#588](https://github.com/wirebench/wirebench/issues/588). This covers:

- Insomnia exports: v4 (JSON or YAML) and v5 (YAML), collections and environments
- Bruno collections in the `.bru` file format, as a folder, and Bruno's single-file JSON export
- Hoppscotch exports: REST and GraphQL collections and environments, every schema version
- Thunder Client exports and its `thunder-tests/` workspace folder

The work ships as one plan and four pull requests, in that order (§10).

Builds on:

- `docs/specs/2026-10-04-more-importers-design.md` (#64): the variable plan (§3.1), the report
  (§3.2), template rewriting (§3.3), the credential rule (§3.4), applying a plan in main (§3.5) and
  response examples (§3.7). This spec calls that document **the importer spec** and does not repeat
  its rules.
- `docs/specs/2026-10-11-collection-v3-import-design.md` (#349): building a v2.1-shaped document and
  running the existing Postman pipeline, the **Folder…** pick and its walk limits.
- ADR-0003 (project folder format), ADR-0004 (secrets outside project files), ADR-0005 (renderer
  path safety), ADR-0017 (protocol modules).

The format facts below were read from each tool's published source: Insomnia at
`Kong/insomnia` 19b48754 (`core@13.3.1`), Bruno at `usebruno/bruno` v4.2.1, Hoppscotch at
`hoppscotch/hoppscotch` 2026.9.0. Thunder Client is closed source: its shapes come from its
documentation, release notes and about 480 real exported files. Fixtures are reconstructions with
fictional values.

## 1. Objective

**Why.** Postman, HAR, `.http` files and OpenCollection already import. Teams arriving from the
other common API clients re-create every request, folder and environment by hand. Each format added
here removes that switching cost for another group.

**What.** Each source goes through the one **Import…** dialog with auto-detect and ends in the
standard report. Every importer keeps credentials out of project files, never overwrites anything
that exists, and reports everything it could not map. These rules are the importer spec's; nothing
here relaxes them.

**User stories.**

- I export my Insomnia collection as v5 YAML and import it. Folders, requests and their order arrive.
  The base environment becomes project properties and each sub-environment becomes a workspace
  environment. The report tells me which vault secrets need a value.
- I pick my Bruno collection's folder. Every `.bru` request arrives in its folder, in `seq` order,
  with folder auth and headers. Its `assert` lines become Wirebench assertions. Its scripts are saved
  as text for me to port.
- I import a Hoppscotch collection exported a year ago. It still imports, because every schema
  version is read. `<<baseUrl>>` becomes `${baseUrl}`.
- I pick the `thunder-tests` folder from my repository. Each collection becomes an API. Its base URL
  becomes the API's server, so relative request URLs work. Its "status equals 200" tests become
  status assertions.

## 2. Decisions

Owner decisions, 2026-10-15 (1–4 chosen in review; 5–8 accepted as proposed):

| # | Question | Decision |
| --- | --- | --- |
| 1 | Scripts | Every tool's scripts, Insomnia's included, are saved as text under `imported-scripts/` and never run. Superseded for Insomnia by the [script layers spec](2026-10-16-imported-script-layers-design.md): its scripts are attached switched off and run once turned on. |
| 2 | Declarative checks | Bruno `assert` lines and Thunder Client test rows become assertions where they fit; the rest is reported. |
| 3 | Request chaining | Insomnia `{% response %}` tags, Thunder Client pre-requests and Bruno post-response variables are reported, not converted. |
| 4 | Command line | `wirebench import` reads all four formats, with the v3 rule: plain variables become project properties, secrets and environments are reported, not imported. |
| 5 | Thunder Client shapes | Collection and environment exports, the legacy four-file `thunder-tests/` layout and the one-file-per-collection layout. The paid one-file-per-request layout is refused with a message until a real sample exists. |
| 6 | Bruno JSON export | Included. It is the same model as the `.bru` files, serialised as JSON. |
| 7 | Where variables land (every format) | A collection's own variables become project properties. Named environments become workspace environments, never activated. A global environment merges into Globals. |
| 8 | Delivery | One plan, one PR per format: Insomnia, Bruno, Hoppscotch, Thunder Client. |

## 3. Shared design

### 3.1 Two pipelines, no new mapper

No format gets a mapper of its own to the Wirebench model. Each one is read into a document an
existing importer already maps, as #349 did for Postman v3:

| Format | Read into | Then mapped by |
| --- | --- | --- |
| Insomnia, Hoppscotch, Thunder Client (HTTP and GraphQL) | a Postman v2.1 document | `parsePostmanCollection` → `apiFromPostmanCollection` |
| Insomnia gRPC and WebSocket requests | gRPC and WebSocket APIs, directly | the shapes the v3 importer builds |
| Bruno (`.bru` and JSON) | an OpenCollection document | `mapOpenCollection` |

**Why.** Auth, bodies, `{{x}}` rewriting, dynamic variables, the credential rule, examples,
assertions and the report already live in those mappers, with their tests. A converter only has to
get the shape right. Whatever later changes those mappers, these formats follow.

**Why Bruno goes through OpenCollection.** OpenCollection is Bruno's own YAML format. The two hold
the same model: the same body modes, auth modes, assertion operators and scripts.

**What a converter must not lose.** Where a v2.1 document has no field for something, the converter
reports it. It never drops it silently. The v2.1 document is an internal value; it is never written
to disk or shown.

### 3.2 Module layout

```text
packages/engine/src/import/
  insomnia/      model.ts parse.ts convert.ts map.ts import.ts
  bruno/         lexer.ts parse.ts convert.ts read-folder.ts import.ts
  hoppscotch/    model.ts parse.ts convert.ts import.ts
  thunder/       model.ts parse.ts convert.ts read-folder.ts import.ts
  template-dialects.ts      the §3.4 rewrites
```

The engine stays pure: parsers take text, or a map from root-relative POSIX path to text. Folder
walks are the hosts' job and reuse the v3 walk (§3.6). Each format has its own error class and codes
(`InsomniaError`, `BrunoError`, `HoppscotchError`, `ThunderError`), in the importer spec's style:
`<format>-malformed`, `<format>-too-large`, plus the codes named below.

Size limits are the Postman ones: 50 MB for a file, and the v3 walk limits for a folder.

### 3.3 Detection

`detectImportFormat` gains five kinds: `insomnia`, `bruno`, `hoppscotch`, `hoppscotch-environment`,
`thunder-client`. The rules are checked before the Postman ones, because Hoppscotch and Thunder
Client both use the key names `folders` and `requests`.

| Kind | Content rule (definite) | File or folder name (probable) |
| --- | --- | --- |
| `insomnia` | `__export_format: 4` with `resources[]`; or a `type` matching `*.insomnia.rest/5.0` | `Insomnia_*.json`, `*.insomnia.yaml` |
| `bruno` | a picked folder holding `bruno.json` and no `opencollection.yml`; or JSON with string `version`, string `name`, array `items` and no `info` | `bruno.json` picked alone stands for its folder |
| `hoppscotch` | an object, or array of objects, with `name`, `folders[]` and `requests[]`, whose requests carry `endpoint` + `method`, or `url` + `query` | `hoppscotch-*.json` |
| `hoppscotch-environment` | an object, or array of objects, with `name` and `variables[]` whose entries carry `key` | `hoppscotch-*-environments.json` |
| `thunder-client` | `clientName` or `client` equal to `"Thunder Client"`; or a picked folder holding `collections/tc_col_*.json` or `thunderclient.json` | `thunder-collection_*.json`, `thunder-environment_*.json`, a folder named `thunder-tests` |

A folder that holds `opencollection.yml` stays OpenCollection even when `bruno.json` is beside it,
which is how Bruno itself decides.

The Import dialog cannot read a picked file or folder itself, so it asks main with
`api.detectImportSource` (`{ path, folder }`). Main checks the path with `checkedImportSource`, reads a
file without following a link up to 50 MB and runs `detectImportFormat` on its text and name, or lists
a folder's direct children for `detectImportFolder`. A renamed export (`export.json`) is therefore
detected by what it holds. The dialog asks after every folder pick and after a file pick whose name
does not settle the format; an Import pressed before the answer waits for it.

A file whose `type` is `mock.insomnia.rest/5.0` or `mcpClient.insomnia/5.0` is refused with
`insomnia-not-collection`, naming the kind. Thunder Client's `thunderActivity.json` (History) is
ignored.

### 3.4 Template dialects

`template-dialects.ts` rewrites each tool's variable syntax to `{{x}}` before the shared
`rewriteMustache` (importer spec §3.3) runs. Dynamic names then map, or are kept and reported,
exactly as for Postman.

| Tool | Source | Becomes |
| --- | --- | --- |
| Insomnia | `{{ _.name }}`, `{{ name }}`, `{{ _['my-name'] }}` | `{{name}}` |
| Insomnia | `{{ _.db.host }}` | `{{db.host}}`, matching the flattened property (§4.4) |
| Insomnia | `{{ _.vault.name }}` | `${secret:…}` when the vault variable became a secret (§4.4), else kept and reported |
| Insomnia | `{% uuid %}`, `{% now 'iso-8601' %}`, `{% now 'unix' %}` | `${$guid}`, `${$isoTimestamp}`, `${$timestamp}` (Unix seconds) |
| Insomnia | any other `{% tag %}`, a filter, or `{% if %}` / `{% for %}` | kept as written; the report lists each tag name with the requests using it |
| Hoppscotch | `<<name>>` | `{{name}}` |
| Hoppscotch | `<<$guid>>` and other predefined names | `{{$guid}}`, then the dynamic rule |
| Thunder Client | `{{#guid}}`, `{{#date}}`, `{{#number}}` and the other `#` system variables | `{{$guid}}` and so on where a Wirebench generator fits; else kept and reported |
| Thunder Client | `{{name \| filter}}` | kept as written and reported |
| Bruno | `{{process.env.NAME}}` | `${#System#NAME}`, as `.http` files' `$processEnv` |
| Bruno | `{{?Prompt}}` | kept as written and reported |

A name a dialect cannot map is never turned into a reference that does not resolve.

### 3.5 Scripts

Per decision 1:

- **Insomnia.** Each `preRequestScript` and `afterResponseScript`, on requests and folders, is
  saved as text. The converter writes no v2.1 `event`, so nothing is attached to a request.
- **Bruno.** Scripts reach the OpenCollection document as `runtime.scripts`, so they are written to
  `imported-scripts/<api-slug>/<item-slug>.<type>.js` and never run, exactly as OpenCollection's.
  `tests` blocks are saved the same way, with type `tests`.
- **Hoppscotch and Thunder Client.** The same `imported-scripts/` rule, through the shared
  `ImportedScriptFile` writer. Thunder Client stores a script as an array of lines; they are joined
  with `\n`.

The report names the script dialect it saw (`pw.`, `hopp.`, `pm.`, `bru.`, `tc.`) so the user knows
what to port.

### 3.6 Folder picks

Bruno collections and Thunder Client's `thunder-tests/` are folders. They use the **Folder…** button
#349 added, and the same walk: the root must pass `checkedImportSource`; no symbolic links; every
entry stays inside the root's real path; no-follow opens; 5,000 files, depth 64, 50 MB and 50,000
entries; `node_modules` and `.git` skipped.

What each walk hands the engine:

- **Bruno.** `*.bru` files, `bruno.json`, and the `.js` files a script may `require`. `.env` and
  `.env.*` files are never read: they hold secrets and are kept out of repositories. A root `mocks/`
  folder and the paths in `bruno.json`'s `ignore` list are skipped.
- **Thunder Client.** `*.json` files under the root. Every other file is ignored.

### 3.7 The dialog

The Import dialog picks its defaults through long chains of per-format conditions. Before four more
formats arrive, PR 1 moves those choices into one table, `features/explorer/import-formats.ts`. Each
row holds a format's label, tabs (URL, File, Paste, Folder), default name, whether the project picker
shows, and its IPC call. The existing formats move onto the table with no behaviour change, which the
existing dialog tests prove. The new formats are four new rows.

| Format | Tabs | Project picker |
| --- | --- | --- |
| Insomnia | File, Paste | shown |
| Bruno | Folder, File (`bruno.json` or a JSON export) | shown |
| Hoppscotch collection | File, Paste | shown |
| Hoppscotch environments | File, Paste | hidden: workspace only |
| Thunder Client | File, Folder | shown; hidden for an environment export |

### 3.8 IPC, commands and CLI

New channels: `api.importInsomnia`, `api.importBruno`, `api.importHoppscotch`,
`api.importHoppscotchEnvironments`, `api.importThunderClient`. Each takes a source (`file`,
`folder` or `text`) and the usual target. No new command: **Import…** auto-detects them (#378).

`wirebench import` accepts each format's file and folder forms (decision 4). Secrets are left out and
named, environments are reported as not imported, and an existing project property keeps its value.

## 4. Insomnia (PR 1)

### 4.1 Reading

- **v4.** JSON or YAML (`yaml` parses both). `resources[]` is flat and linked by `parentId`. A file
  may hold several `workspace` resources: each becomes its own API, or set of APIs, named after the
  workspace. Resources are read by `_type`; an extra `type` key is ignored.
- **v5.** One workspace per file. `collection[]` nests through `children[]`. An item is a folder when
  it has none of `method`, `url` and `reflectionApi`; an HTTP request when it has `method`; gRPC when
  it has `reflectionApi`; otherwise WebSocket. A Socket.IO item, marked by `eventListeners` or a
  `socketio-req_` id, is skipped and reported.
- **`spec.insomnia.rest/5.0`** files are read as collections. Insomnia uses this kind for any
  collection that also holds an API spec. The embedded spec in `spec.contents` is reported, with a
  note to import it as OpenAPI.
- **Older formats.** `__export_format` 1 to 3 is refused with `insomnia-old-format`, which asks for
  a re-export from a current Insomnia.
- **Order.** Siblings sort by `metaSortKey` (v4) or `meta.sortKey` (v5), ascending, ties by id
  descending, as Insomnia does. File order means nothing in either format.

### 4.2 Requests

Each HTTP request becomes a v2.1 item:

- **URL and params.** The URL is kept with its own query string. Each `parameters` row is appended
  as a query param, with `disabled` kept. `:name` segments become `{name}`, with values from
  `pathParameters`.
- **Headers.** Kept, with `disabled`. Folder headers are copied onto each request below that does
  not set the same name, as the OpenCollection importer does, and the report notes it.
- **Body**, by `mimeType`:

  | `mimeType` | Becomes |
  | --- | --- |
  | JSON, XML, YAML, EDN, text, or any other text type | raw, with that content type |
  | `application/x-www-form-urlencoded` | form, from `params` |
  | `multipart/form-data` | multipart. A `type: file` part keeps its `fileName` path and the report notes it, since the file is not in the export. A string `multiline` is that part's content type. |
  | `application/graphql` | GraphQL: `body.text` is parsed as `{query, variables, operationName}`; a string `variables` is parsed, and kept as text when it does not parse |
  | `application/octet-stream` | binary, from `fileName` |
  | absent | none |

  When no `Content-Type` header exists, one is added from `mimeType`.
- **Auth**, through the v2.1 auth it maps to: `basic`, `bearer` (with its prefix), `digest`, `ntlm`,
  `apikey` (header, query or cookie), `oauth2` (each grant), `iam` (AWS SigV4) and `none`. `oauth1`,
  `hawk`, `asap`, `netrc` and `singleToken` become `none` with a warning naming the type. An empty
  `{}` or a disabled auth means inherit; `none` stops inheritance. Folder auth becomes folder auth.
- **Settings.** `followRedirects` `on`/`off` maps; `global` means the default. `encodeUrl` maps.
  Cookie, render and rebuild-path settings are noted.
- **Server-Sent Events.** A request with `Accept: text/event-stream` stays a REST request; Wirebench
  reads the stream when it sends it.

### 4.3 gRPC and WebSocket

- **gRPC.** One gRPC API per workspace. `grpcs://` in the URL means TLS. `protoMethodName`
  (`/pkg.Service/Method`) gives the service and method; `body.text` is the message; `metadata` maps
  with `disabled`. In v4 the `proto_file` the request points to is run through the existing `.proto`
  import, with its `proto_directory` siblings available to `import` statements, so the API gets its
  definition. v5 does not export proto text: the API has no definition, and the report says so.
  Reflection settings are noted.
- **WebSocket.** One WebSocket API per workspace. URL, headers, params and auth map. In v4 the
  `websocket_payload` becomes one saved message. v5 does not export payloads, which the report notes.

### 4.4 Environments

- **Base environment** (v4: the `environment` whose parent is the workspace; v5: `environments`)
  becomes project properties.
- **Sub-environments** become workspace environments (importer spec §3.5). Their `color` is kept as
  the environment colour (#345) when it is a `#rrggbb` value.
- **Folder environments** become project properties, outermost folder first; the first definition
  of a name wins, as for Postman folder variables.
- **Nested values** flatten to dotted names: `{"db": {"host": "x"}}` becomes `db.host`. An array
  element becomes `name.0`. Numbers and booleans become strings. `dataPropertyOrder` sets the order
  when present.
- **Private environments** (`isPrivate: true`) are imported like the others. A private environment is
  in the file only when the user chose to include it.
- **Vault secrets.** Values under `__insomnia_vault` are sealed or masked and cannot be read. Each
  name becomes a secret with no value, listed once in the summary as needing one.
  `{{ _.vault.name }}` points at it. Ruling R9: on apply, each vault secret gets an empty entry of
  its own in the secret store, and the property is `${secret:<ref>}`, so the value typed later goes
  to the store and never into a workspace or project file. A failed apply deletes these entries
  with the others. Every other empty secret keeps the 2026-10-04 rule: an empty property, with a
  line asking for its value. A vault value is known to be secret, and an empty property invites
  typing it into the project file.
- **Global environment file** (`environment.insomnia.rest/5.0`, or a v4 export of an environment
  workspace): the base environment merges into Globals and sub-environments become workspace
  environments. No project picker shows.

### 4.5 Reported, not mapped

Cookie jars (cookies are session state; the jar fills on the first send). Unit test suites, which
are listed with their request names. API specs, mocks, Socket.IO and MCP requests. Client
certificates and responses are never in an Insomnia export.

## 5. Bruno (PR 2)

### 5.1 The `.bru` reader

`bruno/lexer.ts` and `parse.ts` implement the three grammars Bruno has (request, collection or
folder, environment). They are written by hand: no parser generator, no regular expression with
nested quantifiers over unbounded input. The rules that matter:

- **Blocks.** A file is a sequence of `name { … }` blocks. A block is a dictionary (`key: value` per
  line), a text block (body, scripts, tests, docs) or, in environments, a `[ … ]` list.
- **Block end.** A block ends at a line that starts with `}` in the first column. Nothing else ends
  it.
- **Text blocks** lose up to two leading spaces per line.
- **Dictionary values** run to the end of the line and are trimmed. A `'''` value spans lines; four
  characters are removed from each line, then the value is trimmed.
- **Keys** stop at the first `:`. A key in double quotes may hold spaces and `:`, with `\"` as the
  only escape.
- **Disabled entries** start with `~`, before the key or before its opening quote.
- **Annotations** (`@number`, `@boolean`, `@object`, `@description(…)` on their own line above a
  pair) are read. Types turn into strings; descriptions are kept where the target has a description.
- **Multipart values** may be `@file(a|b)` (one part per path) and may end in `@contentType(x)`.
- **Lists** (`tags`, `omitHeaders`) hold one item per line.
- **No comments.** The grammar has none, so a `//` line in a dictionary is an error.

A file that does not parse fails alone, with `bruno-parse-error` naming the file and line. The rest
of the collection still imports and the report lists the failure, so one broken file does not block
a collection.

### 5.2 Layout

- `bruno.json` gives the collection name. Its `version` is a format marker, not the user's version.
- `collection.bru` holds collection headers, auth, variables, scripts, tests and docs.
- A folder's `folder.bru` holds its display name, `seq`, headers, auth, variables, scripts and docs.
  A folder without one is named after its directory.
- Every other `*.bru` file is one request. `environments/*.bru` files are environments, named after
  the file.
- **Order** is `meta.seq`, then the name. A missing `seq` counts as 1, as in Bruno.

### 5.3 Into OpenCollection

Each request becomes an OpenCollection item, so §7 of the importer spec applies from there:

- **Method and URL.** The verb block's name, or `http { method }` for a custom verb. Query params come
  from `params:query`, not the URL, so none is counted twice. `:name` segments take their values
  from `params:path`.
- **Body.** Only the mode the verb block names (`body: json` and so on) is used. Other body blocks
  left in the file are noted. Modes: `json`, `text`, `xml`, `sparql`, `graphql` with
  `body:graphql:vars`, `formUrlEncoded`, `multipartForm`, `file` (the selected entry).
- **Auth.** The request's `auth:` mode, or the folder and collection `auth { mode }`, with the
  matching `auth:*` block. `inherit` and `none` map as they do in OpenCollection.
- **gRPC** (`meta { type: grpc }`): `grpc { url, method, methodType, protoPath }`, `metadata`, and
  the first `body:grpc` message; the others are noted. `protoPath` runs through the `.proto` import
  when the file is inside the collection.
- **WebSocket** (`meta { type: ws }`): `ws { url }`, headers, and each `body:ws` block as a saved
  message.
- **Variables.** `vars:pre-request` on the collection and folders become project properties; on a
  request they are reported, as OpenCollection's request variables are. `vars:post-response` values
  are expressions run against the response, so they are reported as needing a script or a capture.
- **Assertions.** Each `assert` line is `<expression>: <operator> <value>`, and a bare value means
  `eq`. It becomes an OpenCollection assertion, so the importer spec's table maps `res.status`,
  `res.body.<path>` and `res.responseTime`. The other 20 operators are reported.
- **Settings.** `timeout`, `followRedirects`, `maxRedirects` and `encodeUrl` map. `omitHeaders`
  becomes the request's omitted generated headers (#346).
- **Docs** become the request's description.
- **`app` items** are skipped and reported.

### 5.4 Environments

`environments/<Name>.bru` becomes a workspace environment called `<Name>`. `vars { }` entries keep
their `~` disabled flag. `vars:secret [ a, b ]` lists names only: each becomes a secret with no value,
listed as needing one. A value of `{{process.env.X}}` becomes `${#System#X}`. `extends`, `color` and
`vars:externalsecrets:*` are reported.

### 5.5 The JSON export

A Bruno JSON export (`version: "1"`, `name`, `items[]`) is the same model as the parsed files. It
converts to the same OpenCollection document, with no grammar. Its `environments` follow §5.4, and
its secrets are empty in the file. Its `brunoConfig` proxy and client certificate settings are
reported; a proxy password in it is never copied.

## 6. Hoppscotch (PR 3)

### 6.1 Versions

Every version is read, and every level carries its own:

| Object | `v` | Versions read |
| --- | --- | --- |
| Collection and folder | number, or absent for the oldest | legacy, 1 to 12 |
| REST request | string | absent (v0) and `"1"` to `"17"` |
| GraphQL request | number | 1 to 10 |
| Environment | number, or absent | 0 to 2 |

A v0 REST request has `url` + `path` and a string `auth`; it is read as Hoppscotch's own migration
reads it. A version above the newest known one is read as the newest, and the report names it.

### 6.2 Collections

- A file is one collection object or an array of them. Each top-level collection becomes an API.
  Folders nest through `folders[]`, and array order is the display order.
- **REST requests:**
  - **URL.** `endpoint` with `<<x>>` rewritten (§3.4). `params` rows are added unless the same name is
    already in the URL's query; `active: false` becomes disabled.
  - **Headers** keep `active` and `description`.
  - **Body** by `contentType`: JSON variants, XML, HTML and text become raw. `x-www-form-urlencoded`
    is a text of `key: value` lines and becomes a form. `multipart/form-data` becomes multipart; a
    file entry has no file in the export, so it becomes an empty file part and is noted.
    `application/octet-stream` and `binary` become an empty binary body, also noted.
  - **Auth** by `authType`: `none`, `inherit`, `basic`, `bearer`, `api-key` (header or query),
    `oauth-2` (each grant, with its client authentication and extra parameters where Wirebench has
    them), `aws-signature`, `digest` and `jwt` map. `hawk` and `akamai-eg` become `none` with a
    warning. `authActive: false` means no auth. Stale keys left from another auth type are ignored.
  - **Saved responses** (`responses`) become response examples (importer spec §3.7).
  - **`requestVariables`** are reported, since Wirebench has no request scope.
  - **`description`** becomes the request's description.
- **GraphQL requests** become REST requests with a GraphQL body: `query`, and `variables` parsed
  from its JSON string.
- **Collection and folder** `auth` and `headers` become API and folder auth, and copied headers as in
  §4.2. Their `variables` become project properties; a `secret` one becomes a secret with no value.
  Scripts follow §3.5.

### 6.3 Environments

A file is one environment or an array of them. Each becomes a workspace environment; one named
`Global`, or with id `Global`, merges into Globals instead.

- A variable's value is `currentValue`, else `initialValue`, else `value` (older versions). Current
  exports blank every `currentValue`, so `initialValue` is what usually arrives.
- `secret: true` variables never carry a value: each becomes a secret with no value, listed.

### 6.4 Not in the format

Hoppscotch does not export WebSocket, SSE, Socket.IO or MQTT requests, so there is nothing to map.
There is no whole-workspace file: collections and environments are separate imports.

## 7. Thunder Client (PR 4)

### 7.1 Shapes

| Shape | Recognised by | Becomes |
| --- | --- | --- |
| Collection export | `clientName` or `client` `"Thunder Client"`, `collectionName`, `requests[]` | one API |
| Environment export | the same marker, `environmentName`, `variables[]` | one environment, or Globals when `global: true` |
| One-file-per-collection folder | `collections/tc_col_*.json` (`colName`, no marker) and `environments/tc_env_*.json` (`data[]`) | one API per collection; the environments |
| Legacy folder | `thunderclient.json` (requests), `thunderCollection.json`, `thunderEnvironment.json` | the requests grouped by `colId` into their collections, then as above |

The one-file-per-request layout is refused with `thunder-unsupported-layout` (decision 5). The
`ref` field is ignored.

Thunder Client changed some field shapes over time; both forms are read:

- the marker key, `client` (versions 1.0 and 1.1) or `clientName` (1.2)
- `body.raw` and `docs`, a string or an array of lines

### 7.2 Requests

- **Tree.** Folders are flat and nest through `containerId`. A folder whose parent is missing goes to
  the root. Requests point at their folder the same way.
- **Order.** Folders first, then requests, each by `sortNum`.
- **Base URL.** A collection's `settings.options.baseUrl` becomes the API's server. A relative request
  URL is then relative to it, with no doubled slash.
- **URL and params.** Query params come from `params` rows without `isPath`; their `isDisabled` is
  kept, and the URL's own query is not read again. An `isPath` param fills a `{name}` segment.
- **Headers** keep `isDisabled`. Collection and folder headers copy onto requests as in §4.2.
- **Body** by `type`:

  | `type` | Becomes |
  | --- | --- |
  | `json`, `xml`, `text` | raw, with that content type added when no header sets one |
  | `formencoded` | form |
  | `formdata` | multipart: text parts from `form`, file parts from `files` with their paths, noted |
  | `graphql` | a GraphQL body, `variables` parsed from its string |
  | `binary` | binary, from the path |

- **Auth** by `type`: `basic`, `bearer` (flat `bearer`, with `bearerPrefix`), `oauth2`, `aws` (SigV4),
  `ntlm` and `none` map. No `auth` means inherit from the folder, then the collection. Any other type
  becomes `none` with a warning naming it.
- **SSE** (`reqType: "sse"`) stays a REST request.
- **Docs** become the request's description.

### 7.3 Tests

Each row is `{type, custom, action, value}`. Per decision 2:

| Row | Becomes |
| --- | --- |
| `res-code` `equal` | `status` assertion |
| `res-time` `<` or `<=` | `sla`, `maxMs` |
| `json-query` `equal`, with `custom` a plain path (`json.a.b[0]`) | `match`, JSONPath `$.a.b[0]`, `equals` |
| `json-query` `contains` | `match`, `matches` with the escaped value |

Collection and folder test rows are copied onto every request below them. Everything else is
reported with its row: `res-body` rows (a match reads JSON or XML, not plain text), header rows (the header name is in `type`), `count`, `istype`, any `custom`
holding a filter (`|`), and `set-env-var` rows (decision 3).

### 7.4 Environments

- Variables keep `name` and `value`. A `secret: true` variable becomes a secret: its value goes to the
  secret store when the file carries one, otherwise it is listed as needing one. An
  `encrypted: true` value cannot be read and is treated as missing.
- An environment linked to a `.env` file (`envFile`) arrives empty, and the report names the file;
  `.env` files are not read.
- `default` and `local` are noted, never mapped: an import never activates an environment.

### 7.5 Reported, not mapped

`preReq.runRequests` (request chaining; decision 3), `settings.runOptions`, `settings.envId`, and the
attached script paths. Thunder Client WebSocket and gRPC requests have no published shape, so a request
whose `reqType` is neither absent, an HTTP method nor `sse` is skipped and reported.

## 8. Docs

- **Importers guide.** `guides/importers.mdx` gains one row in the format table and one section per
  format, with its limits.
- **Switching pages.** `switching/insomnia.mdx`, `switching/bruno.mdx`, `switching/hoppscotch.mdx`
  and `switching/thunder-client.mdx`: mapping tables in the style of `switching/postman.mdx`, each
  describing its format neutrally.
- **CLI reference.** `wirebench import` lists the new formats.
- **CHANGELOG.** One entry per PR.

## 9. Testing

**Engine, unit.** Per format, `parse` and `convert` tests against crafted fixtures under
`fixtures/<format>/crafted/`. Each of these has a case:

- every mapping row in §4–7
- every skip and report path
- every error code
- every detection rule, including the neighbours: a Hoppscotch file is never Thunder Client and the
  reverse; a Bruno folder with `opencollection.yml` stays OpenCollection; Postman stays Postman
- every Hoppscotch version in §6.1, and Thunder Client's string and array `raw`

**Bruno grammar.** Every rule in §5.1 gets a case, plus hostile input: an unterminated block, a 10 MB
single line, 100,000 tiny blocks, and a `'''` that never closes. Each runs within the timing budget
the other parsers use.

**Converters.** A golden test per format: a fixture collection goes through its converter and the
shared mapper, and the resulting project matches a checked-in snapshot.

**Main and CLI, unit.** The Bruno and Thunder Client folder walks: limits, no symbolic links, no
leaving the root, `.env` never read. The CLI reads each format and leaves secrets out.

**Renderer, unit.** The format table reproduces every existing format's tabs, picker and default name,
so the refactor in §3.7 is proven to change nothing. Each new row has its own cases.

**e2e** (one case per PR, in `e2e/specs/`): import an Insomnia v5 file; pick a Bruno folder; import a
Hoppscotch collection with its environments; pick a `thunder-tests` folder.

**Gates.** `WIREBENCH_SKIP_PERF=1 pnpm check` before each commit, including `check:banned-terms`;
`pnpm test:perf` before each push.

## 10. Delivery

| PR | Content |
| --- | --- |
| 1 | §3.2–3.8 shared pieces, the dialog format table, §4 Insomnia |
| 2 | §5 Bruno, with the folder pick |
| 3 | §6 Hoppscotch |
| 4 | §7 Thunder Client |

Each PR is green on its own, updates its docs and ticks its box on #588.

## 11. Boundaries

- **Always:**
  - Keep engine parsing pure. Main and the CLI do file access, secrets and saving.
  - Reuse the Postman and OpenCollection mappers; a converter reports what it cannot express.
  - Never overwrite an existing environment, global, project property, secret or script file.
  - Report every value that did not come across as it was.
  - Describe each format neutrally (CLAUDE.md, `check:banned-terms`).
- **Never:**
  - Run an imported script. Every imported script is saved as text.
  - Activate an imported environment.
  - Read a `.env` file.
  - Write a secret value or a recorded credential into a project, workspace or History file.
  - Add a third-party dependency. `yaml` already parses Insomnia YAML.

## 12. Out of scope

- Converting request chaining: Insomnia response tags, Thunder Client pre-requests, Bruno
  post-response variables. A follow-up can map them to sequences (#347).
- Translating Bruno, Hoppscotch or Thunder Client scripts to the Wirebench or Postman API.
- Insomnia's v1–v3 export formats, and Thunder Client's one-file-per-request layout.
- Importing cookie jars.
- Exporting to any of these formats.

## 13. Success criteria

- [ ] **Insomnia.** A v4 or v5 export imports with its folders, order, requests, gRPC and WebSocket
      requests, environments and scripts saved as text.
- [ ] **Bruno.** A `.bru` collection folder, or a Bruno JSON export, imports with its folders,
      `seq` order, auth, assertions, scripts as text and environments.
- [ ] **Hoppscotch.** Collections and environments of every schema version import, including saved
      responses as examples.
- [ ] **Thunder Client.** Exports and both `thunder-tests/` layouts import, with base URLs, auth
      inheritance and tests mapped where they fit.
- [ ] **Secrets.** No secret value and no recorded credential lands in a project, workspace or
      History file. No existing secret is overwritten.
- [ ] **Reporting.** Every format sits behind the one **Import…** dialog, and everything it cannot map
      is in its report.
- [ ] **Gates.** `WIREBENCH_SKIP_PERF=1 pnpm check` and `pnpm test:perf` pass.
