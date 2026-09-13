# Spec: REST client

- Status: draft 2026-09-13, for review; the §15 defaults apply until changed here. Implemented by
  `docs/plans/2026-09-13-wirebench-rest-client-plan.md`, which assumes those defaults.
- Date: 2026-09-13
- Builds on: the v1 design (`docs/specs/2026-09-09-wirebench-v1-explore-and-send-design.md`: §4 protocol-neutral
  core, §7 the reserved `kind: rest` discriminator, §10 style, §12 boundaries, §14 the REST item), the workspaces
  design (`docs/specs/2026-09-11-wirebench-workspaces-design.md`: workspace environments and endpoint overrides),
  the environments design (`docs/specs/2026-09-12-wirebench-layout-and-environments-design.md`: the `disabled`
  list, inspectors, the right rail), ADR-0003 (project folder format), ADR-0004 (secrets), ADR-0005 (path safety),
  ADR-0006 (workspaces), and `docs/roadmap.md` item 6.
- Decisions this spec needs from the owner are collected in §15, each with the default the rest of the document
  assumes.

## Assumptions I'm making

1. **REST lives in the same project as SOAP.** A project keeps its `interfaces/` (SOAP, unchanged) and gains an
   `apis/` folder. One workspace, one project, one set of environments serves both; the explorer shows them side by
   side. There is no separate "REST project" type.
2. **The REST container is called an _API_, not a collection.** The workspaces design already uses "collection" for
   what a project is, and the environments design bans the word from UI copy. _API_ is short, is what an OpenAPI
   document describes, and is the word a gRPC service will also fit under later (§8). Inside an API: _folders_ and
   _requests_.
3. **This is a format bump, `formatVersion: 3`.** New top-level folder, new file kinds, a `kind` on history entries
   and new auth types. Under ADR-0003 any additive change bumps the version; the migration from 2 is a no-op (a
   version-2 project has no `apis/`), and a 1.1.0 build refuses a version-3 project with its existing clear error.
4. **The HTTP transport is reused as is.** `packages/engine/src/http` already does methods, redirects, TLS, proxy,
   compression, timings, raw capture and NTLM/Basic. REST adds URL composition, bodies, auth types and response
   decoding on top; it does not fork the client.
5. **No new runtime dependency is required for the core.** OpenAPI parsing (a bounded subset), `$ref` resolution,
   JSON Schema sample generation, multipart encoding and cookie parsing are written in-house, like the WSDL and MIME
   code was. Two optional dependencies are put to the owner in §9 (JSONPath, JSON Schema validation); the design
   works without them.
6. **Scripting, tests and assertions stay in the functional-testing phase.** This spec ships explore-and-send for
   REST; the assertion catalogue, pre-request scripts and data-driven runs extend to REST when that phase lands and
   are only anticipated here (the Query view, the history record).
7. **gRPC is designed for, not built.** §8 fixes the shapes gRPC needs (a `kind` union with `grpc` reserved and
   refused, an API generated from a definition and cached like a WSDL, per-kind editors behind one dispatcher, a
   response record that can hold several messages) and names what is deliberately not pre-built.
8. **UI copy never names other tools.** Behaviour is described on its own terms, in this document and in the
   product.

→ Correct any of these and the spec changes accordingly.

---

## 1. Objective

**What.** A REST/HTTP client inside Wirebench: hand-built or OpenAPI-imported APIs with folders and requests beside
SOAP interfaces; a request editor with method, URL, params, headers, body, auth and settings; a response pane with
pretty, raw and preview bodies, headers, cookies, redirects, timing and TLS; Basic, NTLM, Bearer, API-key and OAuth2
authentication; environments and property expansion shared with SOAP; history, search, diff and cURL both ways.

**Why.** Most estates are mixed. A SOAP-only tool loses the "one tool" argument the moment a team's newer services
speak JSON, and every one of Wirebench's differentiators (git-friendly projects, secrets in the keychain, one
environment switch across projects, a keyboard-first shell, no account) applies to REST unchanged.

**Who.** The existing user (integration engineer, QA, support) whose services are partly REST; developers exploring a
third-party OpenAPI document; teams that want SOAP and REST calls in one reviewable project folder.

**User stories.**

- I create an API called `Orders`, set its base URL to `${#Env#ordersBase}`, add a `GET /orders/{id}` request with a
  path parameter and an `Accept` header, press Send, and read the JSON response pretty-printed with its status,
  duration and size.
- I import an OpenAPI 3 document by URL. I get one API with a folder per tag and a request per operation, path and
  query parameters already listed, and an example body for every `POST`; the document is cached beside the project,
  byte for byte, like a WSDL.
- I set the API's auth to OAuth2 client credentials with the client secret in the keychain; every request in the API
  inherits it; the token is fetched once, cached for the session, shown redacted, and never written to the project.
- I switch the workspace environment from `dev` to `uat` and the next send of every request in the API goes to the
  `uat` base URL, with the same one switch that moves my SOAP interfaces.
- I paste a `curl` command and get a REST request; I copy any request as `curl` for POSIX or PowerShell from the
  Code slide-over.
- I search history for a URL fragment, open two runs of the same request and diff their JSON responses.
- I commit the project. The diff for renaming one request touches exactly two files, and no token, password or key
  is anywhere in the folder.

**Non-goals (this spec).** GraphQL, WebSocket, Server-Sent Events and gRPC (§8 for gRPC); OpenAPI 2.0 and
AsyncAPI; a cookie jar that persists across sends (§15); mock servers for REST; pre-request scripts, tests and
assertions (functional-testing phase); an OpenAPI _Update Definition_ that preserves edits (roadmap, §15); response
validation against the OpenAPI schema (§15); code generation; certificate pinning.

---

## 2. Concepts

| Term            | Meaning                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API**         | A REST container inside a project: a name, a base URL, optional default auth, an optional cached OpenAPI definition, and a tree of folders and requests. Stored under `apis/<slug>/`.         |
| **Folder**      | A named, ordered node in an API's tree. Holds folders and requests; may carry a default auth its children inherit.                                                                          |
| **REST request**| `kind: rest`. Method, URL (absolute or relative to the API's base URL), path and query parameters, headers, one body, auth (`inherit` by default), per-request settings.                       |
| **Interface**   | Unchanged: a SOAP interface under `interfaces/`.                                                                                                                                             |
| **Base URL**    | The API's `baseUrl`, overridable per environment exactly as an interface's endpoint is, and expandable with `${…}` properties.                                                                |
| **Definition**  | For an imported API, the OpenAPI document and every document it references, cached under `apis/<slug>/definition/` with a manifest — the same shape as `interfaces/<slug>/definition/`.        |

The `kind` discriminator that `interface.yaml` and `*.request.yaml` have carried since v1 now takes a second value.
Its type becomes `'soap' | 'rest'` with `'grpc'` reserved: the loader refuses a file whose `kind` is `grpc` with a
clear "not supported by this version" error rather than dropping it (§8).

---

## 3. Functional scope

### 3.1 APIs and folders

- **Create** (_New API…_ on the project row, and the command palette): name, base URL. Slug from the name by the
  ADR-0005 rules. An API and an interface in the same project may not share a slug: creation appends a numeric
  suffix, and the loader reports the pair as a project problem and skips the API.
- **Edit** in an _API_ tab (opened by a single click on the API row, like the project tab): name, description, base
  URL with the environment override shown beside it, the server list an import recorded (a datalist for the base
  URL), default auth (§3.5), the definition's source and fetch date when imported.
- **Folders**: create, rename, reorder by drag or _Move Up_/_Move Down_, move between folders and APIs of the same
  project by drag, delete with confirmation when non-empty. Depth is capped at 8 so a Windows path stays under
  `MAX_PATH` with room for a long request name.
- **Requests**: create in any folder or at the API root (`Request N`, opened with the URL focused), rename in place,
  duplicate, move, delete. Order is explicit (`order`), as for operations and requests today.
- **Delete API** removes the folder tree with confirmation; the definition cache goes with it.

### 3.2 The request

One REST request editor per tab (§7.2). Everything below is saved in `<slug>.request.yaml` except the raw body, which
lives beside it (§4).

- **Method**: `GET POST PUT PATCH DELETE HEAD OPTIONS`, plus a free-text custom method (uppercased, token characters
  only) since some services use `PURGE`, `LOCK` or `REPORT`.
- **URL**: one field. Absolute (`https://…`) or relative to the API's effective base URL (`/pets/{petId}`). Path
  parameters are `{name}` and appear in the _Params_ table as they are typed; `${…}` property expansion applies to
  every part of the URL, params, headers and body. Query parameters typed into the URL are split into the table and
  the table is written back into the URL; the two are one model, never two.
- **Params**: a _Path_ table (name, value, description, always enabled: an unfilled path parameter is a preflight
  problem) and a _Query_ table (name, value, enabled, description; duplicates allowed; order kept). Values are
  percent-encoded on send unless the request setting `encodeUrl` is off; a value that is already encoded is not
  encoded twice (the encoder skips valid `%XX` sequences).
- **Headers**: name, value, enabled, description; order kept; duplicates allowed. The editor shows, greyed and
  read-only, the headers the send will add on its own (`Host`, `User-Agent`, `Accept-Encoding`, `Content-Type` and
  `Content-Length` from the body, `Authorization` from auth) so the wire picture is complete before Send; a typed
  header of the same name wins, as it does for SOAP today.
- **Body**, one of:
  - _None_.
  - _Raw_ with a language: `json`, `xml`, `text`, `html`, `javascript`. The language picks the editor mode and the
    default `Content-Type` (`application/json`, `application/xml`, `text/plain`, `text/html`,
    `application/javascript`), which a typed header overrides. JSON gets Monaco's JSON validation as a warning, never a
    block on send. A per-request _escape properties_ toggle JSON- or XML-escapes substituted property values,
    mirroring the SOAP _entitize_ property; off by default.
  - _Form_ (`application/x-www-form-urlencoded`): name, value, enabled rows.
  - _Multipart_ (`multipart/form-data`): rows of text or file parts; file parts reuse the attachment model
    (`AttachmentSource`: content-addressed cache or a path under the resource root) and the file picker path that
    attachments already use, with an optional file name and content type per part. Boundary is generated per send.
  - _Binary_: one file, one content type.
  - A `GET`, `HEAD` or `DELETE` with a body sends it (some services want it) and shows a hint; nothing is silently
    dropped.
- **Auth** (§3.5): `inherit` by default, resolved request → folder chain → API.
- **Settings** (per request, each _inherit_ unless set, resolving request → API → preferences): timeout, follow
  redirects (default on for REST, unlike SOAP), max redirects, encode URL, verify TLS (`trustInvalid` with the same
  permanent red badge an endpoint gets today), client keystore (`sslKeystoreRef`), bind address, max response size,
  send cookies from the last response of this request (§3.3), keep the body on a `301`/`302` (§3.3).
- **Description**: Markdown, shown in the _Details_ inspector; imported from the OpenAPI operation.

### 3.3 Sending and the response

- **Send** (`Mod+Enter`, the toolbar button) resolves in main, as today: environment base URL → property expansion
  across `Env → Project → Workspace → Global` → auth secrets → keystore → TLS/proxy → `sendRest()` in the engine
  (§5) → history. **Cancel** is the same abort path SOAP uses. A preflight (§3.4) blocks the send on an unfilled path
  parameter or an unresolved property, with the problem in the console.
- **Redirects**, in the engine's own loop (not undici's): `307`/`308` keep method and body; `303` becomes a `GET`
  without body; `301`/`302` on a non-`GET` become a `GET` (browser behaviour) unless the request's _keep body on
  301/302_ setting is on. Every hop is listed in the response pane with its status and location, and a method change
  is called out in the HTTP log. The `Authorization` header is dropped on a cross-origin hop.
- **Response pane**: status line with reason phrase, colour by class, duration, size (body and total), the protocol
  (`HTTP/1.1` or `2`). Tabs:
  - _Body_ with a view switch: **Pretty** (JSON, XML and HTML formatted, Monaco read-only in the matching mode, fold,
    find, copy path on a JSON node), **Raw** (exactly the decoded bytes as text), **Preview** (images — `image/*` —
    rendered from bytes handed over IPC; everything else shows a hex view). The body's language is detected from
    `Content-Type`, then sniffed from the first bytes when the header is missing or `text/plain`. Above a preference
    threshold (`rest.prettyPrintMaxBytes`, default 5 MB) Pretty is disabled with a note and Raw is virtualised.
    Non-UTF-8 charsets in `Content-Type` are decoded with the same table SOAP sends use.
  - _Headers_ (name, value; sorted as received), _Cookies_ (every `Set-Cookie`, parsed into name, value, domain,
    path, expires, secure, HttpOnly, SameSite), _Redirects_, _Timing_ (the existing waterfall: DNS, connect, TLS,
    TTFB, download), _TLS_ (the existing SSL inspector: protocol, cipher, chain, verified), _Raw_ (the reconstructed
    request and response bytes, redacted as today).
  - _Query_ (§3.10).
- **Cookies**: no persistent jar in v1 (§15). Each request remembers the cookies its **own** last response set, for
  the session only, and re-sends the ones whose domain and path match when its _send cookies_ setting is on (off by
  default). The Cookies tab shows what was received and, on the request side, a greyed `Cookie` header shows what
  will be sent. Nothing about cookies reaches the project folder.
- **Save response** to a file (bytes as received, decoded), and _Copy_ for body, headers and the status line.
- **Errors** are the existing `HttpError` codes with their existing readable messages in Problems: DNS, refused,
  timeout, TLS, untrusted certificate (with the endpoint's trust action), too large, too many redirects.

### 3.4 Property expansion and preflight

The `${#Env#name}`, `${#Project#name}`, `${#Workspace#name}`, `${#Global#name}`, `${#System#name}` and shorthand
`${name}` syntax applies to the base URL, URL, path and query values, header values, form and multipart text
values, the raw body and auth fields (token and key values are secret refs and never expanded). Resolution is the
existing `resolveScopes` path with the `disabled` list honoured. The existing preflight (`expansion-preflight.ts`)
gains the REST fields; unresolved references and unfilled `{path}` parameters are Problems and block Send, as today.

### 3.5 Authentication

One auth model for both kinds. `EndpointAuth` grows into `AuthConfig`, a discriminated union on `type`:

| `type`               | Fields (secrets are refs, never values)                                                                                                                                                                                      | Applies to           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `inherit`            | —                                                                                                                                                                                                                          | REST request, folder |
| `none`               | —                                                                                                                                                                                                                          | all                  |
| `basic`              | `username`, `passwordRef`, `preemptive`                                                                                                                                                                                    | all (exists)         |
| `ntlm`               | `username`, `passwordRef`, `domain`, `workstation`                                                                                                                                                                         | all (exists)         |
| `bearer`             | `tokenRef`, `scheme` (default `Bearer`)                                                                                                                                                                                    | all                  |
| `api-key`            | `name`, `valueRef`, `in: 'header' \| 'query'`                                                                                                                                                                              | all                  |
| `oauth2`             | `grant: 'client-credentials' \| 'authorization-code'`, `tokenUrl`, `authorizationUrl` (code only), `clientId`, `clientSecretRef`, `scopes[]`, `audience`, `clientAuth: 'basic' \| 'body'`, `pkce` (code only, default on), `refreshTokenRef` (optional, see below) | all                  |

- **Inheritance for REST**: a request with `inherit` walks its folder chain to the API; the first non-`inherit` wins;
  an API with no auth means `none`. The Auth inspector shows the effective source ("inherited from folder _Admin_")
  exactly as the Details inspector shows an endpoint's source today. SOAP keeps its `override`/`complement` endpoint
  semantics unchanged; SOAP interfaces, endpoints and requests may now use `bearer`, `api-key` and `oauth2` too
  (roadmap: "reusable by SOAP requests"), through the same inspector.
- **OAuth2** runs entirely in main (`apps/desktop/src/main/oauth2.ts`):
  - _Client credentials_: a `POST` to `tokenUrl` with the client credentials in a Basic header or the body per
    `clientAuth`, scopes and audience; through the same TLS and proxy settings as any send.
  - _Authorization code_: main starts a loopback listener on `127.0.0.1` at a random port, bound to that address
    only, single-use, with a random `state` and a PKCE verifier; opens `authorizationUrl` in the system browser
    through the existing http(s)-only `shell.openExternal` path; waits at most five minutes; exchanges the code at
    `tokenUrl`; closes the listener. The redirect URI the user registers with their provider is shown in the
    inspector as `http://127.0.0.1:<port>/callback` with a _fixed port_ option for providers that require an exact
    match.
  - **Tokens** live in a per-session memory cache in main keyed by a hash of the auth config; a send whose token is
    within 30 s of expiry refreshes (with a refresh token when one was issued, else re-runs the grant; the
    authorization-code grant never re-opens the browser silently — it fails the send with a "sign in again" problem
    and a button in the inspector). The access token is never written to disk. A refresh token is kept only when the
    user ticks _Remember refresh token_, as a secret behind `refreshTokenRef`, so it obeys ADR-0004 like any password.
  - The inspector shows token status (obtained at, expires in, scopes granted), _Get new token_, _Clear_, and the
    token itself only under the existing session-scoped _show secrets_ switch.
- **Redaction**: `Authorization`, `Proxy-Authorization`, an API key in a header or query string, `Cookie` and
  `Set-Cookie` values, and OAuth2 client secrets and tokens are redacted in the HTTP log, raw views and history
  unless _show secrets_ is on for the session (`redact.ts` learns the query-string case).

### 3.6 OpenAPI import

_Import OpenAPI…_ (project row, command palette): a URL or a file, JSON or YAML, OpenAPI **3.0.x and 3.1.x**.
Swagger 2.0 is refused with a message naming the version (§15).

- **Fetching and caching** reuse the WSDL path: the root document and every document a `$ref` points at (relative
  file or URL) are fetched under the same reference policy (`wsdl/ref-policy.ts`, generalised), cached byte-exact
  under `apis/<slug>/definition/` with a `manifest.yaml` (location → file, `fetchedAt`, `sha256`), and can be
  exported and re-opened from the API tab as the WSDL viewer does. Cancel works mid-import.
- **Mapping**:
  - `info.title` → API name (editable at import); `servers[0].url` with its variables' defaults substituted → base
    URL; every server → the server list.
  - **Folders** from the operation's first `tag` (fallback: the first path segment; `x-tagGroups` is not read).
  - **One request per operation**, named from `summary`, else `operationId`, else `METHOD /path`, in document order.
    Path parameters from `parameters` (path-level merged with operation-level, operation wins) with `example`, else
    `default`, else empty. Query parameters listed with required ones enabled and optional ones disabled, values as
    for path. Header parameters as disabled headers. `deprecated` operations get a badge and a folder `Deprecated`
    only when they would otherwise be lost.
  - **Bodies**: the first `requestBody.content` entry whose media type is JSON, then XML, then form, then multipart,
    then anything else. The body text is the media type's `example`, else the first of `examples`, else a sample
    generated from its schema. A binary media type becomes an empty _Binary_ body with the content type set.
  - **Sample generation** from JSON Schema (`rest/openapi/sample.ts`, in-house): `example` > `default` > first
    `enum` > type default (`""`, `0`, `false`, `[]` with one item, `{}`); required properties always, optional ones
    per the existing `includeOptional` preference; `allOf` merged, `oneOf`/`anyOf` take the first branch; `$ref`
    cycles cut at a depth of 8 with `null`; `format` picks realistic placeholders (`date-time`, `uuid`, `email`,
    `uri`) only when the `sampleValues` preference is on. XML bodies honour the `xml` object (`name`, `attribute`,
    `wrapped`, `prefix`/`namespace`).
  - **Security**: `securitySchemes` of type `http` (`basic`, `bearer`), `apiKey` (header or query; cookie is skipped
    with a note) and `oauth2` (`clientCredentials`, `authorizationCode`) become the API's default auth when the
    document has one global `security` requirement, else the first scheme is offered in the import dialog. Secrets
    are left unset. Per-operation `security` that differs from the global one becomes that request's own auth with the
    same mapping.
  - Everything the mapping does not understand (callbacks, links, webhooks, `x-` extensions) is skipped and counted;
    the import summary lists the counts and the operations affected.
- **Re-import** of the same document (same `definition.source`) into an existing API is not offered in this spec.
  _Import_ always creates a new API; a preserving _Update Definition_ is roadmap (§15).

### 3.7 cURL both ways

- **Export**: the Code slide-over shows the active REST request as `curl` (POSIX and PowerShell, as today), with
  the resolved URL, every enabled header, the body inline (raw, `--data-urlencode` for form, `-F` for multipart,
  `--data-binary @file` for binary) and the auth as it will go on the wire — redacted unless _show secrets_ is on.
  `http/curl.ts` is generalised to take an `HttpSendInput` and the SOAP exporter becomes a caller of it.
- **Import**: _Import cURL…_ gains a target: when pasted into a REST context (an API or folder row, or the REST
  request editor) it produces a REST request — method, URL split into base and path when it matches the API's base,
  query into the table, headers, body by the most specific flag (`-F` → multipart, `--data-urlencode` → form,
  `-d`/`--data-raw`/`--data-binary` → raw with the language from `Content-Type`), `-u` → basic auth with the password
  offered to the keychain, `-k` → `trustInvalid`, `-L` → follow redirects, `-X`. The existing SOAP import is unchanged.

### 3.8 Environments

The existing endpoint override map applies to APIs. A workspace environment's `endpoints` (keyed
`"<projectSlug>/<slug>"`) and a linked project's own environment `endpoints` (keyed `<slug>`) may name an API slug,
whose value overrides the API's base URL; the uniqueness rule in §3.1 keeps the key unambiguous. The Environments
view's endpoints table gains a row per API under each project, labelled with a REST badge, using the same
`environment-endpoint` control and the same `update-workspace-environment` path. The _effective_ label reads
workspace / project / API.

### 3.9 History, search and diff

- Every REST send is a history entry with `kind: rest`: method, resolved URL (query redacted where an API key lives
  there), status, duration, size, `ok` (a `2xx` or `3xx` without a transport error), the request headers and body
  text, the response headers and body text, the redirect chain, the error if any. Bodies above the existing size cap
  are stored truncated with a flag; binary bodies are stored as content type and size only, with the bytes reachable
  for the session through the existing exchange cache (`exchanges.get`).
- History search matches method, URL, status and the request name; the list shows a method badge instead of the
  SOAP version. Resend works. Diff works on the two bodies, pretty-printed when both are JSON or XML.
- Workspace search (`search.query`) covers REST requests: name, URL, header names and values, body text.

### 3.10 Query view

For a JSON response the Query tab evaluates **XPath 3.1 / XQuery 3.1 over the JSON** through the engine's existing
evaluator — `parse-json()`, maps and arrays are part of XPath 3.1, so `?items?*[?status = "open"]?id` works with no
new dependency. For an XML response it is the existing view. A **JSONPath** mode is put to the owner in §9/§15: it is
what most REST users reach for first, it is one small dependency, and the functional-testing phase will want it for
assertions.

---

## 4. Data model and project format

### 4.1 Folder layout

```
my-service/
  wirebench.yaml                          ← formatVersion: 3
  interfaces/…                            ← unchanged
  apis/
    petstore/
      api.yaml                            ← kind: rest, id, name, order, description, baseUrl, servers[], auth, definition
      definition/                         ← only when imported
        manifest.yaml                     ← source → file, fetchedAt, sha256 (same shape as an interface's)
        openapi.yaml                      ← exact bytes
        schemas/…                         ← every referenced document, exact bytes
      requests/
        get-pet.request.yaml              ← a request at the API root
        get-pet.body.json                 ← its raw body, when the body is raw
        pets/
          folder.yaml                     ← id, name, order, description, auth
          list-pets.request.yaml
          create-pet.request.yaml
          create-pet.body.json
          admin/
            folder.yaml
            delete-pet.request.yaml
  attachments/                            ← shared with SOAP: multipart and binary bodies that were cached
```

Rules, all inherited from ADR-0003 and ADR-0005: UTF-8, stable key order, `exact<T>()` validation with unknown keys
dropped, slugs derived from names by the path-safety rules, every write containment-checked, deterministic
serialisation. The raw body is a sibling file with an extension chosen by its language (`.body.json`, `.body.xml`,
`.body.txt`, `.body.html`, `.body.js`) so it diffs and highlights as what it is; form and multipart bodies are small
and live in the YAML. Renaming a request touches exactly its two files. A directory under `requests/` without a
`folder.yaml` loads as a folder named after the directory and gets its file on the next save.

### 4.2 Files

`api.yaml`:

```yaml
kind: rest
id: 01JD6X5K3Q8ZVQ2N7YH0M4B9SE
name: Petstore
order: 0
description: The public example service.
baseUrl: https://petstore3.swagger.io/api/v3
servers:
  - url: https://petstore3.swagger.io/api/v3
    description: Production
auth:
  type: api-key
  name: api_key
  in: header
  valueRef: sec_01JD6X…
definition:
  source: https://petstore3.swagger.io/api/v3/openapi.json
  cache: true
  version: 3.0.4
```

`folder.yaml`: `{ id, name, order, description?, auth? }`.

`<slug>.request.yaml`:

```yaml
kind: rest
id: 01JD6X6A9…
name: Get pet by id
order: 1
description: Returns a single pet.
method: GET
url: /pet/{petId}
pathParams:
  - name: petId
    value: '42'
query:
  - name: verbose
    value: 'true'
    enabled: false
headers:
  - name: Accept
    value: application/json
body:
  kind: raw
  language: json
  file: get-pet.body.json
auth:
  type: inherit
settings:
  timeoutMs: 30000
  followRedirects: true
```

Body variants, on disk: `{kind: none}`; `{kind: raw, language, contentType?, file}`; `{kind: form, fields: [{name,
value, enabled?, description?}]}`; `{kind: multipart, parts: [{name, kind: text | file, value?, source?, fileName?,
contentType?, enabled?}]}`; `{kind: binary, source, contentType}`. `enabled` is written only when `false`. `source` is
the existing `AttachmentSource`.

### 4.3 Engine model (`packages/engine/src/rest/model.ts`)

```ts
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | (string & {});

export interface KeyValueEntry {
  readonly name: string;
  readonly value: string;
  readonly enabled: boolean; // serialised only when false
  readonly description?: string;
}

export type RestBody =
  | { readonly kind: 'none' }
  | { readonly kind: 'raw'; readonly language: RawLanguage; readonly contentType?: string; readonly text: string }
  | { readonly kind: 'form'; readonly fields: readonly KeyValueEntry[] }
  | { readonly kind: 'multipart'; readonly parts: readonly MultipartPart[] }
  | { readonly kind: 'binary'; readonly source: AttachmentSource; readonly contentType: string };

export interface RestRequestDef {
  readonly kind: 'rest';
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  readonly method: HttpMethod;
  readonly url: string;
  readonly pathParams: readonly KeyValueEntry[];
  readonly query: readonly KeyValueEntry[];
  readonly headers: readonly KeyValueEntry[];
  readonly body: RestBody;
  readonly auth: AuthConfig; // `inherit` by default
  readonly settings: RestRequestSettings; // every field optional = inherit
}

export interface RestFolder {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  readonly auth?: AuthConfig;
  readonly folders: readonly RestFolder[];
  readonly requests: readonly RestRequestDef[];
}

export interface RestApi {
  readonly kind: 'rest';
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  readonly baseUrl: string;
  readonly servers: readonly { readonly url: string; readonly description?: string }[];
  readonly auth?: AuthConfig;
  readonly definition?: { readonly source: string; readonly cache: boolean; readonly version: string };
  readonly folders: readonly RestFolder[];
  readonly requests: readonly RestRequestDef[];
}
```

`Project` gains `readonly apis: readonly RestApi[]`. `RequestDef` is renamed `SoapRequestDef` with a type alias kept
for one release; the union `AnyRequestDef = SoapRequestDef | RestRequestDef` is what id-keyed lookups return.
`HistoryEntry` gains `readonly kind: 'soap' | 'rest'`; an entry without the field (every existing `.jsonl` line)
reads as `soap`, so history needs no migration. Its request/response records become a per-kind union (§8 explains why
the response side is kept open for a message sequence).

### 4.4 Format version and migration

`FORMAT_VERSION` becomes 3. Migration 2 → 3 sets `apis: []` and rewrites the manifest on the next save; the `kind`
union widens; `EndpointAuth` files with the existing two types load unchanged into `AuthConfig`. A version-4-or-later
file is refused as today. ADR-0003 gets an update paragraph; a new ADR-0007 records that an API is a first-class,
kind-discriminated container beside interfaces (and why it is not a second project type), because it constrains the
gRPC work.

---

## 5. Engine

New module `packages/engine/src/rest/`, Node-only like the rest of the engine, every I/O entry point taking an
`AbortSignal`, every export with JSDoc, errors as `WirebenchError` subclasses with stable codes.

```
rest/
  model.ts               ← §4.3
  url.ts                 ← composeUrl(base, url, pathParams, query, {encode}): joins base and relative path, fills {name},
                            encodes query (RFC 3986, skips valid %XX), parses a URL's query back into entries; parseUrlParams
  body.ts                ← encodeBody(body, resolvers) → { bytes, contentType }: raw with charset, form, multipart (own
                            encoder with a random boundary, files through the AttachmentResolver), binary
  auth.ts                ← applyAuth(effectiveAuth, resolvedSecrets) → headers/query additions; effectiveAuth(chain)
  send.ts                ← sendRest(input: RestSendInput): Promise<RestExchange> — composes url, body, auth, headers,
                            calls http/client.ts sendHttp with the engine's redirect rules (§3.3), decodes the response
  response.ts            ← detectLanguage(contentType, bytes), decodeText(bytes, charset), pretty(json|xml|html),
                            parseSetCookie(rawHeaders) → Cookie[]
  cookies.ts             ← the per-request session cookie match (domain/path/secure/expiry) used by main
  curl.ts                ← toCurl for HttpSendInput (the SOAP exporter delegates); fromCurl → partial RestRequestDef
  openapi/
    model.ts             ← the consumed subset of OpenAPI 3.0/3.1 as readonly types
    parse.ts             ← JSON or YAML → model, zod-validated (tolerant: unknown keys kept, counted when skipped)
    refs.ts              ← $ref resolution: local JSON pointers, relative documents through the injected fetcher and the
                            reference policy; cycle-safe
    sample.ts            ← JSON Schema → sample value (§3.6); XML bodies through the `xml` object
    import.ts            ← importOpenApi(source, options) → { api: RestApi, definition: CachedDefinition, summary }
    cache.ts             ← definition manifest read/write (shares wsdl/cache-naming.ts)
  oauth2.ts              ← token request shapes (client credentials, code exchange, refresh) as pure functions over
                            sendHttp; PKCE verifier/challenge; no listener here (that is main)
```

`project/{schema,serialize,load,save,migrate}.ts` learn `apis/`; `project/history.ts` learns `kind`; `http/curl.ts`
is generalised; `send-options.ts` gains `toRestSendInput()` with the same precedence rules (request → API → project →
preference). `index.ts` exports the new surface; nothing SOAP-specific changes signature.

`RestSendInput`, like `SoapSendInput`, receives fully resolved values: the effective base URL, the request, the
effective `AuthConfig` with secrets already substituted (`SendAuth` grows `bearer`, `api-key` and a pre-fetched
`oauth2` access token), `tls`, `proxy`, `timeoutMs`, `followRedirects`, `maxRedirects`, `localAddress`,
`maxSizeBytes`, the cookies to send, and the attachment resolvers. `RestExchange` is an `HttpExchange` plus the decoded
text, detected language, parsed cookies and the redirect chain.

---

## 6. Main process

- **IPC**, in `apps/desktop/src/shared/ipc.ts` with zod pairs as today:
  - `request.send`, `request.cancel`, `request.curl`, `request.preflight` keep their shape and dispatch on the
    request's kind inside main (the renderer sends an id, never a URL). `request.importCurl` gains a `target`
    (`{ kind: 'soap', … }` as today, or `{ kind: 'rest', apiId, folderId? }`).
  - `api.importOpenApi` (`{ projectId, source: {kind:'url'|'file'|'text'}, name?, cache }`, progress over
    `engine.progress`, cancel via `api.cancelImport`), `api.definitionDocuments` / `api.definitionText` /
    `api.exportDefinition` mirroring the `definition.*` channels for interfaces.
  - `oauth2.fetchToken` (`{ ownerId }` — an API, folder or request id; main finds the config), `oauth2.status`,
    `oauth2.clearToken`, `oauth2.cancel`. The response carries status, expiry and scopes; the token value only when
    `secrets.getShowSecrets` is on.
  - `project.mutate` gains change kinds: `add-api`, `update-api` (patch: name, description, baseUrl, servers, auth),
    `remove-api`, `add-folder`, `update-folder`, `remove-folder`, `move-node` (a folder or request to a parent at an
    index), `add-rest-request`, `update-rest-request` (patch of every §4.3 field, body included), plus the existing
    `clone-request` / `remove-request` / `update-request-auth` working by id for both kinds.
- **`ProjectHost`** applies the new kinds (`project-rest-mutations.ts`), keeps `dirty` per project as today, and its
  drafts/unsaved-changes record (`unsaved-store.ts`) holds REST request patches beside SOAP ones, keyed by request
  id with the kind.
- **Send** (`send-with-history.ts`) branches on kind after the shared resolution: environment base URL
  (`endpoint-override` precedence unchanged), scopes, `secret-resolver.ts` for `tokenRef`/`valueRef`/
  `clientSecretRef`/`refreshTokenRef`, `oauth2.ts` for a cached or fresh token, keystore and TLS, proxy; then
  `sendRest()`; then the redacted `kind: rest` history entry and the exchange cache.
- **OAuth2** (`apps/desktop/src/main/oauth2.ts`): token cache, the loopback listener (§3.5), refresh. It is the only
  new listener in the app and is covered by the security model page: bound to `127.0.0.1`, random or user-fixed port,
  one pending flow at a time, five-minute timeout, `state` and PKCE enforced, closed after one response, never
  reachable from the renderer except through the four channels above.
- **Redaction** (`redact.ts`): the additions in §3.5; API-key query parameters are redacted by name from the URL
  wherever a URL is logged or stored.
- **Watch and reload** (`project-watch.ts`): `apis/**` is watched like `interfaces/**`; an external edit to a body
  file reloads that request.

---

## 7. Renderer

### 7.1 Explorer

New node kinds `api`, `folder`, `rest-request` under a project, ordered after its interfaces (a project's `order` of
interfaces and APIs is one list, so the user can interleave). The API row has a REST badge; a request row shows its
method as a coloured monospace badge before the name (`GET` green, `POST` amber, `PUT` blue, `PATCH` violet,
`DELETE` red, others grey — tokens added to the palette, contrast-checked). Context menus: API (_Open_, _New
folder_, _New request_, _Import cURL…_, _Rename_, _Duplicate_, _Delete_, _Reveal definition_ when imported); folder
(_New folder_, _New request_, _Rename_, _Move…_, _Delete_); request (_Open_, _Send_, _Rename_, _Duplicate_,
_Copy as cURL_, _Move…_, _Delete_). Drag and drop reorders and moves within a project. Fold state is remembered per
workspace as today.

### 7.2 REST request editor (`features/rest-editor/`)

One tab kind `rest-request`, dispatched by the existing request-tab opener on the request's kind
(`features/request-editor/` stays SOAP-only). Layout, top to bottom:

- **Path** line (project / API / folder… / request), the same breadcrumb component, with rename in place.
- **URL bar**: method select (`rest-method`), URL field with `${…}` and `{param}` highlighting and the environment's
  effective base URL as a greyed prefix when the URL is relative (`rest-url`), _Send_ (`rest-send`, `Mod+Enter`)
  with cancel while in flight, and the overflow menu (_Copy as cURL_, _Save response_, _Recreate from definition_
  when imported).
- **Request tabs** (`rest-params`, `rest-headers`, `rest-body`, `rest-auth`, `rest-settings`), each a table or form
  built from the same inline-editable key-value table the Environments view introduced (`variables-table.tsx`
  generalised to `kv-table.tsx`: enabled checkbox first, name, value, description, add-row last, Enter/Tab/Escape
  semantics, duplicate names allowed here). The Body tab has the kind switch and, for raw, a Monaco editor in the
  chosen language with _Format_ and the escape-properties toggle. Auth shows the effective source and the type form;
  Settings shows every setting with its inherited value greyed until overridden.
- **Response pane** below or beside (the existing request/response split and its layout toggles), with the tabs of
  §3.3 (`rest-response-body`, `-headers`, `-cookies`, `-redirects`, `-timing`, `-tls`, `-raw`, `-query`).
- **Inspector strip**: _Details_ (resolved URL and its base's source, effective auth source, definition operation
  when imported, description), _Properties_ reuses nothing SOAP-specific and is not shown.
- **Dirty state, save, drafts** exactly as SOAP requests: per-tab dot, `Mod+S`, `Mod+Alt+S`, unsaved-across-sessions.

### 7.3 API tab and import dialog

`features/rest-api/api-tab.tsx` (`api-tab`): the fields of §3.1, the definition card (source, fetched at, version,
_Export…_, _View document_ opening the definition viewer already used for WSDLs) and the same auth form. `features/
explorer/import-openapi-dialog.tsx` reuses the WSDL import dialog's shell (URL or file, target project, name,
cache) plus a summary step listing what was created and what was skipped.

### 7.4 Elsewhere

- **History view**: a method badge column; the entry view opens the REST response pane read-only; diff as §3.9.
- **Environments view**: API rows in the endpoints table (§3.8).
- **Code slide-over**: unchanged component, REST-aware content (§3.7).
- **Search**: REST results with a method badge.
- **Preferences**: a _REST_ page: default follow redirects, max redirects, pretty-print limit, default `Accept`
  header (empty by default), OAuth2 fixed callback port (empty = random).
- **Commands** (all in the palette): `rest.newApi`, `rest.newFolder`, `rest.newRequest`, `rest.importOpenApi`,
  `rest.send` (bound to `Mod+Enter` in a REST tab, the same binding SOAP uses), `rest.copyAsCurl`,
  `rest.importCurl`, `rest.getToken`. One new default shortcut is proposed: `Mod+Shift+I` for _Import OpenAPI…_
  (ask-first under v1 §12; §15).
- **Accessibility**: every new control labelled and keyboard reachable; the method badge carries its text, never
  colour alone; axe and contrast gates extend to the new views; a11y snapshots regenerated in their own commit.

---

## 8. Toward gRPC

The user asked that gRPC be possible later. This spec does not build it; it fixes the shapes that would otherwise
have to change, and says what is left open on purpose.

**Fixed now, because changing them later would be a migration:**

1. **`kind` is a three-valued union with `grpc` reserved.** Schemas accept `'soap' | 'rest'`; a `grpc` file is
   refused with a clear error, never dropped or mangled, so a project written by a later build fails loudly in
   this one.
2. **An API is the container for any non-SOAP protocol.** `api.yaml` carries `kind`; a gRPC API will be
   `kind: grpc`, generated from `.proto` files (or server reflection) cached under `definition/` with the same
   manifest, with a folder per service and a request per method — the same shape an OpenAPI import produces. The
   explorer, the API tab, environments' base-URL override (a gRPC target `host:port`), search and history need no
   new container.
3. **One auth model.** `AuthConfig` is protocol-neutral; gRPC metadata takes `bearer`, `api-key` and `oauth2` the
   way headers do. TLS, client keystores, proxy and `trustInvalid` are transport settings, already shared.
4. **The request editor is per kind behind one dispatcher.** The tab opener switches on `kind`; a gRPC editor is a
   third component, not a mode of the REST one.
5. **The history record is a per-kind union whose response side may hold several messages.** A unary gRPC call is
   one request and one response; server streaming is one request and _n_ messages, and the record must not assume
   one body. The REST entry uses a single-message shape of that union, so adding `messages[]` for gRPC is an
   extension, not a rewrite.
6. **The key-value table is shared.** Headers, query parameters, form fields and gRPC metadata are the same
   component and model (`KeyValueEntry`).

**What gRPC will add, and what is not pre-built:**

- **HTTP/2 as a requirement, not an option.** The transport already offers `allowH2` through undici; gRPC needs
  trailers (`grpc-status`, `grpc-message`) and per-message length-prefixed framing, plus the `application/grpc`
  content type. Whether undici's HTTP/2 client exposes trailers and streaming bodies well enough, or whether Node's
  `http2` module is used directly for that kind, is the first spike of the gRPC spec.
- **Protobuf.** Parsing `.proto` and encoding/decoding messages needs a runtime dependency (ask-first). The editor
  will edit messages as JSON (the canonical JSON mapping) with a schema-driven Form view like the XSD one — the
  `xsd/form-model.ts` abstraction is worth generalising then, not now.
- **Streaming.** Client, server and bidirectional streams change the editor (a message list rather than one body)
  and the response pane (messages arriving over time, an end-of-stream marker). The single-message REST shapes are
  chosen so that becomes an extension of the response record, but nothing streaming is built here.
- **Reflection** as an alternative to `.proto` import, and gRPC-Web, are decisions for that spec.
- **Deadlines** map to the existing timeout; **compression** to the existing gzip handling.

A `kind: grpc` reservation is the only line of code this section adds.

---

## 9. Tech stack and dependencies

Unchanged: Electron, React 19, zustand, Radix, Monaco (JSON and HTML modes are already bundled), Tailwind 4,
`undici`, `yaml`, `zod`, `fontoxpath`, vitest, Playwright.

Under v1 §12 every runtime dependency is ask-first. The core of this spec needs **none**. Two are proposed, each
optional:

| Dependency                          | For                                                     | Recommendation                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jsonpath-plus` (MIT)               | JSONPath in the Query view, later in assertions         | **Add** — it is what REST users expect, it is small, and XPath-over-JSON stays available beside it.                                                                                                  |
| `ajv` (MIT) + `ajv-formats`         | Response validation against the OpenAPI response schema | **Defer** to the functional-testing phase, where a _JSON Schema_ assertion needs it anyway; nothing in explore-and-send depends on it.                                                                |

Everything else is in-house: the OpenAPI subset and `$ref` resolver, JSON Schema samples, multipart encoding,
`Set-Cookie` parsing, PKCE, the loopback listener (Node `http` on `127.0.0.1`).

## 10. Commands

Unchanged from v1 §8. Useful subsets: `pnpm test -- rest` (engine and desktop unit tests for the module),
`pnpm build && pnpm test:e2e -- --grep "rest|openapi|oauth2"`, `pnpm fixtures:refresh` (extended to
`fixtures/openapi/public`), `pnpm bench` (the new budgets in §12).

## 11. Code style

v1 §10 applies unchanged. One snippet for the send entry point:

```ts
// packages/engine/src/rest/send.ts
import { sendHttp } from '../http/client.js';
import { applyAuth } from './auth.js';
import { encodeBody } from './body.js';
import { decodeResponse } from './response.js';
import { composeUrl } from './url.js';
import type { RestExchange, RestSendInput } from './model.js';

/**
 * Sends one REST request. Everything is already resolved by the caller: base URL, property
 * expansion, secrets, TLS and proxy. This function only composes the wire request, applies the
 * engine's redirect rules and decodes what came back — so a CLI and the desktop app send
 * identically.
 */
export async function sendRest(input: RestSendInput): Promise<RestExchange> {
  const url = composeUrl(input.baseUrl, input.request.url, input.request.pathParams, input.request.query, {
    encode: input.settings.encodeUrl,
  });
  const body = await encodeBody(input.request.body, input.attachmentResolvers, input.signal);
  const headers = applyAuth(input.auth, mergeHeaders(input.request.headers, body.contentType, input.cookies));
  const exchange = await sendHttp({ ...transportOptions(input), url, method: input.request.method, headers, body: body.bytes });
  return decodeResponse(exchange);
}
```

Conventions specific to this feature: UI copy says _API_, _folder_, _request_, _base URL_, _params_, _headers_,
_body_, _auth_; a method is always uppercase; secrets are _references_ in every label; no other product is named.

## 12. Testing strategy

| Level                | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit (engine)        | `url.ts`: join rules (base with and without trailing slash, absolute URL wins, `{param}` fill, missing param error, encoding incl. already-encoded values, unicode, duplicate query names, table ⇄ URL round-trip); `body.ts`: each body kind's bytes and content type, multipart boundary and file parts, charset; `auth.ts`: inheritance chain, every type's header or query, OAuth2 client-credentials request shape, PKCE vectors (RFC 7636 appendix); `response.ts`: language detection and sniffing, charset decoding, pretty printers, `Set-Cookie` parsing (RFC 6265 cases); `cookies.ts` matching; `curl.ts` both directions, golden files; `openapi/*`: parse 3.0 and 3.1 fixtures, `$ref` local/relative/cyclic, sample generation golden files per construct, security mapping, the skip counters; project load/save round-trip of every file in §4, slug collision, folder depth cap, migration 2 → 3, `kind: grpc` refused, history `kind` default |
| Integration (engine) | Against the in-process test server: every method, bodies of each kind echoed back, redirect matrix (301/302/303/307/308 × GET/POST, keep-body setting, cross-origin auth drop), Basic and NTLM challenge (existing), Bearer and API key (header and query), OAuth2 client credentials and authorization code against a stub authorisation server (state, PKCE, refresh, expiry), gzip/deflate/br, large body cap, cancel mid-flight, timeouts, binary responses, non-UTF-8 charsets                                                                                                                                                    |
| Interop (opt-in)     | Nightly only, `WIREBENCH_NETWORK_TESTS=1`: import two public OpenAPI documents (recorded in `fixtures/openapi/SOURCES.md`) and make one read-only `GET` against each                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Component            | Explorer nodes and menus for the three new kinds; the key-value table (commit/revert, enabled, add-row, duplicates allowed); URL bar ⇄ params sync; body kind switch keeps each kind's draft; auth inspector effective-source label and the token status states; settings inherit display; response body view switch, size threshold, cookies table; history badge and diff; environments API rows; import dialog summary; the exact `project.mutate` change sent for each edit                                                                                                                                                       |
| E2E                  | `rest.spec.ts`: new API → request → send to the test server → JSON pretty → headers/cookies/timing tabs → history entry → resend → diff; environment base-URL override changes the target; unresolved property and missing path param block send with Problems; rename touches two files; `openapi-import.spec.ts`: import a fixture by URL and by file, tree matches the golden shape, an imported `POST` sends its sample body; `oauth2.spec.ts`: client credentials against the stub, token status, redaction with and without _show secrets_; `curl.spec.ts`: paste → request, copy → golden; `secrets.spec.ts` extended: a project with every REST auth type saved, folder grepped for the token and key values; `a11y.spec.ts` and `keyboard.spec.ts` extended |
| Static               | `pnpm check` incl. contrast for the method colours, banned terms, doc paths, third-party licences for any added dependency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Performance          | Budgets in `packages/engine/test/bench/budgets.ts`: import a 1 MB OpenAPI document with 300 operations < 1 s; sample generation for the fixture set < 200 ms; pretty-print a 5 MB JSON body < 500 ms; REST send overhead (engine, excluding network) < 20 ms; e2e: a 5 MB response renders Raw without dropping below 50 fps while scrolling                                                                                                                                                                                                                                                                                                 |

Fixtures: `fixtures/openapi/public/` (two well-known example documents, refreshed by `pnpm fixtures:refresh`, sources
and dates recorded) and `fixtures/openapi/crafted/` (one document per construct: every parameter location, every body
media type, `allOf`/`oneOf`, cyclic `$ref`, relative `$ref` across files, `xml` object, each security scheme, server
variables, deprecated operations, 3.1 `webhooks`). The engine's test server and `e2e/helpers/test-server.ts` gain JSON
routes: echo (method, headers, body, cookies), status by path, redirect matrix, auth by type, gzip, slow, chunked,
an image, a stub OAuth2 authorisation and token endpoint.

## 13. Boundaries

**Always** — v1 §12, ADR-0003, ADR-0004, ADR-0005; renderer sends ids, never URLs, bodies or secrets to send; every
new file kind zod-validated with `exact<T>()`; secrets by ref only, tokens never on disk unless the user opts a
refresh token into the keychain; redaction extended before any new value can be logged; `packages/engine/src/rest`
Electron-, DOM- and React-free; every I/O entry takes an `AbortSignal`; keep existing testids and channels working for
SOAP; regenerate snapshots only after the suite is green, in their own commit; clean-room — REST behaviour is
implemented from RFC 9110/9111 (HTTP semantics and caching), RFC 3986 (URIs), RFC 6265 (cookies), RFC 6749/7636/8252
(OAuth2, PKCE, native apps), RFC 7578 (multipart), OpenAPI 3.0/3.1 and JSON Schema 2020-12.

**Ask first** — the two dependencies in §9; the `Mod+Shift+I` shortcut; the format bump is approved by accepting
this spec, any further field is a new ask; any loosening of the renderer CSP (HTML preview, §15); any change to
`shell.openExternal`'s allow-list; a fixed OAuth2 callback port below 1024; OpenAPI 2.0 support.

**Never** — write an access token, refresh token, client secret, API key or cookie into a project file, a history
line or an unredacted log; bind the OAuth2 listener to anything but `127.0.0.1`; follow a redirect with the
`Authorization` header to a different origin; let the renderer read a token value outside the session _show secrets_
switch; name another tool in UI copy, code or docs; change SOAP behaviour as a side effect (its tests stay green
untouched).

## 14. Success criteria

1. **Model and format.** A project with two APIs (one hand-built, one imported), nested folders and every body and
   auth kind saves, reopens byte-identically, and passes the "rename touches exactly two files" test; a version-2
   project opens and is rewritten at version 3; a `kind: grpc` file is refused with a readable error (unit + e2e).
2. **Send.** Every method and body kind reaches the test server correctly; the response pane shows status, duration,
   size, pretty and raw bodies, headers, cookies, redirects, timing and TLS; cancel works; errors are readable
   Problems (integration + e2e).
3. **Auth.** Basic, NTLM, Bearer, API key (header and query) and OAuth2 (both grants) succeed against the test
   server and the stub authorisation server; inheritance resolves request → folder → API; a saved project folder
   contains none of the secret values (grep test); tokens are redacted unless _show secrets_ is on (integration +
   e2e).
4. **OpenAPI.** Every crafted fixture and both public fixtures import with the expected tree, parameters, sample
   bodies and auth; the cached definition is byte-identical; the summary lists what was skipped (unit golden + e2e).
5. **Environments and properties.** An environment override changes an API's base URL for the next send with the
   same switch that moves SOAP interfaces; `${…}` expands in URL, params, headers and body; unresolved references and
   unfilled path parameters block Send with a Problem (e2e).
6. **History, search, cURL, query.** Every REST send is in History with a method badge, resend and diff work;
   workspace search finds a request by URL; cURL round-trips through golden tests; the Query view evaluates XPath
   3.1 over a JSON response (and JSONPath if approved) (unit + e2e).
7. **Shell.** Explorer shows APIs beside interfaces with drag-and-drop; the REST editor's tabs, the API tab and
   the import dialog are keyboard-reachable and pass the axe and contrast gates; all SOAP e2e specs are green
   unchanged; `pnpm check` green on three OSes; README, architecture overview, ADR-0003 update, ADR-0007,
   `docs/security.md` (loopback listener) and the changelog updated.
8. **Performance.** The §12 budgets hold in CI.

## 15. Open questions (defaults in bold; the spec above assumes them)

1. Name of the container: **_API_**, or _Collection_ despite the existing use of the word for projects?
2. Format: **`formatVersion: 3` with a no-op migration**, accepted as part of approving this spec.
3. JSONPath: **add `jsonpath-plus` now** beside XPath-over-JSON, or XPath only until the testing phase?
4. Cookie jar: **per-request session cookies only, no jar**; a workspace-wide session jar with a manager is a
   follow-up.
5. HTML preview of a response: **not in v1** — it needs a sandboxed frame and a CSP decision that deserves its own
   security review; Pretty and Raw show the markup.
6. OpenAPI 2.0: **refused with a clear message**; a converter step is a follow-up if asked for.
7. OpenAPI _Update Definition_ with preserved edits, like the WSDL one: **follow-up**, on the roadmap under the REST
   theme.
8. Response validation against the OpenAPI response schema: **functional-testing phase**, with the `ajv` ask.
9. `Mod+Shift+I` for _Import OpenAPI…_: **yes**; no other new default shortcut.
10. Where an OpenAPI import's folders come from: **first tag, else first path segment**; a _by path_ option in the
    import dialog is cheap if wanted.
11. Should SOAP endpoints gain `bearer`/`api-key`/`oauth2` in this spec (through the shared inspector) or in a
    later one: **now**, since the model and inspector are shared and the cost is tests only.
    — _Amended during implementation (W5):_ the cost is not tests only. `AuthConfig` and the inspector are indeed
    shared, but the project **format** persists a SOAP interface, endpoint and request under `endpointAuthSchema`
    (`none`/`basic`/`ntlm`), and the SOAP send path applies only the two schemes the transport owns. Offering the
    others to SOAP owners needs the schema widened at three sites, the engine's auth types widened with it, a
    SOAP-side `applyAuth` for the header and query schemes, and main resolving the new references — a format change
    that deserves its own review rather than a corner of the auth-UI task. **Deferred** to the roadmap entry the
    §3.5 parenthetical already pointed at; the shared form offers SOAP owners only what the format can store
    (`SOAP_AUTH_TYPES`), so nothing silently drops a token in the meantime.

## 16. Risks

| Risk                                                             | Impact                                       | Mitigation                                                                                                                                                              |
| ---------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAPI documents in the wild are messy (invalid `$ref`s, 3.1 nullable, vendor extensions) | Imports fail or produce empty APIs           | Tolerant parser that counts and reports skips instead of failing; crafted fixtures per construct; nightly interop against public documents                              |
| OAuth2 provider quirks (exact redirect URI, no PKCE, non-standard token responses)         | Sign-in fails in the field                   | Fixed-port option, PKCE toggle, `clientAuth` switch, the raw token exchange visible in the HTTP log (redacted), stub server tests for each variant                        |
| Large JSON responses in Monaco                                    | Frozen renderer                              | Size threshold, virtualised Raw view, perf budget in e2e                                                                                                                |
| Shared auth model changes SOAP paths                             | SOAP regressions                             | `EndpointAuth` files load unchanged; SOAP e2e suite must stay green untouched (§14.7)                                                                                    |
| Scope creep toward scripting and tests                           | The phase slips                              | §1 non-goals; assertions and scripts are explicitly the next phase; the Query view is read-only                                                                          |
| Pre-building for gRPC that gRPC then does not want              | Dead abstractions                            | §8 fixes only what a migration would otherwise cost (the `kind` union, the container, the history union); everything else is left to the gRPC spec                       |

## 17. Delivery

Sequenced as checkpoints for the plan, each ending with `pnpm check` green and the e2e suite unchanged for SOAP:

- **A. Model and transport.** `rest/` model, URL, body, response, send; project format and migration; history kind;
  engine and integration tests; the test server routes.
- **B. Shell.** Explorer kinds, REST editor, API tab, response pane, drafts and save, history and search; e2e
  `rest.spec.ts`.
- **C. Auth.** The shared `AuthConfig`, inspector, Bearer and API key, OAuth2 in main with the stub server; redaction;
  `oauth2.spec.ts`; security docs.
- **D. OpenAPI.** Parser, refs, samples, import and cache, dialog; fixtures; `openapi-import.spec.ts`.
- **E. Round-out.** cURL both ways, Query view, environments rows, preferences page, README and architecture docs,
  ADR-0003 update and ADR-0007, changelog, screenshots.
