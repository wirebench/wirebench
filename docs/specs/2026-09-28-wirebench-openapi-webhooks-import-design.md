# Wirebench: `openapi-webhooks-import` — design

Date: 2026-09-28 · Status: draft 2026-09-28, design approved by the owner in conversation · Module:
`openapi-webhooks-import` of `docs/specs/2026-09-24-wirebench-server-capability-map.md` (third slice)

- Builds on:
  - `docs/specs/2026-09-27-wirebench-server-webhook-capture-design.md`: catch URLs, captures and
    the desktop capture viewer (the *Catch URLs* target picker and *Save as webhook* use them).
  - The REST model (`packages/engine/src/rest/model.ts`), the OpenAPI importer and its update flow
    (`packages/engine/src/rest/openapi/`), and the project format (`packages/engine/src/project/`).
  - ADR-0015: values taken from a response are never expanded again.
- Decisions recorded here (2026-09-28):
  - **Webhooks are a first-class item a user can create by hand; OpenAPI import is one way to fill
    them.** The capability map's "a *Webhooks* folder of requests" is widened accordingly.
  - **Each project has one webhook collection, beside its APIs; its items reuse the REST request
    type and the REST sender.**
  - *Save as webhook* on a capture is in scope. This supersedes the line in the `webhook-capture`
    spec (§1.2) that listed "saving it as a request" as not chosen.
  - The module is written ahead of its place in the build order; the order itself is unchanged.

## 1. Goal

A developer integrating with a provider that calls *them* (a payment provider, a source host, their
own platform) needs to fire realistic events at their own receiver on demand: to build and debug the
handler without waiting for the provider, and to replay an event that really arrived. Wirebench
should let them define those outbound events once, by hand, from the provider's OpenAPI document, or
from a captured request, and send them to a receiver they choose.

### 1.1 In scope

- A per-project *Webhooks* collection: folders and webhook items, created, edited, renamed, moved,
  duplicated and deleted like REST requests, edited in the REST request editor.
- A target set once on the collection and overridable per folder; each item adds a path.
- Import of OpenAPI 3.1+ `webhooks` and OpenAPI 3.0+ operation `callbacks` from the OpenAPI import
  dialog, and *Import webhooks…* on an API imported earlier.
- Callback URLs resolved from the standard's runtime expressions against the last exchange of the
  parent operation, with a fallback to the target.
- Imported webhooks kept in step by the existing *Update definition* flow.
- *Save as webhook* on a capture.

### 1.2 Out of scope

- Signing outgoing webhooks: module `webhook-signatures`, which must now **sign outgoing webhooks
  with a preset as well as verify captured ones** (recorded in §9).
- Asserting that a webhook arrived: module `callback-assertion`.
- Checking the receiver's reply against the response schema the document gives for a webhook.
- OpenAPI `links`, which stay reported as skipped.
- Swagger 1.x and 2.0, which have neither `webhooks` nor `callbacks`.

## 2. Approach

| Approach | Why not / why |
| --- | --- |
| The *Webhooks* node as a hidden `RestApi` with `kind: 'webhooks'` | Most reuse, but every surface that lists APIs (environment `baseUrl` overrides, definition fetch, the importer's matching, Explorer ordering) would need an exclusion; one missed check is a bug. Rejected. |
| A new item type with its own editor and sender | Clean separation, but duplicates the REST request stack, and every later request feature is paid for twice. Rejected. |
| **A project-level collection `project.webhooks` whose items are `RestRequestDef`, sent through the REST sender with `baseUrl` set to the resolved target** | Reuses the folder tree, its files, the editor, auth, assertions and history; the new code is the collection, the target and the import. **Chosen.** |

## 3. UX

### 3.1 Explorer

- Each project shows a **↪ Webhooks** node after its APIs and interfaces, once the collection exists
  (first create or import). An empty collection shows the node with a *New Webhook* hint.
- Items show a ↪ icon, the method and the name. A callback adds its operation in a muted suffix:
  `onPetEvent · createSubscription`.
- An imported group is a folder named after its API, with a link badge. Hand-made webhooks live at
  the collection root or in folders the user creates.
- Context menus:
  - project → *New ▸ Webhook* (creates the collection if needed);
  - *Webhooks* node or folder → *New Webhook*, *New Folder*, *Settings…*;
  - item and folder → rename, move, duplicate, delete, as for REST requests;
  - an API → *Import webhooks…* (§3.4).

### 3.2 Settings (node or folder)

- **Target**: a text field with variable autocomplete and a *Catch URLs ▸* submenu listing the
  workspace's catch URLs. The submenu is present only when the project's workspace is shared on a
  server whose `/meta` reports capture enabled; picking one writes its full URL.
- A folder shows *inherits: <value>* until it overrides the target; *Reset* removes the override.
- **Auth** on the node: what items whose auth is *inherit* use (the API auth panel, reused).

### 3.3 Editor

- The REST request editor. The URL bar reads `METHOD  Target · <path>` and shows the resolved URL
  under it: `→ https://my-app.dev/hooks/newPet`.
- On a callback the bar shows the document's expression, and a note gives the source of the URL:
  *from your last POST /subscriptions (10:42)* or *expression unresolved — using Target*.
- A chip in the header: *webhook · Petstore API* for imported items, *webhook* for hand-made ones.
- Params, headers, body, auth, assertions, response pane and history work as for a REST request.
- Empty resolved target: *Send* is disabled, with the tooltip *Set the Webhooks target* and a link to
  *Settings…*.

### 3.4 Import

- The OpenAPI import dialog gains a **Webhooks & callbacks (n found)** section, hidden when n = 0:
  one row per item (name, *webhook* or *callback of <operationId or METHOD path>*), all ticked, an
  *all* toggle, and the line *→ added to <project> ▸ Webhooks ▸ <API name>*.
- *Import webhooks…* on an API opens the same list, read from the API's stored definition. Items
  already imported are shown ticked and disabled (*already imported*). With no stored definition the
  menu item is disabled with the reason.

### 3.5 Update definition

The existing *Update definition* dialog gains a **Webhooks +n ~n −n** block under *Operations*,
listing each added, changed and removed item. Removed items become *orphaned* (struck through in the
tree), never deleted. Hand-made webhooks are never listed. If the linked group no longer exists, the
block reads *Webhooks not imported — Import webhooks…* and applies nothing to webhooks.

### 3.6 Save as webhook

- A *Save as webhook…* button on a capture in a catch URL tab.
- The dialog asks for the project (projects open in the workspace), the folder in its *Webhooks*
  collection, and the name, prefilled from a top-level string `type` field of a JSON body, else
  `<METHOD> <sub-path>`.
- Disabled, with the reason, when the captured body was truncated or is binary.

## 4. Model

In `packages/engine/src/webhooks/model.ts`:

```ts
interface Project { /* … */ readonly webhooks?: WebhookCollection }

interface WebhookCollection {
  readonly target: string;              // default '${webhookTarget}'
  readonly auth?: AuthConfig;
  readonly folders: readonly WebhookFolder[];
  readonly requests: readonly RestRequestDef[];
}

type WebhookFolder = RestFolder & {
  readonly target?: string;             // the nearest folder with a target wins
  readonly source?: { readonly apiId: string }; // imported group → its API
  readonly folders: readonly WebhookFolder[];
};

type HookLink =
  | { readonly kind: 'webhook'; readonly name: string }
  | {
      readonly kind: 'callback';
      readonly operation: string;       // contract key of the parent, e.g. 'post /subscriptions'
      readonly name: string;            // callback name
      readonly expression: string;      // the path-item key, verbatim
    };

interface RestRequestDef { /* … */ readonly hook?: HookLink }
```

- An item's `url` is a path joined to its resolved target; an absolute `http(s)://` URL ignores the
  target, the rule an API's `baseUrl` already follows.
- Methods are kept as the document gives them. A webhook or callback defining several methods yields
  one item per method; the update key is `hook` plus the method.
- Deleting an API clears `source` on its group, which then stays as a plain folder.
- Creating the collection seeds an empty project property `webhookTarget` only when neither the
  project nor its workspace already defines one (R12). Resolution follows the Env → Project →
  Workspace chain: an environment's value overrides the project's, and a project value — even an
  empty one — wins over the workspace's. Deleting the project property falls back to the workspace
  value.
- `hook` is only valid on requests inside the collection; `target` and `source` only on its folders.

## 5. Files

`FORMAT_VERSION` is bumped by one; `migrate` stamps the new version as it does today.

```
webhooks/
  webhooks.yaml                                   target, auth
  requests/
    order-created.request.yaml
    petstore-api/
      folder.yaml                                 + target?, source?
      new-pet.request.yaml                        + hook
```

- `serialize.ts` gains `addWebhooksFiles`, which writes `webhooks.yaml` and reuses `addFolderFiles`
  for the tree (depth cap 8). `load.ts` gains `loadWebhooks`, reusing `loadFolderContents`.
  `save.ts`'s managed-file list includes `webhooks/`.
- `schema.ts` gains `webhooksFileSchema`; the folder and request schemas accept `target`/`source`
  and `hook` only when loaded under `webhooks/`, and reject them elsewhere.
- Every walker of `project.apis` joins the collection: `request-location.ts`, `secrets/scan/walk.ts`
  and `apply.ts`, `run/select.ts` (the CLI and runner can select webhooks), and the desktop's project
  wire, renderer state and REST mutations (rename, move, duplicate, delete).

## 6. Import, callbacks and sending

### 6.1 Parsing

- `parse.ts` reads root `webhooks` for OpenAPI 3.1 and later, and operation `callbacks` for 3.0 and
  later. Their path items' operations go through `parseOperation`, so parameters, request bodies,
  responses and `$ref`s behave as for operations.
- `OpenApiDocument` gains `webhooks: readonly OpenApiHook[]` and `OpenApiOperation` gains
  `callbacks: readonly OpenApiCallback[]` (name, expression, operations).
- `webhooks` and `callbacks` leave the skipped list; `links` and vendor extensions stay in it. A 3.0
  document with a root `webhooks` key keeps the skipped entry *webhooks need OpenAPI 3.1*.

### 6.2 Runtime expressions

`packages/engine/src/rest/openapi/runtime-expression.ts` parses the standard's grammar:

- `$url`, `$method`, `$statusCode`;
- `$request.header.<name>`, `$request.query.<name>`, `$request.path.<name>`,
  `$request.body#<json-pointer>`, and the same under `$response.` (no `path`, no `query`);
- templates mixing literal text and `{expression}` parts, such as
  `https://notify.example.com/cb?id={$request.body#/id}`;
- JSON-pointer escapes `~0` and `~1`; header names case-insensitive.

A key that does not parse is kept verbatim and is always unresolved. Parsing never fails an import.

### 6.3 Mapping

`webhooksFromDocument(document, options)` in `map.ts` returns one `WebhookFolder` named after the
API, `source.apiId` set, holding one item per webhook and callback method, built by the existing
`buildRequest`/`bodyOf` (bodies sampled from schema and examples, headers and query parameters).
A webhook's `url` is `/<name>`; a callback's is `/<callback name>`, used only in the fallback. Names
repeated across operations stay distinct by the operation suffix; slugs go through `uniqueSlug`.

### 6.4 Update

`planRestUpdate` gains webhook rows keyed by `hook` plus method; `applyRestUpdate` merges them with
the same `mergeRows` rules as operations (an untouched generated value follows the document, an
edited or added one is kept, a removed item is marked `orphaned`). New items land in the linked
group; without a linked group nothing is applied to webhooks (§3.5).

### 6.5 Resolving a callback's URL

At send time, for an item with `hook.kind === 'callback'`:

1. Find the parent request: in the API named by the group's `source.apiId`, the request whose
   contract key equals `hook.operation`.
2. Take that request's newest history entry (request and response).
3. Evaluate `hook.expression` against it. A result that is an absolute `http(s)` URL is the URL sent
   to, used verbatim: values from an exchange are never expanded again (ADR-0015).
4. Otherwise (no group link, no parent, no history, a missing value, not a URL) use the target plus
   `url`. The editor note (§3.3) says which applied and why.

### 6.6 Sending

`resolveWebhookSend` (desktop main, beside `rest-send.ts`) builds the ordinary `RestSendInput`:

- `baseUrl` = the nearest folder `target`, else the collection `target`, expanded through the usual
  scopes (Env → Project → Workspace), or the callback URL of §6.5;
- `auth: inherit` resolves to the collection `auth`;
- TLS, proxy and cookie settings as for REST.

The send then goes through `sendAndRecordHistory`, so the response pane, assertions and history work
unchanged. An empty resolved target fails with `webhook-target-missing` before any network call.

### 6.7 Save as webhook

The capture becomes a `RestRequestDef`:

- method: the captured method;
- `url`: the sub-path after `/hooks/<secret>` plus the query string;
- headers: the captured ones minus hop-by-hop and transport headers (`host`, `content-length`,
  `connection`, `transfer-encoding`, `keep-alive`, `upgrade`, `te`, `trailer`, `proxy-*`,
  `x-forwarded-*`, `forwarded`, `x-request-id`) and minus any header whose name contains
  `signature` (it would be stale);
- body: mode from the `Content-Type` (JSON, XML, form, else text).

## 7. Errors

| Code | When | UI |
| --- | --- | --- |
| `webhook-target-missing` | the resolved target is empty | *Send* disabled, tooltip and link to *Settings…* |
| `webhook-target-invalid` | the resolved target is not `http(s)` | inline error under the URL bar |
| `webhook-definition-missing` | *Import webhooks…* on an API with no stored definition | menu item disabled with the reason |
| `webhook-save-truncated`, `webhook-save-binary` | *Save as webhook* on a truncated or binary capture | button disabled with the reason |
| — | a callback expression does not resolve | not an error: editor note and fallback (§6.5) |
| existing format refusal | an older build opens a project with the new `FORMAT_VERSION` | unchanged |

## 8. Testing

- Engine unit tests:
  - runtime expressions: every grammar form, templates, pointer escapes, invalid keys;
  - parsing 3.0, 3.1 and 3.2 documents (root `webhooks` on 3.0 stays skipped with its note);
  - mapping: sampling, several methods per item, repeated names, slugs;
  - update: add, change with edits kept, orphaning, hand-made items untouched, missing group;
  - files: round trip of `webhooks/`, rejection of `target`/`source`/`hook` elsewhere, format bump;
  - walkers: the secret scan finds references in webhooks; run selection includes them.
- Desktop unit tests: `resolveWebhookSend` (target inheritance, environment override, callback from
  history, fallback, no re-expansion of exchange values, empty target), the *Save as webhook*
  mapping, Explorer nodes and menus, the import dialog section, the update dialog block.
- e2e (CI only): import a sample with a webhook and a callback; set the target to a catch URL on the
  fake server and send, seeing the capture arrive; *Save as webhook* from that capture; update with a
  second version showing +1 ~1 −1.
- Docs: a guide page on sending webhooks, the OpenAPI import page, `CHANGELOG.md`, and the
  capability map row. No product that inspired the feature is named (`pnpm check:banned-terms`).

## 9. Later modules

- `webhook-signatures`: besides verifying captures, a signing preset and secret on the *Webhooks*
  collection or a folder, applied to outgoing webhooks at send time.
- `callback-assertion`: may pair a webhook send with a wait on a catch URL.

## Revisions after planning

- **R1 — import dialog selection.** The OpenAPI import dialog has no preview step (only AsyncAPI
  previews), so the dialog shows one checkbox *Import webhooks & callbacks* (ticked) before *Import*,
  and the result lists what was imported with *→ added to <project> ▸ Webhooks ▸ <API>*. Per-item
  ticking is offered by *Import webhooks…* on an existing API (which reads the cached definition
  first). §3.4 otherwise unchanged.
- **R2 — naming.** The existing workspace root label *Webhooks* becomes *Webhook inbox*; the new
  per-project node is *Webhooks*. Internal kinds stay `webhooks`/`catch-url`; new kinds are
  `webhook-collection`, `webhook-folder`, `webhook-request`.
- **R3 — CLI/runner.** `run/select.ts` selects webhook items as REST items against a synthetic API
  whose `baseUrl` is the item's effective target. The runner has no history, so a callback always uses
  the target fallback there.
- **R4 — callback exchange.** A callback expression is evaluated against the parent request's newest
  REST history entry: request URL = `entry.endpoint`, method = `entry.method`, request headers =
  `entry.request.headers`, request body = `entry.request.envelopeXml`, response status/headers/body =
  `entry.response.status` / `rawHeaders` / `envelopeXml`. `$request.path.<name>` matches the parent's
  `contract.path` template against the endpoint path.
- **R5 — wire.** Webhook folders and requests travel to the renderer as `RestFolderWire` /
  `RestRequestWire` rows whose `apiId` is the collection id `webhooks:<projectId>`, plus a `webhooks`
  wire per project. The REST editor and the REST mutations therefore work on them with small, explicit
  branches.
- **R6 — hook key.** Update matches imported items by `hookKey`: `webhook <name> <method>` or
  `callback <operation> <name> <method>` (the expression is refreshed on merge, not part of the key).
- **R7 — update leaves partial imports alone.** *Update definition* never brings back an item a
  partial *Import webhooks…* left unticked: `applyWebhookUpdate` only appends an item from the new
  document that neither the old document's mapping nor the current group already accounts for — one
  the group never held stays absent rather than reappearing.
- **R8 — unresolved target reports the property, not the shape.** `resolveWebhookSend`'s target check
  only raises `webhook-target-invalid` ("The Webhooks target must start with http:// or https://") for
  a *resolved* target that isn't `http(s)`. When the target still holds a `${…}` reference nothing
  resolved, the check stands aside and the send's own unresolved-reference list refuses it, naming the
  reference — the same reporting path REST and SOAP sends already use.
- **R9 — update dialog on an unimported API, and counted toasts.** *Update definition* on a definition
  whose webhooks were never imported shows *Webhooks not imported — Import webhooks…* instead of a
  diff, and applies nothing to webhooks until they are. A successful apply's toast appends however many
  webhooks were added, orphaned, restored and rewritten to the existing operation counts.
- **R10 — target field highlighting.** The Target field in the Webhooks settings dialog is a
  `PropertyHighlightInput`, the same highlighted field the URL bar uses, so a `${…}` in a webhook
  target is as visible there as in a request's own URL bar. Neither field offers property
  autocomplete.
- **R11 — a run sends webhook items only when selected.** `selectRequests(project, [])` leaves the
  webhook items out: a webhook delivers to the user's own receiver rather than testing an API, and
  an existing `wirebench run` with no selector must not start sending to it. An item joins a run only
  when a selector covers it, by item path (`Webhooks/…`) or disk path (`webhooks/requests/…`).
- **R12 — seeding `webhookTarget`.** Creating the collection seeds the empty project property only
  when neither the project nor the workspace defines `webhookTarget`. A project value, even empty,
  wins over the workspace's, so seeding over a workspace value would hide it; deleting the project
  property falls back to the workspace value, and environments still override both.
