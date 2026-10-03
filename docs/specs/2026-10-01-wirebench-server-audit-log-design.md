# Wirebench: `audit-log` — design

Date: 2026-10-01 · Status: design approved by the owner in conversation 2026-10-01 · Module: `audit-log`
of `docs/specs/2026-09-24-wirebench-server-capability-map.md` (fourth slice, second module)

- Builds on:
  - `docs/specs/2026-10-01-wirebench-server-licensing-design.md`: `requireFeature('audit-log')` and
    the `licenseChanged` announcement.
  - `ServerHooks` (`packages/server/src/context.ts`): the in-transaction hook contract of
    `invitationAccepted` (teams-access §3.4, R1), which this module extends with `audit`.
  - Every module with a fire site: identity, teams-access, server-sync, webhook-capture,
    webhook-signatures, ci-tokens, licensing, and team secrets' server routes.
  - The capture sweeper (`packages/server/src/hooks/sweep.ts`) for retention by age.
- Decisions recorded here (owner, 2026-10-01):
  - **Server events only.** What the server did on whose behalf. What the desktop sends to which host
    is not recorded; that needs a client reporting path and a privacy ruling, and is a later feature.
  - **Recorded on every edition; read and export need Enterprise.** A buyer sees history from before
    the purchase. Storage stays bounded by retention.
  - **An event commits with the action it describes.** A rolled-back action records nothing; a
    committed one always has its event.

## Assumptions I'm making

1. **The reader is a server admin.** Team admins reading events scoped to their team is a follow-up.
2. **Pull, not push.** A SIEM collects by polling the export endpoint or by a scheduled
   `wirebench-server admin audit export` on the box. Syslog and HTTP push are follow-ups.
3. **Details never carry a secret or a body.** The `details` object holds names, roles, heads and
   counts. Nothing from a request or response body, no token, no secret value, no password hash.
4. **Retention is by age only**, default 365 days, set by one environment variable. Count-based
   retention (as captures have) is not needed: events are small.
5. **The table is append-only by convention and by the absence of routes**, not by database
   privileges. A deployment that wants a database-level guarantee revokes `update` and `delete` on
   `audit_events` from the server's role; the docs-site page shows the two statements.

→ Correct any of these and the spec changes accordingly.

---

## 1. Objective

A security reviewer asks who had access to a workspace in March, when a given engineer's account was
disabled, and whether anyone pushed to the production workspace during a freeze. A server admin opens
the Audit tab, filters by workspace and date, reads the answer, and exports the range as a file for the
reviewer. A compliance team points their collector at the export endpoint once and forgets about it.

### 1.1 In scope

- An `audit_events` table and the in-transaction hook that writes it.
- Fire sites in every existing module for the actions in §3.2.
- Retention by age.
- Reading with filters and cursor paging; export as newline-delimited JSON; the same from the command
  line.
- The desktop Audit tab.

### 1.2 Not in scope

- Desktop-side events (what the app sent where): added in the second slice, see
  `docs/specs/2026-10-03-wirebench-desktop-audit-events-design.md`.
- Team-scoped readers: added later, see `docs/plans/2026-10-03-wirebench-team-audit-reads-plan.md`.
- Syslog or HTTP push, alerting on events, signing or hash-chaining the log.
- Recording reads: who looked at what is not recorded, except the export itself.

## 2. Concept model

- **Event**: one thing that happened on the server, done by an **actor** to a **target**, at a time,
  with small **details**. Immutable.
- **Actor**: a signed-in user, a CI token, the system (the command line on the box), or anonymous (a
  failed sign-in). A request arriving at a catch URL is **not** an event (§3.2).
- **Action**: a dotted name, `<area>.<verb>`, from a closed list the wire schema enumerates so the
  desktop filter can offer it.
- **Target**: what the action was about: a user, team, workspace, hook, CI token, license or the
  server itself, by kind and id, plus the workspace and team it belongs to when known, for filtering.

## 3. Behaviour

### 3.1 Recording

`ServerHooks.audit: AuditHook[]` where `AuditHook = (tx: Querier, event: AuditInput) => Promise<void>`.
A fire site calls `recordAudit(ctx.hooks, tx, event)`, which runs every registered hook inside the
caller's transaction and awaits it, exactly as `runInvitationAccepted` does. Without the audit module
the list is empty and the call is a no-op, so the other modules' tests do not change.

A write that has no transaction (a failed sign-in, which rolls nothing back) calls the same helper with
`ctx.db`. A hook throw propagates: an action whose audit row cannot be written fails, because an
unaudited action is worse than a refused one for the buyer this is for. The row insert is one statement
and the only way it fails is the database failing, which fails the action anyway.

Recording happens on every edition (owner decision). The module registers last in `BUILTIN_MODULES`,
after `live-updates`. Hooks are read at call time, so registration order does not matter for the hook
list, only for routes.

### 3.2 Events

| Action | Fired from | Target | Details |
| --- | --- | --- | --- |
| `auth.signed_in` | identity: local sign-in, OIDC complete, invitation accept | user | `method: 'local' \| 'oidc'`, `device` |
| `auth.sign_in_failed` | identity: local sign-in with wrong credentials, OIDC refusal | server; `actor: anonymous` | `method`, `reason` (the problem code), `emailLower` |
| `auth.signed_out` | identity: sign-out, `DELETE /me/devices/:id` | user | `tokenId` |
| `auth.password_changed` | identity | user | — |
| `user.invited` | identity: `POST /invitations` kind invite | invitation (`targetId` is the invitation id; the invitee is not a user yet) | `emailLower`, `serverAdmin` |
| `user.invitation_revoked` | identity | invitation | — |
| `user.created` | identity: acceptance, OIDC first sign-in | user | `method`, `invitationId?` |
| `user.disabled`, `user.enabled` | identity: `PATCH /users/:id` | user | — |
| `user.admin_granted`, `user.admin_revoked` | identity: `PATCH /users/:id` | user | — |
| `user.password_reset_issued` | identity | user | — |
| `team.created`, `team.renamed`, `team.deleted` | teams-access | team | `name` |
| `team.member_added`, `team.member_removed`, `team.member_role_changed` | teams-access, and `addInvitedMember` | user; `teamId` | `role`, `previousRole?` |
| `workspace.created`, `workspace.deleted`, `workspace.renamed` | teams-access | workspace | `name` |
| `workspace.default_role_changed` | teams-access | workspace | `role`, `previousRole` |
| `workspace.grant_set`, `workspace.grant_removed` | teams-access | user; `workspaceId` | `role` |
| `workspace.pushed` | server-sync: inside the push's commit | workspace | `head`, `previousHead` |
| `secret.shared`, `secret.rotated`, `secret.access_changed` | the team-secrets server routes (the access-log write and the key-request commit) | workspace | `entry` kind, `machineId` |
| `hook.created`, `hook.changed`, `hook.rotated`, `hook.deleted`, `hook.cleared` | webhook-capture manage API | hook; `workspaceId` | `name` |
| `hook.signature_set`, `hook.signature_cleared` | webhook-signatures | hook; `workspaceId` | `scheme` |
| `ci_token.created`, `ci_token.revoked` | ci-tokens | ci-token; `workspaceId` | `name` |
| `license.installed`, `license.removed` | the `licenseChanged` announcement (licensing §3.9) | license | `edition`, `licenseId` |
| `audit.exported` | this module | server | `from`, `to`, `count` |

Not events: a capture arriving at a catch URL (high volume, already stored as a capture), a sync fetch,
a live socket opening, a `lastUsedAt` touch, any read except the export.

`license.*` arrive through an announcement, after the commit, so they are the one kind whose row is
written outside the action's transaction; a crash between the two loses the event. That is accepted for
an action a server admin performs by hand and can repeat.

### 3.3 Retention

`WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS`, default 365, range 30 to 3650. An `AuditSweeper` with the shape
of `CaptureSweeper`: at boot and every ten minutes, delete events older than the cutoff a thousand at a
time, stop between batches on close. The sweep itself is not an event.

### 3.4 Endpoints (all under `/api/v1`)

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /audit` | server admin, `requireFeature('audit-log')` | Query: `from`, `to` (ISO, `to` exclusive), `action` (exact, or a prefix ending in `.`), `actorUserId`, `workspaceId`, `teamId`, `targetKind`, `targetId`, `after` (cursor), `limit` (default 50, max 200). Returns `{ events, next? }`, newest first. The cursor is the last row's `(at, id)`, opaque to the client. |
| `GET /audit/export` | server admin, `requireFeature('audit-log')` | Same filters minus paging. Streams `application/x-ndjson`, one event per line, oldest first, in batches of 1000 behind a server-side keyset cursor, so a year's export holds no long transaction. Records `audit.exported` when the stream ends. |

An event on the wire:

```json
{
  "id": "01J9EXAMPLE0000000000000001",
  "at": "2026-10-01T12:34:56.789Z",
  "actor": { "kind": "user", "userId": "01J9EXAMPLE00000000000000AA", "email": "a@example.com", "tokenId": "01J9EXAMPLE00000000000000BB" },
  "action": "workspace.grant_set",
  "target": { "kind": "user", "id": "01J9EXAMPLE00000000000000CC" },
  "workspaceId": "01J9EXAMPLE00000000000000DD",
  "teamId": "01J9EXAMPLE00000000000000EE",
  "ip": "203.0.113.7",
  "userAgent": "Wirebench/3.1.0 (darwin)",
  "details": { "role": "editor" }
}
```

`actor.email` is the user's email **at the time of the event**, copied into the row, so a renamed or
deleted account still reads. `ip` honours `WIREBENCH_SERVER_TRUST_PROXY` as the rest of the server does.

### 3.5 Command line

`wirebench-server admin audit export [--from <iso>] [--to <iso>] [--action <prefix>] [--workspace <id>]`
writes NDJSON to stdout, same code as the endpoint, for a cron job on the box. It needs no license: the
operator who runs it has the database anyway (assumption 5). It records `audit.exported` with
`actor: system`.

### 3.6 Desktop

- **Audit tab** in the team dialog, server admins only. On Community and Team the tab shows one line:
  "The audit log is an Enterprise feature. Events are being recorded; install an Enterprise license to
  read them." and nothing else.
- On Enterprise: a filter bar (time range with presets, action group, actor, workspace), a table
  (time, actor, action, target, workspace), a detail drawer with the full event including `details`
  as a read-only tree, *Load more* at the bottom, and *Export…* which asks for a range and a file and
  streams to disk through main.
- No live updates: the tab re-queries on open and on *Refresh*.

## 4. Data model and storage

### 4.1 Configuration

`WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS` (integer, 30–3650, default 365), validated in `config.ts` like
the hooks variables.

### 4.2 Database (`packages/server/migrations/audit-log/0008_audit-log.sql`)

```sql
create table audit_events (
  id             text primary key,
  at             timestamptz not null default now(),
  actor_kind     text not null check (actor_kind in ('user', 'ci-token', 'system', 'anonymous')),
  actor_user_id  text,
  actor_email    text,
  actor_token_id text,
  action         text not null,
  target_kind    text not null,
  target_id      text,
  workspace_id   text,
  team_id        text,
  ip             inet,
  user_agent     text,
  details        jsonb not null default '{}'::jsonb
);
create index audit_events_at on audit_events (at desc, id desc);
create index audit_events_workspace_at on audit_events (workspace_id, at desc) where workspace_id is not null;
create index audit_events_actor_at on audit_events (actor_user_id, at desc) where actor_user_id is not null;
create index audit_events_action_at on audit_events (action, at desc);
```

No foreign keys: an event outlives the user, workspace or hook it names. `id` is a ULID minted at
insert, so `(at, id)` orders and pages. `details` is bounded in the helper to 4 KiB serialised; a
larger object is truncated with `details._truncated: true`.

## 5. Architecture

### 5.1 Server module

`packages/server/src/audit-log/`: `events.ts` (the action list and the `AuditInput` type, pure),
`repo.ts` (insert, query, export cursor, delete-before), `sweep.ts`, `routes.ts`, `cli.ts`,
`module.ts`. `recordAudit` and the `AuditInput` type live in `context.ts` beside
`runInvitationAccepted`, since every module imports them; the module owns the hook that does the
writing.

Request context for an event (`actor`, `ip`, `userAgent`) is read from `request.caller` and the
Fastify request by a small `auditActor(request)` helper in `context.ts` that the fire sites call. The
CI-token guard sets `request.caller` to a `CiCaller`, which maps to `actor.kind: 'ci-token'`.

### 5.2 Wire schemas shared with the desktop

`packages/engine/src/server-api/audit.ts`: `AUDIT_ACTIONS` as a zod enum, the event schema, the query
schema with its limits, the `{ events, next? }` page.

### 5.3 Desktop

Main: `AuditService` (`query`, `exportToFile` streaming the NDJSON body to a path the user chose).
Renderer: `features/team/audit-tab.tsx`, `audit-filter-bar.tsx`, `audit-detail.tsx`.

## 6. Security

- Server-admin only, then the feature gate; a Community server never serves a row over HTTP.
- `details` is built by the fire site from named fields, never by spreading a request body; the
  `AuditInput` type allows only strings, numbers, booleans and arrays of them. A test asserts no event
  in the suite contains a string matching the secret patterns the secret-scanning spec defines.
- `actor_email` is personal data: the docs-site page says so, names the retention variable, and shows
  how to export then purge for a data-subject request (a `delete … where actor_user_id = $1`, run by the
  operator; no route).
- The export is itself audited, with the range and count.

## 7. Tech stack

Postgres, Fastify streaming reply, zod. Nothing new.

## 8. Commands

- `wirebench-server admin audit export …` (§3.5).
- Gates as every module.

## 9. Project structure (new or changed)

```
packages/engine/src/server-api/audit.ts
packages/server/migrations/audit-log/0008_audit-log.sql
packages/server/src/audit-log/{events,repo,sweep,routes,cli,module}.ts
packages/server/src/context.ts                      ServerHooks.audit, recordAudit, AuditInput, auditActor
packages/server/src/config.ts                       WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS
packages/server/src/modules.ts                      auditLogModule() last
packages/server/src/args.ts                         admin audit export
packages/server/src/identity/**                     fire sites (§3.2)
packages/server/src/teams/**                        fire sites
packages/server/src/sync/**                         workspace.pushed
packages/server/src/hooks/**                        hook.* fire sites
packages/server/src/ci-tokens/**                    ci_token.* fire sites
apps/desktop/src/main/server/audit.ts
apps/desktop/src/renderer/features/team/audit-tab.tsx
apps/desktop/src/renderer/features/team/audit-filter-bar.tsx
apps/desktop/src/renderer/features/team/audit-detail.tsx
docs-site/src/content/docs/server/audit-log.md
```

## 10. Code style

As the other modules. A fire site is one call beside the statement it describes, never in a route's
`catch`. Action names are referenced through the enum, never as string literals at the fire site.

## 11. Testing strategy

- **Every fire site**: the existing module tests gain a registered audit hook (a recording fake), and
  each action in §3.2 has one test that the event is present with the expected target and details
  after a committed action, and absent after a rolled-back one (a forced failure after the fire site).
- **Transaction**: an integration test against real Postgres that an insert failure in the audit hook
  fails the action and leaves neither row.
- **Query**: filters singly and combined, prefix action match, cursor paging across a boundary with
  equal `at`, `to` exclusive, limits.
- **Export**: NDJSON shape line by line, oldest first, batches across the cursor, the `audit.exported`
  row at the end with the right count, a client disconnect mid-stream leaves no open transaction.
- **Gate**: `GET /audit` answers 403 on Community and Team, 200 on Enterprise; the CLI export works
  without a license.
- **Retention**: the sweeper deletes past the cutoff in batches, stops on close, is not itself an event.
- **Secrets**: the whole-suite assertion of §6.
- **Desktop**: unit tests for the filter bar's query building; one CI-only e2e that filters and opens
  a detail.

## 12. Boundaries

- The module never changes anything but its own table.
- No route updates or deletes an event.
- No desktop-originated event is accepted: there is no `POST /audit`.
- No egress.

## 13. Success criteria (done when all are true)

1. Every action in §3.2 produces exactly one event, committed with the action, on a Community server.
2. `GET /audit` and `GET /audit/export` answer 403 without `audit-log` and serve the events with it.
3. A year of events exports as NDJSON without a transaction older than one batch.
4. Events older than the configured age disappear within ten minutes of the boundary.
5. No event in the test suite carries a secret-shaped string, a token or a body.
6. The Audit tab filters, pages, shows detail and exports to a file; on Community it shows only the
   notice.
7. `pnpm check` green; the docs-site page covers retention, personal data and the database-privilege
   statements.

## 14. Migration and compatibility

Migration `0008` adds one table and its indexes. There is no backfill: the log starts at the upgrade.
An older desktop sees no Audit tab.

## 15. Risks

- **Fire-site drift**: a new route forgets its event. Mitigation: the review checklist for a server
  PR gains "audit event?" and the module's test enumerates `AUDIT_ACTIONS` and fails on an action with
  no test.
- **Volume**: `workspace.pushed` on a busy server is the only chatty action; at one push a second for
  a year it is 31 million small rows, which the indexes carry. Retention bounds it.
- **Tamper-evidence**: an operator with the database can edit rows. Hash-chaining is a follow-up; the
  spec claims append-only by routes, not immutability.

## 16. Open questions (bold = proposed default)

- **Retention default 365 days.** Compliance regimes often ask for one year; some ask for longer, which
  the variable allows up to ten years.
- **`auth.sign_in_failed` keeps `emailLower`** so a brute-force attempt is readable; it is personal data
  under the same retention.

## Revisions after planning

The plan (`docs/plans/2026-10-02-wirebench-server-audit-log-plan.md`) made 24 rulings where this spec and
the code disagreed or the spec was silent. Where a ruling differs from the text above, the ruling wins.

Ruling 4 changes a requirement in §3.1: a push's events are written after the ref moves and never fail
the push, because the client's commits are already on main. Ruling 1 corrects §5.1: CI tokens set
`request.ciCaller`, not `request.caller`.

1. CI tokens are a separate request field (`request.ciCaller`); `auditSource(request)` reads `request.caller` first, then `request.ciCaller`.
2. The admin command line pushes the audit hook itself, and the license commands record `license.installed` and `license.removed` with the `system` actor.
3. Functions without a request (invitations, resets, linking, adding an invited member) take an `AuditSource` argument.
4. A push has no transaction to join: `workspace.pushed` and the `secret.*` events are written right after the ref moves, and a failed insert is logged and does not fail the push.
5. `license.*` events arrive after the commit, from a `licenseChanged` listener, without IP or user agent.
6. `secret.*` events come from file paths in a push, not from parsed team-secrets files; one event per kind per push.
7. Previous values come from a read before the write inside a transaction; `deleteGrant` and `revokeCiToken` return what they removed.
8. Sign-in issues the token and records `auth.signed_in` in one transaction.
9. `PATCH /users/:id` records only real transitions, decided on the user re-read inside the transaction.
10. A reset acceptance is `auth.password_changed` with `details.via: 'reset'`.
11. `team.created` is one event with `details.name`; the creator's admin membership is not a second event.
12. The cursor is `base64url("<at ISO>|<id>")`; a cursor that does not decode is `400 audit-cursor-invalid`.
13. The export is a Node `Readable` from an async generator, and `audit.exported` is written when it reaches its end.
14. The capture sweeper is reused for retention, with optional `deleteBefore` and `label` dependencies.
15. The Audit tab is reachable with no team selected.
16. The desktop export streams through the engine's `sendHttp` stream hook, and main picks the file.
17. The v1 filter bar offers a time range, an action group and, with a team selected, its workspaces.
18. Desktop files follow the code: `src/main/ipc/audit.ts`, `state/audit.ts` and `features/team/audit-*.tsx`.
19. The docs page is `docs-site/src/content/docs/guides/server-audit-log.mdx`.
20. `AUDIT_ACTIONS` drops nothing from the spec and adds nothing; `team.renamed` stays.
21. A literal typed as `AuditAction` satisfies §10's "through the enum".
22. The table gains `actor_workspace_id`, a `details` value may be `null`, and `auditActor(request)` becomes `auditSource(request)` in `context.ts`.
23. Single-statement actions gain a transaction so the write and its event commit together.
24. `user.created` is written before the invitation-accepted hooks run, so the order reads `user.created` then `team.member_added`.
