# API- and folder-level scripts — design

Issue: #334. Builds on typed scripting (#63, `docs/specs/2026-09-28-typed-scripting-design.md`) and holds to
ADR-0016 (scripts run with no capabilities).

## Goal

A SOAP interface, a REST API, a gRPC API, and each REST or gRPC folder can carry a pre-request and a post-response
script, as a request can. When a request is sent, the scripts of every level above it run around its own: API, then
each enclosing folder outermost first, then the request. That is the same order credentials are inherited in. A
token fetched, a header signed or a check shared once for a whole API is written once.

## Scope

In:

- `scripts` on an API (`api.yaml`), a SOAP interface (`interface.yaml`) and a REST or gRPC folder (`folder.yaml`),
  with script files beside them.
- Order and failure rules (§Running), in the app, `wirebench run`, `wirebench send`, sequences and the MCP server.
  They all send through the engine's script session.
- Type-checking every level before a send (§Types).
- Editing: an API's and an interface's **Scripts** tab, and a folder's **Scripts…** dialog.
- The response **Script** tab shows each level that ran, in order, with its tests, log and failure.
- The Postman importer places collection and folder scripts on the API and folders, not copied into each request.
- Project format 9, documented.

Out:

- A project-wide level above every API. Owner decision, 2026-10-11.
- SOAP folders: an interface has operations, not folders. An operation is not a level.
- WebSocket containers, which have no scripts.
- What `pm.sendRequest`, `setNextRequest` and the like do. That is #335, and it changes no part of this design: a
  level's script runs through the same layer as a request's.
- The other importers' scripts. They keep writing them under `imported-scripts/` and never run them.

## Storage: format 9

`api.yaml`, `interface.yaml` and `folder.yaml` accept the same `scripts` key a request file has (`scriptsSchema`):
`pre`, `post`, `api`, `enabled`, `secrets` and `timeoutMs`. An older build would drop the key and send without the
level's scripts, so `FORMAT_VERSION` goes from 8 to 9. The 8 → 9 migration is a stamp.

The file names are fixed. As for a request, they are derived and never read from the YAML:

| Level               | Files, beside its YAML                                        |
| ------------------- | ------------------------------------------------------------- |
| REST or gRPC API    | `apis/<slug>/api.pre.ts`, `api.post.ts` (`.js` for `postman`) |
| SOAP interface      | `interfaces/<slug>/interface.pre.ts`, `interface.post.ts`     |
| REST or gRPC folder | `<folder dir>/folder.pre.ts`, `folder.post.ts`                |

An API's and an interface's files sit outside `requests/` and `operations/`, so nothing else can claim them. A
folder's files share their directory with its requests. A request slugged `folder` would also own `folder.pre.ts`.
Owner decision: keep `folder.pre.ts`, and handle that one clash:

- On load, a folder with scripts claims the file first. A request slugged `folder` in the same directory that also
  has scripts is a `script-file-clash` problem, and its scripts load as `script-file-missing`, so it refuses to
  send.
- On save, a folder with scripts that holds a request slugged `folder` with scripts is refused with `duplicate-slug`.
  Renaming the request fixes it.

A missing or oversized level script is the same problem as on a request (`script-file-missing`,
`script-too-large`). Every request under that level refuses to send, because sending it would skip a script its
API says to run.

## Running

`ScriptedRequest` gains `outer`: the active scripts of each level above the request, outermost first. A level is
active when it has a script and is switched on. Each level is switched on and off on its own. Switching off a
request's own scripts leaves its API's and folders' scripts running.

- **Pre-request:** each level's pre-request script runs in order on the request the previous one handed back. The
  first failure stops the chain, and the request is not sent.
- **Post-response:** each level's post-response script runs in order on the same response. Owner decision: a
  failure does not stop the later levels, because the response is kept anyway and each level's checks stand on their
  own. Every level's tests are recorded, and the request errors with the first failure.
- **Values:** a value a script sets is seen by every script after it in the same send, at any level and in either
  phase, as a request's post-response script sees its pre-request script's values today.
- **Secrets:** each level lists its own `secrets`, and its scripts read only those. The run resolves the union once,
  before the request connects, and hands each level its own.
- **Timeouts:** each script has its own level's `timeoutMs`.
- A request whose own scripts are off or missing still runs its levels' scripts. `scriptsOff` (a request with scripts
  that ran none) is set only when no level ran at all.

The `scripts` feature switch and a protocol without a scripting facet refuse a request with any active level, as they
refuse one with active scripts of its own today.

## Types

Owner decision: a level's script is checked against the request-script contract for its protocol and phase,
without any one operation's message types. A level runs for many operations, so this is the same check in the editor
and in `wirebench run`. Each level is checked once per send, and the cache is keyed by text and declarations.

- Each protocol's scripting facet gains `levelTypes(): string`. It is the generated half a request gets when its
  operation is unknown: `soapScriptTypes(undefined)`, `restScriptTypes(undefined)`, or
  `grpcScriptTypes(undefined, '', '')`.
- At run time a SOAP level script gets the same typed-body view (`binding`) as the request it runs for, so
  `request.body` holds the same value at every level. Only the type it is checked against is the generic one.
- `wirebench run` checks every level of every selected request before it sends anything. An error names the
  level's file: `api.pre.ts`, `Orders/folder.pre.ts` (the folder path inside the API), or `<slug>.pre.ts`.

## Results

`SentScripts` gains `levels`: one entry per script that ran, in run order, each with
`{ level: 'api' | 'interface' | 'folder' | 'request', name, phase, tests, log, error? }`. Its flat `tests`, `values`, `log` and
`error` are unchanged, so reports, assertions and History read the same as before.

The response **Script** tab lists the levels in order. Each shows its tests, its failure and its log under a heading
such as `API "Shop" · pre-request` or `Folder "Orders" · post-response`. If only the request's own scripts ran, the
tab looks as it does today.

## Editing (desktop)

- REST API tab and gRPC API tab: a **Scripts** section reusing the request **Scripts** editor (both phases, secrets,
  timeout, the switched-off banner).
- SOAP interface editor: a **Scripts** tab, the same editor.
- REST and gRPC folders: **Scripts…** in the explorer's folder menu opens a dialog with the same editor, as
  **Credentials…** does for auth.
- The editor's checker answers a level's script against the level's declarations (§Types).
- One mutation edits the scripts of any request, folder, API or interface by id (`update-request-scripts` takes any
  of those ids). **Switch on scripts** on a folder or API also switches on that level and every level inside it.

## Postman import

A collection's `event`s go on the API, and each folder's go on its folder. A request keeps only its own. They are
still imported on the `postman` layer and switched off, one level at a time. The import warning counts scripted
levels and requests together. Requests no longer get the collection's and folders' text copied in under
`// --- From …` comments.

## Error codes

- `script-file-clash` (load problem): a folder and a request slugged `folder` in the same directory both have
  scripts.

The others are the request-script ones, reported against the level's file.

## Testing

- Engine unit: load/save of every level, the clash, the format stamp, level order across both phases, a failure
  stopping pre and not post, values flowing across levels, per-level secrets, generic level types, Postman placement.
- Engine integration: `runRequests` with API, folder and request scripts on REST, SOAP and gRPC fixtures, and the
  pre-run check naming a level's file.
- Desktop: the mutation on each owner kind, `ScriptHost` lookup and editor model for a level, the Script tab's level
  headings, and an e2e that adds an API script and a folder script and sees both run.

## Docs

`reference/project-format.md` (format 9, the `scripts` key on the three files, the file names), the Scripts guide
(levels and order), the JSON Schemas for v9, and CHANGELOG.
