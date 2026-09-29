# Capability map: Wirebench Server (first, second and third slices)

Issue: #74 · Date: 2026-09-24 · Status: approved by the owner on 2026-09-24; `live-updates` (second slice) added 2026-09-26; webhook modules (third slice) added 2026-09-27
Intent: `docs/intent/wirebench-server-teams.md`
Builds on: `docs/specs/2026-09-13-wirebench-shared-workspaces-design.md` §5.4 (the socket this fills)

The first slice of Wirebench Server bundles four independently testable capabilities. Each gets its own
design doc, named by module id, and is specified, planned and built in the order below. Module ids are
stable; plans, branches and commits select work by them. The second slice adds one module,
`live-updates`, on top of the first four. The third slice adds four webhook modules.

| Module id | Responsibility | Depends on | Design doc |
| --- | --- | --- | --- |
| `server-host` | The `wirebench-server` package: HTTP + WebSocket host, configuration, SQLite store, bare-repository store, Docker image, health endpoint | — | `2026-09-24-wirebench-server-host-design.md` |
| `identity` | Local accounts (invite by email, password), OIDC provider login, sessions and tokens; the desktop sign-in flow (system browser + PKCE, token in `safeStorage`) and the no-account path | `server-host` | `2026-09-24-wirebench-server-identity-design.md` |
| `teams-access` | Teams, membership, per-workspace roles (viewer / editor / admin), invitations, the admin UI in the app | `identity` | `2026-09-24-wirebench-server-teams-access-design.md` |
| `server-sync` | `ServerBackend implements SyncBackend`: `share.yaml` `kind: server`, fetch/merge/push over HTTP, the engine's three-way merge on the client and commits stored with git on a bare repository (ADR-0012), role enforcement (a viewer's push is refused), *Open a team workspace…* | `server-host`, `identity`, `teams-access` | `2026-09-24-wirebench-server-sync-design.md` |
| `live-updates` | Push instead of poll, second slice: one WebSocket per signed-in server account (`GET /api/v1/live`, token in the first message), an in-process hub fed by after-commit `ServerHooks` (`headMoved`, `accessChanged`, `sessionEnded`), `head` / `access` / `session-ended` events that make the desktop fetch under the existing sync rules, workspace-level presence ("Also here"), polling dropped to a 5-minute safety net while connected (ADR-0013); single instance only (the hub is in-process), and a reverse proxy must forward `Upgrade` for `/api/v1/live` | `server-host`, `identity`, `teams-access`, `server-sync` | `2026-09-26-wirebench-server-live-updates-design.md` |
| `webhook-capture` | Third slice: catch URLs owned by a workspace (`ANY /hooks/<secret>/*`, public, secret in the path), captures stored in Postgres with retention by count and age, a configured response per catch URL, a per-URL rate limit, a management API for editors, live `capture` / `hooks` events, the desktop *Webhooks* node and capture viewer | `teams-access`, `live-updates` | `2026-09-27-wirebench-server-webhook-capture-design.md` |
| `webhook-signatures` | Third slice: three generic schemes (HMAC of body, timestamped HMAC, Standard Webhooks) verified on receipt per catch URL, with a write-only secret encrypted at rest and an optional 401 for unverified requests; the same schemes sign outgoing webhook items | `webhook-capture` | `2026-09-29-wirebench-webhook-signatures-design.md` |
| `callback-assertion` | Third slice: a request assertion that waits after the send for a matching capture on a catch URL, within a timeout, then asserts on it | `webhook-capture` | `2026-09-29-wirebench-callback-assertion-design.md` |
| `openapi-webhooks-import` | Third slice: a per-project *Webhooks* collection of outbound webhook items (made by hand, imported from OpenAPI `webhooks` and `callbacks`, or saved from a capture), sent through the REST sender to a target set once and overridable per folder; callback URLs resolved from runtime expressions; kept in step by *Update definition*; engine and desktop only | `webhook-capture` (catch-URL picker, *Save as webhook*) | `2026-09-28-wirebench-openapi-webhooks-import-design.md` |

Build order: `server-host` → `identity` → `teams-access` → `server-sync`.

Second slice: `live-updates`, after the first slice.

Third slice: `webhook-capture` → `webhook-signatures` → `callback-assertion` → `openapi-webhooks-import`.

Interfaces live at the boundary of the provider module: the HTTP surface `identity` exposes to
`teams-access` and `server-sync` is specified in the identity doc; the role check `server-sync` calls is
specified in the teams-access doc; the after-commit hooks `live-updates` listens to, and their fire
sites in the first four modules, are specified in the live-updates doc.

Out of every slice (from the intent): SAML, SCIM, audit log, per-project or per-environment roles, a
hosted cloud, shared secret values (#38). Live updates and workspace-level presence moved into the second
slice (`live-updates`); presence per request or per edit, and multi-instance fan-out, stay out.
