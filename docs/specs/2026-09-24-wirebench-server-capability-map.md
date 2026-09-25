# Capability map: Wirebench Server (first slice)

Issue: #74 · Date: 2026-09-24 · Status: approved by the owner on 2026-09-24
Intent: `docs/intent/wirebench-server-teams.md`
Builds on: `docs/specs/2026-09-13-wirebench-shared-workspaces-design.md` §5.4 (the socket this fills)

The first slice of Wirebench Server bundles four independently testable capabilities. Each gets its own
design doc, named by module id, and is specified, planned and built in the order below. Module ids are
stable; plans, branches and commits select work by them.

| Module id | Responsibility | Depends on | Design doc |
| --- | --- | --- | --- |
| `server-host` | The `wirebench-server` package: HTTP + WebSocket host, configuration, SQLite store, bare-repository store, Docker image, health endpoint | — | `2026-09-24-wirebench-server-host-design.md` |
| `identity` | Local accounts (invite by email, password), OIDC provider login, sessions and tokens; the desktop sign-in flow (system browser + PKCE, token in `safeStorage`) and the no-account path | `server-host` | `2026-09-24-wirebench-server-identity-design.md` |
| `teams-access` | Teams, membership, per-workspace roles (viewer / editor / admin), invitations, the admin UI in the app | `identity` | `2026-09-24-wirebench-server-teams-access-design.md` |
| `server-sync` | `ServerBackend implements SyncBackend`: `share.yaml` `kind: server`, fetch/merge/push over HTTP, the engine's three-way merge on the client and commits stored with git on a bare repository (ADR-0012), role enforcement (a viewer's push is refused), *Open a team workspace…* | `server-host`, `identity`, `teams-access` | `2026-09-24-wirebench-server-sync-design.md` |

Build order: `server-host` → `identity` → `teams-access` → `server-sync`.

Interfaces live at the boundary of the provider module: the HTTP surface `identity` exposes to
`teams-access` and `server-sync` is specified in the identity doc; the role check `server-sync` calls is
specified in the teams-access doc.

Out of the first slice (from the intent): live updates and presence, SAML, SCIM, audit log, per-project
or per-environment roles, a hosted cloud, shared secret values (#38).
