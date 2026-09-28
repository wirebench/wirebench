# Wirebench Server: `webhook-capture` — design

Date: 2026-09-27 · Status: draft 2026-09-27, design approved by the owner in conversation · Module:
`webhook-capture` of `docs/specs/2026-09-24-wirebench-server-capability-map.md` (third slice)

- Builds on:
  - `docs/specs/2026-09-24-wirebench-server-host-design.md`: `ServerContext`, `MetaRegistry`, module
    migrations, configuration, `trustProxy`, the single-instance assumption.
  - `…-teams-access-design.md`: workspace roles and `requireWorkspaceRole`.
  - `…-server-sync-design.md`: how the desktop calls the server with a signed-in account.
  - `…-live-updates-design.md`: the in-process hub, after-commit announcements, and the rule that
    `LiveClient` skips a message `type` it does not know (§3.1, *Unknown types*).
- Decision recorded here (2026-09-27): **the server hosts catch URLs that record inbound webhooks for
  a workspace; captures live in Postgres and reach the desktop as a live nudge followed by a fetch.**

## 1. Goal

A team member working on an integration needs somewhere public for a third party (a payment
provider, a source host, their own service) to send webhooks, and a way to see exactly what arrived.
A desktop app cannot be that endpoint: it sits behind NAT and is not always running. Wirebench Server
already has a public URL, accounts and workspace roles, so it can host the endpoint and show every
call to everyone who can view the workspace, live.

### 1.1 In scope

- Catch URLs owned by a workspace, created and managed by its editors.
- A public route that records each inbound request and answers with a per-URL configured response.
- Retention by count and by age; a per-URL rate limit; a server-wide switch.
- A management API, live `capture` and `hooks` events, and a desktop view that lists captures live
  and shows one in the existing response pane.

### 1.2 Out of scope

- Signature verification presets: module `webhook-signatures`.
- A request assertion that waits for a matching capture: module `callback-assertion`.
- Importing OpenAPI `webhooks` and `callbacks`: module `openapi-webhooks-import`.
- Replaying a capture, saving it as a request, and forwarding captures to a local URL: not chosen by
  the owner.
- Several responses per catch URL chosen by matching rules: that is a mock service, not a catch URL.
- A separate listener or host for the public route, and multi-instance fan-out (the hub stays
  in-process, ADR-0013).

## 2. Approach

Three approaches were weighed:

| Approach | Why not / why |
| --- | --- |
| Captures committed into the workspace repository and synced | Every inbound call becomes a commit: history churn, races with people's pushes, and a rotated secret would stay in git history. Rejected. |
| A separate on-disk ring buffer per catch URL | No transactional pruning, no join to roles, and its own backup story. Only worth it if database write volume were a problem, and the rate limit (§3.3) bounds that. Rejected. |
| **Two Postgres tables, a public route, an after-commit `captureReceived` announcement and a live `capture` nudge; the desktop fetches** | Reuses roles, migrations, the hub and the announcement pattern `head` already uses. **Chosen.** |

Catch-URL configuration lives in the database, not in the workspace files: the server must answer
webhooks whether or not anyone has pushed, and a secret must not survive rotation in history.

## 3. Server

### 3.1 Module and registration

`packages/server/src/hooks/` holds the module, `hooks/module.ts` exports `hooksModule()`, and
`BUILTIN_MODULES` registers it after `syncModule()` and before `liveModule()`. Its routes need
teams-access's role guard, and the live module subscribes to its announcements.

Migration: `packages/server/migrations/webhook-capture/0004_webhook_capture.sql`, numbered after
the highest migration on `main` when the plan is written.

### 3.2 Data model

```sql
create table catch_urls (
  id                    text primary key,              -- ULID
  workspace_id          text not null references workspaces on delete cascade,
  name                  text not null,
  secret                text not null,                 -- 128 random bits, Crockford base32, 26 chars
  enabled               boolean not null default true,
  response_status       integer not null default 200 check (response_status between 200 and 599),
  response_content_type text,
  response_body         text,                          -- at most 64 KiB, checked by the API
  response_delay_ms     integer not null default 0 check (response_delay_ms between 0 and 30000),
  created_by            text references users on delete set null,
  created_at            timestamptz not null default now()
);
create unique index catch_urls_secret on catch_urls (secret);
create unique index catch_urls_workspace_name_lower on catch_urls (workspace_id, lower(name));

create table captures (
  id           text primary key,                       -- ULID: sorts by arrival
  catch_url_id text not null references catch_urls on delete cascade,
  received_at  timestamptz not null default now(),
  method       text not null,
  subpath      text not null,                          -- what followed /hooks/<secret>, '' or '/…'
  query        text not null,                          -- raw query string, without '?'
  headers      jsonb not null,                         -- [[name, value], …] in arrival order, repeats kept
  body         bytea not null,
  body_size    integer not null,                       -- the size that arrived, before truncation
  truncated    boolean not null,
  source_ip    text not null
);
create index captures_catch_url_id_id on captures (catch_url_id, id desc);
create index captures_received_at on captures (received_at);
```

Headers are stored as pairs, not an object, so the order and repeated headers (`Set-Cookie`,
several `Via`) are kept exactly as they arrived.

### 3.3 The public route

`ANY /hooks/:secret/*`, registered at the root, outside the `/api/v1` scope, so identity's
`onRequest` hook never runs on it. All methods Fastify supports are accepted.

1. **Body.** Within its own encapsulated scope, one catch-all content-type parser reads the raw bytes
   for every content type, including none. The route's `bodyLimit` is the server's general
   `WIREBENCH_SERVER_BODY_LIMIT_MB`, so a larger body still gets a `413` from Fastify. The first
   `WIREBENCH_HOOKS_BODY_LIMIT_MB` (default 1) are stored. A longer body is stored cut to that length,
   with `truncated = true` and `body_size` set to its full length, and the sender still gets the
   configured response.
2. **Lookup.** The catch URL is found by the unique `secret` index. An unknown secret and a disabled
   catch URL both answer a bare `404` with no body, so a caller cannot tell the two apart.
3. **Rate limit.** An in-memory token bucket per catch URL: `WIREBENCH_HOOKS_RATE_PER_SECOND` (default
   10) with a burst of `WIREBENCH_HOOKS_BURST` (default 50). An empty bucket answers `429` with
   `Retry-After: 1` and stores nothing. A bucket that has been full for 10 minutes is dropped, so the
   map cannot grow without bound. Like the hub, it is per process (single instance).
4. **Store.** One transaction inserts the capture and deletes that catch URL's captures beyond the
   newest `WIREBENCH_HOOKS_KEEP` (default 500). After commit, the `captureReceived` announcement fires
   with `{ workspaceId, hookId, captureId }` (§3.6).
5. **Store failure.** If the transaction fails, the error is logged and the sender gets `503` with
   `Retry-After: 30`, not the configured response. A webhook sender reads 2xx as "delivered", and a
   capture that was not stored must be retried.
6. **Answer.** The route waits `response_delay_ms` on a timer, holding no database connection, then
   sends `response_status` with `response_content_type` and `response_body` (empty when unset).
   Nothing from the request is echoed and no server state is exposed.

`source_ip` is `request.ip`, which follows `trustProxy`.

Secrets never reach the logs: the request serializer replaces the segment after `/hooks/` with
`<redacted>` in every logged URL.

### 3.4 Retention

- By count: step 4 of §3.3, per catch URL, in the insert's transaction.
- By age: a sweep started at boot and every 10 minutes after deletes captures whose `received_at` is
  older than `WIREBENCH_HOOKS_MAX_AGE_DAYS` (default 7). It deletes in batches of 1,000 so it never
  holds a long lock. `close()` stops the timer and awaits a running sweep.
- By hand: an editor can clear a catch URL (§3.5).

### 3.5 The management API

Under `/api/v1`, guarded by `requireWorkspaceRole`. Wire types and zod schemas live in
`packages/engine/src/server-api/hooks.ts` (plain zod, ADR-0009), exported like `live.ts`. Errors use
`problem.ts`. A `:hookId` that belongs to another workspace answers `404`, like a workspace the caller
cannot see.

| Route | Minimum role | What it does |
| --- | --- | --- |
| `GET /workspaces/:workspaceId/hooks` | viewer | Lists catch URLs: id, name, full URL (`publicUrl` + `/hooks/` + secret), enabled, response settings, capture count, newest capture id |
| `POST /workspaces/:workspaceId/hooks` | editor | Creates one from a name and optional response settings; `201` with the catch URL |
| `PATCH /workspaces/:workspaceId/hooks/:hookId` | editor | Changes name, enabled or response settings |
| `POST /workspaces/:workspaceId/hooks/:hookId/rotate` | editor | Replaces the secret; the old URL answers `404` from then on |
| `DELETE /workspaces/:workspaceId/hooks/:hookId` | editor | Deletes the catch URL and its captures; `204` |
| `GET /workspaces/:workspaceId/hooks/:hookId/captures?before=<id>&after=<id>&limit=<n>` | viewer | Capture summaries, newest first: id, received at, method, subpath, body size, truncated, source IP. `limit` 1–200, default 50. `before` pages back; `after` fills a gap |
| `GET /workspaces/:workspaceId/hooks/:hookId/captures/:captureId` | viewer | One capture in full, body as base64 |
| `DELETE /workspaces/:workspaceId/hooks/:hookId/captures` | editor | Clears every capture of the catch URL; `204` |

Validation: name 1–100 characters, unique per workspace regardless of case (`409`); status 200–599;
content type at most 255 characters; body at most 64 KiB; delay 0–30,000 ms. A workspace holds at most
`WIREBENCH_HOOKS_PER_WORKSPACE` (default 50) catch URLs (`409` past it).

Who created a catch URL is kept in `created_by`. There is no audit log (the capability map leaves it
out), so nothing else records who changed or rotated one.

### 3.6 Announcements and live events

`ServerHooks` gains two after-commit announcements, run by the existing announcement runner (never
awaited, every throw caught and logged):

- `captureReceived: Announcement<{ workspaceId; hookId; captureId }>`, fired by §3.3 step 4.
- `hooksChanged: Announcement<{ workspaceId }>`, fired after create, change, rotate, delete and clear.

The live hub listens to both and adds two server messages to `liveServerMessageSchema`:

- `{ type: 'capture', workspaceId, hookId, captureId }` to every socket subscribed to the workspace.
  Subscription already requires at least viewer. Per catch URL the hub sends at most one `capture`
  every 250 ms, carrying the newest id. The desktop fetches everything after what it has, so the
  merged ones are not lost.
- `{ type: 'hooks', workspaceId }` to the same sockets.

An older desktop skips both types (live-updates §3.1). Like every live message, neither carries
content: HTTP stays the source of truth.

### 3.7 Configuration and `/meta`

| Variable | Default | Meaning |
| --- | --- | --- |
| `WIREBENCH_HOOKS_ENABLED` | `true` | When `false`, neither the public route nor the management routes are registered |
| `WIREBENCH_HOOKS_BODY_LIMIT_MB` | `1` | How much of a body is stored (1–32) |
| `WIREBENCH_HOOKS_KEEP` | `500` | Captures kept per catch URL (1–10,000) |
| `WIREBENCH_HOOKS_MAX_AGE_DAYS` | `7` | Captures older than this are swept (1–365) |
| `WIREBENCH_HOOKS_RATE_PER_SECOND` | `10` | Token refill per catch URL (1–1,000) |
| `WIREBENCH_HOOKS_BURST` | `50` | Bucket size per catch URL (1–10,000) |
| `WIREBENCH_HOOKS_PER_WORKSPACE` | `50` | Catch URLs per workspace (1–1,000) |

The module registers `hooks: { enabled, bodyLimitBytes, keep, maxAgeDays }` in `MetaRegistry`. The
desktop reads `enabled` to decide whether to show the Webhooks node, and the limits to explain
truncation and retention. `/meta` never carries a secret.

## 4. Desktop

### 4.1 Main process

- `apps/desktop/src/main/hooks/hooks-service.ts` calls the §3.5 routes with the signed-in server
  account's token and the same TLS and proxy options as sync.
- The live client forwards `capture` and `hooks` messages to the renderer over IPC.
- Captures are held in memory per open catch URL and never written to disk: a webhook body reaches
  the laptop's storage only if someone copies it out.
- When the live socket reconnects, every open catch URL fetches with `after=<newest id it holds>`,
  paging until the server returns fewer than `limit`, which closes any gap while the socket was down.

### 4.2 Renderer

`apps/desktop/src/renderer/features/webhooks/`:

- **Tree node.** A *Webhooks* node under a workspace shared on a server whose `/meta` reports
  `hooks.enabled`. Its children are the catch URLs, each with a badge counting captures not yet seen.
  The last-seen id is stored per device, per catch URL, in preferences.
- **Context menus.** On the node: *New catch URL…* (editor and up). On a catch URL: *Copy URL*,
  *Settings…*, *Rotate URL…* (the confirmation says the old URL stops working at once), *Clear
  captures*, *Delete*. Commands a viewer may not run are hidden.
- **Catch URL tab.** The header shows the full URL with a copy button and whether it is enabled. On
  the left, the capture list, newest first: method, subpath, time, size. It streams while live and
  loads older pages on scroll. On the right, the selected capture in the existing response pane,
  read only:
  - *Headers*: the pairs in arrival order.
  - *Body*: the existing viewers (pretty JSON, XML, form fields, hex for binary), with a banner "Body
    cut at 1 MiB of 3.4 MiB" when truncated.
  - *Details*: method, subpath and query, source IP, received at, size.
- **Settings dialog.** Name, enabled, status, content type, body, delay. A viewer sees it read only.
- **Offline or signed out.** The tab shows "Connect to <server> to see captures". Nothing is cached.

The renderer must not eagerly import values from `@wirebench/engine`'s wire types: the zod eval probe
breaks every e2e run under the renderer CSP. It imports types only; parsing happens in the main
process.

## 5. Security

- The secret is the only credential on the public route: 128 bits from `crypto.randomBytes(16)`,
  shown only to workspace viewers and up, redacted from logs, absent from `/meta`, and rotatable.
- The public route exposes nothing: an unknown and a disabled secret look alike, and the answer is
  only the configured response, `404`, `413`, `429` or `503`.
- A capture is untrusted content. It is shown only through the viewers that already render untrusted
  responses: no HTML is rendered and no script runs.
- A slow client or a long configured delay does not hold a database connection, and the delay is
  capped at 30 s.
- The rate limit and the per-workspace cap bound database writes and rows. Retention bounds storage.

## 6. Errors

| Situation | Behaviour |
| --- | --- |
| Storing a capture fails | `503` with `Retry-After: 30` to the sender, error logged, no announcement |
| An announcement listener throws | Logged and dropped; the desktop catches up on its next fetch |
| The desktop's fetch fails | The tab shows the error with *Retry*; the live list keeps what it has |
| A catch URL is deleted while its tab is open | The `hooks` event refreshes the list; the tab shows "This catch URL was deleted" |
| The caller loses access to the workspace | Existing `access` handling; the next fetch gets `404` and the tab closes like other workspace tabs |

## 7. Testing

- **Server, unit.** Token bucket refill, burst and idle drop; pruning at `keep` and `keep + 1`; the
  age sweep's boundary and batching; truncation at exactly the limit and one byte past it; log
  redaction of `/hooks/<secret>/…`.
- **Server, integration** (test database on port 55432):
  - Every management route against its role table: none → `404`, viewer → read only, editor → all.
  - The public route with JSON, form, binary, empty and oversized bodies, and with repeated headers.
  - The configured status, body, content type and delay.
  - Unknown, disabled and rotated secrets.
  - `429`, and the `503` path with a failing query.
  - The 501st capture pruning the oldest, the age sweep, and cascade deletes from catch URL and
    workspace.
  - The hub sending `capture` to viewers but not to users outside the workspace, and merging a burst.
  - `WIREBENCH_HOOKS_ENABLED=false` registering no routes.
- **Desktop.**
  - Main process against the fake server: the gap fill after reconnect, and captures kept in memory
    only.
  - Renderer: the capture list, the three tabs of the viewer, the truncation banner, and the settings
    dialog as editor and as viewer.
  - One e2e: create a catch URL, `POST` to it, watch the capture appear live, open it. Runs in CI.
- **Docs.** A user page on catch URLs and the §3.7 variables in the server configuration reference.
  `pnpm check:banned-terms` keeps product names out.

## 8. Later modules

The capability map's third slice lists the three modules that build on this one. Each gets its own
spec when its turn comes:

- `webhook-signatures`: per catch URL, a provider preset and a secret. Each capture shows verified,
  failed or not checked.
- `callback-assertion`: a request assertion that waits, after the send, for a capture on a chosen
  catch URL that matches a method, path, header or body query, within a timeout, then asserts on it.
- `openapi-webhooks-import`: import an OpenAPI document's `webhooks` and `callbacks` as a *Webhooks*
  folder of requests aimed at a target variable, instead of skipping them. Engine importer and
  desktop only: it needs no server and ships independently.

## Revisions after planning

- The environment variables are `WIREBENCH_SERVER_HOOKS_*`, not `WIREBENCH_HOOKS_*`.
- The migration file is `0004_webhook-capture.sql`.
- Logged URLs show `/hooks/[redacted]`, not the secret.
- Seen markers live in `localStorage`, one per device, keyed by server origin rather than kept in
  preferences.
- The Webhooks node is a root in the Explorer after the projects, not under a workspace row.
- A capture shows a Form tab for an `application/x-www-form-urlencoded` body.
- `/meta`'s `hooks` flag is read by the main process and served to the renderer.
