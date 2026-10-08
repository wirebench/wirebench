# Spec: Exporters — Postman Collection v2.1 and OpenCollection YAML

**Date:** 2026-10-08
**Status:** draft (under review)
**Scope:** all of [#65](https://github.com/wirebench/wirebench/issues/65).

Builds on:

- `docs/specs/2026-09-14-postman-collection-import-design.md`: the Postman importer, whose
  `{{x}}` → `${x}` rewrite and auth rules this exporter runs in reverse.
- `docs/specs/2026-10-04-more-importers-design.md`: Postman environments, OpenCollection YAML and the
  shared credential rule (§3.4) — a secret value never leaves the secret store.
- ADR-0004 (secrets outside project files), ADR-0005 (renderer path safety), ADR-0017 (protocol
  modules).

## 1. Objective

**Why.** A tool people can leave is a tool people dare to adopt. Wirebench reads both formats today;
it writes neither, so a project built in Wirebench is stuck there.

**What.** Export a whole project, or one API or SOAP interface, to:

- **Postman Collection v2.1**: one collection JSON file, plus one environment JSON file per
  environment.
- **OpenCollection 1.0 YAML**: one document holding the collection and its environments.

Every export ends in a **report** of what could not be represented, or was changed to fit.

**User stories.**

- I right-click my project and choose *Export As → Postman Collection…*. I pick a folder. It gets
  `orders.postman_collection.json` and `staging.postman_environment.json`. A dialog lists what did not
  fit: "Orders / Submit / Request 1: WS-Security is not represented".
- I right-click one REST API and export it as OpenCollection. Importing that file back into an empty
  Wirebench project gives me the same requests, folders, auth shapes, assertions and environments.
- In CI I run `wirebench export opencollection --out build/` and publish the file.

## 2. Decisions (owner, 2026-10-08)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Surfaces | Desktop (*Export As…* on a project, an API and an interface) and the CLI (`wirebench export`) |
| 2 | SOAP interfaces | Each SOAP request becomes an HTTP POST of its envelope; what HTTP cannot carry is reported |
| 3 | Postman environments | A folder: the collection file plus one environment file per environment |
| 4 | Scripts | Every script is exported as text, whichever API it is written against; incompatibilities are reported |

Not an MCP tool: an export writes files outside the project, and the MCP gates have no notion of an
output folder. A follow-up may add one.

## 3. Engine

A new core folder, `packages/engine/src/export/`, beside `import/`: one export spans protocols, so it
lives in core like the OpenCollection importer (protocol modules spec §7.2). Pure and browser-safe: it
takes a project and returns text; the host writes the files.

```ts
type CollectionExportFormat = 'postman' | 'opencollection';

interface CollectionExportInput {
  readonly project: Project;
  /** The whole project, or one REST/gRPC/WebSocket API or SOAP interface by id. */
  readonly target: { readonly kind: 'project' } | { readonly kind: 'container'; readonly id: string };
  /** Properties the host adds below the project's own (the workspace's). Default: none. */
  readonly workspaceProperties?: PropertyMap;
  /** Environments to write; the host passes the workspace's and the project's. Default: the project's. */
  readonly environments?: readonly CollectionExportEnvironment[];
}

interface CollectionExportEnvironment {
  readonly name: string;
  readonly properties: PropertyMap;
  readonly disabledProperties: readonly string[];
}

interface CollectionExportFile {
  /** A bare file name: no folder, no `..`; the host joins it under the folder the user picked. */
  readonly name: string;
  readonly text: string;
}

interface CollectionExportResult {
  readonly files: readonly CollectionExportFile[];
  readonly counts: { readonly requests: number; readonly folders: number; readonly environments: number };
  /** `warnings`: what was lost. `notes`: what was changed to fit. Same shape as an import's report. */
  readonly report: ImportReport;
}

function exportCollection(format: CollectionExportFormat, input: CollectionExportInput): CollectionExportResult;
```

`exportCollection` throws `ExportError` with `export-target-not-found` for an unknown container id and
`export-nothing` when the target holds no request.

### 3.1 Shared rules (`export/shared.ts`)

**Variables.** Wirebench text is rewritten to the `{{name}}` syntax both formats share:

| Wirebench | Exported | Report |
| --- | --- | --- |
| `${name}` | `{{name}}` | — |
| `${#Project#name}`, `${#Env#name}`, `${#Workspace#name}`, `${#Global#name}` | `{{name}}` | note, once per scope: the scope is flattened |
| `${secret:name}` | `{{name}}`, and `name` is declared as a secret variable with no value | note, once per name |
| `${#System#…}`, `${#Sequence#…}`, nested `${…${…}…}` | kept as written | warning, once per expression |
| `$${` (escaped literal) | `${` | — |

**Values never written.** A property whose value holds a `${secret:…}` reference keeps the
reference (rewritten as above), never a resolved value: the exporter has no access to the secret
store. Auth keeps its shape and leaves every credential field empty; each auth with a credential
reference (`passwordRef`, `tokenRef`, `valueRef`, `clientSecretRef`, `refreshTokenRef`) or CI name
(`…Env`) gets one warning: "re-enter the credential in the target tool".

**URLs.** A request URL relative to its API's base URL is written absolute: base URL joined with the
request URL (one `/` between them). An absolute request URL is kept. Path parameters `{id}` are written
`:id`, the spelling both formats read.

**SOAP → HTTP.** Each SOAP request becomes a POST:

- URL: `endpointUrl`, else the URL of `endpointId`, else of the interface's default endpoint, else
  the first endpoint; no endpoint at all is a warning and an empty URL.
- Body: the envelope, raw XML, as stored (property references rewritten).
- Headers: its own, plus `Content-Type: text/xml; charset=utf-8` and `SOAPAction: "<action>"` for
  SOAP 1.1, or `Content-Type: application/soap+xml; charset=utf-8; action="<action>"` for 1.2 —
  unless the request sets that header itself or `skipSoapAction` drops the action.
- Auth: request, else endpoint, else interface (basic and NTLM shapes, no password).
- Structure: interface → folder, operation → folder, request → request.
- Reported (warning, once per request): WS-Addressing, outgoing/incoming WS-Security, attachments and
  MTOM. Reported (note, once per interface): endpoints beyond the one used; environment endpoint
  overrides.

**Lost everywhere** (warning, once per kind and owner): Kerberos auth (written as no auth),
assertions the target cannot express, `trustInvalid`, a client keystore, bind address, size limit,
`sendCookies`, `escapeProperties`, a file part or binary body stored in the project's content cache
(written with no file; "pick the file in the target tool"), a script whose file is missing.

**Scripts.** Every script is written as text. A script written against Wirebench's own API is warned
about ("uses Wirebench's script API; the target tool will not run it"); a switched-off script is
noted ("was switched off in Wirebench; it runs in the target tool").

**Names.** File names come from `slugify` of the project, API or environment name, made unique in the
result (`staging`, `staging-2`).

### 3.2 Postman Collection v2.1 (`export/postman.ts`)

Files: `<slug>.postman_collection.json` and `<env-slug>.postman_environment.json` per environment,
JSON with two-space indent and a final newline.

| Wirebench | Postman |
| --- | --- |
| project / target name, description | `info.name`, `info.description`, `info.schema` = the v2.1 schema URL, a fresh `_postman_id` |
| project properties (+ workspace's below them) | collection `variable` (`disabled` kept; a `${secret:…}`-only value → `type: secret`, empty value) |
| whole project | one folder per API and interface, in project order |
| one API | its folders and requests at the root; API auth on the collection |
| folder, description, auth | item group with `item`, `description`, `auth` |
| REST request | item with `request.method`, `request.url` (`raw`, `host`, `path`, `query`, `variable` for path params), `header`, `body`, `auth`, `description` |
| raw body | `mode: raw`, `options.raw.language` (`json`, `xml`, `text`, `html`, `javascript`); a `contentType` override adds a `Content-Type` header when none is set (note) |
| form / multipart / binary body | `urlencoded` / `formdata` (`type: text|file`, `src`) / `file.src` |
| auth `none` / `inherit` | `noauth` / absent |
| basic, bearer, api-key, oauth2, ntlm | the same type, credential fields empty; oauth2 `grant_type` `client_credentials` or `authorization_code` (`_with_pkce` when PKCE is on) |
| settings `followRedirects`, `maxRedirects`, `encodeUrl` | `protocolProfileBehavior.followRedirects`, `.maxRedirects`, `.disableUrlEncoding` (inverted); `timeoutMs` and the rest reported |
| scripts | `event`: `prerequest` / `test`, `script.exec` as lines |
| examples | `response`: `name`, `code`, `status`, `header`, `body` |
| assertions | not represented (warning, with the count) |
| gRPC and WebSocket APIs | not represented by v2.1 (warning, one per API); left out |
| environment | file with `name`, `values: [{ key, value, type: default|secret, enabled }]`, `_postman_variable_scope: environment` |

### 3.3 OpenCollection 1.0 YAML (`export/opencollection.ts`)

File: `<slug>.opencollection.yml`, `opencollection: "1.0.0"`, written with the `yaml` package the
importer reads with.

| Wirebench | OpenCollection |
| --- | --- |
| name, description | `info.name`, `info.description` |
| properties | root `request.variables` |
| environments | `config.environments: [{ name, variables: [{ name, value, secret?, disabled? }] }]` |
| whole project | one `type: folder` item per API and interface |
| one API | its items at the root; its auth as root `request.auth` |
| folder | `info.type: folder`, `request.auth`, `items` |
| order | `info.seq`, 1-based, by Wirebench `order` |
| REST request | `type: http`, `http.method`, `url`, `params` (`type: query|path`, `disabled`), `headers`, `body`, `auth` |
| raw body | `body.type` `json` / `xml` / `text` (`html` and `javascript` written as `text`, noted) |
| form / multipart / binary body | `form-urlencoded` / `multipart-form` / `file` (`filePath`, `contentType`, `selected: true`) |
| auth | `inherit`, `none`, `basic`, `bearer`, `apikey` (`key`, `placement`), `ntlm`, `oauth2` (`flow`, `accessTokenUrl`, `authorizationUrl`, `credentials.clientId`, `credentials.placement`, `scope`, `pkce.disabled`); credentials empty |
| settings | `settings.timeout`, `followRedirects`, `maxRedirects`, `encodeUrl` |
| assertions `status` equals, `sla`, JSON-path `match` with `equals` / `exists` / an escaped-literal `matches` | `runtime.assertions` `res.status eq`, `res.responseTime lt`, `res.body.<path> eq|isNotNull|isNull|contains` |
| any other assertion | reported (warning, with the count per request) |
| scripts | `runtime.scripts`: `before-request` / `after-response` |
| examples | `examples: [{ name, response: { status, statusText, headers, body: { type, data } } }]` |
| gRPC request | `type: grpc`, `grpc.url` (`grpc://` or `grpcs://` + the API's target), `method` `/<service>/<method>`, `methodType`, `message`, `metadata`, `auth`; the `.proto` is not exported (note per API) |
| WebSocket request | `type: websocket`, `websocket.url` with its query, `headers`, `auth`, `message` (the first saved message; the rest reported) |

## 4. Desktop

- **Commands.** `workspace.exportPostman` and `workspace.exportOpenCollection` (*Export Project as
  Postman Collection…*, *Export Project as OpenCollection…*) act on the selected project.
- **Explorer.** The project, API (REST, gRPC, WebSocket) and interface context menus gain *Export as
  Postman Collection…* and *Export as OpenCollection…*.
- **Channel.** `workspace.exportCollection { projectId?, containerId?, format }` →
  `{ cancelled, dir?, files, requests, warnings, notes }`. Main finds the project (by id, or as the
  one holding the container), builds the export first (so a target with nothing to export is refused
  before any dialog), asks for a folder with a native dialog, and writes each file atomically under
  it, replacing a file of the same name. The renderer never names a path (ADR-0005).
- **Report.** After writing, a dialog names the folder and the files and lists the warnings and notes,
  with **Copy report**; with none it says "Everything was exported".

## 5. CLI

```
wirebench export <postman|opencollection> [--project <dir>] [--api <name|slug|id>] [--out <dir>] [--json]
```

`--out` defaults to the current folder and is created if missing. The project's workspace, when
`workspace-lookup` finds one, adds its environments and properties as the desktop does. Prints the files
written, then the report (`Warning:` / `Note:` lines); `--json` prints `{ files, counts, report }`.
Exit 0 on success, even with warnings; 2 on a usage error; 3 (a run error) when the target is not
found or empty.

## 6. Testing

- **Round trip (the proof).** For each format, an export of a crafted project is imported back with the
  existing importer; requests, folders, methods, URLs, params, headers, bodies, auth shapes, scripts,
  assertions (OpenCollection), examples (OpenCollection) and environments match.
- **Unit.** Variable rewrite table; URL join; SOAP → HTTP; each auth type; each body kind; each report
  line; file-name uniqueness; no secret value or credential reference in any output.
- **Desktop.** The main handler: cancelled dialog, files written under the picked folder, report passed
  back; renderer: the menu entries and the report dialog.
- **CLI.** `export` against a fixture project: files, `--api`, `--json`, unknown API.

## 7. Out of scope

- Exporting History, sequences, webhooks, mocks or `.proto` / WSDL definitions.
- The OpenCollection directory form, Postman globals, and an MCP tool.
