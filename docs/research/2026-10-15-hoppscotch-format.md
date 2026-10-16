# Hoppscotch export formats: importer research

Research date 2026-10-15. Primary source: `hoppscotch/hoppscotch` pinned to tag **2026.9.0** (commit `63273f8e599e73f0fb38c0739314e8d46b6bc83d`, also the `main` head when checked; latest release 2026.9.0, published 2026-09-30).
Base for all source links: `https://github.com/hoppscotch/hoppscotch/blob/2026.9.0/` (abbreviated `SRC/` below). `DATA/` = `SRC/packages/hoppscotch-data/src/`, `COMMON/` = `SRC/packages/hoppscotch-common/src/`.
Docs: https://docs.hoppscotch.io (llms index https://docs.hoppscotch.io/llms.txt). Anything not confirmed is marked **UNCONFIRMED**. Samples were reconstructed from the zod schemas and cross-checked against real CLI test fixtures (`SRC/packages/hoppscotch-cli/src/__tests__/e2e/fixtures/{collections,environments}/`).

Current latest schema versions (from `DATA/rest/index.ts`, `DATA/collection/index.ts`, `DATA/graphql/index.ts`, `DATA/environment/index.ts`):

| Entity | latest | type of `v` |
|---|---|---|
| Collection (`HoppCollection`) | 12 | **number** |
| REST request (`HoppRESTRequest`) | 17 | **string** (`"17"`) |
| GraphQL request (`HoppGQLRequest`) | 10 | **number** |
| Environment | 2 | number |
| Global environment (internal, not a file format) | 2 | number |
| Saved REST response example | 0 (no `v` in file) | n/a |
| Saved response `originalRequest` (REST) | 6 | string |
| Saved response `originalRequest` (GQL) | 1 | string |

The string-vs-number split for `v` is real and load-bearing: REST requests use `z.string().regex(/^\d+$/)` for `v` (`DATA/rest/index.ts`), collections/GQL/env use `z.number()`. An importer should accept both spellings defensively; real files only use the canonical one.

---

## 1. Detection markers

The Hoppscotch app does not sniff file type: the user picks the source ("Import from Hoppscotch", Postman, Insomnia, OpenAPI, HAR) and `hoppRESTImporter` just JSON-parses and validates (`COMMON/helpers/import-export/import/hopp.ts`, `importers.ts`). An importer in another tool must sniff.

### Hoppscotch collection file (REST and GraphQL, same container)
- Top level: a JSON **array** of collections (what the app exports: `myCollectionsExporter`, `teamCollectionsExporter`, `gqlCollectionsExporter` all `JSON.stringify` an array) **or** a single collection object. The importer wraps a single object into an array (`makeCollectionsArray`, hopp.ts). Exporting one collection from the UI is also an array or single object: UNCONFIRMED which; accept both.
- Collection object keys: `name` (string), `folders` (array), `requests` (array), plus on v>=2 `auth` and `headers`; v>=10 `variables`; v>=11 `description`; v>=12 `preRequestScript`, `testScript`. Optional `v` (number), `id` (string, present in team exports and some personal ones), `_ref_id` (stripped on export since requests/collections are stringified with `stripRefIdReplacer`, but present in some fixtures, e.g. `collection-with-variables.json`).
- Strong marker: object has `folders` (array) AND `requests` (array) AND `name`, with no `info`/`item` (Postman), no `_type`/`resources` (Insomnia).
- **Legacy collections have no `v`** (only `name`, `folders`, `requests`). `HoppCollection.getVersion` returns `null` for them and the app falls back to `translateToNewCollection` (`DATA/collection/index.ts`), which defaults missing `auth` to `{authType:"inherit",authActive:true}`, `headers`/`variables` to `[]`, `description` to null, scripts to `""`.
- Request discrimination inside `requests[]` (`DATA/collection/index.ts`, `isGQLRequest`, `isRESTRequest`):
  - GraphQL request: has `query` and `url`, has **no** `endpoint`. `v` is a number (1..10).
  - REST request: has `endpoint` and `method`. `v` is a string `"1"`..`"17"`; a **v0** REST request has neither `v` nor `endpoint` but has `url`, `path`, `contentType` (see below), so v0 requests also have `url` but no `query`.
- Request-level markers: `auth.authType`, `auth.authActive`, `body.contentType` + `body.body`, `params[]`/`headers[]` with `key,value,active`, `requestVariables`, `preRequestScript`, `testScript`.
- Mixed REST+GQL in one collection is allowed ("unified collections": `mixed-rest-gql-coll.json` fixture).

### Hoppscotch environment file
- Array of environment objects or a single object (`hoppEnvImporter` wraps via `safeParseJSON(str, true)`; `COMMON/helpers/import-export/import/hoppEnv.ts`). Personal/team "export all" writes an **array** (`environmentsExporter`; filename `hoppscotch-personal-environments.json` / `hoppscotch-team-environments.json`, ImportExport.vue); single-env export writes one object (`COMMON/helpers/import-export/export/environment.ts`, filename `<env name>.json`).
- Object keys: `name`, `variables[]` and (v>=1) `v`, `id`. Variable keys `key` plus either `value` (v0/v1) or `initialValue`/`currentValue` (v2), `secret`.
- Distinguish from Postman env (`values[]`, `_postman_variable_scope`), Insomnia env (`_type`/resources or `data`): Hoppscotch uses `variables`, not `values`.

### Not Hoppscotch (for contrast; **general knowledge, not from Hoppscotch source, UNCONFIRMED here**)
- Postman: `info._postman_id`/`info.schema`, `item[]`. Postman env: `values[]`.
- Insomnia: `_type`, `__export_format`, `resources[]`.
- Thunder Client: `client: "Thunder Client"`, `collectionName`, `colId`, `containerId`.
- OpenAPI: `openapi`/`swagger`, `paths`. HAR: `log.entries`.

Rule of thumb that cleanly separates Hoppscotch: (array of) object(s) with `name`+`folders`+`requests`, where requests carry `endpoint`+`method`+`auth.authType` or `url`+`query`.

---

## 2. Collection structure and version history

### 2.1 Structure
Source: `DATA/collection/v/1.ts` ... `12.ts`.
- Tree: `folders[]` are themselves full collection objects (same schema, same `v`), arbitrarily nested; `requests[]` hold requests. Folders and collections are the same type; the app calls top-level ones "collections".
- Ordering: array order in `folders` and `requests` is the display order. For team exports the backend sorts by `orderIndex asc` (`SRC/packages/hoppscotch-backend/src/team-collection/team-collection.service.ts`, `exportCollectionToJSONObject`). Root collections in team exports are `findMany` with **no** orderBy (service.ts `exportCollectionsToJSON`): root order is UNCONFIRMED.
- Collection `auth` is `HoppRESTAuth | HoppGQLAuth` union; default `{ "authType": "inherit", "authActive": true }`. A request with `auth.authType = "inherit"` uses the nearest ancestor folder/collection whose auth is not `inherit`. For the root collection `inherit` means "no auth" (UI behaviour: UNCONFIRMED in source; docs confirm inheritance, https://docs.hoppscotch.io/documentation/features/collections.md).
- Collection/folder `headers` (v>=2): array of `{key,value,active,description}` (description from v3). Child headers are added to request headers. Docs: "headers stay unchanged" on inherit. Precedence between conflicting keys is UNCONFIRMED.
- `variables` (v>=10): `[{key, initialValue, currentValue, secret}]` (`CollectionVariable`, `DATA/collection/v/10.ts`). Docs: collection scope beats environment and global in resolution (variables.md).
- `description` (v>=11): string or null. `preRequestScript`, `testScript` (v>=12): strings. The collection-level script cascade runs root -> folder -> request (CLI fixture `collection-level-scripts-coll.json`).

### 2.2 Collection versions (`DATA/collection/v/N.ts`)

| v | Change |
|---|---|
| (none) | Legacy: `name`, `folders`, `requests` only; no `v`. Handled by `translateToNewCollection`. |
| 1 | `{v:1, id?, name, folders[], requests[]}`. |
| 2 | Adds `auth` (REST v5 / GQL v5 auth union) and `headers` (`{key,value,active}`); migration sets inherit + `[]`. |
| 3 | AWS Signature auth added to union; header `description` added. |
| 4 | Digest auth added (REST auth v8, GQL v7). |
| 5 | `_ref_id` (optional string) added. |
| 6 | OAuth2 client-credentials gets `clientAuthentication` (`IN_BODY` default). |
| 7 | HAWK, Akamai EdgeGrid auth added. |
| 8 | JWT auth added. |
| 9 | OAuth2 advanced params (`authRequestParams`, `tokenRequestParams`, `refreshRequestParams`, `tokenType`). Fixture shows v9 era files exist. |
| 10 | `variables` added (`key, initialValue, currentValue, secret`). First commit touching file: 2025-08-22. |
| 11 | `description` (nullable). 2025-11-25. |
| 12 | `preRequestScript`, `testScript`. 2026-04-27. |

(Dates are the date of the earliest commit touching that path via the GitHub commits API; approximate for the release mapping. Release 2025.7.0 shipped 2025-07-30, 2025.8.0 on 2025-08-28, 2025.11.0 on 2025-11-27.)

Migration is per level: a folder can be an older `v` than... in practice an export has one `v` at every level, but `entityRefUptoVersion` migrates each folder separately, and the fixtures `coll-v1-req-v1.json`, `valid-mixed-versions-coll.json`, `invalid-mixed-versions-coll.json` show mixed-version trees. An importer must read `v` per object at every level and per request.

Requests inside a collection are validated against **their own** `v`, independent of the collection `v` (e.g. `multipart-form-data-coll.json`: collection `v:3`, request `v:"7"`; `collection-with-variables.json`: collection `v:10`, request `v:"15"`).

---

## 3. REST request fields and version history

Source: `DATA/rest/v/*`, `DATA/rest/index.ts`. Latest = 17.

Latest-shape keys: `v`, `name`, `method`, `endpoint`, `params`, `headers`, `preRequestScript`, `testScript`, `auth`, `body`, `requestVariables`, `responses`, `_ref_id?`, `description`. Persisted copies may also have `id` (string; Firestore/team id).

### 3.1 Version table

| v | Change | Source |
|---|---|---|
| 0 | No `v`. Keys: `url`, `path`, `headers[{key,value,active}]`, `params[...]`, `name`, `method`, `preRequestScript`, `testScript`, `contentType`, `body` (string), optional `rawParams`, `auth` (string: `"None"`, `"Basic Auth"`, `"Bearer Token"`), `httpUser`, `httpPassword`, `bearerToken`, `id`. | `rest/v/0.ts` |
| 1 | `endpoint = url + path`. `body` -> `{contentType, body}`. `auth` -> `{authType, authActive, ...}`. Migration: body is `application/json` carrying `rawParams` only if old `contentType` was JSON, else `""` (any other old content type's body is lost); unknown old auth -> none. | `rest/v/1.ts` |
| 2 | `requestVariables: [{key,value,active}]` (default `[]`). | `rest/v/2.ts` |
| 3 | OAuth2 restructured: `grantTypeInfo` discriminated by `grantType` (`AUTHORIZATION_CODE`, `CLIENT_CREDENTIALS`, `PASSWORD`, `IMPLICIT`) + `addTo` (`HEADERS`/`QUERY_PARAMS`). Old flat oauth fields become an `AUTHORIZATION_CODE` grant (`authURL`->`authEndpoint`, `accessTokenURL`->`tokenEndpoint`, `scope`->`scopes`, `isPKCE:false`). | `rest/v/3.ts` |
| 4 | API-key `addTo` becomes enum `HEADERS`/`QUERY_PARAMS` (old free text `"Headers"`/`"Query params"`; anything not `"Query params"` -> `HEADERS`). | `rest/v/4.ts` |
| 5 | Authcode `clientSecret` optional. | `rest/v/5.ts` |
| 6 | Body content type `text/xml` added. | `rest/v/6.ts` |
| 7 | `description` on every param and header (default `""`); `refreshToken` on authcode grant; `aws-signature` auth. | `rest/v/7.ts` |
| 8 | `responses` (saved examples) record; `digest` auth; client-credentials/password `clientSecret` optional. | `rest/v/8/` |
| 9 | Body: `application/octet-stream` (File body) added; multipart entries gain optional `contentType`; `showIndividualContentType`. Literal `"binary"` also in content-type union. | `rest/v/9/body.ts` |
| 10 | Body: multipart `isBulkEditing`; urlencoded gets `isBulkEditing` (UI bulk-edit flag, ignorable). | `rest/v/10/body.ts` |
| 11 | OAuth2 client-credentials `clientAuthentication`: `AS_BASIC_AUTH_HEADERS` or `IN_BODY` (migration: `IN_BODY`). | `rest/v/11/` |
| 12 | `hawk` and `akamai-eg` auth. | `rest/v/12/auth.ts` |
| 13 | `jwt` auth. | `rest/v/13/auth.ts` |
| 14 | No request-shape change (saved-response schema migration only). | `rest/v/14.ts` |
| 15 | OAuth2 advanced params (`authRequestParams`, `tokenRequestParams`, `refreshRequestParams`, `tokenType`). | `rest/v/15/auth.ts` |
| 16 | `_ref_id` (optional string; migration generates `req_<ts36>_<uuid>`). | `rest/v/16.ts` |
| 17 | `description` (string or null; `null` default). | `rest/v/17.ts` |

Approximate first-commit dates (commits API): v7 file 2024-08-27; v15 2025-07-28; v16 2025-09-23; v17 2025-11-25. For v8/v12/v13 the API reports 2025-06-13, which looks like a file-move commit (UNCONFIRMED real date).

### 3.2 Fields (latest)
- `method`: free-form string (not an enum in schema): `"GET"`, `"POST"`, ... (custom methods allowed).
- `endpoint`: full URL string, may contain `<<var>>` and may contain a query string already; `params` are additional/duplicate representations (the app composes endpoint + active params at send time; whether exports keep the query in `endpoint`: UNCONFIRMED, fixtures show empty `endpoint` query with `params` populated).
- `params[]`, `headers[]`: `{key, value, active, description}`; `active:false` means disabled, keep the row. Decoding falls back (`.catch`) to `key:""`, `value:""`, `active:true`, `description:""`.
- `body` union (`rest/v/10/body.ts`), `contentType` values:
  - `null` with `body: null` (no body)
  - `application/json`, `application/ld+json`, `application/hal+json`, `application/vnd.api+json`, `application/xml`, `text/xml`, `text/html`, `text/plain`, and legacy literal `binary`: `body` is a string.
  - `application/x-www-form-urlencoded`: `body` is a **string** (a newline-separated `key: value` text, with `#` prefix for disabled lines per the app's bulk editor: **UNCONFIRMED**, the schema only says string; no structured array). Optional `isBulkEditing`.
  - `multipart/form-data`: `body` is an array of `{key, active, isFile, value, contentType?}`; text: `isFile:false`, `value:string`; file: `isFile:true`, `value:[Blob|null]`. Optional `showIndividualContentType`, `isBulkEditing`.
  - `application/octet-stream`: `body` is a `File` or null.
  - Known content types list: `DATA/rest/content-types.ts`. Note `graphql`/`application/graphql` are not REST body types.
- **Files are not exported.** A `File`/`Blob` stringifies to `{}`, so multipart file entries appear as `"isFile": true, "value": [{}]` (confirmed in fixture `multipart-form-data-coll.json`) and the app then treats them as text entries with `""` when the schema's `.catch([])` + transform runs (`rest/v/9/body.ts`; comments in `COMMON/helpers/experimental-sandbox-integration.ts`). An octet-stream body would export as `{}`/null (derived from the schema, no fixture: UNCONFIRMED). Importer: file name/path is not available; produce a placeholder.
- `auth`: object `{authType, authActive, ...}`; `authActive` is a boolean (false = auth disabled). Types at v17:
  - `none`; `inherit` (only the two common keys)
  - `basic`: `username`, `password`
  - `bearer`: `token`
  - `api-key`: `key`, `value`, `addTo` (`HEADERS` | `QUERY_PARAMS`)
  - `oauth-2`: `addTo` (`HEADERS`|`QUERY_PARAMS`) + `grantTypeInfo`:
    - `AUTHORIZATION_CODE`: `authEndpoint`, `tokenEndpoint`, `clientID`, `clientSecret?`, `scopes?`, `token`, `isPKCE`, `codeVerifierMethod?` (`plain`|`S256`), `refreshToken?`, `authRequestParams[]`, `tokenRequestParams[]`, `refreshRequestParams[]`, `tokenType?` (`access_token`|`id_token`)
    - `CLIENT_CREDENTIALS`: `authEndpoint` (this is the token URL for this grant), `clientID`, `clientSecret?`, `scopes?`, `token`, `clientAuthentication` (`AS_BASIC_AUTH_HEADERS`|`IN_BODY`), `tokenRequestParams[]`, `refreshRequestParams[]`, `tokenType?`
    - `PASSWORD`: `authEndpoint`, `clientID`, `clientSecret?`, `scopes?`, `username`, `password`, `token`, `tokenRequestParams[]`, `refreshRequestParams[]`, `tokenType?`
    - `IMPLICIT`: `authEndpoint`, `clientID`, `scopes?`, `token`, `authRequestParams[]`, `refreshRequestParams[]`, `tokenType?`
    - advanced param: `{id:number, key, value, active, sendIn:"headers"|"url"|"body"}`; `authRequestParams` entries omit `sendIn`.
    - OIDC discovery URL existed only in v1/v2 flat shape (`oidcDiscoveryURL`); dropped at v3 migration (not carried).
  - `aws-signature` (v>=7): `accessKey`, `secretKey`, `region`, `serviceName`, `serviceToken?`, `addTo`
  - `digest` (v>=8): `username`, `password`, `realm`, `nonce`, `algorithm` (`MD5`|`MD5-sess`), `qop` (`auth`|`auth-int`), `nc`, `cnonce`, `opaque`, `disableRetry`
  - `hawk` (v>=12): `authId`, `authKey`, `algorithm` (`sha256`|`sha1`), `includePayloadHash`, optional `user`, `nonce`, `ext`, `app`, `dlg`, `timestamp`
  - `akamai-eg` (v>=12): `accessToken`, `clientToken`, `clientSecret`, optional `nonce`, `timestamp`, `host`, `headersToSign`, `maxBodySize`
  - `jwt` (v>=13): `secret`, `privateKey`, `algorithm` (HS/RS/PS/ES 256/384/512), `payload` (JSON string), `addTo`, `isSecretBase64Encoded`, `headerPrefix` (default `"Bearer "`), `paramName` (default `"token"`), `jwtHeaders` (JSON string)
  - **No `ntlm`, no `oauth1`, no `negotiate`** in any version (schema union closed list; the discriminated union would reject them).
  - Stale keys: fixtures show leftover keys from a previous auth type (e.g. `authType:"none"` with `addTo`/`grantTypeInfo`). zod strips unknown keys; an importer should switch on `authType` and ignore the rest.
- `preRequestScript`, `testScript`: plain strings (JavaScript). See section 6.
- `requestVariables`: `[{key, value, active}]`; referenced with `<<name>>`. Request scope has the highest precedence (variables.md).
- `responses`: record keyed by an arbitrary string (example id/name) -> saved response `{name, originalRequest, status, code, headers[{key,value}], body}` (`DATA/rest-request-response/v/0.ts`; no `v` key written for responses). `originalRequest` is a snapshot request of its own versioning (`v:"6"` latest: `name, method, endpoint, headers, params, body, auth, requestVariables, v`; `DATA/rest-request-response/original-request/v/*.ts`; v1..v6 mirror REST body/auth changes: v2 body v9, v3 body v10+auth v11, v4 auth v12, v5 auth v13, v6 auth v15). `code` must be one of a fixed status-code list (`utils/statusCodes.ts`) else becomes null. Record keys are not guaranteed meaningful; ordering of record keys is the display order (UNCONFIRMED).
- `description`: string or null (v17), request-level documentation.
- `_ref_id`: client-side ID, stripped on export (`stripRefIdReplacer`) but present in some fixtures; `id`: server/team id. Neither should be trusted as stable identity.

---

## 4. GraphQL requests

Source: `DATA/graphql/v/1..10.ts`, `DATA/graphql/index.ts`. `v` is a **number**. Detection: has `url` and `query`, lacks `endpoint`.

Latest (v10) keys: `v`, `name`, `url`, `headers[{key,value,active,description}]`, `query` (string), `variables` (JSON **string**, e.g. `"{\n \"id\": \"1\"\n}"`), `auth`, `_ref_id?`, `description`, `responses`, `preRequestScript`, `testScript`.

| v | Change |
|---|---|
| 1 | `v, name, url, headers[{key,value,active}], query, variables`. |
| 2 | `auth` (none, basic, bearer, oauth-2 flat, api-key with free-text addTo, inherit); migration: `none`. Also `id?`. |
| 3 | OAuth2 restructured to REST v3 grant types (same migration as REST). |
| 4 | API key `addTo` enum. |
| 5 | Authcode `clientSecret` optional. |
| 6 | Header `description`; `aws-signature` auth. |
| 7 | Same OAuth2 as REST v7 (refreshToken). |
| 8 | Client-credentials `clientAuthentication`. |
| 9 | OAuth2 advanced params. |
| 10 | `_ref_id`, `description`, `responses` (GQL saved examples), `preRequestScript`, `testScript`. First commit 2026-08-28 (release 2026.8.0). |

GQL auth types: `none`, `inherit`, `basic`, `bearer`, `oauth-2` (REST v15 shape), `api-key`, `aws-signature`. **No `digest`, `hawk`, `akamai-eg`, `jwt` for GQL requests** (but a collection-level `auth` may use any REST auth since the collection union is REST|GQL).

GQL saved response (`DATA/gql-request-response/v/0.ts`): `{name, originalRequest{v:"1",name,url,query,variables,headers,auth}, status, code, headers[{key,value}], body, operationName?, operationType?}`.

GraphQL collections export through `gqlCollectionsExporter`, producing the same collection container (array of `{v,name,folders,requests,...}`) with GQL requests in `requests`. Introspection schema, operation selection, etc. are not exported. `hoppGqlCollectionsImporter` does no validation (comment "TODO: add zod validation", `import/hoppGql.ts`); newer app builds use the unified validators `validateGQLCollection`/`hoppRESTImporter`, which accept both request kinds.

---

## 5. Environments, variables, secrets

### 5.1 Syntax and resolution
- Syntax: `<<name>>` (regex `/<<([^>]*)>>/g`; `DATA/environment/index.ts`). Recursively expanded up to 10 levels; deeper = loop error. Predefined variables use `<<$name>>` (e.g. `$timestamp`, `$guid`; `DATA/predefinedVariables.ts`; docs variables.md). Postman-style `{{x}}` is NOT Hoppscotch syntax (it only appears in `pm.variables.replaceIn` in scripts).
- Precedence (docs variables.md): request > collection (incl. folders, nearest wins) > predefined > environment > global. (Code in `parseTemplateStringE` also checks predefined variables before environment ones.)
- Missing variable: resolves to `""` in templates (keeps `<<key>>` in some body paths: `keepMissingAsKey`).
- Resolved value = `currentValue || initialValue` (i.e. empty current falls back to initial; `getResolvedVariableValue`).
- Secret variables cannot be request-scoped (docs).

### 5.2 Environment versions (`DATA/environment/v/*.ts`)
- v0 (no `v`, no `id` required): `{id?, name, variables:[{key,value}]}`.
- v1: `{v:1, id, name, variables}` where variable is `{key, value, secret:false}` or `{key, secret:true}` (secrets have **no value field**).
- v2 (since ~2025-05-23): `{v:2, id, name, variables:[{key, initialValue, currentValue, secret}]}`. Migration: non-secret: both = old `value`; secret: both `""`.
- Importer behaviour in the app (`hoppEnvImporter`): numeric values are coerced to strings; entries migrated to the latest version. App-level lenient translator `translateToNewEnvironmentVariables`: `initialValue = x.initialValue ?? x.value ?? ""`, `currentValue = x.currentValue ?? x.value ?? ""`, `secret ?? false`.

### 5.3 What an export actually contains
`stripClientLocalValuesForWire` (`COMMON/helpers/clientLocalVariables.ts`), applied to every environment export and collection/folder `variables` export:
- `currentValue` is set to `""` for **all** variables;
- `initialValue` is set to `""` for **secret** variables;
- non-secret variables keep `initialValue`.
So a real export of non-secret `{key:"baseURL", initialValue:"https://x", currentValue:"https://x"}` becomes `currentValue:""`. The importer in the app then promotes `initialValue` to an empty `currentValue` (`promoteInitialValueForImport`). Secret values are **never** in exports (docs: https://docs.hoppscotch.io/documentation/features/environments confirm secrets aren't exported). Fixture `secret-envs.json` shows exactly this shape (`secret:true` with empty values; non-secret with `initialValue` set and `currentValue:""`).
- Older exports (before the strip logic) may carry `currentValue` and in v1 files no secret value at all. Treat `currentValue` as possibly populated; prefer `currentValue || initialValue`.
- Single env export object contains only `{id, v, name, variables}` (`transformEnvironmentVariables`).

### 5.4 Global environment
Not a separate file format. In the UI the global environment is a pseudo-environment `{v:2, id:"Global", name:"Global", variables}` (`COMMON/components/environments/index.vue`) and its export is the same shape as any environment, so it appears as a normal environment named `Global`. On Hoppscotch import it is just another environment (special merge into globals exists only for Insomnia's "Base Environment", `ImportExport.vue`). Internal `GlobalEnvironment` entity is `{v:2, variables}` without name/id (`DATA/global-environment/`), v0 being a bare array of variables; this is persistence-only: UNCONFIRMED whether any user-visible export ever emitted it. Heuristic: name `Global` and/or id `"Global"`.

### 5.5 Team/personal workspace environments
Personal and team "export all" produce an array of the same objects. No wrapper object and no workspace metadata.

---

## 6. Scripts

Sources: docs https://docs.hoppscotch.io/documentation/features/scripts.md; sandbox `SRC/packages/hoppscotch-js-sandbox/src/cage-modules/namespaces/{pw,hopp,pm}-namespace.ts`; fixtures `scripting-revamp-coll.json`, `collection-level-scripts-coll.json`.
- Scripts are stored as plain strings in `preRequestScript` / `testScript` on requests (REST all versions, GQL v10), and on collections/folders (v12). There is no script language marker in the file; the sandbox mode (legacy vs experimental) is an app **setting** (Settings -> Experiments), not a file property.
- **`pw.`** (legacy): `pw.env.get/getResolve/set/unset/resolve`, `pw.response.status|body|headers`, `pw.test(name, fn)`, `pw.expect(x).toBe/toBeType/toInclude/...`. Present in v0 era files and the majority of fixtures. Docs: "kept for existing scripts".
- **`hopp.`** (experimental): `hopp.env.{get,getRaw,set,delete,reset,...}` with `hopp.env.active` / `hopp.env.global` scopes, `hopp.request.*` (setters only in pre-request: `setUrl`, `setMethod`, `setHeader`, `setParam`, `setBody`, `setAuth`), `hopp.response.{statusCode,statusText,headers,responseTime,body.asJSON()/asText()/bytes()}`, `hopp.cookies.*`, `hopp.test`, `hopp.expect` (Chai-style BDD + custom). Scripts may start with `export {};` to mark module context, and support top-level `import`.
- **`pm.`** (Postman-compat): `pm.environment`, `pm.globals`, `pm.variables`, `pm.request`, `pm.response`, `pm.test`, `pm.expect`, `pm.info`, `pm.sendRequest`. Unsupported: `pm.visualizer`, `pm.collectionVariables`, `pm.iterationData`, `pm.execution.setNextRequest()`.
- Introduction: the `hopp-namespace.ts` file's earliest commit is 2025-09-24 (release line 2025.9.x); exact release: **UNCONFIRMED**. Collection/folder-level scripts: collection v12, 2026-04-27 (releases 2026.4.x).
- Mapping notes for an importer: `pw.env.set/get` has a direct analogue in other tools' environment APIs; `pw.expect(...).toBe` chain is not Chai-compatible beyond basic matchers (`toBeType`, `toInclude`, `toBeLevel2xx`-style helpers exist: **UNCONFIRMED full list**). Pass scripts through verbatim with a warning, or flag by regex on `\bpw\.`, `\bhopp\.`, `\bpm\.`.

---

## 7. Other request types and workspace-level export

- Realtime clients (WebSocket, SSE, Socket.IO, MQTT) have **no schema in `hoppscotch-data`** (only `rest`, `graphql`, `collection`, `environment`, `global-environment`, `*-request-response`, `cookies`, utils). `HoppCollection.requests` is typed as `HoppRESTRequest | HoppGQLRequest` (`collection/v/1.ts`), so realtime requests cannot be members of collection files. Whether the UI has any export for realtime history: **UNCONFIRMED** (none found). Treat as never exported.
- Other app-level exports (not collection formats): OpenAPI 3.1 export JSON/YAML (lossy: drops scripts, auth credentials, inactive items; en.json `openapi_lossy_summary`), Gist export, test-runner result exports (`runnerResults.ts`, JUnit via CLI).
- **No whole-workspace export format.** Collections and environments are exported separately. Team "export collections" calls the backend GraphQL `exportCollectionsToJSON`, then converts to the same array-of-collections shape with `teamCollectionJSONToHoppRESTColl` (`COMMON/helpers/backend/helpers.ts`, line ~193 and `getTeamCollectionJSON` ~309); the intermediate backend JSON is `{id, name, folders, requests, data}` where `data` is a JSON string holding auth/headers/variables/description/scripts, but it is converted before saving. Resulting team file differences: collections and requests carry an `id` (database id), root collection `v:12` always, and nested requests may be at any request `v`. Environments are separate (`hoppscotch-team-environments.json`).
- The import UI also offers "Import from Another Workspace" and "Import from Personal Collections" (en.json `from_all_collections`), which are in-app transfers, not files.
- A CLI collection runner (`hopp test`) reads the same collection JSON and environment JSON (fixtures dir above).

---

## 8. Samples (reconstructed from schemas; all values fictional)

### 8.1 Oldest REST collection form: v1 collection with v0 requests (confirmed by fixture `coll-v1-req-v0.json`)
```json
{
  "v": 1,
  "name": "Legacy API",
  "folders": [],
  "requests": [
    {
      "url": "https://echo.hoppscotch.io",
      "path": "/get",
      "headers": [
        { "key": "X-Old", "value": "1", "active": false },
        { "key": "Authorization", "value": "Bearer abc", "active": true }
      ],
      "params": [{ "key": "q", "value": "x", "active": true }],
      "name": "get-thing",
      "method": "GET",
      "preRequestScript": "",
      "testScript": "pw.test(\"ok\", () => { pw.expect(pw.response.status).toBe(200) })",
      "contentType": "application/json",
      "body": "",
      "auth": "Bearer Token",
      "bearerToken": "abc"
    }
  ]
}
```
Migrated result: `endpoint "https://echo.hoppscotch.io/get"`, bearer auth, JSON body `""`.

An even older still: the same without `"v"` at all (no `auth`/`headers` on the collection).

### 8.2 Current: collection v12, request v17
```json
[
  {
    "v": 12,
    "name": "Shop API",
    "description": "Root collection",
    "auth": { "authType": "bearer", "authActive": true, "token": "<<token>>" },
    "headers": [
      { "key": "X-Team", "value": "web", "active": true, "description": "" }
    ],
    "variables": [
      { "key": "baseUrl", "initialValue": "https://api.example.test", "currentValue": "", "secret": false }
    ],
    "preRequestScript": "hopp.env.set('ts', String(Date.now()))",
    "testScript": "",
    "folders": [
      {
        "v": 12,
        "name": "Orders",
        "description": null,
        "auth": { "authType": "inherit", "authActive": true },
        "headers": [],
        "variables": [],
        "preRequestScript": "",
        "testScript": "",
        "folders": [],
        "requests": [
          {
            "v": "17",
            "name": "Create order",
            "method": "POST",
            "endpoint": "<<baseUrl>>/orders",
            "params": [
              { "key": "dry_run", "value": "true", "active": true, "description": "Validate only" }
            ],
            "headers": [
              { "key": "Content-Type", "value": "application/json", "active": true, "description": "" },
              { "key": "X-Debug", "value": "1", "active": false, "description": "disabled" }
            ],
            "preRequestScript": "hopp.env.set('orderRef', 'A-1')",
            "testScript": "hopp.test('created', () => { hopp.expect(hopp.response.statusCode).toBe(201) })",
            "auth": { "authType": "inherit", "authActive": true },
            "body": { "contentType": "application/json", "body": "{\n  \"sku\": \"X-1\",\n  \"qty\": 2\n}" },
            "requestVariables": [{ "key": "sku", "value": "X-1", "active": true }],
            "description": "Creates an order",
            "responses": {
              "Created": {
                "name": "Created",
                "originalRequest": {
                  "v": "6",
                  "name": "Create order",
                  "method": "POST",
                  "endpoint": "<<baseUrl>>/orders",
                  "headers": [],
                  "params": [],
                  "body": { "contentType": "application/json", "body": "{\"sku\":\"X-1\"}" },
                  "auth": { "authType": "inherit", "authActive": true },
                  "requestVariables": []
                },
                "status": "Created",
                "code": 201,
                "headers": [{ "key": "content-type", "value": "application/json" }],
                "body": "{\"id\":42}"
              }
            }
          },
          {
            "v": "17",
            "name": "Login form",
            "method": "POST",
            "endpoint": "<<baseUrl>>/login",
            "params": [],
            "headers": [],
            "preRequestScript": "",
            "testScript": "",
            "auth": { "authType": "none", "authActive": true },
            "body": { "contentType": "application/x-www-form-urlencoded", "body": "user: alice\npass: secret" },
            "requestVariables": [],
            "description": null,
            "responses": {}
          }
        ]
      }
    ],
    "requests": [
      {
        "v": "17",
        "name": "Upload avatar",
        "method": "POST",
        "endpoint": "<<baseUrl>>/avatar",
        "params": [],
        "headers": [],
        "preRequestScript": "",
        "testScript": "",
        "auth": { "authType": "api-key", "authActive": true, "key": "X-API-Key", "value": "<<apiKey>>", "addTo": "HEADERS" },
        "body": {
          "contentType": "multipart/form-data",
          "body": [
            { "key": "caption", "value": "me", "active": true, "isFile": false },
            { "key": "file", "value": [{}], "active": true, "isFile": true }
          ]
        },
        "requestVariables": [],
        "description": null,
        "responses": {}
      },
      {
        "v": "17",
        "name": "Token via client credentials",
        "method": "GET",
        "endpoint": "<<baseUrl>>/me",
        "params": [],
        "headers": [],
        "preRequestScript": "",
        "testScript": "",
        "auth": {
          "authType": "oauth-2",
          "authActive": true,
          "addTo": "HEADERS",
          "grantTypeInfo": {
            "grantType": "CLIENT_CREDENTIALS",
            "authEndpoint": "https://auth.example.test/oauth/token",
            "clientID": "client-1",
            "clientSecret": "<<clientSecret>>",
            "scopes": "read write",
            "token": "",
            "clientAuthentication": "IN_BODY",
            "tokenRequestParams": [],
            "refreshRequestParams": []
          }
        },
        "body": { "contentType": null, "body": null },
        "requestVariables": [],
        "description": null,
        "responses": {}
      }
    ]
  }
]
```
Notes: the urlencoded body text format `key: value` per line is the app's bulk-edit format (UNCONFIRMED exact grammar, e.g. disabled-line prefix). In real exports `_ref_id` is absent; `id` may appear. The file entry `[{}]` is how a file part serializes (fixture-confirmed).

### 8.3 GraphQL collection (v1 collection, GQL v10 requests; mirrors `gql-coll.json`)
```json
[
  {
    "v": 1,
    "name": "GraphQL Only",
    "folders": [],
    "requests": [
      {
        "v": 10,
        "name": "Get user",
        "url": "https://api.example.test/graphql",
        "headers": [
          { "key": "Authorization", "value": "Bearer <<token>>", "active": true, "description": "" }
        ],
        "query": "query User($id: ID!) { user(id: $id) { id name } }",
        "variables": "{\n  \"id\": \"1\"\n}",
        "auth": { "authType": "inherit", "authActive": true },
        "description": null,
        "responses": {},
        "preRequestScript": "",
        "testScript": ""
      }
    ]
  }
]
```
(Newer builds write the collection with `v:12` and `auth/headers/variables`; a v1 container is still valid.)

### 8.4 Environment export with a secret variable (v2, as written by the current exporter)
```json
[
  {
    "id": "cm0abc123",
    "v": 2,
    "name": "Staging",
    "variables": [
      { "key": "baseUrl", "initialValue": "https://staging.example.test", "currentValue": "", "secret": false },
      { "key": "apiKey", "initialValue": "", "currentValue": "", "secret": true }
    ]
  },
  {
    "id": "Global",
    "v": 2,
    "name": "Global",
    "variables": [
      { "key": "tenant", "initialValue": "acme", "currentValue": "", "secret": false }
    ]
  }
]
```
Older: v1 `{ "v":1, "id":"x", "name":"Old", "variables":[ {"key":"a","value":"1","secret":false}, {"key":"s","secret":true} ] }`; v0 `{ "name":"Older", "variables":[{"key":"a","value":"1"}] }`.

---

## 9. Importer risk list (mapping hazards)

1. **Per-object versioning with mixed types**: REST `v` string vs collection/GQL/env `v` number; versions differ across levels in one file; legacy collections have no `v`; v0 requests have no `v` and use `url`+`path`.
2. **Secrets and values missing by design**: secret `initialValue`/`currentValue` are always empty; non-secret `currentValue` is empty in current exports (use `initialValue`). Old v1 secrets have no value property.
3. **Collection/folder-level auth, headers, variables, scripts with `inherit`**: semantics need an inheritance model; headers merge, auth falls to nearest non-inherit ancestor. Collection `variables` shadow environments.
4. **Files not exported**: multipart file parts (`value:[{}]`) and octet-stream bodies carry no path or bytes.
5. **Body encodings**: urlencoded is a text blob (not an array); `binary` and `application/octet-stream` coexist; custom content-type header vs `body.contentType` must be reconciled.
6. **Auth zoo**: 11 auth types incl. JWT/HAWK/Akamai/AWS/Digest/OAuth2 four grants with request-param lists; stale keys remain after a type change; `authActive:false` disables auth without removing it; GQL cannot use digest/hawk/akamai/jwt.
7. **Scripts in three dialects** (`pw`, `hopp`, `pm`) with no marker in the file; collection-level scripts since v12; GQL scripts since GQL v10.
8. **Saved responses** (`responses` record, REST v8+, GQL v10) with an embedded versioned `originalRequest` snapshot.
9. **Variable syntax `<<x>>`** needs translating to the target syntax, including predefined `<<$guid>>` and nested expansion; scripts use other syntaxes.
10. **Unconfirmed behaviours**: exact urlencoded text grammar, `endpoint` vs `params` duplication on export, root ordering in team exports, whole list of `pw` matchers, exact release of the `hopp.`/`pm.` sandbox, whether single-collection export is an array or an object.

## Source index (all at tag 2026.9.0)
- Versioned schemas: https://github.com/hoppscotch/hoppscotch/tree/2026.9.0/packages/hoppscotch-data/src (rest/, graphql/, collection/, environment/, global-environment/, rest-request-response/, gql-request-response/)
- Export code: https://github.com/hoppscotch/hoppscotch/tree/2026.9.0/packages/hoppscotch-common/src/helpers/import-export/export
- Import code: https://github.com/hoppscotch/hoppscotch/tree/2026.9.0/packages/hoppscotch-common/src/helpers/import-export/import
- Secret stripping: https://github.com/hoppscotch/hoppscotch/blob/2026.9.0/packages/hoppscotch-common/src/helpers/clientLocalVariables.ts
- Team export: https://github.com/hoppscotch/hoppscotch/blob/2026.9.0/packages/hoppscotch-backend/src/team-collection/team-collection.service.ts and https://github.com/hoppscotch/hoppscotch/blob/2026.9.0/packages/hoppscotch-common/src/helpers/backend/helpers.ts
- Fixtures: https://github.com/hoppscotch/hoppscotch/tree/2026.9.0/packages/hoppscotch-cli/src/__tests__/e2e/fixtures
- Docs: https://docs.hoppscotch.io/documentation/features/{scripts,collections,importer,variables,environments}.md
