# Wirebench Server: `teams-access` — design

Issue: #74 · Date: 2026-09-24 · Status: approved by the owner on 2026-09-24 · Module: `teams-access` of
`docs/specs/2026-09-24-wirebench-server-capability-map.md`

- Intent: `docs/intent/wirebench-server-teams.md`
- Builds on: `docs/specs/2026-09-24-wirebench-server-host-design.md` (`workspaces` table, `RepoStore`,
  `ServerContext.events`), `docs/specs/2026-09-24-wirebench-server-identity-design.md` (`request.caller`,
  `requireUser`, `requireServerAdmin`, invitations, the desktop `ServerClient` and account state).
- Decisions taken with the owner on 2026-09-24: **several teams per server**, each owning workspaces and
  having its own team admins; a workspace has a **default role for team members, set by its admin**,
  new workspaces default to *viewer*; **any team member may create a workspace** and becomes its
  admin; the admin UI is **a Team dialog opened from the account menu**.

## Assumptions I'm making

1. **A workspace belongs to exactly one team.** Sharing a workspace with two teams means putting the
   people in one team; cross-team grants are not in this slice.
2. **Roles are per user, never per group.** Team membership plus the workspace default role covers the
   "everyone on the team" case; explicit grants cover the exceptions.
3. **Only existing users are granted; new people are invited.** A team invitation is an identity
   invitation that also records the team and team role; on acceptance (local or OIDC path) the user is
   added to the team.
4. **The role list is closed.** `viewer`, `editor`, `admin` for a workspace; `member`, `admin` for a
   team; `serverAdmin` from identity. No custom roles, no permissions matrix.
5. **The app is the only admin UI.** Every screen below is a renderer view calling main over IPC; main
   calls the server. The server serves no admin HTML.
6. **`server-sync` will call `requireWorkspaceRole`.** This module ships the guard and the tests for it
   before there is a route that needs it, on a probe route in its own tests.

→ Correct any of these and the spec changes accordingly.

---

## 1. Objective

**What.** Teams on Wirebench Server, membership with team roles, workspaces owned by teams, a
default role per workspace, explicit per-user grants, the effective-role rule that combines them, the
server guard `server-sync` will use to allow or refuse a push, team invitations, and the Team dialog
in the app where a team admin does all of it.

**Why.** The intent's success line: an admin adds, removes and re-roles members without touching a
git host, and a viewer can open and send but cannot push. This module is the "who may do what"; the
next one is the "do it".

**Who.** A team admin (the owner's team lead); members who need to see which workspaces they can open
and with which role; `server-sync`, which asks one question: "may this caller push to this
workspace?".

**User stories.**

- As a server admin, I create the *Payments QA* team and make Alice its admin.
- As a team admin, I invite Bob by email as a member; when he accepts, he is already on the team.
- As a team admin, I open the *Integration* workspace's access list, see every team member with the
  role they effectively have and why, and make Bob an editor.
- As a team admin, I set a workspace's default role to *none* so that only granted members see it.
- As a member, I create a workspace for the team and I am its admin.
- As a viewer, I open the workspace and send requests; my edits stay on my machine and the app tells
  me why.
- As a team admin, I remove someone who left; their access to every team workspace ends at once.

**Non-goals (this module).** Moving files (server-sync); per-project or per-environment roles; groups
within a team; cross-team workspaces; audit log; SCIM; transferring a workspace between teams; a
public "request access" flow.

## 2. Concept model

- **Team.** `id` (ULID), `name`. Members with a **team role**: `admin` (manages members, invitations
  and every workspace of the team as a workspace admin) or `member` (gets each workspace's default
  role, plus explicit grants).
- **Workspace.** The server-host row plus `teamId`, `defaultRole` (`none` | `viewer` | `editor`) and
  `createdBy`. Its bare repository is created with it.
- **Grant.** `(workspaceId, userId, role)` with role `viewer` | `editor` | `admin`. A grant overrides
  the default role for that user, upward or downward.
- **Effective role.** What a user can actually do in a workspace (§3.1). Every route and `server-sync`
  decide on it and nothing else.
- **Team invitation.** An identity invitation with `(teamId, teamRole)` attached.

## 3. Behaviour

### 3.1 Effective role

For user `u` and workspace `w` in team `t`, evaluated in this order, first match wins:

| Condition | Effective role | Source |
| --- | --- | --- |
| `u` is disabled | `none` | — |
| `u.serverAdmin` | `admin` | `server-admin` |
| `u` is team admin of `t` | `admin` | `team-admin` |
| a grant `(w, u)` exists | the grant's role | `grant` |
| `u` is a member of `t` | `w.defaultRole` (`none` → `none`) | `default` |
| otherwise | `none` | — |

Capabilities by role, which `server-sync` and the app enforce:

| Role | Open and pull | Send requests | Push | Manage access, rename, change default role | Delete workspace |
| --- | --- | --- | --- | --- | --- |
| `viewer` | yes | yes (local secrets, local edits) | no | no | no |
| `editor` | yes | yes | yes | no | no |
| `admin` | yes | yes | yes | yes | yes |

`none` means the workspace does not exist for that user: listings omit it and direct requests answer
`404 teams-workspace-not-found`, never `403`, so an id does not reveal a workspace.

### 3.2 Server endpoints (all under `/api/v1`, all `requireUser`)

| Method and path | Who | Purpose |
| --- | --- | --- |
| `GET /teams` | user | Teams the caller belongs to with `myRole`; a server admin sees every team with `myRole: "admin"`. |
| `POST /teams` | server admin | `{ name }` → `201 { team }`; the creator is added as team admin. Name unique per server (`409 teams-name-taken`). |
| `PATCH /teams/:teamId` | team admin | `{ name }`. |
| `DELETE /teams/:teamId` | server admin | Refused while the team owns workspaces (`409 teams-not-empty`). |
| `GET /teams/:teamId/members` | team member | `[{ userId, email, displayName, role, addedAt }]`. |
| `POST /teams/:teamId/members` | team admin | `{ email, role }`; the user must exist (`404 teams-user-unknown`, message says to invite instead); already a member → `409 teams-already-member`. |
| `PATCH /teams/:teamId/members/:userId` | team admin | `{ role }`. Demoting the last admin → `400 teams-last-admin`. |
| `DELETE /teams/:teamId/members/:userId` | team admin | Removes membership and every grant of that user in the team's workspaces. Removing the last admin → `400 teams-last-admin`. A member may remove themselves unless they are the last admin. |
| `GET /teams/:teamId/invitations` | team admin | Open team invitations: `[{ id, email, role, createdBy, createdAt, expiresAt }]`. |
| `POST /teams/:teamId/invitations` | team admin | `{ email, role }` → `201 { id, email, role, url, expiresAt }`. Creates an identity invitation (never `serverAdmin`) and the team attachment. An existing user → `409 identity-user-exists` with the hint to add them as a member. |
| `DELETE /teams/:teamId/invitations/:id` | team admin | Revokes. |
| `GET /workspaces` | user | Every workspace whose effective role is not `none`: `[{ id, name, teamId, teamName, defaultRole, myRole, source, createdAt }]`. |
| `POST /teams/:teamId/workspaces` | team member | `{ id?, name, defaultRole? }` (default `viewer`) → `201 { workspace }`. `id` is an optional ULID supplied by the app so the server workspace id equals the workspace manifest's id (server-sync §3.2); omitted → minted; taken → `409 teams-workspace-exists`. Creates the row, the bare repository through `RepoStore.create`, and an `admin` grant for the creator. Name unique within the team (`409 teams-workspace-name-taken`). |
| `GET /workspaces/:workspaceId` | viewer+ | `{ id, name, teamId, teamName, defaultRole, myRole, source, createdAt }`. |
| `PATCH /workspaces/:workspaceId` | workspace admin | `{ name?, defaultRole? }`. |
| `DELETE /workspaces/:workspaceId` | workspace admin | Deletes the row (grants cascade) and calls `RepoStore.remove` (moves, never deletes). |
| `GET /workspaces/:workspaceId/access` | workspace admin | Every team member with `{ userId, email, displayName, teamRole, effectiveRole, source, grant?: role }`, so the dialog can show "editor (grant)" beside "viewer (default)". |
| `PUT /workspaces/:workspaceId/access/:userId` | workspace admin | `{ role }` sets or replaces a grant; the user must be a team member (`400 teams-not-a-member`). |
| `DELETE /workspaces/:workspaceId/access/:userId` | workspace admin | Removes the grant; the user falls back to the default role. |

Route parameters are validated as ULIDs before any query. Every write runs in one transaction.

### 3.3 The guard `server-sync` uses

```ts
export type WorkspaceRole = 'viewer' | 'editor' | 'admin';
export type RoleSource = 'server-admin' | 'team-admin' | 'grant' | 'default';
export function effectiveRole(db: Querier, userId: string, workspaceId: string):
  Promise<{ role: WorkspaceRole; source: RoleSource } | { role: 'none' }>;
/** preHandler: requireUser, then 404 teams-workspace-not-found for `none`, 403 teams-forbidden below `min`;
 *  on success sets request.workspaceAccess = { workspaceId, role, source }. Reads `:workspaceId`. */
export function requireWorkspaceRole(min: WorkspaceRole): preHandlerHookHandler;
```

`server-sync` will wrap its pull in `requireWorkspaceRole('viewer')` and its push in
`requireWorkspaceRole('editor')`; that is the whole enforcement of "a viewer's push is refused".

### 3.4 Invitation acceptance

`identity` emits `invitation.accepted { invitationId, userId }` on `ctx.events` (host §5.2) inside the
accepting transaction's success path. This module listens: when a `team_invitations` row exists for
that invitation, it inserts the team membership with the stored role (idempotent: `on conflict do
nothing`). If the team was deleted in between, the user simply has no team and the log says so at
`warn`. Identity's OIDC-linking path (identity §3.3 rule 4) emits the same event.

### 3.5 Desktop: the Team dialog

- **Entry.** Status bar account item → *Manage teams…*; command `team.manage` ("Account: Manage
  teams…"); Preferences → Accounts → *Manage…* beside a signed-in server. With more than one signed-in
  server the dialog opens with a server picker at the top.
- **Layout.** A wide dialog (`w-[56rem]`): a left list of the caller's teams (server admins also see
  *New team…*); the selected team's name (editable by a team admin) and three tabs.
  - **Members.** Table: name, email, team role (select, team admins only), *Remove*. *Add member…*
    takes an email of an existing user. *Invite…* takes email and role, then shows the link with
    *Copy* and the expiry, exactly once.
  - **Workspaces.** Table: name, default role (select for workspace admins), my role, *Access…*,
    *Delete* (confirm dialog, workspace admins). *New workspace…* takes a name (any member).
    *Access…* opens an inline panel for that workspace: every team member with effective role and its
    source; a select per member sets a grant; *Use default* removes it.
  - **Invitations.** Open team invitations with *Copy link* (only right after creation; afterwards the
    link is gone and the row offers *Revoke*).
- **Role changes apply immediately**; the dialog refreshes from the server after every write and shows
  a toast on failure with the problem's message. Nothing is cached across dialog openings.
- **Viewer feedback elsewhere** (for `server-sync` to wire): the workspace's sync status carries
  `role`; the Sync badge shows "Viewer" and the push actions are disabled with the reason. This module
  only adds `role` to the wire status; the badge change lands with `server-sync`.
- Members and non-admins see the dialog read-only (selects disabled, actions hidden), so a member can
  check their own roles.

### 3.6 What a member sees without the dialog

`GET /workspaces` feeds `server-sync`'s join dialog ("Open a team workspace…"). This module adds the IPC
`team.listWorkspaces { url }` returning that list, so the next module has nothing to add on the server.

## 4. Data model and storage

### 4.1 Database (`packages/server/src/teams/migrations/0003_teams.sql`)

```
teams            (id text pk, name text not null unique, created_at timestamptz not null default now())
team_members     (team_id text references teams on delete cascade, user_id text references users on delete cascade,
                  role text not null check (role in ('admin','member')), added_at timestamptz not null default now(),
                  primary key (team_id, user_id))
team_invitations (invitation_id text pk references invitations on delete cascade,
                  team_id text not null references teams on delete cascade,
                  role text not null check (role in ('admin','member')))
alter table workspaces add column team_id text not null references teams on delete restrict,
                       add column default_role text not null default 'viewer' check (default_role in ('none','viewer','editor')),
                       add column created_by text references users on delete set null;
create unique index on workspaces (team_id, lower(name));
workspace_grants (workspace_id text references workspaces on delete cascade, user_id text references users on delete cascade,
                  role text not null check (role in ('viewer','editor','admin')), granted_at timestamptz not null default now(),
                  primary key (workspace_id, user_id))
```

`workspaces.team_id` is added `not null` without a default: the table is empty until this module
exists (no earlier module inserts rows), which the migration asserts.

### 4.2 Wire schemas

`packages/engine/src/server-api/teams.ts`: `teamSchema`, `teamMemberSchema`, `workspaceSummarySchema`
(with `myRole`, `source`), `accessEntrySchema`, `teamInvitationSchema`, and the role enums. Shared by
server routes and the desktop client as in identity §5.2.

### 4.3 Desktop

No new files on disk. The Team dialog's state is a zustand store `state/team.ts` populated per
opening; nothing persists.

## 5. Architecture

### 5.1 Server module

`packages/server/src/teams/` — `module.ts` (migrations dir, routes, the `invitation.accepted`
listener), `roles.ts` (`effectiveRole`, `requireWorkspaceRole`, the capability table as data),
`repo.ts` (SQL: teams, members, invitations, workspaces, grants; one function per statement),
`routes/{teams,members,invitations,workspaces,access}.ts`.

### 5.2 Desktop

- `main/server-client.ts` grows `teams`, `members`, `invitations`, `workspaces`, `access` groups, each
  mirroring §3.2 one method per route.
- `main/ipc/team.ts`: channels `team.list`, `team.create`, `team.rename`, `team.delete`,
  `team.members`, `team.addMember`, `team.setMemberRole`, `team.removeMember`, `team.invitations`,
  `team.invite`, `team.revokeInvitation`, `team.listWorkspaces`, `team.createWorkspace`,
  `team.updateWorkspace`, `team.deleteWorkspace`, `team.access`, `team.setAccess`, `team.clearAccess`;
  every request carries `{ url }` to pick the server account; responses are the engine schemas.
- `renderer/features/team/{team-dialog,members-tab,workspaces-tab,access-panel,invitations-tab,
  invite-dialog}.tsx`, `state/team.ts`, command `team.manage` under the `Account` category.
- `shared/wire-types.ts`: `syncStatusWireSchema` gains `role?: 'viewer' | 'editor' | 'admin'`.

## 6. Security

- Every route derives authority from `request.caller` and `effectiveRole`; no route trusts a role in a
  request body.
- `none` is `404`, so workspace and team ids leak nothing.
- Last-admin rules prevent an orphaned team; server admins can always recover a team.
- Removing a member deletes their grants in the same transaction; their device tokens stay valid but
  authorise nothing in that team.
- Team invitations can never mint a server admin.
- Team names and workspace names are trimmed, 1–80 characters, and displayed escaped in the dialog.

## 7. Tech stack

Nothing new. `node:events` for `ServerEvents`.

## 8. Commands

Desktop: `team.manage` (palette, no default shortcut). Server: no new sub-commands.

## 9. Project structure (new or changed)

```
packages/server/src/teams/**                              # §5.1, including migrations/0003_teams.sql
packages/server/test/unit/teams/roles.test.ts             # effective-role table, guard behaviour on a probe route
packages/server/test/integration/teams/**                 # every route; invitation → membership event
packages/engine/src/server-api/teams.ts
apps/desktop/src/main/server-client.ts                    # team groups
apps/desktop/src/main/ipc/team.ts
apps/desktop/src/shared/{ipc,wire-types,commands,command-catalog}.ts
apps/desktop/src/renderer/features/team/**
apps/desktop/src/renderer/features/account/account-status-item.tsx   # Manage teams… entry
apps/desktop/src/renderer/state/team.ts
apps/desktop/test/{main,renderer}/team/**
e2e/helpers/fake-server.ts                                # teams endpoints
e2e/specs/team.spec.ts
docs/collaborate.md                                       # "Teams and roles" section
```

## 10. Code style

As identity §10. Error codes are `teams-*`. Authority is one call:

```ts
app.put('/workspaces/:workspaceId/access/:userId',
  { preHandler: requireWorkspaceRole('admin'), schema: { params: accessParamsSchema, body: setAccessSchema } },
  async (request, reply) => {
    const { workspaceId, userId } = request.params;
    await ctx.db.transaction(async (tx) => {
      if (!(await repo.isTeamMemberOfWorkspace(tx, workspaceId, userId))) {
        throw new WirebenchError('teams-not-a-member', 'That user is not on this workspace\'s team.', { details: { status: 400 } });
      }
      await repo.upsertGrant(tx, workspaceId, userId, request.body.role);
    });
    return reply.code(204).send();
  });
```

## 11. Testing strategy

- **Server unit:** `effectiveRole` as a table covering every row of §3.1 including disabled users and
  a user in two teams; `requireWorkspaceRole` on a probe route: `none` → 404, below `min` → 403, equal
  or above → passes and sets `request.workspaceAccess`; last-admin rule; name uniqueness.
- **Server integration (PostgreSQL):** every route in §3.2 with its codes; creating a workspace creates
  the repository (`RepoStore.exists`) and the creator's grant; deleting moves it; removing a member
  drops grants; a team invitation accepted through identity's local path and through the fake OIDC
  issuer path both yield membership; a server admin sees all teams; `GET /workspaces` for each role
  source; `DELETE /teams` refused while non-empty.
- **Desktop unit:** `ServerClient` team groups (URL, method, body per call); the Team dialog per tab:
  read-only for members, selects for admins, invite link shown once, access panel shows source labels;
  command registered; status bar entry present only when signed in.
- **e2e:** against `fake-server.ts` extended with teams: sign in as a team admin, create a workspace,
  open Access, set a member to editor, see it reflected; invite a member and copy the link; a member
  account sees the dialog read-only.
- **Checks:** `check:banned-terms`; `docs:commands --check` for the new command.

## 12. Boundaries

Extends identity §12.

- **Always:** decide with `effectiveRole`; answer `404` for `none`; keep every write in one
  transaction; keep the role list closed; validate ids as ULIDs before querying.
- **Ask first:** cross-team workspaces; groups; per-project or per-environment roles; a "request
  access" flow; letting a member leave a team that would then have no members; transferring a
  workspace between teams.
- **Never:** trust a role from a request body; let a team lose its last admin; let a team invitation
  create a server admin; expose a workspace id to a user with `none`; delete a repository directory.

## 13. Success criteria (done when all are true)

1. A server admin creates a team and its first admin; that admin invites a member; the member accepts
   (local path in e2e, OIDC path in server integration) and is on the team with the invited role.
2. The effective-role table in §3.1 is a passing unit test, row by row.
3. A workspace created by a member exists in the repository store with the creator as admin and the
   default role *viewer*; other members see it in `GET /workspaces` with `source: "default"`.
4. Setting a grant, removing it, changing the default role, and removing the member each change what
   `GET /workspaces` and `GET /workspaces/:id/access` return, immediately.
5. `requireWorkspaceRole('editor')` on a probe route refuses a viewer with `403 teams-forbidden` and a
   stranger with `404 teams-workspace-not-found`.
6. The Team dialog does everything in §3.5 for a team admin and is read-only for a member, on all
   three OSes in e2e.
7. `WIREBENCH_SKIP_PERF=1 pnpm check` is green.

## 14. Migration and compatibility

`0003_teams.sql` alters `workspaces`; it runs only on databases where the table is empty, which is
every database before `server-sync` ships. `syncStatusWireSchema` gains an optional field.

## 15. Risks

- **Role source confusion in the UI.** Mitigation: every role shown carries its source label
  ("default", "grant", "team admin"), and the access panel is the only place a grant is set.
- **Event ordering between modules.** If teams-access's listener runs after a failed commit it would
  add membership for a user that does not exist. Mitigation: identity emits after commit, the listener
  inserts with a foreign key that fails loudly, and the integration test covers the accepted path.
- **Dialog scope creep.** Mitigation: three tabs, the actions in §3.5 and nothing else in this slice.

## 16. Open questions (bold = proposed default)

1. Default role for a new workspace: **viewer** (owner's decision); configurable per team later.
2. May a member leave a team themselves: **yes, unless last admin**.
3. Team names unique per server: **yes**.
4. Show disabled users in member lists: **yes, marked "disabled", removable**.
