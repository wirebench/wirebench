# Insomnia export formats: importer reference

Research date 2026-10-15. Read-only research; no importer code. Every fact is tied to Insomnia source (Kong/insomnia) unless flagged UNCONFIRMED.

## 0. Provenance and version pinning

- Source repo: https://github.com/Kong/insomnia . Everything below was read from `develop` at commit `19b4875499c38edb53f398dc0a7ae6f198cfbffd` (2026-10-15). All key files also exist at the latest stable tag `core@13.3.1` (commit c5e1798e4e19777c5b766c48be0af6a256070230), so the shapes are stable for current releases.
- Permalink prefix: `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/`. A path written as `S <path>` in this document means that prefix followed by `<path>`; bare `.../x.ts` continues the directory of the previous path.
- Key files (paths are real, current; the models moved out of `packages/insomnia/src/models` into a separate `insomnia-data` package):
  - v5 Zod schema (source of truth for the file format): `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia/src/common/import-v5-parser.ts`
  - v5 import + export conversion: `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia/src/common/insomnia-v5.ts`
  - v5 JSON Schema (generated from the Zod; 5 file kinds): `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/schemas/insomnia.schema.5.1.json`, `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/schemas/README.md`
  - v5 schema migrations (5.0 to 5.1): `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia/src/common/insomnia-schema-migrations/index.ts`, `.../v5.1.ts`, `.../migration.md`, `.../schema-version.ts` (`INSOMNIA_SCHEMA_VERSION = '5.1'`)
  - Import orchestration / detection / id remapping: `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia/src/common/import.ts`
  - v1..v4 importers: `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia/src/main/importers/importers/insomnia-1.ts` (and `-2`, `-3`, `-4`), registry `.../importers/index.ts`, `.../convert.ts`
  - Data models (v4 resource field shapes): `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia-data/src/models/*.ts` (request.ts, request-group.ts, environment.ts, grpc-request.ts, websocket-request.ts, websocket-payload.ts, proto-file.ts, cookie-jar.ts, unit-test.ts, unit-test-suite.ts, api-spec.ts, mock-*.ts, socket-io-request.ts, mcp-request.ts)
  - Historic v4 exporter (v4 option already gone from the export dialog by core@11.3.0): `https://github.com/Kong/insomnia/blob/core@10.0.0/packages/insomnia/src/common/export.tsx`
  - Template tags: `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia/src/common/templating/local-template-tags.ts`, `.../utils.ts`, `.../liquid-engine.ts`
  - Real example files used as ground truth: `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia-smoke-test/fixtures/*.yaml`, `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia-inso/src/examples/*.yml`, `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia/src/common/__fixtures__/insomnia-v5-roundtrip/*.yaml`

Release timeline (CONFIRMED from git trees): v5 files and `export.tsx` both exist at `core@11.0.0`; at `core@11.3.0` the export dialog only offers "Insomnia v5" and HAR (`export.tsx` line ~103); at `core@12.0.0` the old `export.tsx` is gone. So: **current Insomnia versions export only v5 YAML (and HAR). v4 files are produced by Insomnia 10.x and earlier, by `inso`-era tooling, and by Insomnia's own importers (other tools to v4 internal form).** Insomnia still imports v4 (and v1 to v3).

Template engine timeline (CONFIRMED): `core@12.6.0` package.json depends on `nunjucks`; `core@13.0.0` depends on `liquidjs` (`https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia/src/common/templating/liquid-engine.ts`). Syntax of `{{ }}` and `{% tag args %}` is kept compatible. See section 6.

## 1. Summary table

| Item | v4 JSON/YAML | v5 YAML |
|---|---|---|
| Produced by | Insomnia <= 10.x, older tools | Insomnia >= 11.0 (all current) |
| Serialisation | JSON (default) or YAML (user choice in 10.x export dialog) | YAML only (the desktop app only routes content starting with `type: ` to the v5 parser) |
| Top-level marker | `_type: export`, `__export_format: 4` | `type: <kind>.insomnia.rest/5.0` (mcp: `mcpClient.insomnia/5.0`), `schema_version: "5.1"` |
| Structure | flat `resources[]`, tree via `parentId` | one document per workspace, nested `collection[]` / `children[]` |
| Multiple workspaces per file | yes | no (one workspace per file) |
| Ordering | `metaSortKey` | `meta.sortKey` (array order is NOT guaranteed sorted) |
| Folder env | inline `environment` object on `request_group` | inline `environment` on folder |
| Base/sub env | separate `environment` resources linked by `parentId` | `environments:` (base) with `subEnvironments:` |
| gRPC | `grpc_request` + `proto_file` + `proto_directory` resources | gRPC request only; proto text NOT exported |
| WebSocket | `websocket_request` + `websocket_payload` | request only; payload NOT exported |
| Client certs, OAuth2 tokens, responses | not exported | not exported |

## 2. Detection markers

### 2.1 How Insomnia itself detects (CONFIRMED)

`https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia/src/common/import.ts` (`scanResources`, ~line 195-215):
1. If the raw text `startsWith('type: ')` it is tried as v5 (`tryImportV5Data`). So the app requires the YAML document to begin with the literal characters `type: `. A reordered/hand-edited file (comment first, `schema_version` first, JSON form `{"type": ...}`) skips the v5 path and falls through to the other importers, which then fail. An external importer should instead parse YAML and look at the `type` value.
2. Otherwise importers are tried in order (`importers/index.ts`): insomnia-1, insomnia-2, insomnia-3, insomnia-4, postman, postman-env, har, curl, swagger2, openapi3, wsdl.
3. v4 importer (`insomnia-4.ts`): `YAML.parse(raw)` (so it accepts JSON or YAML) and checks only `data.__export_format === 4`; it returns `data.resources` untouched. It does not even check `_type: export`. v2/v3 importers use `JSON.parse` and check `__export_format` 2 / 3; v1 checks 1.
4. `inso` CLI (`https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia-inso/src/db/adapters/insomnia-adapter.ts` ~line 80-115): `YAML.parse`; if no `__export_format`, tries v5; accepts only format 4 or 5, else errors.

### 2.2 Markers to use

**v4**: top-level mapping with all of: `_type: "export"`, `__export_format: 4`, `__export_date` (ISO string), `__export_source` (e.g. `insomnia.desktop.app:v10.3.1`; importers emit `insomnia.importers:v0.1.0`), `resources` (array). Each resource has `_type` (string) and `_id` with a typed prefix. Real YAML v4 example: `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia-inso/src/examples/script-folder-environments.yml`; real JSON v4: `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia-inso/src/db/fixtures/insomnia-v4/insomnia_v4.json`.

**v5**: top-level mapping with `type` equal to one of exactly five strings (`https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia/src/common/import-v5-parser.ts` lines 384-443, `schemas/README.md`):

| `type` | Kind | Workspace scope on import |
|---|---|---|
| `collection.insomnia.rest/5.0` | request collection | collection |
| `spec.insomnia.rest/5.0` | API spec / design document. ALSO emitted for ordinary collections that contain an OpenAPI spec or legacy test suites | collection (legacy spec treated as collection) |
| `environment.insomnia.rest/5.0` | global/base environments file | environment |
| `mock.insomnia.rest/5.0` | mock server | mock-server |
| `mcpClient.insomnia/5.0` | MCP client (note: no `.rest`, deliberately, INS-1762) | mcp |

`schema_version` is a quoted string (`"5.1"` currently). Missing means 5.0: in 5.0 files headers/params/metadata/body-params entries still carry an `id` field and may contain empty rows; the 5.1 migration strips those (`S .../insomnia-schema-migrations/v5.1.ts`). The `type` string stays `.../5.0` even for schema 5.1 by design.

Quick sniff rule: YAML/JSON parse; `type` matches `/\.insomnia(\.rest)?\/5\.0$/` (v5) vs `__export_format` present (v1-v4). Also valid: collections of kind `spec.*` can hold `collection:` just like `collection.*`.

### 2.3 Distinguishing from other tools (from general knowledge; NOT verified against those tools' repos in this research, UNCONFIRMED)

- Postman collection: `info._postman_id`/`info.schema` containing `getpostman.com/json/collection`, `item[]`. Postman env: `_postman_variable_scope`.
- OpenAPI/Swagger: `openapi:` or `swagger:` top-level key. (Insomnia v5 `spec:` is an embedded OpenAPI document under `spec.contents`, not a top-level `openapi`.)
- Hoppscotch: collection objects with `v`, `name`, `folders`, `requests`; environment arrays of `{name, variables}`.
- Thunder Client: JSON with `client: "Thunder Client"`, `collectionName`, `requests`.
- Bruno: JSON export with `brunoConfig`/`items`, or `.bru` text files.
None of these contain `__export_format`, `_type: export`, or an Insomnia `type: *.insomnia.rest/5.0`.

### 2.4 Older formats (one line)

v1 (`__export_format: 1`, `items[]`), v2 (`2`, `resources[]` with string bodies), v3 (`3`) are still converted by Insomnia (`importers/insomnia-1..3.ts`); v2 differs from v3 only in request `body` being a string. Old exports exist in the wild (Insomnia 3-5 era, 2017-2019) but are rare; v4 (Insomnia 2019+) is the format people actually have.

## 3. Id prefixes (both formats; v5 `meta.id` also uses them)

Source: `prefix` constants in `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia-data/src/models/*.ts` and `startsWith` checks in `import-v5-parser.ts`.

| Prefix | Resource | v4 `_type` |
|---|---|---|
| `wrk_` | workspace | `workspace` |
| `fld_` | folder | `request_group` |
| `req_` | HTTP request | `request` |
| `greq_` | gRPC request | `grpc_request` |
| `ws-req_` | WebSocket request | `websocket_request` |
| `ws-payload_` | WebSocket payload | `websocket_payload` |
| `socketio-req_` / (payload) | Socket.IO request | `socketio_request`, `socketio_payload` |
| `mcp-req_` | MCP request | `mcp_request` |
| `env_` | environment | `environment` |
| `jar_` | cookie jar | `cookie_jar` |
| `spc_` | API spec | `api_spec` |
| `uts_` / `ut_` | unit test suite / test | `unit_test_suite` / `unit_test` |
| `pf_` / `pd_` | proto file / dir | `proto_file` / `proto_directory` |
| `mock_` / `mock-route_` | mock server / route | `mock` / `mock_route` |

v4 `_type` values come from `MODELS_BY_EXPORT_TYPE` in `import.ts` (lines 168-187): request, mcp_request, websocket_payload, websocket_request, socketio_payload, socketio_request, mock, mock_route, grpc_request, request_group, unit_test_suite, unit_test, workspace, cookie_jar, environment, api_spec, proto_file, proto_directory. Note the 10.0.0 exporter (`export.tsx`) wrote only: unit_test_suite, unit_test, request, websocket_payload, websocket_request, grpc_request, request_group, proto_file, proto_directory, workspace, cookie_jar, environment, api_spec (no socketio, mcp, mock except via separate mock export).

On import Insomnia assigns fresh ids to everything and rewrites old ids found inside `url`, `body`, `parameters`, `pathParameters`, `headers`, `authentication`, `preRequestScript`, `afterResponseScript` strings (`replaceIdsInFields`, `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia-data/src/models/utils/replace-ids-in-fields.ts`). Why this matters: template tags reference other requests by id (`{% response 'body', 'req_...' %}`), and unit tests carry `requestId`; an importer must keep an id map and substitute in all of those strings.

## 4. v4 format

### 4.1 Envelope and structure

```
{ "_type": "export", "__export_format": 4, "__export_date": "...", "__export_source": "insomnia.desktop.app:v10.x", "resources": [ ... ] }
```
- Flat `resources`. Tree via `parentId`: workspace has `parentId` null (older) or a `proj_...` id (newer global-env/mock exports spread the raw model); request_group.parentId = workspace or another folder; request.parentId = workspace or folder; base environment.parentId = workspace; sub environment.parentId = base environment `_id`; cookie_jar.parentId = workspace; websocket_payload.parentId = the ws request; proto_file.parentId = workspace or proto_directory; unit_test_suite.parentId = workspace; unit_test.parentId = suite; api_spec.parentId = workspace.
- A file can contain several `workspace` resources (project export). Insomnia splits resources per workspace by walking parent chains (`filterResourcesInWorkspace` in `import.ts`).
- The 10.0.0 exporter dropped the `type` key (`delete d.type`) and kept only `_type`. Some newer v4 fixtures (global env, mock exports) DO retain `type: Workspace|Environment|...` next to `_type` (e.g. `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia-smoke-test/fixtures/vault-environment.yaml`). Importer must key off `_type` and tolerate an extra `type`.
- Private docs: `isPrivate: true` resources are omitted unless the user answered "include private environments" (`getDocWithDescendants`, export.tsx). Private applies to any doc but in practice private sub-environments.
- v4 workspace keys: `_id, parentId, modified, created, name, description, scope` (`collection` | `design`; also `environment`, `mock-server`, `mcp` in new ones; `null` in very old files, e.g. fixture `insomnia_v4.json`), `_type: workspace`. `certificates` is deprecated.
- Ordering: `metaSortKey` (number, ascending; commonly `-<creation ms timestamp>`, may be fractional like `-1731983168815.5`). Insomnia's comparator (`https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia/src/common/sorting.ts` `metaSortKeySort`): ascending `metaSortKey`; ties broken by `_id` descending. Folders and requests are siblings in one ordering. Resource array order in the file is NOT meaningful.

### 4.2 Resource field shapes (v4 = raw DB model + `_type`)

Source models in `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia-data/src/models/`. Common fields on every resource: `_id, parentId, modified, created` (ms epoch), `isPrivate`, `name`.

`request` (`request.ts` `baseRequestSchema`):
- `url`, `name`, `description`, `method` (string; custom verbs allowed), `metaSortKey`
- `parameters: [{name, value, description?, disabled?, id?, type?, multiline?}]` (query parameters)
- `pathParameters: [{name, value}]` (for `:name` URL segments, regex `/\/:[^/?#:]+/g`)
- `headers: [{name, value, description?, disabled?, id?}]`
- `body: {mimeType?, text?, fileName?, params?: [{name, value?, description?, disabled?, multiline?, id?, fileName?, type?}]}` (empty `{}` means no body)
- `authentication` (see 4.4); `{}` means "inherit"
- `preRequestScript`, `afterResponseScript` (strings; absent or `''`)
- Settings flat: `settingStoreCookies`, `settingSendCookies`, `settingDisableRenderRequestBody`, `settingEncodeUrl`, `settingRebuildPath` (booleans, defaults true/true/false/true/true), `settingFollowRedirects` (`global` | `on` | `off`)
- `disableUserAgentHeader` (bool, optional), `konnectRouteKey`, `konnectManagedHeaderNames` (Kong Konnect plumbing; ignore)
- No per-request timeout, no per-request SSL verify, no HTTP version field exists in the model (CONFIRMED by absence in the schema). SSL/proxy/timeout are application settings and are not in exports.

`request_group` (folder; `request-group.ts`): `name, description, environment` (plain JSON object of variables), `environmentPropertyOrder`, `metaSortKey`, `authentication?`, `headers?`, `preRequestScript?`, `afterResponseScript?`, `kvPairData?`, `environmentType?` (`json` | `kv`), `konnectRouteId?`. Older v4 folders only have `name, description, environment, environmentPropertyOrder, metaSortKey` (+ empty scripts); folder auth/headers/scripts exist in newer exports.

`environment` (`environment.ts`): `name, data` (arbitrary JSON, nested objects and numbers allowed), `dataPropertyOrder`, `color` (`#rrggbb` string from an HTML color input, or null), `isPrivate`, `metaSortKey`, optional `environmentType`, `kvPairData: [{id, name, value, type: 'str'|'json'|'secret', enabled?, isConfidential?}]`.

`cookie_jar` (`cookie-jar.ts`): `name, cookies: [{id, key, value, expires (date|null|'Infinity'), domain, path, secure, httpOnly, extensions?, creation?, creationIndex?, hostOnly?, pathIsDefault?, lastAccessed?, source?: 'manual'|'response'}]`.

`grpc_request` (`grpc-request.ts`): `url, name, description, protoFileId, protoMethodName, body: {text}, metadata: [{name, value, description?, disabled?}], metaSortKey, reflectionApi: {enabled, url, apiKey, module}`.
`proto_file`: `name, protoText` (full .proto source). `proto_directory`: `name` (parent of proto files; proto imports resolved by directory).

`websocket_request`: `url, name, description, headers, parameters, pathParameters, authentication, metaSortKey, settingEncodeUrl, settingStoreCookies, settingSendCookies, settingFollowRedirects, settingUseProxy?`. `websocket_payload`: `name, value, mode` (a content-type string; UI default `application/json`; the exact list of modes UNCONFIRMED), parented to the ws request; UI says one payload per request ("@TODO: multiple payloads", `ui/components/websockets/websocket-request-pane.tsx`).

`socketio_request`: as ws plus `eventListeners: [{id, eventName, desc, isOpen}]`, `settingPath`.

`unit_test_suite`: `name, metaSortKey`. `unit_test`: `name, requestId (nullable), code (JS string using chai `expect` and the legacy test API), metaSortKey`.

`api_spec`: `fileName, contentType ('json'|'yaml'), contents` (the OpenAPI document as a STRING). `mock` / `mock_route`: `url, useInsomniaCloud` / `name (path), body, headers, method, mimeType, statusCode, statusText`.

### 4.3 Query params, headers, body

- Query: `url` may itself contain a literal query string AND `parameters` holds extra params. At send time enabled params are rendered and appended with `?` or `&` (`joinUrlAndQueryString`, `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia/src/common/utils/url/querystring.ts`; disabled ones dropped at `render.ts` ~line 675-682). Do not assume url is query-free.
- Headers: `disabled: true` rows are dropped at send. Inheritance (`getOrInheritHeaders`, `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia/src/network/network.ts`): folder headers (outermost first) then request headers; same name is joined with `, ` except for single-value headers (`common-headers.ts`) where the last wins; header-name case of the last one is kept.
- Body `mimeType` values (`https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia/src/common/constants.ts` ~line 222-240, `insomnia-data/common-src/constants.ts`): `application/json`, `application/xml`, `text/plain`, `application/yaml`, `application/edn`, `application/x-www-form-urlencoded` (uses `params`), `multipart/form-data` (uses `params`), `application/graphql` (GraphQL, see 4.6), `application/octet-stream` (binary file: path in `body.fileName`), `''`/null/missing (no body or "Other"; custom mime strings can appear). Request without a body is `body: {}`.
- Multipart parts (`https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia/src/main/network/multipart.ts`): text part = `{name, value, disabled?, multiline?, type: 'text'}` where `multiline`, if it is a string, is used as that part's `Content-Type` and, if boolean `true`, only marks the editor as multiline; file part = `type: 'file'` with `fileName` = ABSOLUTE local path (basename becomes the filename; content type via mime lookup, default `application/octet-stream`); the part is only treated as a file when both `type === 'file'` and `fileName` are set. The file CONTENT is never in the export, only the path.
- url-encoded: `params: [{name, value, disabled?}]`.
- Insomnia UI normally writes an explicit `Content-Type` header next to the body (see fixtures), but a body with `mimeType` and no such header is possible; whether the runtime adds one is UNCONFIRMED. An importer should add Content-Type from `mimeType` when no header is present.

### 4.4 Authentication (`request.authentication`, folder `authentication`)

Schema: `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia-data/src/models/request.ts` lines 40-190. Every variant has optional `disabled`. `type` is the discriminator.

| `type` | Fields |
|---|---|
| `none` | (none) explicit "no auth", stops inheritance |
| `basic` | `username, password, useISO88591?` |
| `bearer` | `token, prefix?` (`prefix: 'NO_PREFIX'` means send the token raw; empty/absent means `Bearer`; `_buildBearerHeader` in `network/authentication.ts`) |
| `digest` | `username, password` |
| `ntlm` | `username, password` |
| `apikey` | `key, value, addTo` (`header` | `queryParams` | `cookie`; `network/api-key/constants.ts`) |
| `oauth1` | `signatureMethod` (`HMAC-SHA1`|`HMAC-SHA256`|`RSA-SHA1`|`PLAINTEXT`), `consumerKey, consumerSecret, tokenKey, tokenSecret, privateKey, version, nonce, timestamp, callback, realm, verifier, includeBodyHash` |
| `oauth2` | `grantType` (`authorization_code`|`client_credentials`|`password`|`implicit`|`refresh_token`|`mcp_auth_flow`), `accessTokenUrl, authorizationUrl, clientId, clientSecret, clientIdIssuedAt, clientSecretExpiresAt, audience, scope, resource, username, password, redirectUrl, useDefaultBrowser, credentialsInBody, state, code, accessToken, refreshToken, tokenPrefix, usePkce, pkceMethod, responseType` (`code`|`id_token`|`id_token token`|`none`|`token`), `launchBrowserManually, origin` |
| `hawk` | `id, key, algorithm` (`sha1`|`sha256`), `ext?, validatePayload?` |
| `iam` (AWS Signature) | `accessKeyId, secretAccessKey, sessionToken, region, service` |
| `asap` | `issuer, audience, keyId, privateKey, subject?, additionalClaims` (JSON string) |
| `netrc` | (none) uses `~/.netrc` |
| `singleToken` | `token` (appears in the union and parser tests; the UI use is UNCONFIRMED, likely MCP-related) |

Also an empty object `{}` is valid and means "inherit".

Inheritance semantics (`getOrInheritAuthentication`, `network/network.ts` lines 54-77; `network/authentication.ts`): an auth object "counts" if it has a `type` key and `disabled !== true`. If the request's auth counts, use it. Otherwise use the closest ancestor folder whose auth counts. If none, `{type: 'none'}`. Consequences for an importer: request `{}` or `disabled: true` = inherit; request `{type: 'none'}` = explicit no auth that overrides folder auth.

OAuth2 runtime state (access/refresh tokens fetched) is stored in a separate `OAuth2Token` model and is NOT exported. The `accessToken`/`refreshToken`/`code` fields above are user-entered values (used by refresh_token/implicit style flows).

### 4.5 Environments and variables (v4)

- Base environment: `environment` resource whose `parentId` is the workspace id. Sub-environments: `parentId` = base env `_id`. Newer Insomnia (and the Postman env importer) also use `parentId: '__BASE_ENVIRONMENT_ID__'` for importer-created ones (`importers/utils.ts` `setDefaults`). Sub-environment detection in `import.ts` `isSubEnvironmentResource`: empty parentId, or starts with `env`, or starts with `__BASE_ENVIRONMENT_ID__`.
- `data`: any JSON, NESTED OBJECTS ALLOWED (`{{ _.db.host }}`), numbers/bools allowed. Keys cannot start with `$` or contain `.` (NeDB constraint; `dotInKeyNameInvariant` in `convert.ts`, `ensureKeyIsValid` in `utils/environment-utils.ts`); `_` and `vault`/`__insomnia_vault` are reserved at the root.
- `dataPropertyOrder`: ordering metadata (json-order library). Shape: `{"&": [rootKeys...], "&~|<key>": [childKeys...]}`; prefix `&`, separator `~|` (`common/constants.ts` JSON_ORDER_PREFIX/SEPARATOR); array elements are addressed like `&~|users~|0` (`common/__tests__/render.test.ts` ~402). Can be `null` or `{}`. An importer that wants key order should apply it; otherwise insertion order of `data` is fine.
- Folder-level environment: `request_group.environment` (object) + `environmentPropertyOrder`; NOT an `environment` resource.
- Merge/precedence at render (`https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia/src/common/render.ts` ~100-215), lowest to highest: project/global environment (separate `environment`-scope workspace, selected per collection) base then sub; collection base env; active sub env; folder envs outermost to innermost; runner iteration data; script-set transient variables. A later value overrides an earlier one with the same key; values are themselves rendered, so they can reference earlier variables.
- Private environments: `isPrivate: true` (shown in UI as a local-only environment); excluded from sync and from export unless the user opted in.
- `color`: string hex (`#ff0000`) or null.
- Secret / vault (Insomnia 10.3+): in a private environment with `environmentType: 'kv'`, items of `kvPairData` have `type: 'secret'`. In `data` they are stored under the reserved key `__insomnia_vault` as an object `name -> sealed value` (a base64 string of a JSON AES-GCM envelope `{iv, t, ad, d}` in the fixture `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia-smoke-test/fixtures/vault-environment.yaml`). Cipher text is only decryptable with the user's vault key; an importer cannot recover the plaintext. At render time the secrets are exposed as `{{ _.vault.<name> }}` (key `vault`; `render.ts` ~281-337) and in scripts as `insomnia.vault.get('name')`. There is NO `{% vault %}` template tag (CONFIRMED; the 12 built-in tags are in section 6). A literal env variable named `vault` that is a plain string is a conflict ("reserved key" error).
- `kvPairData` types: `str`, `json` (value is a JSON string), `secret`. `isConfidential` marks a value that is hidden (not necessarily vault-sealed). When `environmentType` is `kv`, `kvPairData` is the editor source of truth and `data` the derived object (`getDataFromKVPair`, `utils/environment-utils.ts`); disabled pairs (`enabled: false`) are not in `data`.

### 4.6 GraphQL, gRPC, WebSocket, SSE

- GraphQL: a normal `request` with `method: POST`, `body.mimeType: "application/graphql"` and `body.text` = a JSON STRING `{"query": "...", "variables": {...} | "<string>", "operationName"?: "..."}`. `variables` may be a nested object or (as seen in `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia-smoke-test/fixtures/graphql.yaml`) a JSON-encoded string that can contain templates. There is no separate graphql resource. Operation type is derived by parsing `query`. The UI also adds `Content-Type: application/json` as a header.
- gRPC: `grpc_request.url` has no scheme (`localhost:50051`); TLS is chosen by a `grpcs://` prefix (`network/grpc/parse-grpc-url.ts`). `protoFileId` points to a `proto_file` resource (v4 only), `protoMethodName` is the fully qualified `"/package.Service/Method"` path, `body.text` is the JSON message (the model has a single `text`), `metadata` = headers. If reflection is used: `reflectionApi.enabled` true with `url`, `apiKey`, `module` (a buf.build schema registry module). Empty `protoFileId` means reflection or not set.
- WebSocket: URL scheme `ws://` or `wss://`; headers/params/auth like HTTP; no `method`; message body is the separate `websocket_payload`.
- Socket.IO (newer): `socketio_request` with `eventListeners` and `settings.path`.
- Server-Sent Events: there is no dedicated type. A normal HTTP request is treated as SSE when it has a header `Accept: text/event-stream` (`isEventStreamRequest` in `request.ts`; `CONTENT_TYPE_EVENT_STREAM`).
- MCP: new `mcp_request`/`mcpClient` kind (not requested but present).

### 4.7 Scripts

- v4 fields: `preRequestScript`, `afterResponseScript` on `request` and, in newer files, `request_group` (folder scripts). Strings; may be missing or `''`. Folder scripts run for every request in the folder (outer to inner, UNCONFIRMED exact order).
- Runtime API: global `insomnia` object (alias `$` in the QuickJS engine, `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia/src/scripting/quickjs-script-engine.ts` line 142 and 208). Members include `insomnia.environment`, `insomnia.baseEnvironment`, `insomnia.collectionVariables` (alias of baseEnvironment), `insomnia.variables`, `insomnia.request`, `insomnia.response`, `insomnia.cookies`, `insomnia.info`, `insomnia.execution`, `insomnia.vault`, `insomnia.parentFolders`, `insomnia.test(name, fn)`, `insomnia.expect` (chai), `insomnia.sendRequest(...)`, `insomnia.globals` and `insomnia.parentFolders` (both used by the shipped fixtures), `require(...)` (`https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia-scripting-environment/src/objects/insomnia.ts`). It is deliberately Postman-shaped.
- `pm.` is NOT a runtime global (CONFIRMED by search of the scripting sources; `pm` appears only in the editor's lint globals and in error text). Insomnia's own Postman importer rewrites scripts textually: legacy `postman.*`/`tests[]`/`globals.x` patterns to `pm.*`, then every `pm.` to `insomnia.` (`https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia/src/main/importers/importers/translate-postman-script.ts`, last lines). An importer to another tool should do the inverse if it targets `pm`, and must expect that Insomnia scripts do not use `pm`.
- Legacy Insomnia scripts (pre-2022, `insomnia.request.getUrl()` style and `unit_test.code` with `expect(...)`) can appear in old v4 files; do not assume the new API.
- Legacy tests (`unit_test.code`) are JS using chai assertions (`expect(x).to...`) against the response of `requestId`; they are not the same as `insomnia.test(...)` in after-response scripts.

### 4.8 Cookies, certificates, tests, responses

- `cookie_jar`: one jar per workspace ("Default Jar"). Fields above. `expires` is a date or null/`Infinity`. Cookies with `source: 'manual'` can contain template syntax; `response` cookies are literal.
- Client certificates (`ClientCertificate`: `host, cert, key, pfx, passphrase, disabled`) and CA certificates are NOT in v4 export (not in the exported-type list) and also not in v5. The v5 schema has a `certificates` key (CA entries `{path, disabled, meta}`), but neither the exporter nor the importer reads it (CONFIRMED by reading `insomnia-v5.ts`; only the schema accepts it).
- Unit tests: `unit_test_suite` + `unit_test` resources (above).
- Responses: NEVER exported. `Response` models (history) are not in `MODELS_BY_EXPORT_TYPE`; there is no "saved response/example" concept in the data models (CONFIRMED by search for example/saved-response models). Postman-style examples have no counterpart.

## 5. v5 format

### 5.1 Envelope

Top-level keys by kind (`import-v5-parser.ts`):

- `collection.insomnia.rest/5.0`: `type, schema_version, name, meta, collection, cookieJar, environments, certificates?, testSuites?, spec?`
- `spec.insomnia.rest/5.0`: same keys, `spec` defaults to `{contents: {}}`. Insomnia exports ANY collection that contains an API spec or test suites as `spec.*`, and design-scope workspaces always.
- `environment.insomnia.rest/5.0`: `type, schema_version, name, meta, environments`
- `mock.insomnia.rest/5.0`: `type, schema_version, name, meta, server: {meta, url, useInsomniaCloud}, routes: [...]`. NOTE a stale smoke fixture `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia-smoke-test/fixtures/mock-server.yaml` uses top-level `url` / `useInsomniaCloud` instead of `server:`; the current Zod schema strips unknown keys, so the app would read `server.url` as empty for that old shape. Importer should read `server.url` and fall back to top-level `url`.
- `mcpClient.insomnia/5.0`: `type, schema_version, name, meta, mcpRequest: {name, url, transportType: stdio|streamable-http, headers, authentication, meta, env: [kvPair], roots: [{uri, name?}]}, environments`

Workspace identity: `name` and `meta: {id, created, modified, isPrivate?, description?}` (`meta.id` starts with `wrk_`). One workspace per file.

Empty keys are omitted: the exporter runs `removeEmptyFields` (null/undefined/empty objects and arrays dropped) before `yaml.stringify`. So absent `headers`, `parameters`, `body`, `authentication`, `scripts` mean empty/inherit, and `disabled: false` may or may not be written.

### 5.2 Structure and ordering

- `collection:` is an array of items. Items are one of: folder, HTTP request, gRPC request, WebSocket request, Socket.IO request. Discrimination in the importer (`insomnia-v5.ts` `walkCollection`, ~line 500-615): item is a **folder** if it has none of `method`, `reflectionApi`, `url`; **HTTP request** if it has `method`; **gRPC** if it has `reflectionApi`; otherwise try the WebSocket schema first then the Socket.IO schema (the Zod union uses `meta.id` `startsWith('ws-req')` / `startsWith('socketio-req')` when `meta` present; Socket.IO is also marked by `eventListeners` and `settings.path`). Missing `meta` makes a ws item ambiguous with socket.io.
- Folders nest via `children: [ ... ]` (arbitrary depth). Folder keys: `name, meta{id,created,modified,sortKey,description}, children, authentication, headers, environment, environmentPropertyOrder, scripts{preRequest, afterResponse}` (the schema also accepts `kvPairData`/`environmentType`, but the exporter never writes them and the importer never reads them).
- Ordering: `meta.sortKey` (the v4 `metaSortKey`). The exporter does NOT sort; items are emitted in DB query order (`getCollectionFromResources`, no sort call). So an importer must sort siblings by `meta.sortKey` ascending (ties by id descending to mimic Insomnia) or keep array order if all sortKeys are missing. Import code treats missing sortKey as 0. Folders and requests share one ordering.
- Description lives in `meta.description` for workspace/folder/request, not top-level. (`mapMeta`/`mapGroupMeta`.) Per header/param `description` is top-level on the row.

### 5.3 HTTP request (v5 keys)

`url, name, meta, method, body, parameters, headers, authentication, scripts: {preRequest, afterResponse}, settings, pathParameters`.

`settings` mapping from v4 flat fields (`insomnia-v5.ts` ~552-566 and ~896-908):

| v5 | v4 |
|---|---|
| `settings.renderRequestBody` | NOT `settingDisableRenderRequestBody` (inverted) |
| `settings.encodeUrl` | `settingEncodeUrl` |
| `settings.followRedirects` (`global`|`on`|`off`) | `settingFollowRedirects` |
| `settings.cookies.send` | `settingSendCookies` |
| `settings.cookies.store` | `settingStoreCookies` |
| `settings.rebuildPath` | `settingRebuildPath` |

All default to true (followRedirects `global`) when `settings` is absent. `disableUserAgentHeader` and `konnect*` are not exported in v5. Row shapes: header `{name, value, description?, disabled?}` (schema 5.1: no `id`); parameter `{name, value, description?, disabled?, type?, multiline?}`; body `{mimeType, text, fileName, params: [{name, value, description, disabled, multiline, fileName, type}]}`; `pathParameters: [{name, value}]`; `authentication` identical to v4 (section 4.4).

### 5.4 gRPC, WebSocket, Socket.IO (v5)

- gRPC item: `url, name, meta{id: greq_...}, body{text}, metadata[{name,value,description?,disabled?}], protoFileId, protoMethodName, reflectionApi{enabled,url,apiKey,module}`. The proto source and directory are NOT exported (`proto_file`/`proto_directory` are v4 only; they appear in `MODELS_BY_EXPORT_TYPE` but v5 `getCollectionFromResources` emits nothing for them). `protoFileId` is therefore a dangling reference on import; the user must re-attach the .proto. Exporter always writes `reflectionApi`, and the importer relies on its presence to recognise gRPC.
- WebSocket item: `url, name, meta{id: ws-req_...}, settings{encodeUrl, followRedirects, cookies{send,store}, useProxy}, authentication, headers, parameters, pathParameters`. The message payload (`websocket_payload`) is NOT exported in v5: payloads are lost (CONFIRMED by reading the exporter; real fixture `https://github.com/Kong/insomnia/blob/19b4875499c38edb53f398dc0a7ae6f198cfbffd/packages/insomnia-smoke-test/fixtures/websockets.yaml` has none).
- Socket.IO item: `url, name, meta{id: socketio-req_...}, settings{encodeUrl, cookies, path}, headers, parameters, authentication, eventListeners[{id, eventName, desc, isOpen}]`.
- No SSE type (same `Accept: text/event-stream` convention).

### 5.5 Environments (v5)

```
environments:
  name: Base Environment
  meta: {id: env_..., created, modified, isPrivate}
  data: { ...arbitrary JSON, nested objects and numbers ok }
  dataPropertyOrder: { "&": [...], "&~|child": [...] }   # optional
  color: "#rrggbb"                                        # optional
  subEnvironments:
    - name, meta{id, created, modified, isPrivate, sortKey}, data, dataPropertyOrder?, color?
```
- Exactly one base environment per file; `environments` is an OBJECT, not an array. Sub-environments are in `subEnvironments[]`; on import the FIRST sub-environment becomes active (`importResourcesToNewWorkspace`).
- `isPrivate: true` sub-environments are included only if the user chose "include private environments"; when included, vault values in `data.__insomnia_vault` are replaced by the mask `••••••` if the env has secret kvPairs (`maskVaultEnvironmentData`, `utils/environment-utils.ts`). Sealed ciphertext may also appear. Either way the plaintext secret is not recoverable from the export.
- The schema also allows `kvPairData` and `environmentType` on environments, but neither the exporter nor `getEnvironments` copies them, so real v5 files do not carry them (CONFIRMED by code). Secrets in v5 are therefore only visible as `data.__insomnia_vault.<name>`.
- Folder environment: `environment: {k: v}` on the folder (+ `environmentPropertyOrder`).
- Global environment file (`environment.insomnia.rest/5.0`): same `environments` object; used as the "Project environment" a collection can select.
- Colors are hex strings.

### 5.6 Other v5 sections

- `cookieJar`: a single object `{name, meta, cookies:[...]}`; only the first jar is exported. `expires` becomes an ISO timestamp (YAML), `creation`/`lastAccessed` are stripped by migration 5.1.
- `spec`: `{contents: <the OpenAPI document as a YAML mapping>, meta}` (exporter parses the stored string as JSON then YAML; import re-stringifies to YAML). Alternative `{file: "<name>", meta}` is allowed by the schema but unused on export. Treat `spec.contents` as an embedded OpenAPI doc.
- `testSuites: [{name, meta, tests:[{name, meta, requestId, code}]}]` (legacy unit tests).
- `certificates`: schema only; never written or read (see 4.8).
- `scripts` per request/folder: `{preRequest: "...", afterResponse: "..."}`; empty strings are dropped by migration/exporter.

### 5.7 Import side effects worth copying

`insomnia-v5.ts` import: `created`/`modified` default to now when missing; `isPrivate` false; `metaSortKey` 0; request `disableUserAgentHeader` false; the cookie jar becomes `Imported Cookie Jar` if unnamed; default names `Imported Request`, `Imported Folder`, etc.

## 6. Template syntax

Insomnia renders string fields (url, headers, params, body, auth values, env values) before sending; scripts read variables through the `insomnia.*` API instead. Engine: Nunjucks up to 12.x, LiquidJS from 13.0.0 (`liquid-engine.ts`: delimiters `{{ }}` and `{% %}`, `{# #}` comments stripped; `strictVariables: true`; `jsTruthy: true`; `include`/`render`/`layout` blocked). Exports from either era contain the same textual form.

Variable forms (CONFIRMED by `templating/__tests__/liquid-compat.test.ts`):
- `{{ _.name }}`: namespaced form; this is what the UI generates (global property `_`, `NUNJUCKS_TEMPLATE_GLOBAL_PROPERTY_NAME`).
- `{{ name }}`: bare form, also works.
- `{{ _['my-var'] }}`: bracket notation for keys with dashes or other non-identifier chars (UI emits this automatically; seen in `variable_inheritance.yaml`).
- Nested: `{{ _.db.host }}`, `{{ _.users[0].id }}` (arrays by index).
- Filters (`| upcase`) and control flow (`{% if %}`, `{% for %}`, `{% endif %}`) are valid in any string; they are rare in practice.
- `{{ _.vault.secret }}` for vault secrets.
- Path parameters use a different syntax: `:id` URL segments with `pathParameters`.

Tag serialisation: `{% name 'arg1', 'arg2', 3 %}`; string args single-quoted; booleans bare; some args are base64-wrapped as `'b64::<base64>::46b'` (`encodeEncoding`/`decodeEncoding`, `templating/utils.ts` ~120-140) where the tag declares `encoding: 'base64'`, so the arg survives quoting (e.g. JSONPath `$.token` is `b64::JC50b2tlbg==::46b`).

The 12 built-in tags (CONFIRMED; `local-template-tags.ts`, `name` fields). Arguments in positional order:

| Tag | Arguments | Notes |
|---|---|---|
| `response` | 1 attribute: `'body'`, `'raw'`, `'header'`, `'url'`; 2 request id (`'req_...'`); 3 filter (`b64::..::46b` JSONPath or XPath for body, header name for header; ignored for raw/url); 4 trigger behaviour: `'never'`(default) / `'no-history'` / `'when-expired'` / `'always'`; 5 max age seconds (default 60, used with when-expired) | Request chaining; depends on a previous response of another request; the request id must be remapped. Example: `{% response 'body', 'req_...', 'b64::JC50b2tlbg==::46b', 'always', 60 %}` |
| `request` | 1 attribute: `name`, `folder`, `url`, `parameter`, `header`, `cookie`, `oauth2`, `oauth2-identity`, `oauth2-refresh`; 2 name (for parameter/header/cookie); 3 folder parent index (for `folder`) | Reads from the current request |
| `uuid` | 1 version `'v4'` or `'v1'` | NB: the run function ignores the arg and returns `crypto.randomUUID()` (v4) |
| `now` | 1 `'iso-8601'`, `'millis'`, `'unix'`, `'custom'`; 2 date-fns format (custom) | |
| `base64` | 1 `'encode'`/`'decode'`; 2 `'normal'`/`'url'`/`'hex'`; 3 text | |
| `hash` | 1 `'md5'`/`'sha1'`/`'sha256'`/`'sha512'`; 2 `'hex'`/`'base64'`; 3 input | |
| `jsonpath` | 1 JSON string; 2 JSONPath (base64-wrapped) | |
| `file` | 1 absolute file path | reads file content |
| `faker` | 1 function name (e.g. `internet.email`; list in `faker-functions.ts`) | random data |
| `prompt` | 1 title (required), 2 label, 3 default value, 4 storage key, 5 mask (bool), 6 default-to-last (bool) | interactive |
| `os` | 1 `arch|cpus|freemem|hostname|platform|release|userInfo`; 2 JSONPath filter | |
| `cookie` | 1 url, 2 cookie name | reads cookie jar |

Plus user-installed plugin tags (any other `{% name ... %}`). There is no `secret`/`vault` tag (vault is `{{ _.vault.x }}`). Translation hints: `uuid`, `now`, `base64`, `hash`, `faker`, `os` map to dynamic variables/functions in other tools; `response`, `request`, `prompt`, `file`, `cookie`, `jsonpath` need either a feature or an "unsupported, reported" outcome. An importer should at least list tags found per request and flag `response` (needs a request-id lookup and a JSONPath/XPath decode).

References that need id remapping: `{% response ..., 'req_<id>' %}` and `unit_test.requestId`.

## 7. What does NOT round-trip (loss matrix, v5 vs v4)

| Data | v4 | v5 |
|---|---|---|
| Proto files and directories | yes (`proto_file`, `proto_directory`) | no (only `protoFileId`) |
| WebSocket message payload | yes (`websocket_payload`) | no |
| Multiple workspaces/projects per file | yes | no |
| Folder `kvPairData`/env `kvPairData`/`environmentType` | yes (raw model) | schema allows, exporter does not write |
| `disableUserAgentHeader`, konnect fields | yes | no |
| Client certs, CA certs, OAuth2 tokens, history, responses | no | no |
| Private requests | omitted unless included | included (only envs are filtered by the include-private choice) |
| Secrets | sealed under `__insomnia_vault` | sealed or masked `••••••` under `__insomnia_vault` |

## 8. Samples (reconstructed from source; the v5 sample was validated against `schemas/insomnia.schema.5.1.json` with Ajv 2020; the v4 one is a hand build from the model schemas)

### 8.1 v5 YAML (`collection.insomnia.rest/5.0`)

Items shown: workspace, folder `Orders` with folder auth (bearer), headers, env, and folder pre-request script; JSON POST with an enabled and a disabled query param, an enabled and disabled header, basic auth override, pre-request and after-response scripts; multipart with a text part and a file part; GraphQL; a `{% response %}` chained header using `{{ _.baseUrl }}`; gRPC; a top-level WebSocket request; cookie jar; base environment with nested `db` object and `dataPropertyOrder`; private sub-environment `Staging` with a vault secret.

```yaml
type: collection.insomnia.rest/5.0
schema_version: "5.1"
name: Orders API
meta:
  id: wrk_0a1b2c3d4e5f60718293a4b5c6d7e8f9
  created: 1760000000000
  modified: 1760000100000
  description: Sample collection
collection:
  - name: Orders
    meta:
      id: fld_1111111111111111111111111111aaaa
      created: 1760000001000
      modified: 1760000001000
      sortKey: -1760000001000
      description: Everything under /orders
    authentication:
      type: bearer
      token: "{{ _.token }}"
      prefix: ""
      disabled: false
    headers:
      - name: X-Tenant
        value: "{{ _.tenant }}"
    environment:
      tenant: acme
    scripts:
      preRequest: |-
        console.log('folder pre-request');
    children:
      - url: "{{ _.baseUrl }}/orders"
        name: Create order
        meta:
          id: req_2222222222222222222222222222aaaa
          created: 1760000002000
          modified: 1760000002000
          isPrivate: false
          description: Creates an order
          sortKey: -1760000002000
        method: POST
        body:
          mimeType: application/json
          text: |-
            {
              "sku": "ABC-1",
              "qty": 2
            }
        parameters:
          - name: dryRun
            value: "true"
            disabled: true
          - name: expand
            value: items
        headers:
          - name: Content-Type
            value: application/json
          - name: X-Debug
            value: "1"
            disabled: true
        authentication:
          type: basic
          useISO88591: false
          username: svc
          password: "{{ _.svcPassword }}"
          disabled: false
        scripts:
          preRequest: |-
            insomnia.variables.set('requestedAt', Date.now());
          afterResponse: |-
            insomnia.test('201', () => insomnia.expect(insomnia.response.code).to.eql(201));
        settings:
          renderRequestBody: true
          encodeUrl: true
          followRedirects: global
          cookies:
            send: true
            store: true
          rebuildPath: true
      - url: "{{ _.baseUrl }}/orders/:id/attachments"
        name: Upload attachment
        meta:
          id: req_3333333333333333333333333333aaaa
          created: 1760000003000
          modified: 1760000003000
          isPrivate: false
          sortKey: -1760000003000
        method: POST
        body:
          mimeType: multipart/form-data
          params:
            - name: note
              value: scanned copy
              disabled: false
              multiline: text/plain
              type: text
            - name: file
              value: ""
              disabled: false
              fileName: /Users/dev/invoice.pdf
              type: file
        pathParameters:
          - name: id
            value: "42"
        settings:
          renderRequestBody: true
          encodeUrl: true
          followRedirects: "off"
          cookies:
            send: true
            store: false
          rebuildPath: true
      - url: "{{ _.baseUrl }}/graphql"
        name: Order by id (GraphQL)
        meta:
          id: req_4444444444444444444444444444aaaa
          created: 1760000004000
          modified: 1760000004000
          isPrivate: false
          sortKey: -1760000004000
        method: POST
        body:
          mimeType: application/graphql
          text: '{"query":"query($id: ID!) { order(id: $id) { id total } }","variables":{"id":"42"}}'
        headers:
          - name: Content-Type
            value: application/json
        settings:
          renderRequestBody: true
          encodeUrl: true
          followRedirects: global
          cookies:
            send: true
            store: true
          rebuildPath: true
      - url: "{{ _.baseUrl }}/orders/latest"
        name: Latest order (chained)
        meta:
          id: req_5555555555555555555555555555aaaa
          created: 1760000005000
          modified: 1760000005000
          isPrivate: false
          sortKey: -1760000005000
        method: GET
        headers:
          - name: X-Order-Id
            value: "{% response 'body', 'req_2222222222222222222222222222aaaa', 'b64::JC5pZA==::46b', 'when-expired', 60 %}"
        settings:
          renderRequestBody: true
          encodeUrl: true
          followRedirects: global
          cookies:
            send: true
            store: true
          rebuildPath: true
      - url: grpc.example.com:443
        name: GetOrder (gRPC)
        meta:
          id: greq_6666666666666666666666666666aaaa
          created: 1760000006000
          modified: 1760000006000
          isPrivate: false
          sortKey: -1760000006000
        body:
          text: |-
            {"id": "42"}
        metadata:
          - name: authorization
            value: Bearer {{ _.token }}
        protoFileId: pf_7777777777777777777777777777aaaa
        protoMethodName: /orders.v1.Orders/GetOrder
        reflectionApi:
          enabled: false
          url: https://buf.build
          apiKey: ""
          module: buf.build/connectrpc/eliza
  - url: wss://echo.example.com/ws
    name: Echo (WebSocket)
    meta:
      id: ws-req_8888888888888888888888888888aaaa
      created: 1760000008000
      modified: 1760000008000
      sortKey: -1760000008000
    settings:
      encodeUrl: true
      followRedirects: global
      cookies:
        send: true
        store: true
    headers:
      - name: X-Token
        value: "{{ _.token }}"
cookieJar:
  name: Default Jar
  meta:
    id: jar_9999999999999999999999999999aaaa
    created: 1760000000000
    modified: 1760000000000
  cookies:
    - id: c1
      key: session
      value: abc
      domain: api.example.com
      path: /
      secure: true
      httpOnly: true
environments:
  name: Base Environment
  meta:
    id: env_aaaaaaaaaaaaaaaaaaaaaaaaaaaa0001
    created: 1760000000000
    modified: 1760000000000
    isPrivate: false
  data:
    baseUrl: https://api.example.com
    tenant: base
    db:
      host: localhost
      port: 5432
  dataPropertyOrder:
    "&":
      - baseUrl
      - tenant
      - db
    "&~|db":
      - host
      - port
  color: "#00aa88"
  subEnvironments:
    - name: Staging
      meta:
        id: env_bbbbbbbbbbbbbbbbbbbbbbbbbbbb0002
        created: 1760000000000
        modified: 1760000000000
        isPrivate: true
        sortKey: 1760000000001
      data:
        baseUrl: https://staging.example.com
        __insomnia_vault:
          svcPassword: "••••••"
      color: "#ff8800"
```

Notes: `_.token`, `_.tenant`, `_.svcPassword` are variables; `svcPassword` lives in `Staging` under `__insomnia_vault` (here shown masked as the exporter does for private envs); `tenant: acme` on the folder overrides the base `tenant: base` for requests in that folder.

### 8.2 v4 JSON

Same content in v4 form. Demonstrates flat resources, `parentId` links, `metaSortKey`, flat `setting*` fields, `proto_file` + `grpc_request`, `websocket_request` + `websocket_payload`, base and private sub environment with `kvPairData` including a `secret` item. (The vault value is shown as a placeholder string; real files hold a base64 JSON envelope.)

```json
{
  "_type": "export",
  "__export_format": 4,
  "__export_date": "2026-10-15T12:00:00.000Z",
  "__export_source": "insomnia.desktop.app:v10.3.1",
  "resources": [
    {
      "_id": "wrk_0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      "parentId": null,
      "modified": 1760000100000,
      "created": 1760000000000,
      "name": "Orders API",
      "description": "Sample collection",
      "scope": "collection",
      "_type": "workspace"
    },
    {
      "_id": "fld_1111111111111111111111111111aaaa",
      "parentId": "wrk_0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      "modified": 1760000001000,
      "created": 1760000001000,
      "name": "Orders",
      "description": "Everything under /orders",
      "environment": {
        "tenant": "acme"
      },
      "environmentPropertyOrder": {
        "&": [
          "tenant"
        ]
      },
      "metaSortKey": -1760000001000,
      "authentication": {
        "type": "bearer",
        "token": "{{ _.token }}",
        "prefix": "",
        "disabled": false
      },
      "headers": [
        {
          "name": "X-Tenant",
          "value": "{{ _.tenant }}"
        }
      ],
      "preRequestScript": "console.log('folder pre-request');",
      "afterResponseScript": "",
      "_type": "request_group"
    },
    {
      "_id": "req_2222222222222222222222222222aaaa",
      "parentId": "fld_1111111111111111111111111111aaaa",
      "modified": 1760000000000,
      "created": 1760000000000,
      "url": "{{ _.baseUrl }}/orders",
      "name": "Create order",
      "description": "",
      "method": "POST",
      "body": {
        "mimeType": "application/json",
        "text": "{\n  \"sku\": \"ABC-1\",\n  \"qty\": 2\n}"
      },
      "parameters": [
        {
          "name": "dryRun",
          "value": "true",
          "disabled": true
        },
        {
          "name": "expand",
          "value": "items"
        }
      ],
      "headers": [
        {
          "name": "Content-Type",
          "value": "application/json"
        },
        {
          "name": "X-Debug",
          "value": "1",
          "disabled": true
        }
      ],
      "authentication": {
        "type": "basic",
        "useISO88591": false,
        "username": "svc",
        "password": "{{ _.svcPassword }}",
        "disabled": false
      },
      "metaSortKey": -1760000002000,
      "isPrivate": false,
      "pathParameters": [],
      "settingStoreCookies": true,
      "settingSendCookies": true,
      "settingDisableRenderRequestBody": false,
      "settingEncodeUrl": true,
      "settingRebuildPath": true,
      "settingFollowRedirects": "global",
      "preRequestScript": "insomnia.variables.set('requestedAt', Date.now());",
      "afterResponseScript": "insomnia.test('201', () => insomnia.expect(insomnia.response.code).to.eql(201));",
      "_type": "request"
    },
    {
      "_id": "req_3333333333333333333333333333aaaa",
      "parentId": "fld_1111111111111111111111111111aaaa",
      "modified": 1760000000000,
      "created": 1760000000000,
      "url": "{{ _.baseUrl }}/orders/:id/attachments",
      "name": "Upload attachment",
      "description": "",
      "method": "POST",
      "body": {
        "mimeType": "multipart/form-data",
        "params": [
          {
            "name": "note",
            "value": "scanned copy",
            "disabled": false,
            "multiline": "text/plain",
            "type": "text"
          },
          {
            "name": "file",
            "value": "",
            "disabled": false,
            "fileName": "/Users/dev/invoice.pdf",
            "type": "file"
          }
        ]
      },
      "parameters": [],
      "headers": [],
      "authentication": {},
      "metaSortKey": -1760000003000,
      "isPrivate": false,
      "pathParameters": [
        {
          "name": "id",
          "value": "42"
        }
      ],
      "settingStoreCookies": false,
      "settingSendCookies": true,
      "settingDisableRenderRequestBody": false,
      "settingEncodeUrl": true,
      "settingRebuildPath": true,
      "settingFollowRedirects": "off",
      "_type": "request"
    },
    {
      "_id": "req_4444444444444444444444444444aaaa",
      "parentId": "fld_1111111111111111111111111111aaaa",
      "modified": 1760000000000,
      "created": 1760000000000,
      "url": "{{ _.baseUrl }}/graphql",
      "name": "Order by id (GraphQL)",
      "description": "",
      "method": "POST",
      "body": {
        "mimeType": "application/graphql",
        "text": "{\"query\":\"query($id: ID!) { order(id: $id) { id total } }\",\"variables\":{\"id\":\"42\"}}"
      },
      "parameters": [],
      "headers": [
        {
          "name": "Content-Type",
          "value": "application/json"
        }
      ],
      "authentication": {},
      "metaSortKey": -1760000004000,
      "isPrivate": false,
      "pathParameters": [],
      "settingStoreCookies": true,
      "settingSendCookies": true,
      "settingDisableRenderRequestBody": false,
      "settingEncodeUrl": true,
      "settingRebuildPath": true,
      "settingFollowRedirects": "global",
      "_type": "request"
    },
    {
      "_id": "req_5555555555555555555555555555aaaa",
      "parentId": "fld_1111111111111111111111111111aaaa",
      "modified": 1760000000000,
      "created": 1760000000000,
      "url": "{{ _.baseUrl }}/orders/latest",
      "name": "Latest order (chained)",
      "description": "",
      "method": "GET",
      "body": {},
      "parameters": [],
      "headers": [
        {
          "name": "X-Order-Id",
          "value": "{% response 'body', 'req_2222222222222222222222222222aaaa', 'b64::JC5pZA==::46b', 'when-expired', 60 %}"
        }
      ],
      "authentication": {},
      "metaSortKey": -1760000005000,
      "isPrivate": false,
      "pathParameters": [],
      "settingStoreCookies": true,
      "settingSendCookies": true,
      "settingDisableRenderRequestBody": false,
      "settingEncodeUrl": true,
      "settingRebuildPath": true,
      "settingFollowRedirects": "global",
      "_type": "request"
    },
    {
      "_id": "pf_7777777777777777777777777777aaaa",
      "parentId": "wrk_0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      "modified": 1760000000000,
      "created": 1760000000000,
      "name": "orders.proto",
      "protoText": "syntax = \"proto3\";\npackage orders.v1;\nservice Orders { rpc GetOrder (GetOrderRequest) returns (Order); }\nmessage GetOrderRequest { string id = 1; }\nmessage Order { string id = 1; }\n",
      "isPrivate": false,
      "_type": "proto_file"
    },
    {
      "_id": "greq_6666666666666666666666666666aaaa",
      "parentId": "fld_1111111111111111111111111111aaaa",
      "modified": 1760000000000,
      "created": 1760000000000,
      "url": "grpc.example.com:443",
      "name": "GetOrder (gRPC)",
      "description": "",
      "protoFileId": "pf_7777777777777777777777777777aaaa",
      "protoMethodName": "/orders.v1.Orders/GetOrder",
      "body": {
        "text": "{\"id\": \"42\"}"
      },
      "metadata": [
        {
          "name": "authorization",
          "value": "Bearer {{ _.token }}"
        }
      ],
      "metaSortKey": -1760000006000,
      "isPrivate": false,
      "reflectionApi": {
        "enabled": false,
        "url": "https://buf.build",
        "apiKey": "",
        "module": "buf.build/connectrpc/eliza"
      },
      "_type": "grpc_request"
    },
    {
      "_id": "ws-req_8888888888888888888888888888aaaa",
      "parentId": "wrk_0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      "modified": 1760000000000,
      "created": 1760000000000,
      "url": "wss://echo.example.com/ws",
      "name": "Echo (WebSocket)",
      "description": "",
      "headers": [
        {
          "name": "X-Token",
          "value": "{{ _.token }}"
        }
      ],
      "authentication": {},
      "parameters": [],
      "metaSortKey": -1760000008000,
      "isPrivate": false,
      "settingEncodeUrl": true,
      "settingStoreCookies": true,
      "settingSendCookies": true,
      "settingFollowRedirects": "global",
      "_type": "websocket_request"
    },
    {
      "_id": "ws-payload_8888888888888888888888888888bbbb",
      "parentId": "ws-req_8888888888888888888888888888aaaa",
      "modified": 1760000000000,
      "created": 1760000000000,
      "name": "New Payload",
      "value": "{\"hello\":\"world\"}",
      "mode": "application/json",
      "isPrivate": false,
      "_type": "websocket_payload"
    },
    {
      "_id": "jar_9999999999999999999999999999aaaa",
      "parentId": "wrk_0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      "modified": 1760000000000,
      "created": 1760000000000,
      "name": "Default Jar",
      "cookies": [
        {
          "id": "c1",
          "key": "session",
          "value": "abc",
          "domain": "api.example.com",
          "path": "/",
          "secure": true,
          "httpOnly": true,
          "expires": null
        }
      ],
      "_type": "cookie_jar"
    },
    {
      "_id": "env_aaaaaaaaaaaaaaaaaaaaaaaaaaaa0001",
      "parentId": "wrk_0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      "modified": 1760000000000,
      "created": 1760000000000,
      "name": "Base Environment",
      "data": {
        "baseUrl": "https://api.example.com",
        "tenant": "base",
        "db": {
          "host": "localhost",
          "port": 5432
        }
      },
      "dataPropertyOrder": {
        "&": [
          "baseUrl",
          "tenant",
          "db"
        ],
        "&~|db": [
          "host",
          "port"
        ]
      },
      "color": "#00aa88",
      "isPrivate": false,
      "metaSortKey": 1760000000000,
      "_type": "environment"
    },
    {
      "_id": "env_bbbbbbbbbbbbbbbbbbbbbbbbbbbb0002",
      "parentId": "env_aaaaaaaaaaaaaaaaaaaaaaaaaaaa0001",
      "modified": 1760000000000,
      "created": 1760000000000,
      "name": "Staging",
      "data": {
        "baseUrl": "https://staging.example.com",
        "__insomnia_vault": {
          "svcPassword": "<sealed base64 JSON {iv,t,ad,d} blob>"
        }
      },
      "dataPropertyOrder": {
        "&": [
          "baseUrl",
          "__insomnia_vault"
        ],
        "&~|__insomnia_vault": [
          "svcPassword"
        ]
      },
      "color": "#ff8800",
      "isPrivate": true,
      "metaSortKey": 1760000000001,
      "environmentType": "kv",
      "kvPairData": [
        {
          "id": "envPair_1",
          "name": "baseUrl",
          "value": "https://staging.example.com",
          "type": "str",
          "enabled": true
        },
        {
          "id": "envPair_2",
          "name": "svcPassword",
          "value": "<sealed base64 JSON {iv,t,ad,d} blob>",
          "type": "secret",
          "enabled": true
        }
      ],
      "_type": "environment"
    }
  ]
}
```

## 9. Riskiest importer mapping questions

1. v5 vs v4 detection: the app gates v5 on the file starting with `type: `; and `spec.insomnia.rest/5.0` is not only for design docs (it is also used for plain collections that contain an API spec or legacy tests). Parse YAML and key off `type` (and `__export_format`) instead.
2. Request order: v5 array order is not sorted; v4 is a flat list. Sort by sortKey (asc, ties by id desc).
3. Auth inheritance: `{}`/missing/`disabled:true` = inherit; explicit `type: none` overrides folder auth. Folder auth, folder headers, folder env and folder scripts all exist and must be applied in scope order outer to inner.
4. Vault/secret values are not recoverable (sealed or masked). The importer must create the variable name only and warn.
5. Template tags: `{% response 'body', 'req_x', 'b64::...::46b', ... %}` needs id remap plus base64 decoding of the filter; other tags (`prompt`, `file`, `faker`, `cookie`, `os`) have no portable equivalent; plus the engine is Liquid now and users may have `{% if %}` blocks.
6. Nested environment objects: `data` is arbitrary JSON; `{{ _.a.b }}` references nested keys; variables can reference other variables; dot-in-key not allowed; folder env overrides.
7. Multipart file parts store only an absolute local path (`fileName`), never content; disabled params/headers/parts must be kept as disabled, not dropped.
8. Proto files (v5) and WebSocket payloads (v5) are absent; gRPC and WS requests import as shells. v4 has them but links via `protoFileId` and `parentId`.
9. Query string can live in `url` and in `parameters` simultaneously; path parameters use `:name` plus `pathParameters`.
10. Scripts use `insomnia.*` (not `pm.*`); folder-level scripts exist; legacy `unit_test.code` is a different API.

## 10. UNCONFIRMED items

- Detection markers of Postman, Hoppscotch, Thunder Client, Bruno (section 2.3): from general knowledge, not read from their repos.
- The full list of `websocket_payload.mode` values (UI default `application/json`).
- Cookie `expires` serialisation in v4 JSON (ISO string vs epoch vs `Infinity`); model is date/null/`'Infinity'`.
- Whether the HTTP runtime auto-adds a `Content-Type` header from `body.mimeType` when none is present.
- Exact folder-script execution order (outer to inner assumed).
- UI usage of `singleToken` auth type.
- The 11.x-era exact release in which the v4 export option disappeared beyond: present in 10.0.0 (confirmed), absent from 11.3.0 dialog (confirmed). Behaviour at 11.0 to 11.2 was not inspected.
- Real-world frequency of v1-v3 files.
