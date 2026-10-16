# Thunder Client (VS Code, rangav) file formats: research for an importer

Research date: 2026-10-15. Thunder Client (TC) is closed source. There is no published schema. Everything below comes from three kinds of evidence, tagged in the text:

- **[REAL]** Observed in files that TC itself wrote. These were exports and on-disk database files committed to public GitHub repos. I sampled about 480 files with `gh api` and `curl`, and aggregated the key sets with `jq`. Counts are given where they matter. Genuine files are recognisable by a `ref` hash, `_id`/`colId` UUIDs and a realistic `sortNum` cadence.
- **[DOC]** Official docs (https://docs.thunderclient.com), the support repo's release notes and issues (https://github.com/thunderclient/thunder-client-support).
- **[3P]** Third-party importers or generators. Several of these invent fields. Treat them as hints only, see section 11.

"UNCONFIRMED" means I could not find a real sample or a doc statement. I never filled a gap by guessing.

Downloaded evidence (untrusted data, never executed) is in `/private/tmp/claude-501/-Users-mnaami--claude-spares-spare-jbJNQ8/bca66a86-3617-407d-88d5-51db74883589/scratchpad/downloads/thunder` and `.../thunder2`. Nothing under the wirebench repo was touched.

---

## 0. Executive summary

There are **five distinct JSON shapes** an importer will meet. They are easy to confuse.

| # | Shape | Origin | Top-level JSON | File name pattern |
|---|---|---|---|---|
| A | Collection **export** | UI "Export" | object, `clientName`/`client` + `collectionName` + `requests` | `thunder-collection_<name>.json` |
| B | Environment **export** | UI "Export" | object, `clientName`/`client` + `environmentName` + `variables` | `thunder-environment_<name>.json` |
| C | On-disk **v1/v2 database** ("Save to Workspace", old) | extension | four array files | `thunder-tests/thunderclient.json`, `thunderCollection.json`, `thunderEnvironment.json`, `thunderActivity.json` |
| D | On-disk **v3 database** (one file per collection / environment) | extension (default since about v2.x) | object per file | `thunder-tests/collections/tc_col_<name>.json`, `thunder-tests/environments/tc_env_<name>.json` |
| E | On-disk **v4 database** (one file per request, paid) | extension, opt-in since v2.23.0 | per-entity files | layout UNCONFIRMED (no real sample found) |

Shape A and shape D are structurally close but **not identical**. The D collection file is the export without the envelope. It has `colName` instead of `collectionName`, no `clientName`/`version`/`ref`, and the folders and requests are inline. Shape A and shape B are the only ones with a `clientName`/`client` marker.

Key instability to plan for, all **[REAL]**:

1. The marker key was **`client`** (not `clientName`) in older exports. `client` + `version` 1.0/1.1 is used from 2021-04 to 2024-04. `clientName` + `version` 1.2 + `ref` + `collectionId` is used from 2024-04 on (corpus of 366 genuine collection exports, 2024-04 to 2026-01). An importer must accept both keys.
2. `body.raw` is a **string** in all older files and an **array of lines** in files written by v2.39.0 or later (2026-02). Confirmed in two real files. [DOC] release v2.39.0.
3. Request `docs` is a **string** in older files and an **array** after v2.39.3 [DOC]. I found only the string form in real files.
4. Environment variables carry `secret: true` (and `encrypted: true` on the Enterprise plan). **There is no `isSecret`.** The `isSecret` seen in some GitHub files is from hand-written or generated fixtures, not TC.

---

## 1. Detection markers

### 1.1 Positive identification

| File | Rule | Evidence |
|---|---|---|
| Collection export (A) | `(clientName ?? client) === "Thunder Client"` AND `requests` is an array (or `folders`) AND `collectionName` is a string | 480 sampled files, no counter-example among genuine files. [REAL] |
| Environment export (B) | `(clientName ?? client) === "Thunder Client"` AND `variables` is an array AND `environmentName` is a string | [REAL] (e.g. issue #1535) https://github.com/thunderclient/thunder-client-support/issues/1535 |
| Disk collection (D) | no marker. Object with `_id`, `colName`, `folders` (array), `requests` (array, may be missing in `thunderCollection.json`), `created`, `sortNum` | [REAL] |
| Disk environment (D) | object with `_id`, `name`, `data` (array of `{name,value}`), `default`, `sortNum`, `created`, `modified` | [REAL] |
| Legacy `thunderclient.json` (C) | top-level **array** whose elements have `colId` + `containerId` + `method` + `url` | [REAL] |
| Legacy `thunderCollection.json` (C) | top-level **array** whose elements have `colName` and `folders` but no `requests` | [REAL] (Food Oasis, Chattum) |
| Legacy `thunderEnvironment.json` (C) | top-level **array** of environment objects | [REAL] |
| `thunderActivity.json` | history log, array. Real samples are `[]` (3 bytes) | [REAL] (Chattum). Contents UNCONFIRMED. |

Do not rely on the file name. Users rename exports. Content checks above are enough.

Two parse paths to cover for "is it TC":
- Object with the marker, or
- Directory `thunder-tests/` (workspace) or `.../globalStorage/rangav.vscode-thunder-client` [DOC https://docs.thunderclient.com/ storage section] containing the files in section 3.

### 1.2 Distinguishing from neighbours

| Other format | Their marker | Why TC is different |
|---|---|---|
| Postman v2.1 collection | `info._postman_id`, `info.schema` URL, `item[]` | TC has no `info`/`item`. TC uses flat `folders[]` and `requests[]`. |
| Postman environment | `_postman_variable_scope`, `values[]` | TC uses `variables[]` or `data[]`. |
| Insomnia v4 | `_type: "export"`, `__export_format`, `resources[]` | not in TC. |
| Insomnia v5 | `type: "collection.insomnia.rest/5.0"` | not in TC. |
| Hoppscotch | `v`, `name`, `folders`, `requests` with `endpoint` | The Hoppscotch collection also has `folders` + `requests` and **shares the key names**. TC requests have `url`, `_id`, `colId`, `containerId`. Hoppscotch has `endpoint`. Always check the `clientName`/`client` marker first. A Hoppscotch file is one of the negative fixtures a third party built for this. |
| OpenAPI | `openapi`/`swagger` key | not in TC. |
| HAR | `log.entries` | not in TC. |

A weak but useful sanity test for files without a marker (disk shape D): every request has `colId` equal to its collection's `_id`, and `containerId` is `""` or a folder `_id` of the same file.

---

## 2. Collection export (shape A)

### 2.1 Versions

Only `version` strings `"1.0"`, `"1.1"`, `"1.2"` are in real exports. The count of genuine/third-party files across the corpus: 1.2 about 377, 1.1 about 43, 1.0 about 29. [REAL] There is no `2.x`. (One generated fixture used `"1.0.0"`; it is not TC.)

| `version` | Marker key | Extra top-level keys | Dates seen | Notes |
|---|---|---|---|---|
| `1.0` | `client` | `collectionName`, `dateExported`, `folders`, `requests` | 2021-04 | first export format. |
| `1.1` | `client` | same, optional `settings` | 2021-06 to 2024-04 | `settings` (collection auth/headers/tests/options) present when set. Issue #443 shows a real 1.1 export with `settings.auth.oauth2`. https://github.com/thunderclient/thunder-client-support/issues/443 |
| `1.2` | `clientName` | adds `collectionId`, `ref` (a long URL-safe hash) | 2024-04 onward | `colId` on every request equals `collectionId`. |

Files in the wild with `clientName` and version 1.0 or 1.1 and no `ref` exist, mostly hand-edited or generated. So do not branch on version alone. Branch on key presence.

### 2.2 Envelope [REAL]

```
{
  "clientName": "Thunder Client",       // "client" in <= 1.1 exports
  "collectionName": "Gamersworld.Gateway",
  "collectionId": "71d56da9-e3af-...",  // 1.2 only
  "dateExported": "2024-06-17T18:53:08.442Z",
  "version": "1.2",
  "folders": [ ... ],
  "requests": [ ... ],
  "settings": { ... },                  // optional
  "ref": "GaQrDAicavx..."               // 1.2 only
}
```

A real 1.2 export example from https://github.com/buraksenyurt/DistributedChallenge/blob/main/thunder/thunder-collection_Gamersworld.Gateway.json (keys exactly as above, no `settings`).

`ref`: a hash/signature that TC verifies on import. A third party generating files reported that hand-built JSON "doesn't import" because of it, and TC staff did not answer how it is computed (https://github.com/thunderclient/thunder-client-support/issues/1571). How it is computed is UNCONFIRMED. For an importer this means: **ignore `ref` on read**. For an exporter (not our job) it is a blocker.

### 2.3 Folders [REAL]

Flat list, nesting by parent pointer:

```
{ "_id": "...", "name": "interaction", "containerId": "<parent folder _id or empty>",
  "created": "2024-01-12T09:09:52.083Z", "sortNum": 40000, "settings": { ... } }
```

- Key sets seen over 361 folders: `_id,containerId,created,name,sortNum` (345) and the same plus `settings` (16).
- `containerId` is `""` for a folder directly under the collection and a parent folder `_id` otherwise. Nesting depth is unbounded in principle. Real nested examples exist (a folder whose `containerId` is another folder's `_id`).
- A folder does **not** carry `colId` in exports, but in the Chattum/Food Oasis older database files it is in the collection object, not the folder.
- Folder `settings` keys actually seen: `headers`, `auth`, `tests`, `runOptions` (`{delay, iterations, dataFilePath}`), and `{}`. Folder-level `preReq`/`postReq`: UNCONFIRMED in real files (the docs say scripts can be at folder level, https://docs.thunderclient.com/scripting).
- Order: sort folders and requests by `sortNum` ascending. `sortNum` is a **number** (integers like 10000, 20000, 5000, but also fractions like 7031.3 and negative like -2 for the global env). Real insertion moves produce midpoints, so do not assume integer or unique values across parents. 30 requests had no `sortNum` (null).
- Folder and request siblings share one numbering space within a `containerId`? UNCONFIRMED. Treat folders and requests as a combined list sorted by `sortNum` only if you need an interleaved order. The TC UI lists folders first (UNCONFIRMED), so sorting folders first, then requests is the safe choice.
- Orphans: `containerId` pointing at an id that does not exist should fall back to root. (Third-party negative fixtures test this; TC itself never writes it.)

### 2.4 Collection `settings` [REAL]

Union of keys seen: `headers`, `auth`, `tests`, `options`, `preReq`, `docs`, `envId`.

| key | Shape | Notes |
|---|---|---|
| `headers` | `[{name, value, isDisabled?}]` | applied to every request in the collection |
| `auth` | same object as request `auth` (section 4) | applied to requests that do not set their own |
| `tests` | same row shape as request `tests` (section 5) | observed with a `set-env-var` row on the collection |
| `options.baseUrl` | string, may contain `{{var}}` | see below |
| `preReq` | `{runRequests: [ ... ]}` | request chaining at collection level (section 6) |
| `docs` | string (markdown) | collection description |
| `envId` | string, an environment `_id` | "environment attached to the collection" [DOC https://docs.thunderclient.com/features/environments]. The target env is normally **not** in the export. |

`options.baseUrl`: requests in these collections carry **relative URLs** like `"/auth/createuser"` or `"login"`, and the effective URL is `baseUrl + url`. Real example: iNoteBook has `settings.options.baseUrl = "http://localhost:5000/api"` and request urls `"/auth/createuser"`. [REAL, https://github.com/vancityAyush/inotebook]. The exact join rule (slash handling when both sides have one, as in `"/api/"` + `"/x"`) is UNCONFIRMED. An importer should normalise duplicate slashes at the join and leave absolute URLs (`http...` or `{{...}}` starting with a scheme variable) untouched.

Whether TC also applies `baseUrl` when `url` starts with `{{var}}` is UNCONFIRMED. Real collections with `baseUrl: "{{FHIR_SERVER_URL}}"` have request urls like `Patient/...` (relative) [REAL], so the relative-path case is the one that matters.

### 2.5 Inheritance (headers, auth)

- Evidence that a request with no `auth` object inherits: a third-party importer (Fetch Client) maps "no auth" to "inherit" (https://github.com/Ganesan-Chandran/vscode-fetch-client), and bug reports use the word "Inherit authentication" for TC (issue #381 https://github.com/thunderclient/thunder-client-support/issues/381). In 94 real requests with auth, only `bearer` (356 object hits), `basic`, `oauth2`, `ntlm`, `aws`, `none` appear. **No request carries `auth.type: "inherit"`.** [REAL]. So: absent `auth` = inherit from folder then collection. Explicit `auth.type: "none"` appears 4 times and presumably means "No Auth, do not inherit". The inheritance order folder-to-collection (nearest wins) is described in #381 comments (parent folders and sub folders). The exact merge rule for headers (collection + folder + request, request wins on name clash?) is UNCONFIRMED. A reasonable reading is to concatenate and let the nearest definition win by header name. Mark that as assumed behaviour.
- `auth: {type: "inherit"}` is not found anywhere in real files. If you see it, treat it as inherit.

---

## 3. On-disk workspace storage

### 3.1 Where [DOC]

- Default storage (no Git Sync): VS Code global storage, `.../globalStorage/rangav.vscode-thunder-client` (macOS `~/Library/Application Support/Code/User/globalStorage/rangav.vscode-thunder-client/`, Linux `~/.config/Code/User/globalStorage/...`, Windows `%APPDATA%\Code\User\globalStorage\...`). https://docs.thunderclient.com/ (storage location).
- Git Sync (paid): setting "Save to Workspace" creates `thunder-tests/` at the workspace root. Alternatives: "Workspace Relative Path" and "Custom Location" (`$HOME/...`). If both are set, Save to Workspace wins. Requests created before enabling Git Sync are not moved automatically. The docs tell you to copy the `collections` and `environments` folders into `thunder-tests`. https://docs.thunderclient.com/team
- `tc_env_global.json` is the global environment file name. https://docs.thunderclient.com/features/environments
- Also seen: `.vscode/thunder-tests/`, `<subproject>/thunder-tests/`, `thunderclient/` (renamed) [REAL]. Do not hard-code the root. Locate it by the presence of `collections/` + `environments/` or the legacy four files.

### 3.2 Database versions [DOC]

From https://docs.thunderclient.com/team and release v2.23.0 / issue #1507 (https://github.com/thunderclient/thunder-client-support/issues/1507):

| Name | Layout | Status |
|---|---|---|
| (v1/v2, legacy) | 4 files in `thunder-tests/`: `thunderclient.json`, `thunderCollection.json`, `thunderEnvironment.json`, `thunderActivity.json` | [REAL] still present in many repos, and kept in `thunder-tests/_db-backup/` after migrating |
| **v3** (default) | "The collection is stored in a single JSON file": `thunder-tests/collections/tc_col_<name>.json`, `thunder-tests/environments/tc_env_<name>.json` | [DOC] + [REAL] 247 `tc_col_*` files in GitHub |
| **v4** (paid, opt-in since v2.23.0, 2024-05-12) | "one file per request". The issue #1728 text says "TC entities 'Environment, Collection, Folder and Request' are stored as separate JSON files", and that collection and folder files only have `created` while request files have `created` and `modified` | [DOC]. File names, folder layout and the field set of the folder/collection files: **UNCONFIRMED**. I found no public sample (code search for `_db-backupv3` and request files gave nothing). v4 is paid and rare in public repos. |

Switching: command palette "Thunder Client: Upgrade Database to v4" and "Downgrade Database to v3". The old files are backed up in `_db-backupv3` (v4 upgrade) and `_db-backup` (v1/v2 to v3) [DOC #1507; REAL].

**What current versions write.** v2.39.0 (2026-02) is the latest version in the release list I read. It writes v3 by default and v4 on opt-in. It also changed `body.raw` to an array of lines and froze the `modified` field to reduce git diffs. [DOC https://github.com/thunderclient/thunder-client-support/releases, #1728]

Recommendation for the importer: support A, B, C and D fully. For E, accept a directory walk where every `*.json` below `thunder-tests/` is classified by content (section 1.1), and report "v4 layout not recognised" if nothing matches. Ask for a user sample before promising E.

### 3.3 Shape D: `tc_col_<name>.json` [REAL]

One collection per file, with folders and requests **inline**:

```
{
  "_id": "a5036bd1-cef7-436a-9e09-dd470ffd7f93",
  "colName": "Auth",
  "created": "2023-07-14T02:55:20.471Z",
  "sortNum": 5000,
  "folders": [ ...same folder objects as exports... ],
  "requests": [ ...same request objects as exports... ],
  "settings": { ... }                       // optional, same keys as 2.4
}
```

Over 122 sampled files: keys are `_id,colName,created,folders,requests,sortNum` (63) or the same plus `settings` (59). Requests are identical in shape to export requests (including `colId`, which equals the collection `_id`). The `<name>` part of the file name is a slug of `colName`.

Differences from an export: `colName` not `collectionName`; no `clientName`/`version`/`dateExported`/`ref`; collection `_id` instead of `collectionId`; has `created` and `sortNum` for the collection itself.

### 3.4 Shape D: `tc_env_<name>.json` [REAL]

```
{
  "_id": "c7c3e46c-894a-4fbc-91fe-5c5a84293850",
  "name": "(Global Env)",
  "default": false,
  "global": true,
  "sortNum": -2,
  "created": "2023-07-14T02:56:00.306Z",
  "modified": "2023-07-14T02:56:00.306Z",
  "data": [ {"name": "host", "value": "http://192.168.1.4:80"}, {"name": "api", "value": "{{host}}/api"} ],
  "envFile": "..\\server\\.env"           // only for .env-linked envs
}
```

Key sets over 42 env files: `_id,created,data,default,modified,name,sortNum` (20), `+global,local` (16), `+global` (5), `+envFile` (1).

- `global: true` marks the global environment. The file is `tc_env_global.json`. Name is `(Global Env)`. [REAL, DOC]
- `local: true` appears together with `global: true` (16 of 21 global-flagged files). I never saw `local` without `global`. Per the docs, "Local Environment" is a global-type environment for secrets kept on the computer and meant to stay out of git ([DOC https://docs.thunderclient.com/features/environments]). The exact on-disk difference between a local and a non-local global env is UNCONFIRMED. Local envs that really are kept out of the workspace will simply not be in the repo.
- `default: true` marks the active environment? UNCONFIRMED. The `default` boolean exists on every env. It is true on 5 of the 8 envs I looked at, and the docs describe "Set Active" as the activation action. Do not map `default` to "active" without a user prompt.
- `envFile`: relative path to a linked `.env` file. `data` is `[]` in the one sample, so the values live in the `.env` file. [REAL one sample, DOC "Link to .env file" in https://docs.thunderclient.com/features/environments]. Format of the `.env` file per the docs is `key=value` lines.
- Variable objects: `{name, value}` plus `secret: true` and `encrypted: true` (see section 7).

### 3.5 Legacy files [REAL]

- `thunderclient.json`: JSON array of request objects, each with `colId`/`containerId`. This is the flat request store.
- `thunderCollection.json`: array of collection objects `{_id, colName, created, sortNum, folders: [...]}` with **no** `requests` key. Folder objects are the same as above.
- `thunderEnvironment.json`: array of env objects, same fields as `tc_env_*.json`.

To import a legacy workspace: group `thunderclient.json` requests by `colId` into the collections in `thunderCollection.json`, then handle each collection as shape D.

### 3.6 `thunder-tests` extras

Scripts and filter files live loose in the workspace (e.g. `thunder-tests/test-import.js`) and are referenced by workspace-relative path in `require("thunder-tests/test-import.js")`. [DOC https://docs.thunderclient.com/scripting/import-files]. Custom-filter JS files are "attached to Collection Settings" by relative path [DOC https://docs.thunderclient.com/scripting/custom-filters]. The key under `settings` that stores the attached paths: UNCONFIRMED (not in any sampled `settings`).

---

## 4. Request object

A genuine request (key frequency over about 1,700 requests [REAL]):

| key | Present | Notes |
|---|---|---|
| `_id`, `colId`, `containerId`, `name`, `url`, `method`, `sortNum`, `created`, `modified` | about 98% | `_id` UUID string |
| `headers` | 100% | `[{name, value, isDisabled?}]` |
| `params` | 46% | `[{name, value, isPath, isDisabled?}]` |
| `body` | 46% | section 4.3 |
| `auth` | 6% | section 4.4 |
| `tests` | 45% | section 5 |
| `preReq` | 1.3% | section 6 |
| `postReq` | 16% | section 6 |
| `docs` | 1% | string (markdown). Array form after v2.39.3 per [DOC], not seen in samples. |
| `reqType` | 0.4% | see 4.1 |

### 4.1 `method`, `reqType`, special request types

- `method`: upper-case HTTP method as typed. Odd values exist (`"UPDATE"` appeared twice). Accept any token.
- `reqType`: appears in a few old files with the lower-case method (`"get"`, `"post"`, `"patch"`, `"put"`, `"del"`). It is redundant with `method`. **`reqType: "sse"`** appeared once with `method: "GET"`, a Server-Sent-Events request: `{"method":"GET","url":"http://localhost:4200/sse?sessionId=dev","reqType":"sse", ...}`. [REAL, https://github.com/... tc/121.json in my sample]
- WebSocket: TC added "Web Socket support" in v2.19.0 (2024-03-04) and "Save to collection for SSE and WS requests" in v2.32.3 [DOC release notes]. I found no real WS request. The `reqType` value for WebSocket and the stored message fields: UNCONFIRMED. gRPC (beta since v2.37.0): shape UNCONFIRMED.
- GraphQL is a **body type**, not a request type (section 4.3). SOAP: no special type.

### 4.2 URL and params

- `url` may contain the query string (`?a=1&b=2`) **and** the parsed `params` array. They are redundant. Real exports usually have both. Prefer `params` for names/values/enable flags, and take the URL path portion (before `?`) from `url`. If `params` is missing or empty, parse the query from `url`. The exact rule for when TC re-serialises the query from `params` is UNCONFIRMED.
- `params[]`: `{name, value, isPath, isDisabled?}`. `isPath: true` marks a **path variable**. The URL then contains `{name}` (curly braces). [REAL: `"url":"/api/v1/tenant/account/{id}"`, `params:[{"name":"id","isPath":true,"value":"75"}]`; DOC https://docs.thunderclient.com/features/path-variables]. One third-party fixture claims `:name`; that is not TC.
- 10 of 891 params carried `isDisabled: true`. `isPath` is present on essentially every param (even `false`). Older exports may omit it.
- A param named like `cookie.xsrf-token|urlDecode` is a (disabled) param whose value holds a filter. It is a genuine oddity, ignore.

### 4.3 Body [REAL unless noted]

`body` has `type` and these keys: `raw` (string, or array of lines in v2.39+), `form` (array), `files` (array, formdata), `graphql` (object), `binary` (string path). Key sets seen: `form,raw,type` (510), `binary,form,raw,type` (228), `raw,type` (32), `files,form,raw,type` (9), `files,form,type` (7).

| `body.type` | Fields used | Notes |
|---|---|---|
| (no `body`) | none | |
| `none` | none | seen only in generated files; treat as no body |
| `json` | `raw` | the common case (517 hits). Real example below shows the array form. |
| `xml`, `text` | `raw` | `text` seen once; `xml` listed by 3P importers and by the UI. |
| `formencoded` | `form[]` of `{name, value, isDisabled?}` | 12 hits |
| `formdata` | `form[]` (text fields) + `files[]` of `{name, value}` | `value` of a file is a **local path** (e.g. `../../../../../Downloads/funny-racoon.webp`), relative or absolute. `isDisabled` is valid on form fields. Content type per field: the docs say you append it to the field name, with the "name=" convention, in `name=`; see https://docs.thunderclient.com/features/common. Exact syntax UNCONFIRMED. |
| `graphql` | `graphql: {query: string, variables: string}` | `raw` is `""`. `variables` is a JSON **string**, not an object. |
| `binary` | `binary: "<path>"` | 228 hits, e.g. `"binary":"../../Downloads/full-ig.zip"`. `raw` and `form` also present and empty. |

Real examples:

```json
"body": { "type": "json", "raw": ["{", "  \"question\": \"delete the database\"", "}", ""], "form": [] }
"body": { "type": "graphql", "raw": "", "form": [], "graphql": { "query": "query { ... }", "variables": "{...}" } }
"body": { "type": "formdata", "raw": "",
          "form":  [ {"name":"name","value":"T-shirt Ten"} ],
          "files": [ {"name":"picture","value":"../../../../../Downloads/funny-racoon.webp"} ] }
"body": { "type": "binary", "raw": "", "form": [], "binary": "../input/tests/measure/Smoking/tests-tus-screened-bundle.json" }
```

- Array `raw`: join with `"\n"`. Observed arrays end with an empty string element, giving a trailing newline when joined. That matches how `JSON.stringify` of a text with a trailing newline would split. Whether the last empty string is meaningful (trailing newline) is UNCONFIRMED. Stripping one trailing newline is safe for JSON.
- Body `Content-Type`: TC does not store a separate content type. For `json` it sets `Content-Type: application/json` at send time unless a header overrides it (UNCONFIRMED but standard). An importer should add the header when the user has none.
- `formdata` text field type override: UNCONFIRMED (see above).

### 4.4 Auth [REAL for what is listed]

`auth: {type, <type>: {...}}`. Observed `type` values and the exact shapes seen:

| `type` | Shape | Evidence |
|---|---|---|
| `none` | `{type:"none"}` | 4 hits |
| `bearer` | `{type:"bearer", bearer:"<token>", bearerPrefix?:"Bearer"}` | 356 hits. The token is **flat on `auth.bearer`**, not nested. `bearerPrefix` is optional (a custom prefix, set in the UI since v1.x: "Support change prefix in Bearer Token Auth" [DOC release notes]). Default prefix `Bearer` when absent. Real values of `bearerPrefix`: "Sanctum", "Bea". |
| `basic` | `{type:"basic", basic:{username, password}}` | 8 hits |
| `oauth2` | `{type:"oauth2", oauth2:{grantType, authUrl?, tokenUrl, clientId, clientSecret, clientAuth, scope?, state?, audience?, resource?, origin?, tokenName?, username?, password?, accessToken?, callbackUrl?, tokenPrefix?}}` | 17 hits. `grantType` observed: `authorization_code` (13), `password` (3), `client_credentials` (1). `clientAuth` observed: `in-header` (17). The other value (credentials in body) is UNCONFIRMED. The doc says credentials can be sent in the header or the body. `accessToken` holds a cached token. |
| `aws` | `{type:"aws", aws:{accessKeyId, secretKey, region, service, sessionToken}}` | 1 hit. Note `accessKeyId`, not `accessKey`. |
| `ntlm` | `{type:"ntlm", ntlm:{username, password, workstation, domain}}` | 1 hit |
| `apikey` | UNCONFIRMED. A 3P importer maps an `apikey` type, but I found no real sample. The docs list no API-key mode. Probably not a TC type. |
| `digest` | UNCONFIRMED. No sample. A 3P importer lists it, the support release notes don't mention it. |
| `inherit` | not observed. Use absent `auth` for inherit. |

Docs on OAuth: callback URLs `https://www.thunderclient.com/oauth/callback` or `http://localhost:6789/callback`; refresh at request, folder and collection levels (paid); tokens saved locally and "not in JSON files" (but `accessToken` was seen in two real files). https://docs.thunderclient.com/features/auth

Secrets: tokens, passwords and `clientSecret` are stored in plain text in the JSON. An importer must route these into secrets handling. A real example of a pasted bearer JWT in a collection's `settings.auth` exists in public repos.

---

## 5. Declarative tests (`tests`) [REAL]

`tests: [{type, custom, action, value}]`, all strings. They run after the response. Counts over about 1,150 test rows:

| `type` | `custom` | `action` values seen | `value` | Meaning |
|---|---|---|---|---|
| `res-code` | `""` | `equal` (272) | `"200"` | status code |
| `res-time` | `""` | `<=`, `<`, `notequal` | ms as string | response time |
| `res-body` | `""` | `contains`, `notcontains`, `isjson`, `notequal`, `count` | text | body check. `isjson` has an empty `value`. |
| `json-query` | `"json.data[0].id"` | `equal` (224), `count`, `contains`, `istype`, `setto` | string | JSON path into the body. `custom` is the query. `json.` is the root prefix. Filters can be piped (`json.items | filter(id>5)`). |
| `<Header-Name>` e.g. `Content-Type`, `Content-Length`, `Content-Encoding` | `""` | `equal`, `contains`, `notcontains`, `notequal`, `count`, `>=` | string | **header check: the header name is stored in `type`**. Not `res-header` and not `custom-header` in real files. |
| `set-env-var` | source expression | `setto` | target `{{var}}` | set an env var from the response. See below. |

Notes:
- The reqweave generator and a Fetch Client mapping mention `res-header` and `custom-header`. They did not appear in 1,150 real rows. Treat them as unknown types to be skipped with a warning. [3P]
- `set-env-var`: `custom` is the **source**, `value` the **target** (`{{token}}`). Source syntax [DOC https://docs.thunderclient.com/testing/set-env]:
  - `json.propertyName` (JSON body path; real files use nested paths like `json.data.token` and filter chains like `json.data | at(0) | prop("id")`)
  - `header.<name>`, `cookie.<name>` (real: `cookie.token`, `cookie.xsrf-token`)
  - `text` stores the whole body
  - plain text stores a literal
  - `delete` (delete variable) and `null` (clear) keywords
  - Target scope suffix: `{{variable, local}}` or `{{variable, global}}`; no suffix means the active environment.
  - A real row with an empty source `"custom":"json."` exists (a half-configured row).
- The docs mention "JSON schema validation" in the Tests tab (https://docs.thunderclient.com/testing/schema) and "array testing", "xml testing". How a schema test is stored: UNCONFIRMED (no row with a schema type found).
- Tests also exist at collection (and folder) level: `settings.tests` with the same row shape [REAL, collection level].
- The full action list in the UI is UNCONFIRMED. The list above is what appeared in the data.

---

## 6. Pre-request and post-request

### 6.1 `preReq` [REAL]

Key sets: `["runRequests"]` (51) and `["inlineScripts","runRequests"]` (5). The `options` key listed by the task prompt was never seen.

```json
"preReq": { "runRequests": [
  { "reqId": "<request _id>", "colId": "<collection _id>",
    "triggerCondition": "run-always", "triggerValue": "" } ] }
```

- `runRequests` = request chaining: run these other requests (by `_id`) before this one. Order of the array = order of execution ("pre-requests can be reordered by dragging" [DOC https://docs.thunderclient.com/features/request-chaining]).
- `triggerCondition` values seen: `run-always` (54), `run-once` (2), `run-var-value` (1) with `triggerValue: "{{token}}=1"`. The docs say the supported condition operators are `= != <= < >= > *= ^= $=` (contains, startsWith, endsWith) and the feature is paid-only. So `triggerValue` is `"<expr><op><value>"` form.
- It works at request, folder and collection level. The collection-level form appears under `settings.preReq` in a real file. Folder-level `settings.preReq`: UNCONFIRMED.
- `reqId` may point at a request in another collection (`colId` differs). The importer must resolve through its own id map after creating all requests, and drop or warn on dangling ids. A GitHub issue notes pre-run was historically lost on import (#974 https://github.com/thunderclient/thunder-client-support/issues/974).
- `inlineScripts` inside `preReq`: `[{ "script": ["line1","line2"] }]`, script text as an array of lines.

### 6.2 `postReq` [REAL]

Only key seen: `inlineScripts` (267 of 267):

```json
"postReq": { "inlineScripts": [ { "script": [
  "var json = tc.response.json;",
  "tc.setVar(\"token\", json.authtoken);" ] } ] }
```

`script` is an array of lines. Join with `\n`. A script that is a single line is still an array. Collection and folder level script placement: UNCONFIRMED in real files (docs say they exist: https://docs.thunderclient.com/scripting). Scripting is a paid feature.

### 6.3 Script API

JavaScript with a global `tc` object. Full list in https://docs.thunderclient.com/scripting/api:
`tc.getVar`, `tc.setVar(name, value, "local"|"global"|"request")`, `tc.replaceVars`, `tc.setParam`, `tc.request.{id,name,url,method,headers,body,auth,getHeader,setHeader,setBody}`, `tc.request.url.{getParam,setParam}`, `tc.response.{status,time,size,contentType,json,text,headers,cookies,getHeader,getBinary,passed}`, `tc.info.*`, `tc.test(name, fn)`, `tc.runRequest(id)`, `tc.retryRequest()`, `tc.skipRequest(id)`, `tc.loadModule`, `tc.loadFromPath`, `tc.readFile`, `tc.exec`, cookie helpers, `tc.delay`, `tc.chartHTML`. Types: https://github.com/thunderclient/thunder-client-support/blob/master/docs/tc-types.d.ts (referenced from release notes; I read the docs page, not the d.ts).

Because the API is TC-specific, an importer cannot run these scripts as-is. It should carry the text over as a comment or a "needs rewrite" note.

### 6.4 Script files

Scripts can `require("thunder-tests/<file>.js")` workspace-relative paths (Git Sync) or absolute paths. [DOC https://docs.thunderclient.com/scripting/import-files]. Custom filters are JS files attached in collection settings (deprecated in favour of import files) [DOC]. There is no `scripts` array of file paths in any sampled `settings`. UNCONFIRMED how/where attachment paths are stored.

---

## 7. Environments

### 7.1 Environment export (shape B) [REAL]

Three real variants, by era:

```jsonc
// 2021 to 2024-03, version 1.0, marker "client", no ids
{ "client": "Thunder Client", "environmentName": "my env",
  "dateExported": "2024-04-10T04:57:54.728Z", "version": "1.0",
  "variables": [ {"name":"client_id","value":"05e5...","secret":true}, {"name":"DOMAIN","value":"https://example.com"} ] }

// global environment export: same, plus "global": true
{ "client": "Thunder Client", "environmentName": "(Global Env)", "dateExported": "...", "version": "1.0",
  "global": true, "variables": [ ... ] }

// 2024-04 onward, version 1.2
{ "clientName": "Thunder Client", "environmentId": "410b4444-5876-44f9-9451-acfed6db415e",
  "environmentName": "...", "dateExported": "...", "version": "1.2", "ref": "rYrCjTp0rBiaCP...",
  "global": true, "local": true,                      // only on the global/local env
  "variables": [ {"name": "url", "value": "http://0.0.0.0:9000"} ] }
```

Sources: issue #1535 https://github.com/thunderclient/thunder-client-support/issues/1535 (1.0 import example including `secret`), and real exports in https://github.com/aneachi/pi-aneachi-backend, https://github.com/AhmedAdelFahim/restaurant-management-system (1.2 with `ref`).

Counts over genuine envs: `client`+1.0: 9; `clientName`+1.2+`ref`: 8.

- **Export of a single env** produces one file per environment: `thunder-environment_<name>.json` ("thunder-environment_(Local Env).json" for the `(Local Env)` name).
- **"All environments" export:** I found no real sample of a combined file. Real data shows only one env per file. Whether TC writes a multi-env file or several files: UNCONFIRMED. The release notes mention "Import multiple/bulk collections or environment files" (#62, v1.x), which suggests bulk = several files at import time, not a combined file. Postman global-env import was added in v2.38.3. The `environments`, `env` and `data`-keyed files in the corpus were hand-written or generated (no `ref`, no `environmentId`) and are **not** TC output.
- Env variable keys in genuine files: `name`, `value`, and `secret` (bool) when set. Never `isSecret`, never `isDisabled`. **Hand-built fixtures with `isSecret` exist; do not detect on it.**
- When exporting, TC has an option to remove secret values: "Option to Remove Secret Values when Exporting Environment" (v2.25.0) [DOC release notes]. Expect `secret: true` with an empty `value` in such files.

### 7.2 On-disk environment [REAL]

See 3.4. Variables are in `data`, not `variables`. This is the main field-name difference between export (`variables`) and disk (`data`). Variable objects are the same.

Encrypted environments (Enterprise, v2.35.3, 2025-07) [DOC release v2.35.3 https://github.com/thunderclient/thunder-client-support/releases/tag/v2.35.3]:

```json
{ "name": "color", "value": "red", "secret": true }                                   // Free/Starter/Business: plain text
{ "name": "color", "value": "F4cuC3C1bmjrhpbG0uDj8A", "secret": true, "encrypted": true }  // Enterprise: encrypted
```

An importer cannot decrypt `encrypted: true` values (key not in the file). Import such a variable with an empty value, flagged secret, and tell the user.

Secret managers (Azure Key Vault, AWS Secrets Manager) are fetched at runtime with the normal `{{variable}}` syntax [DOC https://docs.thunderclient.com/features/environments/secret-managers]. Whether the env file stores a secret-manager reference and in what field: UNCONFIRMED.

### 7.3 Scoping and precedence [DOC]

Global, Local, `.env` file, Active, collection-attached, collection variable, request variable. Lowest to highest: OS variables, Global, Local, .env files, Active environment, collection-attached environment, collection and request variables. https://docs.thunderclient.com/features/environments

Collection-attached env: `settings.envId` on the collection (section 2.4). Project-level environments: not in the docs I read.

---

## 8. Variable syntax

- Basic: `{{name}}` in URL, params, headers, body, auth fields, tests. [DOC https://docs.thunderclient.com/features/environments]
- Path variable: `{name}` in the URL (single braces), values from `params` with `isPath: true`. [DOC https://docs.thunderclient.com/features/path-variables]
- System (dynamic) variables with a `#` prefix [DOC https://docs.thunderclient.com/features/system-variables]:
  - `{{#guid}}`, `{{#name}}`, `{{#string}}`, `{{#email}}`, `{{#bool}}`
  - `{{#number}}` (1 to 1,000,000) and `{{#number, min, max}}`
  - `{{#enum, a, b, c}}`
  - `{{#date}}` (Unix ms), `{{#date, 'YYYY-MM-DD hh:mm:ss:fff'}}`, `{{#date, 'X'}}` (Unix seconds), offsets: `{{#date, {year: -1, day: 3, mon: 5}}}` and `{{#date,'YYYY-MM-DD', {year: -1}}}`. Offset keys `year, mon, day, hour, min, sec`.
  - `{{#dateISO}}` and `{{#dateISO, {year: 1}}}`
  - Arguments are comma-separated inside the braces.
  - `{{#date, ...}}` mixes a quoted format and an object, so a naive comma split breaks. Parse braces and quotes.
- Filters: `{{variable | filter1 | filter2(arg)}}`, no variable: `{{@ | filter}}`, in tests: `json.items | filter`. [DOC https://docs.thunderclient.com/scripting/filters]. Built-ins: `at, abs, add, atob, btoa, exec (paid), first, filter, format, hash, hmac, isEmail, isUrl, join, last, length, lower, map, multiply, parseJSON, prop, readFile (paid), removeQuotes, removeSpaces, replace, setIfValue, setNull, slice, split, stringify, substring, subtract, unique, upper, urlEncode, urlDecode`. Real file uses `{{csrf_token | urlDecode}}`.
- `{{var, local}}` / `{{var, global}}`: scope suffix, **only on the target side of a `set-env-var` test** [DOC https://docs.thunderclient.com/testing/set-env].
- Secure/masked: `{{secure:name}}` was **requested** in issue #1468 and rejected in favour of a CLI flag; it is not a TC syntax. https://github.com/thunderclient/thunder-client-support/issues/1468
- OS environment variables are readable through `{{NAME}}` [DOC].
- No `{{$name}}` style. The `#` prefix is TC's.

---

## 9. Other request kinds

| Kind | Status |
|---|---|
| GraphQL | `body.type: "graphql"` with `graphql.query` and `graphql.variables` (string). [REAL] |
| SSE | `reqType: "sse"`, plain GET fields. [REAL one sample] |
| WebSocket | Exists since v2.19.0 [DOC]. Stored shape UNCONFIRMED. |
| gRPC | Beta since v2.37.0 [DOC]. Stored shape UNCONFIRMED. |
| Docs tab | `docs` markdown string [REAL] (array in v2.39.3+ [DOC]) |

---

## 10. Realistic samples

All values below are invented. **Structure is reconstructed from the real files named in each header.** They are not byte-for-byte copies. IDs shortened.

### 10.1 Collection export (v1.2), nested folder, folder auth, JSON POST, formdata with file, GraphQL, tests

Structure: Gamersworld.Gateway export (envelope), iNoteBook export (set-env-var, postReq, baseUrl), food-oasis/framgia files (formdata, bearer folder settings), the folder-settings shapes from real files `{"settings":{"auth":{"type":"bearer","bearer":"..."}}}`, Chattum (array `raw`).

```json
{
  "clientName": "Thunder Client",
  "collectionName": "Shop API",
  "collectionId": "11111111-1111-4111-8111-111111111111",
  "dateExported": "2025-03-02T10:15:30.000Z",
  "version": "1.2",
  "folders": [
    { "_id": "f-admin",  "name": "admin",  "containerId": "", "created": "2025-03-01T09:00:00.000Z", "sortNum": 10000,
      "settings": { "auth": { "type": "bearer", "bearer": "{{adminToken}}" }, "headers": [ { "name": "X-Scope", "value": "admin" } ] } },
    { "_id": "f-orders", "name": "orders", "containerId": "f-admin", "created": "2025-03-01T09:01:00.000Z", "sortNum": 10000 }
  ],
  "requests": [
    {
      "_id": "r-create", "colId": "11111111-1111-4111-8111-111111111111", "containerId": "f-orders",
      "name": "Create order", "url": "/orders/{orderId}/items", "method": "POST", "sortNum": 10000,
      "created": "2025-03-01T09:05:00.000Z", "modified": "2025-03-01T09:06:00.000Z",
      "headers": [
        { "name": "Accept", "value": "application/json" },
        { "name": "X-Debug", "value": "1", "isDisabled": true }
      ],
      "params": [
        { "name": "orderId", "value": "42", "isPath": true },
        { "name": "dryRun", "value": "true", "isPath": false, "isDisabled": true }
      ],
      "body": { "type": "json", "raw": "{\n  \"sku\": \"{{#string}}\",\n  \"qty\": {{#number, 1, 5}}\n}", "form": [] },
      "tests": [
        { "type": "res-code",  "custom": "", "action": "equal", "value": "201" },
        { "type": "json-query", "custom": "json.id", "action": "istype", "value": "string" },
        { "type": "set-env-var", "custom": "json.id", "action": "setto", "value": "{{lastItemId}}" }
      ]
    },
    {
      "_id": "r-upload", "colId": "11111111-1111-4111-8111-111111111111", "containerId": "",
      "name": "Upload picture", "url": "/products/{{productId}}/picture", "method": "POST", "sortNum": 20000,
      "created": "2025-03-01T09:10:00.000Z", "modified": "2025-03-01T09:10:00.000Z",
      "headers": [],
      "body": {
        "type": "formdata", "raw": "",
        "form":  [ { "name": "caption", "value": "front view" } ],
        "files": [ { "name": "picture", "value": "../assets/front.webp" } ]
      },
      "auth": { "type": "basic", "basic": { "username": "svc", "password": "{{svcPassword}}" } }
    },
    {
      "_id": "r-gql", "colId": "11111111-1111-4111-8111-111111111111", "containerId": "",
      "name": "Product by id", "url": "/graphql", "method": "POST", "sortNum": 30000,
      "created": "2025-03-01T09:15:00.000Z", "modified": "2025-03-01T09:15:00.000Z",
      "headers": [],
      "body": { "type": "graphql", "raw": "", "form": [],
                "graphql": { "query": "query($id: ID!) { product(id: $id) { name } }", "variables": "{ \"id\": \"{{productId}}\" }" } },
      "postReq": { "inlineScripts": [ { "script": [ "var json = tc.response.json;", "tc.setVar(\"firstName\", json.data.product.name);" ] } ] },
      "preReq": { "runRequests": [ { "reqId": "r-create", "colId": "11111111-1111-4111-8111-111111111111", "triggerCondition": "run-once", "triggerValue": "" } ] }
    }
  ],
  "settings": {
    "headers": [ { "name": "Accept", "value": "application/json" } ],
    "auth": { "type": "bearer", "bearer": "{{token}}" },
    "options": { "baseUrl": "{{baseUrl}}" },
    "envId": "env-dev-0001"
  },
  "ref": "REPLACE_WITH_REAL_HASH_IGNORED_ON_READ"
}
```

Notes on this sample:
- `r-upload` has its own `basic` auth that overrides collection `bearer`.
- `r-gql` has no `auth`, so it inherits the collection bearer.
- `r-create` is in folder `f-orders` inside `f-admin`. Folder `f-admin` sets bearer `{{adminToken}}`. The nearest definition (folder) beats the collection. This is the inferred rule, section 2.5.
- Pre-request chaining `runRequests` is always by request `_id`.

### 10.2 Environment export, v1.2, with a secret

Structure: restaurant-management-system / pi-aneachi-backend exports (envelope, `environmentId`, `ref`), `secret` from issue #1535.

```json
{
  "clientName": "Thunder Client",
  "environmentId": "22222222-2222-4222-8222-222222222222",
  "environmentName": "Staging",
  "dateExported": "2025-03-02T10:20:00.000Z",
  "version": "1.2",
  "ref": "REPLACE_WITH_REAL_HASH_IGNORED_ON_READ",
  "variables": [
    { "name": "baseUrl", "value": "https://staging.example.com/api" },
    { "name": "apiKey",  "value": "s3cr3t", "secret": true }
  ]
}
```

Global environment export adds `"global": true` and (for the local variant) `"local": true`. Name `(Global Env)`.

### 10.3 Disk environment (v3) with `.env` link and encrypted secret

Structure: food-oasis `tc_env_server-env-file.json` (envFile), framgia `tc_env_global.json`, v2.35.3 release notes (`secret`/`encrypted`).

```json
{
  "_id": "7125f331-2265-4a91-be18-62faf5aba81d",
  "name": "Server Env File",
  "default": true,
  "sortNum": 30000,
  "created": "2022-11-18T03:07:15.325Z",
  "modified": "2022-11-18T03:30:59.496Z",
  "data": [ { "name": "color", "value": "F4cuC3C1bmjrhpbG0uDj8A", "secret": true, "encrypted": true } ],
  "envFile": "..\\server\\.env"
}
```

(The real `envFile` sample had `data: []`. Combining `data` with `envFile`, as shown, is my illustration.)

### 10.4 Disk collection (v3), start of `tc_col_auth.json`

Real structure (framgia/sph-flutter), shortened:

```json
{
  "_id": "a5036bd1-cef7-436a-9e09-dd470ffd7f93", "colName": "Auth",
  "created": "2023-07-14T02:55:20.471Z", "sortNum": 5000, "folders": [],
  "requests": [ { "_id": "ce1013c0-...", "colId": "a5036bd1-...", "containerId": "", "name": "login",
    "url": "{{login}}", "method": "POST", "sortNum": 20000, "created": "...", "modified": "...",
    "headers": [ { "name": "Accept", "value": "application/json" } ], "params": [],
    "body": { "type": "formdata", "raw": "", "form": [ { "name": "email", "value": "a@b.c" } ] },
    "tests": [ { "type": "set-env-var", "custom": "json.data.token", "action": "setto", "value": "{{token}}" } ] } ]
}
```

---

## 11. Third-party importers: what not to trust

I read these to cross-check, and they disagree with real data in places.

| Source | Problem |
|---|---|
| Restbro `thunder-client.ts` https://github.com/shivam96anand/restbro-app | Environment shape `{name, data:[...]}` plus `clientName`: matches **disk** env, not an export (exports use `environmentName` + `variables`). Assumes `apikey` auth. |
| Daakia `thunder-importer.ts` https://github.com/salilvnair/daakia | Flat `auth.username/password`, `apikey`, `addTo`, `preReqScript` string, `tests` string: none of this is real TC output. |
| Nouto `ThunderClientImportService.ts` https://github.com/frostybee/nouto | Uses `colName` for exports and lists `apikey`, `digest`, `ntlm` auth, `auth.oauth2.tokenUrl` (OK) and `aws.accessKey` (wrong, real is `accessKeyId`). |
| thun2bru https://github.com/eltNEG/thun2bru | `body.form` typed as strings, requires `ref` as a string. Minimal. |
| noir (OWASP) `thunder_client.cr` https://github.com/owasp-noir/noir | Correct on `_id`, `containerId`, `isPath`, handles both array and object forms. Useful. |
| reqweave exporter https://github.com/aks-builds/reqweave | Invents `res-header` and `env` field names (`environmentName`/`data`). Not TC output. |
| Fetch Client `thunderClient_1_2_types.ts` and importer https://github.com/Ganesan-Chandran/vscode-fetch-client | Most faithful to real 1.2 exports. Handles array `raw`, `binary`, `files`, `bearerPrefix`, `aws.accessKeyId`, "no auth means inherit". Still maps only `client_credentials` and `password` OAuth. |
| apiome fixtures https://github.com/apiome/apiome (apiome-ui/examples/thunder-client) | Synthetic. The README's claims (e.g. `isSecret`, `res-time`, `containerId` chain) are partly invented. Use only for test ideas. |
| api-evangelist schemas | Auto-generated, `isSecret` wrong. |

Bruno's repo has no TC importer in code search. I did not find a Postman/Hoppscotch converter for TC that reads TC files other than the above. TC itself exports to Postman and OpenAPI (OpenAPI paid) [DOC https://docs.thunderclient.com/features/import], so the Postman path is an alternative the user can use.

---

## 12. Riskiest mapping questions for an importer

1. Two marker keys: `client` and `clientName`; versions 1.0/1.1/1.2 are not strictly era-bound.
2. `body.raw` string vs array of lines (v2.39+); `docs` string vs array.
3. Auth inheritance: absent `auth` means inherit; no `inherit` literal in real data; folder vs collection merge for headers unverified.
4. Collection `settings.options.baseUrl` with relative request URLs: join rule unverified.
5. `set-env-var` source expression mini-language (`json.`, `header.`, `cookie.`, `text`, `delete`, `null`, filter chains, `, local|global` target).
6. Header tests store the header name in `type`; JSON-schema tests and many UI actions unobserved.
7. `preReq.runRequests` references by `_id` across collections, with `run-once` / `run-var-value` conditions and paid-only status.
8. Secrets: `secret`/`encrypted` flags, plain tokens in `auth`, `ref` integrity hash, and TC's own scripts (`tc.*`) not portable.
9. File paths in `formdata.files[].value` and `binary` are machine-local and often relative.
10. v4 on-disk layout and WebSocket/gRPC request shapes are unknown.

## 13. Confidence

- **High** (hundreds of genuine samples): the collection/env export envelope, folder and request keys, `params`, `headers`, JSON/formdata/formencoded/binary/graphql bodies, bearer/basic/oauth2/aws/ntlm shapes, declarative test row shapes, `postReq.inlineScripts`, `preReq.runRequests`, v3 `tc_col_*`/`tc_env_*` and the four legacy files.
- **Medium**: auth inheritance semantics, `baseUrl` behaviour, `local`/`default` env flags, array `raw` details, sse `reqType`. Inferred from data and bug reports, not a spec.
- **Low / UNCONFIRMED**: v4 file layout, WebSocket and gRPC request shapes, `ref` algorithm, "all environments" export format, folder-level scripts, the key storing custom filter file paths, `clientAuth` other values, the full list of test actions, the interplay of `docs` array form.

The field list is built from observation, not a schema: a field absent from my ~480-file sample may still exist (paid-only features like OAuth refresh, scripting at folder level, and anything added after 2026-02 are the likeliest gaps). Parse permissively, preserve unknown keys, and warn rather than fail.

## 14. Primary URLs

- Docs index https://docs.thunderclient.com ; pages used: `/features/import`, `/features/environments`, `/features/system-variables`, `/features/path-variables`, `/features/auth`, `/features/request-chaining`, `/testing/set-env`, `/scripting`, `/scripting/api`, `/scripting/filters`, `/scripting/import-files`, `/scripting/custom-filters`, `/team`, `/` (storage location).
- Support repo https://github.com/thunderclient/thunder-client-support : releases (v2.19.0, v2.23.0, v2.25.0, v2.35.3, v2.37.0, v2.39.0), issues #381, #443, #503, #974, #1468, #1507, #1535, #1571, #1728.
- MCP server (only runs the `tc curl` CLI; no format information) https://github.com/thunderclient/thunderclient-mcp
- Real sample repos: https://github.com/vancityAyush/inotebook, https://github.com/buraksenyurt/DistributedChallenge, https://github.com/framgia/sph-flutter, https://github.com/hackforla/food-oasis, https://github.com/TheLion-ai/Chattum, https://github.com/aneachi/pi-aneachi-backend, https://github.com/AhmedAdelFahim/restaurant-management-system
