# Wirebench Server `teams-access` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship module `teams-access` of issue #74. It covers:

- **Server:** teams, membership with team roles, workspaces owned by teams with a default role, per-user
  grants, the effective-role rule, the `requireWorkspaceRole` guard `server-sync` will use, and team
  invitations that land the new user on the team inside identity's accepting transaction.
- **App:** the Team dialog where a team admin does all of it, and a member sees it read-only.

**Architecture:**

- **Server module.** `packages/server/src/teams/` is one `ServerModule`, registered after identity in
  the shared `/api/v1` scope, so `request.caller` is already set when its routes run.
  - A pure `resolveRole(facts)` decides every access question; one SQL query per question feeds it.
  - Two async `preHandler` factories (`requireWorkspaceRole`, `requireTeamRole`) turn "none" into `404`
    and "too low" into `403`.
  - Five route files implement spec §3.2 over a SQL repository.
- **Host and identity changes.** The host's `ServerEvents` becomes `ServerHooks`: identity runs them
  inside the transaction that claims an invitation, so membership commits together with the account.
  Identity's `createInvitation` gains an `attach` callback, so a team invitation is written in one
  transaction. `RepoStore.create` builds under `tmp/` and renames into place.
- **Desktop.** Main calls the server through `ServerClient` with the token from `AccountService`. A
  `401` marks the account signed out. The renderer talks only through `team.*` channels, and a zustand
  store drives the Team dialog.

**Tech Stack:** As identity: TypeScript strict with `exactOptionalPropertyTypes`, Node 24, Fastify 5.12,
`pg` 8.23, zod 4, vitest 5, PostgreSQL 16; on the desktop, React, zustand, Radix. Nothing new anywhere.

**Spec:** `docs/specs/2026-09-24-wirebench-server-teams-access-design.md`, as revised on 2026-09-25. Read
it first, including its *Revision 2026-09-25* table (R1–R10); section numbers below are the spec's. It
builds on the server-host and identity specs, and on ADR-0009 and ADR-0010. Module id and build order:
`docs/specs/2026-09-24-wirebench-server-capability-map.md`.

## Global Constraints

- **Branch and gate.** Branch `feat/teams-access` from `main` (which contains server-host #156 and
  identity #157). Worktree at `git-worktrees/teams-access`. One commit per task, made only after
  `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check` is green. Run
  `pnpm test:perf` once before the push.
- **Commits.** Commit as Mohammed Naami <m.naami@outlook.com>. **No** `Co-Authored-By:` trailer, **no**
  `Claude-Session:` trailer, no generated-by footer. The body says why.
- **Copy.** Never name, in code, docs or UI copy, a product that inspired a feature
  (`pnpm check:banned-terms`).
- **e2e.** No local Electron windows and no local e2e run; CI runs e2e. Run heavy checks under `nice`.
- **Dependencies.** No new dependency in any package.
- **Routes.**
  - Validate with `jsonSchema()` from `packages/server/src/schema.ts`, with `io: 'input'` for
    body/params. Never use a type provider (ADR-0009).
  - Handlers read `request.body as T` / `request.params as T` through the engine schema's inferred
    type, as identity's routes do.
  - Fastify validates params before any `preHandler`, so a malformed id never reaches SQL.
- **Migration path.** The migration lives at `packages/server/migrations/teams-access/0003_teams.sql`
  (`ServerModule.migrationsDir` convention).
- **Error codes.** `teams-*`, one function each in `packages/server/src/teams/errors.ts` through
  `problem()`. Clients see `{ code, message }` only.
- **Always** (§12):
  - Decide access with `resolveRole`, fed by `effectiveRole` or the listing queries.
  - Answer `404` for `none`, never `403`.
  - Run every write in one transaction.
  - Keep the role list closed.
  - Lock the team row (`SELECT … FOR UPDATE`) before a last-admin check.
- **Never** (§12):
  - Trust a role from a request body.
  - Let a team lose its last admin.
  - Let a team invitation create a server admin.
  - Delete a repository directory (`RepoStore.remove` moves).
  - Use an event for work that must commit with the caller's transaction.
- **Renderer rule** (memory `renderer-wire-types-csp`): renderer modules import only **types** from
  `apps/desktop/src/shared/wire-types.ts` and from the engine. Anything the renderer needs as a value
  (role lists, labels) is restated in a zod-free renderer module.
- **Integration tests** skip, printing why, when `WIREBENCH_SERVER_TEST_DATABASE_URL` is unset. To run
  them locally:
  1. `WIREBENCH_DB_PORT=55432 docker compose -f packages/server/compose.yaml up -d db`. Port 5432
     belongs to another project's container; never stop it.
  2. Once: `docker compose -f packages/server/compose.yaml exec db createdb -U wirebench wirebench_test`.
  3. `export WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:55432/wirebench_test`.

  Run a single server file with
  `pnpm exec vitest run --project server-integration packages/server/test/integration/teams/<file>`.
- **Style.** `readonly` interfaces, discriminated unions, no `any`, conditional spreads, JSDoc that says
  why. Ids are ULIDs (`newId()` from `packages/server/src/identity/tokens.ts`). Every SQL statement is
  parameterised.

## File Structure

```
packages/engine/src/server-api/teams.ts                 every §3.2 request/response schema, role enums, TEAMS_ID_PATTERN
packages/engine/src/index.ts                            + teams exports
packages/engine/test/unit/server-api/teams.test.ts
packages/server/src/context.ts                          ServerHooks + serverHooks() + runInvitationAccepted() replace ServerEvents
packages/server/src/serve.ts                            ctx.hooks
packages/server/src/db/errors.ts                        isUniqueViolation, isForeignKeyViolation
packages/server/src/repos/repo-store.ts                 create() stages under tmp/ then renames
packages/server/src/identity/env.ts                     InvitationEnv picks 'hooks'
packages/server/src/identity/invitations.ts             createInvitation(env, input, attach?); accept runs hooks in its transaction
packages/server/src/identity/linking.ts                 OIDC create runs hooks in its transaction
packages/server/src/identity/repo.ts                    + revokeExpiredInvitesOf
packages/server/src/identity/cli.ts                     ctx.hooks
packages/server/src/modules.ts                          BUILTIN_MODULES = [identityModule(), teamsModule()]
packages/server/migrations/teams-access/0003_teams.sql  §4.1
packages/server/src/teams/module.ts                     teamsModule(options): migrationsDir, capability, hook, routes
packages/server/src/teams/env.ts                        TeamsEnv
packages/server/src/teams/errors.ts                     one function per teams-* problem
packages/server/src/teams/repo.ts                       every SQL statement; row types
packages/server/src/teams/roles.ts                      resolveRole, effectiveRole, requireWorkspaceRole, requireTeamRole, CAPABILITIES
packages/server/src/teams/routes/{teams,members,invitations,workspaces,access}.ts
packages/server/test/helpers/context.ts                 hooks
packages/server/test/helpers/identity.ts                real RepoStore, hooks, modules factory
packages/server/test/helpers/teams.ts                   teamsHarness, call, seedTeam
packages/server/test/unit/repo-store.test.ts            + staged create
packages/server/test/unit/teams/roles.test.ts           §3.1 table row by row; CAPABILITIES
packages/server/test/integration/identity/{invitations,oidc}.test.ts   events → hooks; rollback; expired re-invite
packages/server/test/integration/teams/{migration,roles,teams,members,invitations,workspaces,access}.test.ts
packages/server/README.md                               "Teams" section
apps/desktop/src/main/server-client.ts                  + team methods; PATCH/PUT/DELETE
apps/desktop/src/main/ipc/team.ts                       registerTeamChannels, withToken
apps/desktop/src/main/index.ts                          wiring
apps/desktop/src/shared/wire-types.ts                   team wire schemas; syncStatusWireSchema.role
apps/desktop/src/shared/ipc.ts                          channels.team
apps/desktop/src/shared/{commands,command-catalog}.ts   team.manage
apps/desktop/src/renderer/state/ui.ts                   teamDialog, openTeamDialog, setTeamDialogOpen
apps/desktop/src/renderer/state/team.ts                 useTeamStore
apps/desktop/src/renderer/features/team/roles.ts        zod-free role lists and labels
apps/desktop/src/renderer/features/team/{team-dialog,members-tab,invite-dialog,invitations-tab,workspaces-tab,access-panel}.tsx
apps/desktop/src/renderer/features/account/account-status-item.tsx       Manage teams…
apps/desktop/src/renderer/features/preferences/sections/accounts-section.tsx   Manage teams…
apps/desktop/src/renderer/commands/register-account-commands.ts          team.manage
apps/desktop/src/renderer/shell/app-shell.tsx          <TeamDialog />
apps/desktop/test/server-client.test.ts, ipc-team.test.ts
apps/desktop/test/mocks/wirebench-api.ts                + team channels
apps/desktop/test/renderer/{team-store,team-dialog,team-workspaces}.test.tsx, account-status-item.test.tsx, accounts-section.test.tsx
e2e/helpers/fake-server.ts                              + teams endpoints, serverAdmin
e2e/specs/team.spec.ts
docs/collaborate.md                                     "Teams and roles"
docs-site/src/content/docs/guides/shared-workspaces.mdx "Teams and roles"
docs-site/src/content/docs/reference/commands.md        regenerated (pnpm docs:commands)
docs/adr/0011-workspace-roles-are-team-default-plus-grants.md
```

---

### Task 1: Shared wire schemas in the engine

**Files:**
- Create: `packages/engine/src/server-api/teams.ts`, `packages/engine/test/unit/server-api/teams.test.ts`
- Modify: `packages/engine/src/index.ts` (after the `./server-api/identity.js` export blocks, ~line 1261)

**Interfaces:**
- Produces (every later server and desktop task imports these by name):
  - Constants: `TEAMS_ID_PATTERN`, `MAX_TEAMS_NAME_LENGTH`.
  - Base schemas: `teamsIdSchema`, `teamsNameSchema`.
  - Role enums and their types: `teamRoleSchema`/`TeamRole`, `workspaceRoleSchema`/`WorkspaceRole`,
    `defaultRoleSchema`/`DefaultRole`, `roleSourceSchema`/`RoleSource`, `effectiveRoleSchema`/`EffectiveRole`.
  - Teams: `teamSchema`/`Team`, `teamsResponseSchema`, `teamNameRequestSchema`/`TeamNameRequest`,
    `teamParamsSchema`.
  - Members: `teamMemberSchema`/`TeamMember`, `teamMembersResponseSchema`,
    `memberAddRequestSchema`/`MemberAddRequest`, `memberRoleRequestSchema`/`MemberRoleRequest`,
    `memberParamsSchema`.
  - Invitations: `teamInvitationSchema`/`TeamInvitation`, `teamInvitationsResponseSchema`,
    `teamInvitationCreateRequestSchema`/`TeamInvitationCreateRequest`,
    `teamInvitationCreatedSchema`/`TeamInvitationCreated`, `teamInvitationParamsSchema`.
  - Workspaces: `teamWorkspaceSchema`/`TeamWorkspace`, `teamWorkspacesResponseSchema`,
    `teamWorkspaceCreateRequestSchema`/`TeamWorkspaceCreateRequest`,
    `teamWorkspaceUpdateRequestSchema`/`TeamWorkspaceUpdateRequest`, `teamWorkspaceParamsSchema`.
  - Access: `accessEntrySchema`/`AccessEntry`, `accessResponseSchema`, `accessParamsSchema`,
    `setAccessRequestSchema`/`SetAccessRequest`.
- Consumes: `emailSchema` from `./identity.js`.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/unit/server-api/teams.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  accessEntrySchema,
  MAX_TEAMS_NAME_LENGTH,
  memberAddRequestSchema,
  TEAMS_ID_PATTERN,
  teamInvitationCreatedSchema,
  teamSchema,
  teamsIdSchema,
  teamWorkspaceCreateRequestSchema,
  teamWorkspaceSchema,
  teamWorkspaceUpdateRequestSchema,
} from '../../../src/index.js';

const ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';

describe('server-api teams schemas', () => {
  it('ids are upper-case 26-character ULIDs and nothing else', () => {
    expect(TEAMS_ID_PATTERN.test(ID)).toBe(true);
    for (const bad of [ID.toLowerCase(), `${ID}X`, '../etc', '', 'I'.repeat(26), 'U'.repeat(26)]) {
      expect(teamsIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('names are 1 to MAX_TEAMS_NAME_LENGTH characters', () => {
    expect(MAX_TEAMS_NAME_LENGTH).toBe(80);
    expect(teamWorkspaceCreateRequestSchema.safeParse({ name: '' }).success).toBe(false);
    expect(teamWorkspaceCreateRequestSchema.safeParse({ name: 'x'.repeat(81) }).success).toBe(false);
    expect(teamWorkspaceCreateRequestSchema.parse({ name: 'Integration' })).toEqual({ name: 'Integration' });
  });

  it('workspace creation takes an optional ULID and an optional default role, never admin', () => {
    expect(teamWorkspaceCreateRequestSchema.parse({ id: ID, name: 'A', defaultRole: 'none' }).defaultRole).toBe('none');
    expect(teamWorkspaceCreateRequestSchema.safeParse({ name: 'A', defaultRole: 'admin' }).success).toBe(false);
    expect(teamWorkspaceCreateRequestSchema.safeParse({ id: 'nope', name: 'A' }).success).toBe(false);
    expect(teamWorkspaceUpdateRequestSchema.parse({})).toEqual({});
  });

  it('parse the documented response examples', () => {
    expect(teamSchema.parse({ id: ID, name: 'Payments QA', myRole: 'admin', createdAt: '2026-09-25T10:00:00.000Z' }).myRole).toBe('admin');
    expect(
      teamWorkspaceSchema.parse({
        id: ID,
        name: 'Integration',
        teamId: ID,
        teamName: 'Payments QA',
        defaultRole: 'viewer',
        myRole: 'editor',
        source: 'grant',
        createdAt: '2026-09-25T10:00:00.000Z',
      }).source,
    ).toBe('grant');
    expect(
      accessEntrySchema.parse({
        userId: ID,
        email: 'bob@example.com',
        displayName: 'Bob',
        teamRole: 'member',
        disabled: false,
        effectiveRole: 'none',
      }).effectiveRole,
    ).toBe('none');
    expect(
      teamInvitationCreatedSchema.safeParse({ id: ID, email: 'b@x.co', role: 'member', url: 'not a url', expiresAt: 'x' })
        .success,
    ).toBe(false);
  });

  it('a member is added by email with a closed role list', () => {
    expect(memberAddRequestSchema.safeParse({ email: 'bob@example.com', role: 'owner' }).success).toBe(false);
    expect(memberAddRequestSchema.parse({ email: 'bob@example.com', role: 'member' }).role).toBe('member');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project engine-unit packages/engine/test/unit/server-api/teams.test.ts`
Expected: FAIL: the imported names are `undefined` (`TEAMS_ID_PATTERN.test` is not a function).

- [ ] **Step 3: Write the schemas**

`packages/engine/src/server-api/teams.ts`:

```ts
/**
 * The teams-access module's wire shapes (teams-access spec §3.2, §4.2). The server's routes
 * validate with them (through `jsonSchema()`) and the desktop's `ServerClient` parses answers with
 * them, so a drift between the two fails typecheck.
 *
 * Names arrive untrimmed: Fastify validates the JSON Schema rendering, which cannot carry a
 * transform, so the handler trims and re-checks the length (`teams-name-invalid`).
 */
import { z } from 'zod';
import { emailSchema } from './identity.js';

/**
 * Crockford base32 ULID, upper case, 26 characters: what `ulidx` mints and what the server's
 * `RepoStore` accepts. `identityIdSchema` only checks length; every teams route parameter is this.
 */
export const TEAMS_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** §6: team and workspace names, after trimming. */
export const MAX_TEAMS_NAME_LENGTH = 80;

export const teamsIdSchema = z.string().regex(TEAMS_ID_PATTERN);
export const teamsNameSchema = z.string().min(1).max(MAX_TEAMS_NAME_LENGTH);

export const teamRoleSchema = z.enum(['member', 'admin']);
export type TeamRole = z.infer<typeof teamRoleSchema>;
export const workspaceRoleSchema = z.enum(['viewer', 'editor', 'admin']);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
/** What a team member gets without a grant; `none` hides the workspace from them (§3.1). */
export const defaultRoleSchema = z.enum(['none', 'viewer', 'editor']);
export type DefaultRole = z.infer<typeof defaultRoleSchema>;
export const roleSourceSchema = z.enum(['server-admin', 'team-admin', 'grant', 'default']);
export type RoleSource = z.infer<typeof roleSourceSchema>;
/** A role as the access list shows it: a team member may have `none`. */
export const effectiveRoleSchema = z.enum(['none', 'viewer', 'editor', 'admin']);
export type EffectiveRole = z.infer<typeof effectiveRoleSchema>;

// ---- teams -------------------------------------------------------------------------------

export const teamSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** A server admin sees every team as `admin`. */
  myRole: teamRoleSchema,
  createdAt: z.string(),
});
export type Team = z.infer<typeof teamSchema>;
export const teamsResponseSchema = z.array(teamSchema);
export const teamNameRequestSchema = z.object({ name: teamsNameSchema });
export type TeamNameRequest = z.infer<typeof teamNameRequestSchema>;
export const teamParamsSchema = z.object({ teamId: teamsIdSchema });

// ---- members -----------------------------------------------------------------------------

export const teamMemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: teamRoleSchema,
  /** §16 question 4: a disabled user stays listed, marked, and removable. */
  disabled: z.boolean(),
  addedAt: z.string(),
});
export type TeamMember = z.infer<typeof teamMemberSchema>;
export const teamMembersResponseSchema = z.array(teamMemberSchema);
export const memberAddRequestSchema = z.object({ email: emailSchema, role: teamRoleSchema });
export type MemberAddRequest = z.infer<typeof memberAddRequestSchema>;
export const memberRoleRequestSchema = z.object({ role: teamRoleSchema });
export type MemberRoleRequest = z.infer<typeof memberRoleRequestSchema>;
export const memberParamsSchema = z.object({ teamId: teamsIdSchema, userId: teamsIdSchema });

// ---- invitations -------------------------------------------------------------------------

export const teamInvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: teamRoleSchema,
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type TeamInvitation = z.infer<typeof teamInvitationSchema>;
export const teamInvitationsResponseSchema = z.array(teamInvitationSchema);
export const teamInvitationCreateRequestSchema = z.object({ email: emailSchema, role: teamRoleSchema });
export type TeamInvitationCreateRequest = z.infer<typeof teamInvitationCreateRequestSchema>;
/** The link is in this answer and nowhere else: the server stores only the secret's hash. */
export const teamInvitationCreatedSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: teamRoleSchema,
  url: z.string().url(),
  expiresAt: z.string(),
});
export type TeamInvitationCreated = z.infer<typeof teamInvitationCreatedSchema>;
export const teamInvitationParamsSchema = z.object({ teamId: teamsIdSchema, id: teamsIdSchema });

// ---- workspaces --------------------------------------------------------------------------

export const teamWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  defaultRole: defaultRoleSchema,
  myRole: workspaceRoleSchema,
  source: roleSourceSchema,
  createdAt: z.string(),
});
export type TeamWorkspace = z.infer<typeof teamWorkspaceSchema>;
export const teamWorkspacesResponseSchema = z.array(teamWorkspaceSchema);
export const teamWorkspaceCreateRequestSchema = z.object({
  /** The workspace manifest's ULID, so the server id equals the local one (server-sync §3.2). */
  id: teamsIdSchema.optional(),
  name: teamsNameSchema,
  defaultRole: defaultRoleSchema.optional(),
});
export type TeamWorkspaceCreateRequest = z.infer<typeof teamWorkspaceCreateRequestSchema>;
export const teamWorkspaceUpdateRequestSchema = z.object({
  name: teamsNameSchema.optional(),
  defaultRole: defaultRoleSchema.optional(),
});
export type TeamWorkspaceUpdateRequest = z.infer<typeof teamWorkspaceUpdateRequestSchema>;
export const teamWorkspaceParamsSchema = z.object({ workspaceId: teamsIdSchema });

// ---- access ------------------------------------------------------------------------------

/** One team member as a workspace admin sees them: what they can do, why, and any grant. */
export const accessEntrySchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  teamRole: teamRoleSchema,
  disabled: z.boolean(),
  effectiveRole: effectiveRoleSchema,
  /** Absent exactly when `effectiveRole` is `none`. */
  source: roleSourceSchema.optional(),
  grant: workspaceRoleSchema.optional(),
});
export type AccessEntry = z.infer<typeof accessEntrySchema>;
export const accessResponseSchema = z.array(accessEntrySchema);
export const accessParamsSchema = z.object({ workspaceId: teamsIdSchema, userId: teamsIdSchema });
export const setAccessRequestSchema = z.object({ role: workspaceRoleSchema });
export type SetAccessRequest = z.infer<typeof setAccessRequestSchema>;
```

- [ ] **Step 4: Export them**

In `packages/engine/src/index.ts`, directly after the `export type { … } from './server-api/identity.js';`
block:

```ts
export {
  MAX_TEAMS_NAME_LENGTH,
  TEAMS_ID_PATTERN,
  accessEntrySchema,
  accessParamsSchema,
  accessResponseSchema,
  defaultRoleSchema,
  effectiveRoleSchema,
  memberAddRequestSchema,
  memberParamsSchema,
  memberRoleRequestSchema,
  roleSourceSchema,
  setAccessRequestSchema,
  teamInvitationCreatedSchema,
  teamInvitationCreateRequestSchema,
  teamInvitationParamsSchema,
  teamInvitationSchema,
  teamInvitationsResponseSchema,
  teamMemberSchema,
  teamMembersResponseSchema,
  teamNameRequestSchema,
  teamParamsSchema,
  teamRoleSchema,
  teamSchema,
  teamsIdSchema,
  teamsNameSchema,
  teamsResponseSchema,
  teamWorkspaceCreateRequestSchema,
  teamWorkspaceParamsSchema,
  teamWorkspaceSchema,
  teamWorkspacesResponseSchema,
  teamWorkspaceUpdateRequestSchema,
  workspaceRoleSchema,
} from './server-api/teams.js';
export type {
  AccessEntry,
  DefaultRole,
  EffectiveRole,
  MemberAddRequest,
  MemberRoleRequest,
  RoleSource,
  SetAccessRequest,
  Team,
  TeamInvitation,
  TeamInvitationCreated,
  TeamInvitationCreateRequest,
  TeamMember,
  TeamNameRequest,
  TeamRole,
  TeamWorkspace,
  TeamWorkspaceCreateRequest,
  TeamWorkspaceUpdateRequest,
  WorkspaceRole,
} from './server-api/teams.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run --project engine-unit packages/engine/test/unit/server-api/teams.test.ts`
Expected: PASS (5 tests). Then `pnpm --filter @wirebench/engine build`, so the server and desktop see the new
exports.

- [ ] **Step 6: Commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/server-api/teams.ts packages/engine/src/index.ts packages/engine/test/unit/server-api/teams.test.ts
git commit -m "feat(engine): teams-access wire schemas shared by the server and the desktop

Every request and response of the teams-access routes (spec §3.2) as one zod object, so the
server's validation and the desktop's parsing cannot drift. Ids are checked as ULIDs here
because identity's id schema only checks length and teams ids reach the repository store."
```

---

### Task 2: `ServerHooks` replace `ServerEvents`; `createInvitation` gains `attach`

Spec R1, R2, §3.4. Identity currently emits `invitation.accepted` on a plain `EventEmitter` after
commit, then issues the token. A listener is not awaited, so a membership insert could land after the
new user's first request, and a failure would be an unhandled rejection. After this task, identity
runs `ctx.hooks.invitationAccepted` inside the accepting transaction.

The same task fixes a latent identity bug a team invitation would hit at once. An expired, never-used
invitation still occupies the partial unique index `invitations_one_open_per_email` (the index cannot
see `expires_at`), so re-inviting that email answered `500`. **Ruling:** `createInvitation` revokes such
rows in its transaction before inserting, and maps a remaining `23505` on that index to
`identity-invitation-exists`.

**Files:**
- Create: `packages/server/src/db/errors.ts`
- Modify:
  - Host: `packages/server/src/context.ts`, `packages/server/src/serve.ts`
  - Identity: `packages/server/src/identity/{env,invitations,linking,repo,cli}.ts`
  - Test helpers: `packages/server/test/helpers/{context,identity}.ts`
  - Identity tests: `packages/server/test/integration/identity/{invitations,oidc}.test.ts`

**Interfaces:**
- Produces:
  - In `context.ts`: `InvitationAccepted { invitationId; userId }`, `InvitationAcceptedHook`,
    `ServerHooks { invitationAccepted: InvitationAcceptedHook[] }`, `serverHooks()`,
    `runInvitationAccepted(hooks, tx, accepted)`. `ServerContext.hooks` replaces `ServerContext.events`;
    `ServerEvents` and `ServerEventMap` are gone.
  - In `db/errors.ts`: `isUniqueViolation(error, constraint)`, `isForeignKeyViolation(error)`.
  - Identity: `createInvitation(env, input, attach?: (tx: Querier, invitationId: string) => Promise<void>)`,
    and `repo.revokeExpiredInvitesOf(db, emailLower, now)`.
  - Test harness: `identityHarness({ modules?: ServerModule[] | ((clock) => ServerModule[]) })` now
    builds a **real** `RepoStore` and returns `{ app, db, clock, hooks, repos, dataDir, close }`.
- Consumes: nothing new.

- [ ] **Step 1: Update the tests first**

In `packages/server/test/integration/identity/invitations.test.ts`:

1. Add `import { createInvitation } from '../../../src/identity/invitations.js';` to the imports.
2. In the test named `accept creates the user with a password and a token, marks the invitation, emits
   the event, and works once`:
   - Rename it to `… marks the invitation, runs the invitationAccepted hooks, and works once`.
   - Replace its first two lines with:

   ```ts
   const accepted = vi.fn();
   h.hooks.invitationAccepted.push((_tx, event) => {
     accepted(event);
     return Promise.resolve();
   });
   ```

3. Append these tests inside the `describeDb` block:

```ts
  it('a throwing invitationAccepted hook rolls the accept back: no user, the invitation stays open', async () => {
    h.hooks.invitationAccepted.push(() => Promise.reject(new Error('membership failed')));
    const { url } = (await create({ email: 'carol@example.com' })).json<{ url: string }>();
    const res = await accept({ secret: secretOf(url), displayName: 'Carol', password: PASSWORD, device: { name: 'x' } });
    expect(res.statusCode).toBe(500);
    expect(await repo.findUserByEmail(h.db, 'carol@example.com')).toBeUndefined();
    expect((await lookup(secretOf(url))).statusCode).toBe(200);
  });

  it('an expired, unused invitation does not block a new one for the same email', async () => {
    expect((await create({ email: 'dan@example.com' })).statusCode).toBe(201);
    h.clock.advance(8 * DAY);
    expect((await create({ email: 'dan@example.com' })).statusCode).toBe(201);
  });

  it('createInvitation runs attach in the insert transaction: a failing attach leaves no invitation', async () => {
    const env = {
      ctx: { db: h.db, config: { publicUrl: 'https://wirebench.test' }, hooks: h.hooks },
      settings: { invitationMs: 7 * DAY },
      now: () => h.clock.now,
    } as never;
    await expect(
      createInvitation(env, { email: 'erin@example.com', serverAdmin: false, createdBy: null }, () =>
        Promise.reject(new Error('attach failed')),
      ),
    ).rejects.toThrow('attach failed');
    expect(await repo.openInvitationByEmail(h.db, 'erin@example.com', h.clock.now)).toBeUndefined();
    const attached: string[] = [];
    const created = await createInvitation(env, { email: 'erin@example.com', serverAdmin: false, createdBy: null }, (tx, id) => {
      attached.push(id);
      return tx.query('select 1').then(() => undefined);
    });
    expect(attached).toEqual([created.id]);
  });
```

In `packages/server/test/integration/identity/oidc.test.ts`:

1. In the `env` helper, change `events: h.events` to `hooks: h.hooks`.
2. In `start → callback → complete creates an invited user …`, replace
   `h.events.on('invitation.accepted', accepted);` with:

```ts
    h.hooks.invitationAccepted.push((_tx, event) => {
      accepted(event);
      return Promise.resolve();
    });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/identity/invitations.test.ts packages/server/test/integration/identity/oidc.test.ts`
Expected: FAIL on `h.hooks` being `undefined`
(`Cannot read properties of undefined (reading 'invitationAccepted')`). With no database configured the
files are skipped; configure it first (Global Constraints).

- [ ] **Step 3: The database error helpers**

`packages/server/src/db/errors.ts`:

```ts
/**
 * The PostgreSQL error classes modules map to problems. `pg` puts the SQLSTATE on `code` and the
 * violated constraint's (or unique index's) name on `constraint`; the migrations name every one a
 * route maps, so a race answers with the same problem as the pre-check it slipped past.
 */
interface PgErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

function shape(error: unknown): PgErrorShape | undefined {
  return typeof error === 'object' && error !== null ? (error as PgErrorShape) : undefined;
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const e = shape(error);
  return e?.code === '23505' && e.constraint === constraint;
}

export function isForeignKeyViolation(error: unknown): boolean {
  return shape(error)?.code === '23503';
}
```

- [ ] **Step 4: `ServerHooks` in the context**

In `packages/server/src/context.ts`, delete `import { EventEmitter } from 'node:events';`, and replace the
`ServerEventMap` interface and the `ServerEvents` class with:

```ts
/** What identity reports when an invitation becomes a user (teams-access spec §3.4). */
export interface InvitationAccepted {
  readonly invitationId: string;
  readonly userId: string;
}

export type InvitationAcceptedHook = (tx: Querier, accepted: InvitationAccepted) => Promise<void>;

/**
 * Work a later module does inside an earlier module's transaction (teams-access spec §3.4, R1).
 * Unlike an event, a hook is awaited and runs on the caller's transaction: its writes commit with
 * the caller's, and a throw rolls the caller back. Modules push onto these lists in `register()`.
 */
export interface ServerHooks {
  readonly invitationAccepted: InvitationAcceptedHook[];
}

export function serverHooks(): ServerHooks {
  return { invitationAccepted: [] };
}

/** Runs every `invitationAccepted` hook in registration order; the first throw propagates. */
export async function runInvitationAccepted(
  hooks: ServerHooks,
  tx: Querier,
  accepted: InvitationAccepted,
): Promise<void> {
  for (const hook of hooks.invitationAccepted) await hook(tx, accepted);
}
```

In `ServerContext`, replace `readonly events: ServerEvents;` with `readonly hooks: ServerHooks;`.

In `packages/server/src/serve.ts`:
- The context import becomes
  `import { MetaRegistry, serverHooks, type ServerContext, type ServerModule } from './context.js';`.
- In the `ctx` literal, `events: new ServerEvents(),` becomes `hooks: serverHooks(),`.
- Keep `import type { EventEmitter } from 'node:events';`: the signals use it.

In `packages/server/src/identity/cli.ts`:
- `import { ServerEvents } from '../context.js';` becomes `import { serverHooks } from '../context.js';`.
- `ctx: { db, config, events: new ServerEvents() },` becomes `ctx: { db, config, hooks: serverHooks() },`.

In `packages/server/src/identity/env.ts`, `InvitationEnv.ctx` becomes
`Pick<ServerContext, 'db' | 'config' | 'hooks'>`.

- [ ] **Step 5: Identity runs the hooks inside its transactions**

In `packages/server/src/identity/repo.ts`, directly after `revokeInvitation`:

```ts
/**
 * Closes expired, never-used `invite` rows for an email. The one-open-invitation index cannot see
 * `expires_at` (a partial index predicate must be immutable), so without this an expired link
 * would block a new invitation for the same person.
 */
export async function revokeExpiredInvitesOf(db: Querier, emailLower: string, now: Date): Promise<void> {
  await db.query(
    "update invitations set revoked_at = $2 where kind = 'invite' and email_lower = $1 and accepted_at is null and revoked_at is null and expires_at <= $2",
    [emailLower, now],
  );
}
```

In `packages/server/src/identity/invitations.ts`:

1. Add the imports:

```ts
import { runInvitationAccepted, type Querier } from '../context.js';
import { isUniqueViolation } from '../db/errors.js';
```

2. Replace `createInvitation` with:

```ts
/**
 * `attach` runs in the insert's transaction with the new invitation's id: teams-access writes its
 * `team_invitations` row through it (teams spec §3.4), so a team invitation never exists without
 * its team.
 */
export async function createInvitation(
  env: InvitationEnv,
  input: CreateInvitationInput,
  attach?: (tx: Querier, invitationId: string) => Promise<void>,
): Promise<InvitationCreated> {
  const lower = emailLower(input.email);
  const now = env.now();
  if ((await repo.findUserByEmail(env.ctx.db, lower)) !== undefined) throw userExists();
  if ((await repo.openInvitationByEmail(env.ctx.db, lower, now)) !== undefined) throw invitationExists();
  const { secret, hash } = mintSecret();
  let row: repo.InvitationRow;
  try {
    row = await env.ctx.db.transaction(async (tx) => {
      await repo.revokeExpiredInvitesOf(tx, lower, now);
      const inserted = await repo.insertInvitation(tx, {
        id: newId(),
        kind: 'invite',
        email: input.email.trim(),
        userId: null,
        secretHash: hash,
        serverAdmin: input.serverAdmin,
        createdBy: input.createdBy,
        createdAt: now,
        expiresAt: new Date(now.getTime() + env.settings.invitationMs),
      });
      if (attach !== undefined) await attach(tx, inserted.id);
      return inserted;
    });
  } catch (error) {
    // Two creates for one email raced past the pre-check: the index decides, the loser hears 409.
    if (isUniqueViolation(error, 'invitations_one_open_per_email')) throw invitationExists();
    throw error;
  }
  return { id: row.id, email: row.email, url: inviteUrl(env, secret), expiresAt: row.expiresAt };
}
```

3. In `acceptInvitation`, replace everything from `const outcome = await env.ctx.db.transaction(` to the
   end of the function with:

```ts
  const user = await env.ctx.db.transaction(async (tx) => {
    if (!(await repo.acceptInvitation(tx, invitation.id, now))) throw invitationInvalid();
    if (invitation.kind === 'reset') {
      const existing = invitation.userId === null ? undefined : await repo.findUserById(tx, invitation.userId);
      if (existing === undefined || existing.disabledAt !== null) throw invitationInvalid();
      await repo.upsertCredential(tx, existing.id, hash, now);
      await repo.revokeTokensOfUser(tx, existing.id, now);
      return existing;
    }
    if ((await repo.findUserByEmail(tx, invitation.emailLower)) !== undefined) throw userExists();
    const displayName = input.displayName.trim() || (invitation.email.split('@')[0] ?? invitation.email);
    const created = await repo.insertUser(tx, {
      id: newId(),
      email: invitation.email,
      displayName,
      serverAdmin: invitation.serverAdmin,
      at: now,
    });
    await repo.upsertCredential(tx, created.id, hash, now);
    // Later modules add to the new account here, in this transaction (teams spec §3.4): a
    // failure rolls the accept back and the invitation stays open.
    await runInvitationAccepted(env.ctx.hooks, tx, { invitationId: invitation.id, userId: created.id });
    return created;
  });
  return issueToken(env, user, input.device.name);
}
```

In `packages/server/src/identity/linking.ts`:

1. Add `import { runInvitationAccepted } from '../context.js';`.
2. In the `'create'` case, add this line right after the `insertOidcIdentity` call, inside the
   transaction:

```ts
        await runInvitationAccepted(env.ctx.hooks, tx, { invitationId: decision.invitationId, userId: created.id });
```

3. Delete the line
   `env.ctx.events.emit('invitation.accepted', { invitationId: decision.invitationId, userId: user.id });`.

- [ ] **Step 6: The test helpers**

In `packages/server/test/helpers/context.ts`:
- `ServerEvents` in the context import becomes `serverHooks`.
- `events: new ServerEvents(),` becomes `hooks: serverHooks(),`.

In `packages/server/test/helpers/identity.ts`:

1. Add the imports:

```ts
import { join } from 'node:path';
import type { ServerHooks, ServerModule } from '../../src/context.js';
import { NO_HOOKS_DIR, RepoStore } from '../../src/repos/repo-store.js';
import { mkTempDir, removeTempDir, testGit } from './git.js';
```

   These replace the existing `context.js` type import and the `./git.js` import.

2. In `IdentityHarness`, replace the `events` member and its comment with:

```ts
  /** The context's hooks, to register an `invitationAccepted` probe. */
  readonly hooks: ServerHooks;
  /** A real repository store over `dataDir`: teams-access creates repositories through it. */
  readonly repos: RepoStore;
  readonly dataDir: string;
```

3. Change the `modules` option's type to
   `readonly modules?: readonly ServerModule[] | ((clock: TestClock) => readonly ServerModule[]);`.
4. In the body, replace `const modules = [identity, ...(options.modules ?? [])];` with:

```ts
  const extra = typeof options.modules === 'function' ? options.modules(clock) : (options.modules ?? []);
  const modules = [identity, ...extra];
```

5. Replace `const ctx = await testContext({ dataDir, db, config });` with:

```ts
  await RepoStore.prepare(dataDir);
  const repos = new RepoStore({ git: testGit(join(dataDir, NO_HOOKS_DIR)), dataDir });
  const ctx = await testContext({ dataDir, db, config, repos });
```

6. In the returned object, replace `events: ctx.events,` with `hooks: ctx.hooks, repos, dataDir,`.

- [ ] **Step 7: Verify nothing else still names the event**

Run: `grep -rn "ServerEvents\|\.events\b\|invitation\.accepted" packages/server/src packages/server/test`
Expected: no output.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project server-unit --project server-integration packages/server/test`
Expected: PASS, including the three new invitation tests and the OIDC create test.

- [ ] **Step 9: Commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server/src/context.ts packages/server/src/serve.ts packages/server/src/db/errors.ts packages/server/src/identity packages/server/test/helpers packages/server/test/integration/identity
git commit -m "refactor(server): invitation hooks run inside identity's accepting transaction

teams-access adds the membership a team invitation promises. As an event emitted after commit
and not awaited, that insert could land after the new user's first request, and a failure was
an unhandled rejection. A hook on the accepting transaction commits with the account or rolls
the accept back (teams spec §3.4, R1).

createInvitation gains attach(tx, id) so a team invitation is written with its team in one
transaction, revokes expired never-used invites first (the partial unique index cannot see
expires_at, so re-inviting after expiry answered 500), and maps a racing duplicate to
identity-invitation-exists. The test harness now uses a real RepoStore."
```

---

### Task 3: `RepoStore.create` builds under `tmp/` and renames into place

Spec §3.7, R5: this is the server-host review's carry-over, and teams-access is the first caller of
`create`.

**Files:**
- Modify: `packages/server/src/repos/repo-store.ts` (`create`), `packages/server/test/unit/repo-store.test.ts`

**Interfaces:**
- Produces: the same `RepoStore.create(workspaceId): Promise<void>`; a failure mid-way leaves a
  `tmp/creating-<id>-<hex>` directory and nothing at `repos/<id>.git`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

In `packages/server/test/unit/repo-store.test.ts`:
- Add `import type { GitCli } from '@wirebench/engine';`.
- Append inside the `describeGit` block:

```ts
  it('builds under tmp/ and renames into place: a failed init leaves nothing at the real path', async () => {
    const real = testGit(join(dataDir, NO_HOOKS_DIR));
    const failing = {
      run: (dir: string, args: readonly string[]) =>
        args[0] === 'config' ? Promise.reject(new Error('config failed')) : real.run(dir, args),
    } as unknown as GitCli;
    const broken = new RepoStore({ git: failing, dataDir });
    await expect(broken.create(ID)).rejects.toThrow('config failed');
    expect(existsSync(store.path(ID))).toBe(false);
    expect(await store.exists(ID)).toBe(false);
    // The failed attempt's staging directory stays in tmp/ (the store never deletes); a retry works.
    expect(readdirSync(join(dataDir, 'tmp')).filter((name) => name.startsWith(`creating-${ID}-`))).toHaveLength(1);
    await store.create(ID);
    expect(await store.exists(ID)).toBe(true);
    expect(readdirSync(join(dataDir, 'tmp')).filter((name) => name.startsWith(`creating-${ID}-`))).toHaveLength(1);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/repo-store.test.ts`
Expected: FAIL. `store.path(ID)` exists after the broken create, because today `create` builds at the
real path.

- [ ] **Step 3: Implement**

In `packages/server/src/repos/repo-store.ts`:
- Add `import { randomBytes } from 'node:crypto';`.
- Replace `create` with:

```ts
  /**
   * Initialises the repository in `tmp/` and renames it into `repos/` (teams-access spec §3.7): a
   * crash or a failing git step leaves a stray `tmp/creating-…` directory, never a half-built
   * repository at the path the workspace id names. Callers run it inside {@link withLock}.
   */
  async create(workspaceId: string): Promise<void> {
    const dir = this.path(workspaceId);
    if (await this.exists(workspaceId)) {
      throw problem('server-repo-exists', 'A repository for this workspace already exists.', 409);
    }
    const staging = join(this.dataDir, TMP_DIR, `creating-${workspaceId}-${randomBytes(4).toString('hex')}`);
    await mkdir(staging, { recursive: true });
    await this.git.run(staging, [GIT.init, '--bare', '--quiet']);
    await this.git.run(staging, [GIT.symbolicRef, 'HEAD', 'refs/heads/main']);
    await this.git.run(staging, [GIT.config, 'core.hooksPath', join(this.dataDir, NO_HOOKS_DIR)]);
    await this.git.run(staging, [GIT.config, 'receive.denyNonFastForwards', 'true']);
    await rename(staging, dir);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/repo-store.test.ts`
Expected: PASS, including the older create tests (same config, same path).

- [ ] **Step 5: Commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server/src/repos/repo-store.ts packages/server/test/unit/repo-store.test.ts
git commit -m "fix(server): build a workspace repository in tmp/ and rename it into place

teams-access is the first caller of RepoStore.create (spec §3.7). Building at the real path
meant a failing git step or a crash left a half-initialised repository where the workspace id
points, which the next create would refuse as existing. Staging under tmp/ and renaming makes
the repository appear whole or not at all."
```

---

### Task 4: The migration, the module skeleton, the problems and the SQL repository

**Files:**
- Create:
  - `packages/server/migrations/teams-access/0003_teams.sql`
  - `packages/server/src/teams/{module,env,errors,repo}.ts`
  - `packages/server/test/helpers/teams.ts`
  - `packages/server/test/integration/teams/{migration,repo}.test.ts`
- Modify: `packages/server/src/modules.ts`

**Interfaces:**
- Produces:
  - Module: `teamsModule(options?: { now?: () => Date }): ServerModule` (name `'teams-access'`,
    migrations dir, capability `teams`); `TEAMS_MIGRATIONS_DIR`;
    `TeamsEnv { ctx; now; invitations: InvitationEnv }`.
  - `errors.ts`, every problem the routes throw: `teamNotFound`, `workspaceNotFound`, `forbidden`,
    `nameTaken`, `nameInvalid`, `notEmpty`, `userUnknown`, `alreadyMember`, `memberNotFound`, `lastAdmin`,
    `invitationNotFound`, `userExistsInvite`, `workspaceExists`, `workspaceNameTaken`, `notAMember`.
  - `repo.ts` row types: `TeamRow`, `MemberRow`, `TeamInvitationRow`, `WorkspaceRow`,
    `WorkspaceFactsRow`, `VisibleWorkspaceRow`, `AccessRow`.
  - `repo.ts` functions, each taking a `Querier` first:
    - Teams: `insertTeam`, `teamById`, `renameTeam`, `deleteTeam`, `lockTeam`, `allTeams`,
      `teamsOfUser`, `teamHasWorkspaces`.
    - Members: `listMembers`, `memberOf`, `memberRole`, `insertMember`, `setMemberRole`,
      `deleteMember`, `countAdmins`, `deleteGrantsInTeam`.
    - Invitations: `insertTeamInvitation`, `teamInvitationOf`, `openTeamInvitations`,
      `isTeamInvitation`.
    - Workspaces: `insertWorkspace`, `workspaceById`, `updateWorkspace`, `deleteWorkspace`,
      `workspaceFacts`, `visibleWorkspaces`.
    - Access: `accessRows`, `isTeamMemberOfWorkspace`, `upsertGrant`, `deleteGrant`.
  - Constraint names the routes map: `teams_name_lower`, `workspaces_pkey`, `workspaces_team_name_lower`.
  - Test helpers: `teamsHarness(options?)`, `call(h, user, method, path, payload?)` →
    `{ status, body }`, `seedTeam(h, { name, admins?, members? })` → `TeamRow`,
    `seedWorkspace(h, { team, name, defaultRole? })` → `string` (id, row only, no repository).
- Consumes: `ServerModule`, `ServerContext`, `Querier` (host); `InvitationEnv`, `identitySettings`
  (identity `env.ts`); `problem` (host); the harness from Task 2; engine role types from Task 1.

- [ ] **Step 1: The migration**

`packages/server/migrations/teams-access/0003_teams.sql`:

```sql
-- Wirebench Server 0003: teams, membership, workspace ownership and grants (teams-access spec §4.1).
-- `workspaces.team_id` is added not null without a default, which only works on an empty table:
-- no module wrote workspace rows before this one, and the first statement makes that a checked
-- precondition rather than an assumption.
do $$
begin
  if exists (select 1 from workspaces) then
    raise exception '0003_teams needs an empty workspaces table';
  end if;
end
$$;

create table teams (
  id         text primary key,
  name       text not null,
  created_at timestamptz not null default now()
);
-- Names are unique per server regardless of case (R8).
create unique index teams_name_lower on teams (lower(name));

create table team_members (
  team_id  text not null references teams on delete cascade,
  user_id  text not null references users on delete cascade,
  role     text not null check (role in ('admin', 'member')),
  added_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_user_id on team_members (user_id);

-- A team invitation is an identity invitation plus the team and the role it grants (§3.4).
create table team_invitations (
  invitation_id text primary key references invitations on delete cascade,
  team_id       text not null references teams on delete cascade,
  role          text not null check (role in ('admin', 'member'))
);
create index team_invitations_team_id on team_invitations (team_id);

alter table workspaces
  add column team_id      text not null references teams on delete restrict,
  add column default_role text not null default 'viewer' check (default_role in ('none', 'viewer', 'editor')),
  add column created_by   text references users on delete set null;
create unique index workspaces_team_name_lower on workspaces (team_id, lower(name));

create table workspace_grants (
  workspace_id text not null references workspaces on delete cascade,
  user_id      text not null references users on delete cascade,
  role         text not null check (role in ('viewer', 'editor', 'admin')),
  granted_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_grants_user_id on workspace_grants (user_id);
```

- [ ] **Step 2: The problems**

`packages/server/src/teams/errors.ts`:

```ts
/** Every `teams-*` problem (spec §3.2, §10), one function each so a code is spelled once. */
import type { WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

/** §3.1: an outsider hears "not found", never "forbidden", so an id reveals nothing. */
export const teamNotFound = (): WirebenchError =>
  problem('teams-team-not-found', 'That team does not exist, or you are not on it.', 404);
export const workspaceNotFound = (): WirebenchError =>
  problem('teams-workspace-not-found', 'That workspace does not exist, or you have no access to it.', 404);
export const forbidden = (): WirebenchError => problem('teams-forbidden', 'Your role does not allow this.', 403);
export const nameTaken = (): WirebenchError =>
  problem('teams-name-taken', 'A team with this name already exists.', 409);
export const nameInvalid = (): WirebenchError =>
  problem('teams-name-invalid', 'Names are 1 to 80 characters, not counting spaces at either end.', 400);
export const notEmpty = (): WirebenchError =>
  problem('teams-not-empty', 'This team still owns workspaces. Remove them first.', 409);
export const userUnknown = (): WirebenchError =>
  problem('teams-user-unknown', 'No user has this email. Invite them instead.', 404);
export const alreadyMember = (): WirebenchError =>
  problem('teams-already-member', 'That user is already on this team.', 409);
export const memberNotFound = (): WirebenchError =>
  problem('teams-member-not-found', 'That user is not on this team.', 404);
export const lastAdmin = (): WirebenchError =>
  problem('teams-last-admin', 'A team needs at least one admin. Make someone else an admin first.', 400);
export const invitationNotFound = (): WirebenchError =>
  problem('teams-invitation-not-found', 'That invitation is not open on this team.', 404);
/** Identity's code, with the hint a team admin needs (§3.2). */
export const userExistsInvite = (): WirebenchError =>
  problem('identity-user-exists', 'A user with this email already exists. Add them as a member instead.', 409);
export const workspaceExists = (): WirebenchError =>
  problem('teams-workspace-exists', 'A workspace with this id already exists.', 409);
export const workspaceNameTaken = (): WirebenchError =>
  problem('teams-workspace-name-taken', 'This team already has a workspace with this name.', 409);
export const notAMember = (): WirebenchError =>
  problem('teams-not-a-member', "That user is not on this workspace's team.", 400);
```

- [ ] **Step 3: The SQL repository**

`packages/server/src/teams/repo.ts`:

```ts
/**
 * Every SQL statement of the teams-access module (spec §4.1), one function each over a `Querier`
 * so a route can run several inside one `db.transaction`. Columns come back aliased to camelCase;
 * timestamps leave as ISO-8601 strings, the only date shape the wire schemas know.
 */
import type { DefaultRole, TeamRole, WorkspaceRole } from '@wirebench/engine';
import type { Querier } from '../context.js';

export interface TeamRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}
export interface MemberRow {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: TeamRole;
  readonly disabled: boolean;
  readonly addedAt: string;
}
export interface TeamInvitationRow {
  readonly id: string;
  readonly email: string;
  readonly role: TeamRole;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}
export interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly defaultRole: DefaultRole;
  readonly createdBy: string | null;
  readonly createdAt: string;
}
/** What `resolveRole` needs about one user and one workspace; `null` where there is no row. */
export interface WorkspaceFactsRow {
  readonly disabled: boolean;
  readonly serverAdmin: boolean;
  readonly teamRole: TeamRole | null;
  readonly grant: WorkspaceRole | null;
  readonly defaultRole: DefaultRole;
}
export interface VisibleWorkspaceRow extends WorkspaceRow {
  readonly teamRole: TeamRole | null;
  readonly grant: WorkspaceRole | null;
}
export interface AccessRow {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly serverAdmin: boolean;
  readonly disabled: boolean;
  readonly teamRole: TeamRole;
  readonly grant: WorkspaceRole | null;
  readonly defaultRole: DefaultRole;
}

type Raw = Record<string, unknown>;

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : new Date(value as string).toISOString();

/** Converts the named timestamp columns to ISO strings; every other column is already the right type. */
function dated<T>(row: Raw, keys: readonly string[]): T {
  const out: Raw = { ...row };
  for (const key of keys) out[key] = iso(out[key]);
  return out as T;
}

const TEAM_COLUMNS = 'id, name, created_at as "createdAt"';
const MEMBER_SELECT = `select m.user_id as "userId", u.email, u.display_name as "displayName", m.role,
  u.disabled_at is not null as disabled, m.added_at as "addedAt"
  from team_members m join users u on u.id = m.user_id`;
const WORKSPACE_SELECT = `select w.id, w.name, w.team_id as "teamId", t.name as "teamName",
  w.default_role as "defaultRole", w.created_by as "createdBy", w.created_at as "createdAt"
  from workspaces w join teams t on t.id = w.team_id`;

// ---- teams -------------------------------------------------------------------------------

export async function insertTeam(
  db: Querier,
  input: { readonly id: string; readonly name: string; readonly at: Date },
): Promise<TeamRow> {
  const rows = (
    await db.query(`insert into teams (id, name, created_at) values ($1, $2, $3) returning ${TEAM_COLUMNS}`, [
      input.id,
      input.name,
      input.at,
    ])
  ).rows;
  return dated<TeamRow>(rows[0]!, ['createdAt']);
}

export async function teamById(db: Querier, id: string): Promise<TeamRow | undefined> {
  const row = (await db.query(`select ${TEAM_COLUMNS} from teams where id = $1`, [id])).rows[0];
  return row === undefined ? undefined : dated<TeamRow>(row, ['createdAt']);
}

export async function renameTeam(db: Querier, id: string, name: string): Promise<TeamRow> {
  const rows = (await db.query(`update teams set name = $2 where id = $1 returning ${TEAM_COLUMNS}`, [id, name])).rows;
  return dated<TeamRow>(rows[0]!, ['createdAt']);
}

export async function deleteTeam(db: Querier, id: string): Promise<void> {
  await db.query('delete from teams where id = $1', [id]);
}

/**
 * Locks the team row until the transaction ends. Every membership change that could drop the last
 * admin takes it first (§3.2), so two admins demoting each other are serialised. `false` when the
 * team does not exist.
 */
export async function lockTeam(tx: Querier, id: string): Promise<boolean> {
  return ((await tx.query('select id from teams where id = $1 for update', [id])).rowCount ?? 0) > 0;
}

export async function allTeams(db: Querier): Promise<readonly TeamRow[]> {
  return (await db.query(`select ${TEAM_COLUMNS} from teams order by lower(name)`)).rows.map((row) =>
    dated<TeamRow>(row, ['createdAt']),
  );
}

export async function teamsOfUser(
  db: Querier,
  userId: string,
): Promise<readonly (TeamRow & { readonly role: TeamRole })[]> {
  return (
    await db.query(
      `select t.id, t.name, t.created_at as "createdAt", m.role
       from teams t join team_members m on m.team_id = t.id
       where m.user_id = $1 order by lower(t.name)`,
      [userId],
    )
  ).rows.map((row) => dated<TeamRow & { readonly role: TeamRole }>(row, ['createdAt']));
}

export async function teamHasWorkspaces(db: Querier, id: string): Promise<boolean> {
  return ((await db.query('select 1 from workspaces where team_id = $1 limit 1', [id])).rowCount ?? 0) > 0;
}

// ---- members -----------------------------------------------------------------------------

export async function listMembers(db: Querier, teamId: string): Promise<readonly MemberRow[]> {
  return (await db.query(`${MEMBER_SELECT} where m.team_id = $1 order by lower(u.email)`, [teamId])).rows.map(
    (row) => dated<MemberRow>(row, ['addedAt']),
  );
}

export async function memberOf(db: Querier, teamId: string, userId: string): Promise<MemberRow | undefined> {
  const row = (await db.query(`${MEMBER_SELECT} where m.team_id = $1 and m.user_id = $2`, [teamId, userId])).rows[0];
  return row === undefined ? undefined : dated<MemberRow>(row, ['addedAt']);
}

export async function memberRole(db: Querier, teamId: string, userId: string): Promise<TeamRole | undefined> {
  const row = (
    await db.query<{ role: TeamRole }>('select role from team_members where team_id = $1 and user_id = $2', [
      teamId,
      userId,
    ])
  ).rows[0];
  return row?.role;
}

/** `false` when the user is already on the team: the caller decides whether that is a conflict. */
export async function insertMember(
  db: Querier,
  input: { readonly teamId: string; readonly userId: string; readonly role: TeamRole; readonly at: Date },
): Promise<boolean> {
  const result = await db.query(
    'insert into team_members (team_id, user_id, role, added_at) values ($1, $2, $3, $4) on conflict do nothing',
    [input.teamId, input.userId, input.role, input.at],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function setMemberRole(db: Querier, teamId: string, userId: string, role: TeamRole): Promise<void> {
  await db.query('update team_members set role = $3 where team_id = $1 and user_id = $2', [teamId, userId, role]);
}

export async function deleteMember(db: Querier, teamId: string, userId: string): Promise<void> {
  await db.query('delete from team_members where team_id = $1 and user_id = $2', [teamId, userId]);
}

export async function countAdmins(db: Querier, teamId: string): Promise<number> {
  const row = (
    await db.query<{ count: string }>(
      "select count(*) as count from team_members where team_id = $1 and role = 'admin'",
      [teamId],
    )
  ).rows[0];
  return Number(row?.count ?? 0);
}

/** Every grant `userId` holds in the team's workspaces: removal from the team ends them (§6). */
export async function deleteGrantsInTeam(db: Querier, teamId: string, userId: string): Promise<void> {
  await db.query(
    'delete from workspace_grants g using workspaces w where g.workspace_id = w.id and w.team_id = $1 and g.user_id = $2',
    [teamId, userId],
  );
}

// ---- invitations -------------------------------------------------------------------------

export async function insertTeamInvitation(
  db: Querier,
  input: { readonly invitationId: string; readonly teamId: string; readonly role: TeamRole },
): Promise<void> {
  await db.query('insert into team_invitations (invitation_id, team_id, role) values ($1, $2, $3)', [
    input.invitationId,
    input.teamId,
    input.role,
  ]);
}

export async function teamInvitationOf(
  db: Querier,
  invitationId: string,
): Promise<{ readonly teamId: string; readonly role: TeamRole } | undefined> {
  return (
    await db.query<{ teamId: string; role: TeamRole }>(
      'select team_id as "teamId", role from team_invitations where invitation_id = $1',
      [invitationId],
    )
  ).rows[0];
}

/** Unaccepted, unrevoked, unexpired invitations of one team, newest first. */
export async function openTeamInvitations(
  db: Querier,
  teamId: string,
  now: Date,
): Promise<readonly TeamInvitationRow[]> {
  return (
    await db.query(
      `select i.id, i.email, ti.role, i.created_by as "createdBy", i.created_at as "createdAt", i.expires_at as "expiresAt"
       from team_invitations ti join invitations i on i.id = ti.invitation_id
       where ti.team_id = $1 and i.accepted_at is null and i.revoked_at is null and i.expires_at > $2
       order by i.created_at desc`,
      [teamId, now],
    )
  ).rows.map((row) => dated<TeamInvitationRow>(row, ['createdAt', 'expiresAt']));
}

export async function isTeamInvitation(db: Querier, teamId: string, invitationId: string): Promise<boolean> {
  const result = await db.query('select 1 from team_invitations where team_id = $1 and invitation_id = $2', [
    teamId,
    invitationId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

// ---- workspaces --------------------------------------------------------------------------

export async function insertWorkspace(
  db: Querier,
  input: {
    readonly id: string;
    readonly name: string;
    readonly teamId: string;
    readonly defaultRole: DefaultRole;
    readonly createdBy: string | null;
    readonly at: Date;
  },
): Promise<void> {
  await db.query(
    'insert into workspaces (id, name, team_id, default_role, created_by, created_at) values ($1, $2, $3, $4, $5, $6)',
    [input.id, input.name, input.teamId, input.defaultRole, input.createdBy, input.at],
  );
}

export async function workspaceById(db: Querier, id: string): Promise<WorkspaceRow | undefined> {
  const row = (await db.query(`${WORKSPACE_SELECT} where w.id = $1`, [id])).rows[0];
  return row === undefined ? undefined : dated<WorkspaceRow>(row, ['createdAt']);
}

export async function updateWorkspace(
  db: Querier,
  id: string,
  patch: { readonly name?: string; readonly defaultRole?: DefaultRole },
): Promise<void> {
  await db.query(
    'update workspaces set name = coalesce($2, name), default_role = coalesce($3, default_role) where id = $1',
    [id, patch.name ?? null, patch.defaultRole ?? null],
  );
}

export async function deleteWorkspace(db: Querier, id: string): Promise<void> {
  await db.query('delete from workspaces where id = $1', [id]);
}

/** `undefined` when the workspace or the user does not exist: both mean `none`. */
export async function workspaceFacts(
  db: Querier,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceFactsRow | undefined> {
  return (
    await db.query<WorkspaceFactsRow & Raw>(
      `select u.disabled_at is not null as disabled, u.server_admin as "serverAdmin",
              m.role as "teamRole", g.role as "grant", w.default_role as "defaultRole"
       from workspaces w
       join users u on u.id = $1
       left join team_members m on m.team_id = w.team_id and m.user_id = u.id
       left join workspace_grants g on g.workspace_id = w.id and g.user_id = u.id
       where w.id = $2`,
      [userId, workspaceId],
    )
  ).rows[0];
}

/**
 * Every workspace `userId` might see, with the facts that decide it: a server admin gets all of
 * them, anyone else those of their teams. `resolveRole` then drops the `none` ones.
 */
export async function visibleWorkspaces(
  db: Querier,
  userId: string,
  serverAdmin: boolean,
): Promise<readonly VisibleWorkspaceRow[]> {
  return (
    await db.query(
      `select w.id, w.name, w.team_id as "teamId", t.name as "teamName", w.default_role as "defaultRole",
              w.created_by as "createdBy", w.created_at as "createdAt", m.role as "teamRole", g.role as "grant"
       from workspaces w
       join teams t on t.id = w.team_id
       left join team_members m on m.team_id = w.team_id and m.user_id = $1
       left join workspace_grants g on g.workspace_id = w.id and g.user_id = $1
       where $2 or m.user_id is not null
       order by lower(t.name), lower(w.name)`,
      [userId, serverAdmin],
    )
  ).rows.map((row) => dated<VisibleWorkspaceRow>(row, ['createdAt']));
}

// ---- access ------------------------------------------------------------------------------

/** Every member of the workspace's team with what decides their role there, by email. */
export async function accessRows(db: Querier, workspaceId: string): Promise<readonly AccessRow[]> {
  return (
    await db.query<AccessRow & Raw>(
      `select u.id as "userId", u.email, u.display_name as "displayName", u.server_admin as "serverAdmin",
              u.disabled_at is not null as disabled, m.role as "teamRole", g.role as "grant", w.default_role as "defaultRole"
       from workspaces w
       join team_members m on m.team_id = w.team_id
       join users u on u.id = m.user_id
       left join workspace_grants g on g.workspace_id = w.id and g.user_id = u.id
       where w.id = $1
       order by lower(u.email)`,
      [workspaceId],
    )
  ).rows;
}

export async function isTeamMemberOfWorkspace(db: Querier, workspaceId: string, userId: string): Promise<boolean> {
  const result = await db.query(
    'select 1 from workspaces w join team_members m on m.team_id = w.team_id where w.id = $1 and m.user_id = $2',
    [workspaceId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function upsertGrant(
  db: Querier,
  input: { readonly workspaceId: string; readonly userId: string; readonly role: WorkspaceRole; readonly at: Date },
): Promise<void> {
  await db.query(
    `insert into workspace_grants (workspace_id, user_id, role, granted_at) values ($1, $2, $3, $4)
     on conflict (workspace_id, user_id) do update set role = excluded.role, granted_at = excluded.granted_at`,
    [input.workspaceId, input.userId, input.role, input.at],
  );
}

export async function deleteGrant(db: Querier, workspaceId: string, userId: string): Promise<void> {
  await db.query('delete from workspace_grants where workspace_id = $1 and user_id = $2', [workspaceId, userId]);
}
```

- [ ] **Step 4: The environment and the module skeleton**

`packages/server/src/teams/env.ts`:

```ts
import type { ServerContext } from '../context.js';
import type { InvitationEnv } from '../identity/env.js';

/** Everything a teams route file needs; built once by `module.ts` and passed to each route group. */
export interface TeamsEnv {
  readonly ctx: ServerContext;
  readonly now: () => Date;
  /** What identity's `createInvitation` and `revokeOpenInvitation` need, from the same context. */
  readonly invitations: InvitationEnv;
}
```

`packages/server/src/teams/module.ts`:

```ts
/**
 * The `teams-access` ServerModule (spec §5.1). Registered after identity in the shared /api/v1
 * scope, so identity's `onRequest` hook has set `request.caller` before any route here runs.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { identitySettings } from '../identity/env.js';
import type { TeamsEnv } from './env.js';

export const TEAMS_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/teams-access/', import.meta.url));

export interface TeamsOptions {
  /** Injected clock, shared with identity's in tests. */
  readonly now?: () => Date;
}

export function teamsModule(options: TeamsOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  return {
    name: 'teams-access',
    migrationsDir: TEAMS_MIGRATIONS_DIR,

    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const env: TeamsEnv = { ctx, now, invitations: { ctx, settings: identitySettings(ctx.config), now } };
      ctx.meta.addCapability('teams');
      // Tasks 6–8 register their routes and the invitation hook here, replacing these two lines.
      void app;
      void env;
      await Promise.resolve();
    },
  };
}
```

In `packages/server/src/modules.ts`:

```ts
import type { ServerModule } from './context.js';
import { identityModule } from './identity/module.js';
import { teamsModule } from './teams/module.js';

/** The modules a production process runs, in registration order. Tests pass their own list. */
export const BUILTIN_MODULES: readonly ServerModule[] = [identityModule(), teamsModule()];
```

- [ ] **Step 5: The test helpers**

`packages/server/test/helpers/teams.ts`:

```ts
import type { DefaultRole } from '@wirebench/engine';
import type { OidcProvider } from '../../src/identity/oidc.js';
import { newId } from '../../src/identity/tokens.js';
import { teamsModule } from '../../src/teams/module.js';
import * as teamsRepo from '../../src/teams/repo.js';
import { identityHarness, type IdentityHarness, type SignedInUser } from './identity.js';

/** Identity plus teams-access over a fresh schema, both on the harness clock. */
export function teamsHarness(
  options: { readonly env?: Record<string, string>; readonly provider?: OidcProvider } = {},
): Promise<IdentityHarness> {
  return identityHarness({ ...options, modules: (clock) => [teamsModule({ now: () => clock.now })] });
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** One request under `/api/v1` as `user` (anonymous when `undefined`); the body parsed when present. */
export async function call<T = unknown>(
  h: IdentityHarness,
  user: SignedInUser | undefined,
  method: Method,
  path: string,
  payload?: object,
): Promise<{ readonly status: number; readonly body: T }> {
  const res = await h.app.inject({
    method,
    url: `/api/v1${path}`,
    ...(user !== undefined ? { headers: user.headers } : {}),
    ...(payload !== undefined ? { payload } : {}),
  });
  return { status: res.statusCode, body: (res.body.length > 0 ? res.json() : undefined) as T };
}

/** A team written straight into the tables, for tests that are not about creating teams. */
export async function seedTeam(
  h: IdentityHarness,
  input: {
    readonly name: string;
    readonly admins?: readonly SignedInUser[];
    readonly members?: readonly SignedInUser[];
  },
): Promise<teamsRepo.TeamRow> {
  const team = await teamsRepo.insertTeam(h.db, { id: newId(), name: input.name, at: h.clock.now });
  for (const user of input.admins ?? []) {
    await teamsRepo.insertMember(h.db, { teamId: team.id, userId: user.user.id, role: 'admin', at: h.clock.now });
  }
  for (const user of input.members ?? []) {
    await teamsRepo.insertMember(h.db, { teamId: team.id, userId: user.user.id, role: 'member', at: h.clock.now });
  }
  return team;
}

/** A workspace row without a repository, for tests about roles rather than storage. */
export async function seedWorkspace(
  h: IdentityHarness,
  input: { readonly team: teamsRepo.TeamRow; readonly name: string; readonly defaultRole?: DefaultRole },
): Promise<string> {
  const id = newId();
  await teamsRepo.insertWorkspace(h.db, {
    id,
    name: input.name,
    teamId: input.team.id,
    defaultRole: input.defaultRole ?? 'viewer',
    createdBy: null,
    at: h.clock.now,
  });
  return id;
}
```

- [ ] **Step 6: Write the tests**

`packages/server/test/integration/teams/migration.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import { migrate } from '../../../src/db/migrate.js';
import { identityModule } from '../../../src/identity/module.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { allMigrations } from '../../../src/serve.js';
import { teamsModule } from '../../../src/teams/module.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import type { IdentityHarness } from '../../helpers/identity.js';
import { call, teamsHarness } from '../../helpers/teams.js';

describeDb('0003_teams (§4.1)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  beforeEach(async () => {
    db = await testDatabase();
  });
  afterEach(() => db.close());

  it('comes right after identity, and production runs it', async () => {
    const list = (await allMigrations([identityModule(), teamsModule()])).map((m) => `${m.version}_${m.name}`);
    expect(list).toEqual(['1_init', '2_identity', '3_teams']);
    expect(BUILTIN_MODULES.map((m) => m.name)).toEqual(['identity', 'teams-access']);
  });

  it('refuses to run over a workspaces table that already has rows', async () => {
    const all = await allMigrations([identityModule(), teamsModule()]);
    await migrate(db, all.slice(0, 2));
    await db.query("insert into workspaces (id, name) values ('01J8ZC5Q0V7R3T9XK2M4N6P8QA', 'early')");
    await expect(migrate(db, all)).rejects.toThrow(/0003_teams needs an empty workspaces table/);
  });
});

describeDb('the teams capability (§5.1)', () => {
  let h: IdentityHarness;
  beforeEach(async () => {
    h = await teamsHarness();
  });
  afterEach(() => h.close());

  it('meta lists teams after identity', async () => {
    const meta = await call<{ capabilities: string[] }>(h, undefined, 'GET', '/meta');
    expect(meta.body.capabilities).toEqual(['identity', 'teams']);
  });
});
```

`packages/server/test/integration/teams/repo.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import { isForeignKeyViolation, isUniqueViolation } from '../../../src/db/errors.js';
import { newId } from '../../../src/identity/tokens.js';
import * as repo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { seedTeam, seedWorkspace, teamsHarness } from '../../helpers/teams.js';

describeDb('teams repository (§4.1)', () => {
  let h: IdentityHarness;
  let alice: SignedInUser;
  let bob: SignedInUser;
  beforeEach(async () => {
    h = await teamsHarness();
    alice = await signedInUser(h, { email: 'alice@example.com' });
    bob = await signedInUser(h, { email: 'bob@example.com' });
  });
  afterEach(() => h.close());

  it('team names are unique regardless of case, under the index the routes map', async () => {
    await repo.insertTeam(h.db, { id: newId(), name: 'Payments QA', at: h.clock.now });
    const error: unknown = await repo
      .insertTeam(h.db, { id: newId(), name: 'payments qa', at: h.clock.now })
      .catch((e: unknown) => e);
    expect(isUniqueViolation(error, 'teams_name_lower')).toBe(true);
  });

  it('members: insert is idempotent, admins are counted, and only the team’s grants go with a removal', async () => {
    const team = await seedTeam(h, { name: 'T', admins: [alice] });
    const add = (role: 'admin' | 'member') =>
      repo.insertMember(h.db, { teamId: team.id, userId: bob.user.id, role, at: h.clock.now });
    expect(await add('member')).toBe(true);
    expect(await add('admin')).toBe(false);
    expect(await repo.memberRole(h.db, team.id, bob.user.id)).toBe('member');
    expect(await repo.countAdmins(h.db, team.id)).toBe(1);
    expect((await repo.listMembers(h.db, team.id)).map((m) => [m.email, m.role, m.disabled])).toEqual([
      ['alice@example.com', 'admin', false],
      ['bob@example.com', 'member', false],
    ]);
    const other = await seedTeam(h, { name: 'Other', members: [bob] });
    const here = await seedWorkspace(h, { team, name: 'W' });
    const there = await seedWorkspace(h, { team: other, name: 'W' });
    await repo.upsertGrant(h.db, { workspaceId: here, userId: bob.user.id, role: 'editor', at: h.clock.now });
    await repo.upsertGrant(h.db, { workspaceId: there, userId: bob.user.id, role: 'editor', at: h.clock.now });
    await repo.deleteGrantsInTeam(h.db, team.id, bob.user.id);
    expect((await repo.workspaceFacts(h.db, bob.user.id, here))?.grant).toBeNull();
    expect((await repo.workspaceFacts(h.db, bob.user.id, there))?.grant).toBe('editor');
  });

  it('workspace names are unique per team regardless of case; ids are unique; a team with workspaces cannot go', async () => {
    const team = await seedTeam(h, { name: 'T' });
    const other = await seedTeam(h, { name: 'U' });
    const id = await seedWorkspace(h, { team, name: 'Integration' });
    await seedWorkspace(h, { team: other, name: 'integration' }); // another team: fine
    const sameName: unknown = await seedWorkspace(h, { team, name: 'INTEGRATION' }).catch((e: unknown) => e);
    expect(isUniqueViolation(sameName, 'workspaces_team_name_lower')).toBe(true);
    const sameId: unknown = await repo
      .insertWorkspace(h.db, { id, name: 'X', teamId: team.id, defaultRole: 'viewer', createdBy: null, at: h.clock.now })
      .catch((e: unknown) => e);
    expect(isUniqueViolation(sameId, 'workspaces_pkey')).toBe(true);
    const inUse: unknown = await repo.deleteTeam(h.db, team.id).catch((e: unknown) => e);
    expect(isForeignKeyViolation(inUse)).toBe(true);
  });

  it('visibleWorkspaces: members see their teams’ workspaces, server admins see every one', async () => {
    const root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    const team = await seedTeam(h, { name: 'T', members: [alice] });
    const other = await seedTeam(h, { name: 'U' });
    await seedWorkspace(h, { team, name: 'Mine' });
    await seedWorkspace(h, { team: other, name: 'Theirs' });
    expect((await repo.visibleWorkspaces(h.db, alice.user.id, false)).map((w) => [w.name, w.teamRole])).toEqual([
      ['Mine', 'member'],
    ]);
    expect((await repo.visibleWorkspaces(h.db, root.user.id, true)).map((w) => w.name)).toEqual(['Mine', 'Theirs']);
    expect(await repo.visibleWorkspaces(h.db, bob.user.id, false)).toEqual([]);
  });

  it('accessRows lists every team member with their grant; updateWorkspace patches only what it is given', async () => {
    const team = await seedTeam(h, { name: 'T', admins: [bob], members: [alice] });
    const id = await seedWorkspace(h, { team, name: 'W', defaultRole: 'none' });
    await repo.upsertGrant(h.db, { workspaceId: id, userId: alice.user.id, role: 'viewer', at: h.clock.now });
    await repo.upsertGrant(h.db, { workspaceId: id, userId: alice.user.id, role: 'editor', at: h.clock.now });
    expect((await repo.accessRows(h.db, id)).map((r) => [r.email, r.teamRole, r.grant, r.defaultRole])).toEqual([
      ['alice@example.com', 'member', 'editor', 'none'],
      ['bob@example.com', 'admin', null, 'none'],
    ]);
    await repo.updateWorkspace(h.db, id, { defaultRole: 'editor' });
    expect(await repo.workspaceById(h.db, id)).toMatchObject({ name: 'W', defaultRole: 'editor', teamName: 'T' });
    expect(await repo.isTeamMemberOfWorkspace(h.db, id, alice.user.id)).toBe(true);
    const stranger = await signedInUser(h, { email: 'x@example.com' });
    expect(await repo.isTeamMemberOfWorkspace(h.db, id, stranger.user.id)).toBe(false);
    expect(await repo.workspaceFacts(h.db, alice.user.id, newId())).toBeUndefined();
  });

  it('lockTeam answers whether the team exists', async () => {
    const team = await seedTeam(h, { name: 'T' });
    expect(await h.db.transaction((tx) => repo.lockTeam(tx, team.id))).toBe(true);
    expect(await h.db.transaction((tx) => repo.lockTeam(tx, newId()))).toBe(false);
  });
});
```

- [ ] **Step 7: Run the tests**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/teams`
Expected: PASS (9 tests).

- [ ] **Step 8: Commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server/migrations/teams-access packages/server/src/teams packages/server/src/modules.ts packages/server/test/helpers/teams.ts packages/server/test/integration/teams
git commit -m "feat(server): teams-access migration, module skeleton, problems and SQL repository

0003_teams adds teams, membership, team invitations, workspace ownership and grants (spec
§4.1). It asserts the workspaces table is empty before adding a not-null team_id, and it names
every unique index a route maps to a 409, so a race answers like the pre-check. The module
registers after identity and reports the teams capability."
```

---

### Task 5: The role rule and the two guards

Spec §3.1, §3.3. `resolveRole` is the whole of §3.1 as a pure function, so the table is a unit test
row by row. `effectiveRole` feeds it one query. The guards throw before a handler runs.

**Ruling:** the guards take the database first (`requireWorkspaceRole(db, min)`), as the revised spec
§3.3 says. The server attaches nothing to a request that could carry it, and identity builds its own
guards from the module environment the same way.

**Ruling:** a grant counts only for a team member. Removing a member deletes their grants in the same
transaction, and `PUT …/access` refuses non-members, so a grant always implies membership. The explicit
check makes a stray row harmless instead of a quiet privilege.

**Files:**
- Create: `packages/server/src/teams/roles.ts`, `packages/server/test/unit/teams/roles.test.ts`,
  `packages/server/test/integration/teams/roles.test.ts`

**Interfaces:**
- Produces:
  - Types: `Effective = { role: WorkspaceRole; source: RoleSource } | { role: 'none' }`, `RoleFacts`.
  - Rule helpers: `resolveRole(facts): Effective`, `factsOf(row): RoleFacts`,
    `atLeast(role, min): boolean`, `CAPABILITIES`.
  - `effectiveRole(db, userId, workspaceId): Promise<Effective>`.
  - Guards: `requireWorkspaceRole(db, min): preHandlerAsyncHookHandler`, which sets
    `request.workspaceAccess = { workspaceId, role, source }`; and `requireTeamRole(db, min)`, which sets
    `request.teamAccess = { teamId, role }`.
- Consumes: `repo.workspaceFacts`, `repo.teamById`, `repo.memberRole` (Task 4); `forbidden`,
  `teamNotFound`, `workspaceNotFound` (Task 4); `unauthenticated` (identity `errors.ts`).

- [ ] **Step 1: Write the failing unit test**

`packages/server/test/unit/teams/roles.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '@wirebench/engine';
import { atLeast, CAPABILITIES, resolveRole, type Effective, type RoleFacts } from '../../../src/teams/roles.js';

const BASE: RoleFacts = {
  disabled: false,
  serverAdmin: false,
  teamRole: undefined,
  grant: undefined,
  defaultRole: 'viewer',
};

describe('resolveRole — the §3.1 table, first match wins', () => {
  const rows: readonly [string, Partial<RoleFacts>, Effective][] = [
    [
      'a disabled user has nothing, even a server admin who is team admin',
      { disabled: true, serverAdmin: true, teamRole: 'admin' },
      { role: 'none' },
    ],
    ['a server admin is admin everywhere, on no team', { serverAdmin: true }, { role: 'admin', source: 'server-admin' }],
    [
      'a team admin is admin of every team workspace, whatever the grant',
      { teamRole: 'admin', grant: 'viewer' },
      { role: 'admin', source: 'team-admin' },
    ],
    ['a grant raises a member above the default', { teamRole: 'member', grant: 'editor' }, { role: 'editor', source: 'grant' }],
    [
      'a grant lowers a member below the default',
      { teamRole: 'member', grant: 'viewer', defaultRole: 'editor' },
      { role: 'viewer', source: 'grant' },
    ],
    [
      'a grant still applies when the default is none',
      { teamRole: 'member', grant: 'viewer', defaultRole: 'none' },
      { role: 'viewer', source: 'grant' },
    ],
    [
      'a member without a grant gets the default role',
      { teamRole: 'member', defaultRole: 'editor' },
      { role: 'editor', source: 'default' },
    ],
    ['default none hides the workspace from a member', { teamRole: 'member', defaultRole: 'none' }, { role: 'none' }],
    ['someone on no team has nothing', {}, { role: 'none' }],
    ['a grant without membership grants nothing', { grant: 'admin' }, { role: 'none' }],
  ];
  for (const [name, facts, expected] of rows) {
    it(name, () => {
      expect(resolveRole({ ...BASE, ...facts })).toEqual(expected);
    });
  }
});

describe('ranks and capabilities', () => {
  const ROLES: readonly WorkspaceRole[] = ['viewer', 'editor', 'admin'];

  it('atLeast orders viewer < editor < admin', () => {
    expect(ROLES.map((role) => ROLES.map((min) => atLeast(role, min)))).toEqual([
      [true, false, false],
      [true, true, false],
      [true, true, true],
    ]);
  });

  it('the capability table agrees with the ranks the guards compare', () => {
    for (const role of ROLES) {
      expect(CAPABILITIES[role].pull && CAPABILITIES[role].send).toBe(true);
      expect(CAPABILITIES[role].push).toBe(atLeast(role, 'editor'));
      expect(CAPABILITIES[role].manage).toBe(atLeast(role, 'admin'));
      expect(CAPABILITIES[role].delete).toBe(atLeast(role, 'admin'));
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/teams/roles.test.ts`
Expected: FAIL (`Cannot find module '../../../src/teams/roles.js'`).

- [ ] **Step 3: Implement**

`packages/server/src/teams/roles.ts`:

```ts
/**
 * Who may do what in a workspace (teams-access spec §3.1, §3.3). `resolveRole` is the whole rule,
 * pure and table-tested; `effectiveRole` feeds it one query; the guards turn its answer into a
 * `404` (none) or a `403` (too low) before a handler runs. Every route and `server-sync` decide
 * through here and nowhere else.
 */
import type { DefaultRole, RoleSource, TeamRole, WorkspaceRole } from '@wirebench/engine';
import type { preHandlerAsyncHookHandler } from 'fastify';
import type { Querier } from '../context.js';
import { unauthenticated } from '../identity/errors.js';
import { forbidden, teamNotFound, workspaceNotFound } from './errors.js';
import * as repo from './repo.js';

export type Effective =
  { readonly role: WorkspaceRole; readonly source: RoleSource } | { readonly role: 'none' };

export interface RoleFacts {
  readonly disabled: boolean;
  readonly serverAdmin: boolean;
  /** The user's role on the workspace's team; `undefined` when they are not on it. */
  readonly teamRole: TeamRole | undefined;
  readonly grant: WorkspaceRole | undefined;
  readonly defaultRole: DefaultRole;
}

/**
 * §3.1, first match wins. A grant counts only for a team member: removal from the team deletes
 * grants in the same transaction, and this check keeps a stray row from ever granting access.
 */
export function resolveRole(facts: RoleFacts): Effective {
  if (facts.disabled) return { role: 'none' };
  if (facts.serverAdmin) return { role: 'admin', source: 'server-admin' };
  if (facts.teamRole === 'admin') return { role: 'admin', source: 'team-admin' };
  if (facts.teamRole === undefined) return { role: 'none' };
  if (facts.grant !== undefined) return { role: facts.grant, source: 'grant' };
  return facts.defaultRole === 'none' ? { role: 'none' } : { role: facts.defaultRole, source: 'default' };
}

/** A query row (`null` for a missing join) as `resolveRole` facts. */
export function factsOf(row: {
  readonly disabled: boolean;
  readonly serverAdmin: boolean;
  readonly teamRole: TeamRole | null;
  readonly grant: WorkspaceRole | null;
  readonly defaultRole: DefaultRole;
}): RoleFacts {
  return {
    disabled: row.disabled,
    serverAdmin: row.serverAdmin,
    teamRole: row.teamRole ?? undefined,
    grant: row.grant ?? undefined,
    defaultRole: row.defaultRole,
  };
}

const RANK: Readonly<Record<WorkspaceRole, number>> = { viewer: 1, editor: 2, admin: 3 };

export function atLeast(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return RANK[role] >= RANK[min];
}

type Capability = 'pull' | 'send' | 'push' | 'manage' | 'delete';

/** §3.1's capability table as data: what `server-sync` and the app enforce per role. */
export const CAPABILITIES = {
  viewer: { pull: true, send: true, push: false, manage: false, delete: false },
  editor: { pull: true, send: true, push: true, manage: false, delete: false },
  admin: { pull: true, send: true, push: true, manage: true, delete: true },
} as const satisfies Readonly<Record<WorkspaceRole, Readonly<Record<Capability, boolean>>>>;

export async function effectiveRole(db: Querier, userId: string, workspaceId: string): Promise<Effective> {
  const row = await repo.workspaceFacts(db, userId, workspaceId);
  return row === undefined ? { role: 'none' } : resolveRole(factsOf(row));
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by {@link requireWorkspaceRole}: what the caller may do in `:workspaceId`, and why. */
    workspaceAccess?: { readonly workspaceId: string; readonly role: WorkspaceRole; readonly source: RoleSource };
    /** Set by {@link requireTeamRole}: the caller's role on `:teamId` (a server admin counts as admin). */
    teamAccess?: { readonly teamId: string; readonly role: TeamRole };
  }
}

/**
 * `preHandler` for routes with a `:workspaceId` param. `none` → `404 teams-workspace-not-found`
 * (an id reveals nothing, §3.1); below `min` → `403 teams-forbidden`. Fastify has validated the
 * param as a ULID before this runs.
 */
export function requireWorkspaceRole(db: Querier, min: WorkspaceRole): preHandlerAsyncHookHandler {
  return async (request) => {
    const caller = request.caller;
    if (caller === undefined) throw unauthenticated();
    const { workspaceId } = request.params as { readonly workspaceId: string };
    const found = await effectiveRole(db, caller.id, workspaceId);
    if (found.role === 'none') throw workspaceNotFound();
    if (!atLeast(found.role, min)) throw forbidden();
    request.workspaceAccess = { workspaceId, role: found.role, source: found.source };
  };
}

/**
 * `preHandler` for routes with a `:teamId` param. Not on the team (and not a server admin) →
 * `404 teams-team-not-found`; a member where an admin is needed → `403 teams-forbidden`.
 */
export function requireTeamRole(db: Querier, min: TeamRole): preHandlerAsyncHookHandler {
  return async (request) => {
    const caller = request.caller;
    if (caller === undefined) throw unauthenticated();
    const { teamId } = request.params as { readonly teamId: string };
    if ((await repo.teamById(db, teamId)) === undefined) throw teamNotFound();
    const role = caller.serverAdmin ? 'admin' : await repo.memberRole(db, teamId, caller.id);
    if (role === undefined) throw teamNotFound();
    if (min === 'admin' && role !== 'admin') throw forbidden();
    request.teamAccess = { teamId, role };
  };
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/teams/roles.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Write the guard integration test**

`packages/server/test/integration/teams/roles.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import { teamParamsSchema, teamWorkspaceParamsSchema } from '@wirebench/engine';
import type { ServerModule } from '../../../src/context.js';
import { newId } from '../../../src/identity/tokens.js';
import { jsonSchema } from '../../../src/schema.js';
import { teamsModule } from '../../../src/teams/module.js';
import * as repo from '../../../src/teams/repo.js';
import { effectiveRole, requireTeamRole, requireWorkspaceRole } from '../../../src/teams/roles.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam, seedWorkspace } from '../../helpers/teams.js';

/** What server-sync will do: guard a route by workspace role (§3.3), and one by team role. */
const probe: ServerModule = {
  name: 'server-sync',
  register: async (app, ctx) => {
    app.get(
      '/probe/:workspaceId',
      {
        preHandler: requireWorkspaceRole(ctx.db, 'editor'),
        schema: { params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' }) },
      },
      (request) => Promise.resolve(request.workspaceAccess),
    );
    app.get(
      '/probe-team/:teamId',
      { preHandler: requireTeamRole(ctx.db, 'admin'), schema: { params: jsonSchema(teamParamsSchema, { io: 'input' }) } },
      (request) => Promise.resolve(request.teamAccess),
    );
    await Promise.resolve();
  },
};

describeDb('requireWorkspaceRole and requireTeamRole (§3.3)', () => {
  let h: IdentityHarness;
  let admin: SignedInUser;
  let member: SignedInUser;
  let editor: SignedInUser;
  let stranger: SignedInUser;
  let root: SignedInUser;
  let workspaceId: string;
  let teamId: string;
  beforeEach(async () => {
    h = await identityHarness({ modules: (clock) => [teamsModule({ now: () => clock.now }), probe] });
    admin = await signedInUser(h, { email: 'admin@example.com' });
    member = await signedInUser(h, { email: 'member@example.com' });
    editor = await signedInUser(h, { email: 'editor@example.com' });
    stranger = await signedInUser(h, { email: 'stranger@example.com' });
    root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    const team = await seedTeam(h, { name: 'T', admins: [admin], members: [member, editor] });
    teamId = team.id;
    workspaceId = await seedWorkspace(h, { team, name: 'W' });
    await repo.upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at: h.clock.now });
  });
  afterEach(() => h.close());

  it('a viewer is refused with 403, a stranger and an unknown id with 404, nobody with 401', async () => {
    expect(await call(h, member, 'GET', `/probe/${workspaceId}`)).toEqual({
      status: 403,
      body: { code: 'teams-forbidden', message: 'Your role does not allow this.' },
    });
    for (const [user, id] of [
      [stranger, workspaceId],
      [admin, newId()],
    ] as const) {
      const res = await call<{ code: string }>(h, user, 'GET', `/probe/${id}`);
      expect([res.status, res.body.code]).toEqual([404, 'teams-workspace-not-found']);
    }
    expect((await call<{ code: string }>(h, undefined, 'GET', `/probe/${workspaceId}`)).body.code).toBe(
      'identity-unauthenticated',
    );
  });

  it('editor and above pass and see their role and its source', async () => {
    expect((await call(h, editor, 'GET', `/probe/${workspaceId}`)).body).toEqual({
      workspaceId,
      role: 'editor',
      source: 'grant',
    });
    expect((await call(h, admin, 'GET', `/probe/${workspaceId}`)).body).toMatchObject({
      role: 'admin',
      source: 'team-admin',
    });
    expect((await call(h, root, 'GET', `/probe/${workspaceId}`)).body).toMatchObject({
      role: 'admin',
      source: 'server-admin',
    });
  });

  it('a malformed id is a 400 before any query', async () => {
    const res = await call<{ code: string }>(h, admin, 'GET', '/probe/not-a-ulid');
    expect([res.status, res.body.code]).toEqual([400, 'invalid-request']);
  });

  it('team guard: outsider 404, member 403, admin and server admin pass', async () => {
    expect((await call<{ code: string }>(h, stranger, 'GET', `/probe-team/${teamId}`)).body.code).toBe(
      'teams-team-not-found',
    );
    expect((await call<{ code: string }>(h, member, 'GET', `/probe-team/${teamId}`)).body.code).toBe(
      'teams-forbidden',
    );
    expect((await call(h, admin, 'GET', `/probe-team/${teamId}`)).body).toEqual({ teamId, role: 'admin' });
    expect((await call(h, root, 'GET', `/probe-team/${teamId}`)).body).toEqual({ teamId, role: 'admin' });
    expect((await call<{ code: string }>(h, root, 'GET', `/probe-team/${newId()}`)).body.code).toBe(
      'teams-team-not-found',
    );
  });

  it('a user in two teams has a different role in each; a disabled user has none', async () => {
    const other = await seedTeam(h, { name: 'U', members: [admin] });
    const theirs = await seedWorkspace(h, { team: other, name: 'W', defaultRole: 'editor' });
    expect(await effectiveRole(h.db, admin.user.id, workspaceId)).toEqual({ role: 'admin', source: 'team-admin' });
    expect(await effectiveRole(h.db, admin.user.id, theirs)).toEqual({ role: 'editor', source: 'default' });
    await h.db.query('update users set disabled_at = now() where id = $1', [admin.user.id]);
    expect(await effectiveRole(h.db, admin.user.id, workspaceId)).toEqual({ role: 'none' });
  });
});
```

- [ ] **Step 6: Run it**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/teams/roles.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server/src/teams/roles.ts packages/server/test/unit/teams packages/server/test/integration/teams/roles.test.ts
git commit -m "feat(server): the effective-role rule and the workspace and team guards

resolveRole is spec §3.1 as a pure function, tested row by row. A grant counts only for a
team member, so a stray row can never grant access. requireWorkspaceRole is what server-sync
will wrap its pull and push in: none is a 404 so an id reveals nothing, a role below the
minimum is a 403."
```

---

### Task 6: Team and member routes

Spec §3.2: the `/teams` and `/teams/:teamId/members` rows, the last-admin rule under a row lock (R4),
and "a member may remove themselves unless they are the last admin" (§16 question 2). A single-statement
write (rename, add member) is its own transaction; multi-statement writes use `db.transaction`.

**Files:**
- Create: `packages/server/src/teams/names.ts`, `packages/server/src/teams/routes/{teams,members}.ts`,
  `packages/server/test/integration/teams/{teams,members}.test.ts`
- Modify: `packages/server/src/teams/module.ts` (register the two route groups)

**Interfaces:**
- Produces: `cleanName(raw): string`; `teamRoutes(env)`, `memberRoutes(env)`, each
  `(app: FastifyInstance) => void`.
- Consumes: Task 1 schemas; Task 4 `repo`, `errors`, `TeamsEnv`; Task 5 `requireTeamRole`; identity
  `requireUser`, `requireServerAdmin`, `newId`, `findUserByEmail`, `emailLower`; Task 2
  `isUniqueViolation`, `isForeignKeyViolation`.

- [ ] **Step 1: Write the failing tests**

`packages/server/test/integration/teams/teams.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Team } from '@wirebench/engine';
import * as repo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam, seedWorkspace, teamsHarness } from '../../helpers/teams.js';

describeDb('/teams (§3.2)', () => {
  let h: IdentityHarness;
  let root: SignedInUser;
  let alice: SignedInUser;
  let bob: SignedInUser;
  beforeEach(async () => {
    h = await teamsHarness();
    root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    alice = await signedInUser(h, { email: 'alice@example.com' });
    bob = await signedInUser(h, { email: 'bob@example.com' });
  });
  afterEach(() => h.close());

  it('a server admin creates a team with a trimmed name and becomes its admin', async () => {
    const res = await call<Team>(h, root, 'POST', '/teams', { name: '  Payments QA ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Payments QA', myRole: 'admin' });
    expect(res.body.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(await repo.memberRole(h.db, res.body.id, root.user.id)).toBe('admin');
  });

  it('refuses a non-admin, a duplicate name in any case, a blank name and a long one', async () => {
    expect((await call<{ code: string }>(h, alice, 'POST', '/teams', { name: 'X' })).body.code).toBe(
      'identity-forbidden',
    );
    await call(h, root, 'POST', '/teams', { name: 'Payments QA' });
    expect(await call(h, root, 'POST', '/teams', { name: 'payments qa' })).toMatchObject({
      status: 409,
      body: { code: 'teams-name-taken' },
    });
    expect(await call(h, root, 'POST', '/teams', { name: '   ' })).toMatchObject({
      status: 400,
      body: { code: 'teams-name-invalid' },
    });
    expect(await call(h, root, 'POST', '/teams', { name: 'x'.repeat(81) })).toMatchObject({
      status: 400,
      body: { code: 'invalid-request' },
    });
  });

  it('GET /teams: members see their teams with their role, a server admin sees every team as admin', async () => {
    const alpha = await seedTeam(h, { name: 'Alpha', admins: [alice], members: [bob] });
    await seedTeam(h, { name: 'beta', members: [alice] });
    await seedTeam(h, { name: 'Gamma' });
    expect((await call<Team[]>(h, alice, 'GET', '/teams')).body.map((t) => [t.name, t.myRole])).toEqual([
      ['Alpha', 'admin'],
      ['beta', 'member'],
    ]);
    expect((await call<Team[]>(h, bob, 'GET', '/teams')).body.map((t) => t.id)).toEqual([alpha.id]);
    expect((await call<Team[]>(h, root, 'GET', '/teams')).body.map((t) => [t.name, t.myRole])).toEqual([
      ['Alpha', 'admin'],
      ['beta', 'admin'],
      ['Gamma', 'admin'],
    ]);
    const stranger = await signedInUser(h, { email: 'stranger@example.com' });
    expect((await call(h, stranger, 'GET', '/teams')).body).toEqual([]);
    expect((await call(h, undefined, 'GET', '/teams')).status).toBe(401);
  });

  it('a team admin renames; a member gets 403, an outsider 404, a clash 409, a bad id 400', async () => {
    const team = await seedTeam(h, { name: 'Alpha', admins: [alice], members: [bob] });
    await seedTeam(h, { name: 'Beta' });
    const stranger = await signedInUser(h, { email: 'stranger@example.com' });
    expect(await call(h, alice, 'PATCH', `/teams/${team.id}`, { name: 'Alpha QA' })).toMatchObject({
      status: 200,
      body: { name: 'Alpha QA', myRole: 'admin' },
    });
    expect((await call<{ code: string }>(h, bob, 'PATCH', `/teams/${team.id}`, { name: 'X' })).body.code).toBe(
      'teams-forbidden',
    );
    expect((await call<{ code: string }>(h, stranger, 'PATCH', `/teams/${team.id}`, { name: 'X' })).body.code).toBe(
      'teams-team-not-found',
    );
    expect((await call<{ code: string }>(h, alice, 'PATCH', `/teams/${team.id}`, { name: 'BETA' })).body.code).toBe(
      'teams-name-taken',
    );
    expect((await call(h, alice, 'PATCH', '/teams/nope', { name: 'X' })).status).toBe(400);
  });

  it('only a server admin deletes a team, and only an empty one', async () => {
    const team = await seedTeam(h, { name: 'Alpha', admins: [alice] });
    const workspaceId = await seedWorkspace(h, { team, name: 'W' });
    expect((await call<{ code: string }>(h, alice, 'DELETE', `/teams/${team.id}`)).body.code).toBe(
      'identity-forbidden',
    );
    expect(await call(h, root, 'DELETE', `/teams/${team.id}`)).toMatchObject({
      status: 409,
      body: { code: 'teams-not-empty' },
    });
    await repo.deleteWorkspace(h.db, workspaceId);
    expect((await call(h, root, 'DELETE', `/teams/${team.id}`)).status).toBe(204);
    expect(await repo.teamById(h.db, team.id)).toBeUndefined();
    expect(await repo.memberRole(h.db, team.id, alice.user.id)).toBeUndefined();
    expect((await call<{ code: string }>(h, root, 'DELETE', `/teams/${team.id}`)).body.code).toBe(
      'teams-team-not-found',
    );
  });
});
```

`packages/server/test/integration/teams/members.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { TeamMember } from '@wirebench/engine';
import * as repo from '../../../src/teams/repo.js';
import { effectiveRole } from '../../../src/teams/roles.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam, seedWorkspace, teamsHarness } from '../../helpers/teams.js';

describeDb('/teams/:teamId/members (§3.2)', () => {
  let h: IdentityHarness;
  let admin: SignedInUser;
  let member: SignedInUser;
  let carol: SignedInUser;
  let team: repo.TeamRow;
  beforeEach(async () => {
    h = await teamsHarness();
    admin = await signedInUser(h, { email: 'admin@example.com' });
    member = await signedInUser(h, { email: 'member@example.com' });
    carol = await signedInUser(h, { email: 'carol@example.com' });
    team = await seedTeam(h, { name: 'T', admins: [admin], members: [member] });
  });
  afterEach(() => h.close());

  const path = (userId?: string) => `/teams/${team.id}/members${userId === undefined ? '' : `/${userId}`}`;

  it('any member lists the members; an outsider gets 404; a disabled user is listed and marked', async () => {
    expect((await call(h, member, 'GET', path())).status).toBe(200);
    expect((await call<{ code: string }>(h, carol, 'GET', path())).body.code).toBe('teams-team-not-found');
    await h.db.query('update users set disabled_at = now() where id = $1', [member.user.id]);
    const res = await call<TeamMember[]>(h, admin, 'GET', path());
    expect(res.body.map((m) => [m.email, m.role, m.disabled])).toEqual([
      ['admin@example.com', 'admin', false],
      ['member@example.com', 'member', true],
    ]);
  });

  it('a team admin adds an existing user by email; duplicates, unknown emails and members are refused', async () => {
    expect(await call(h, admin, 'POST', path(), { email: 'CAROL@example.com', role: 'member' })).toMatchObject({
      status: 201,
      body: { userId: carol.user.id, email: 'carol@example.com', role: 'member', disabled: false },
    });
    expect(await call(h, admin, 'POST', path(), { email: 'carol@example.com', role: 'admin' })).toMatchObject({
      status: 409,
      body: { code: 'teams-already-member' },
    });
    expect(await call(h, admin, 'POST', path(), { email: 'nobody@example.com', role: 'member' })).toMatchObject({
      status: 404,
      body: { code: 'teams-user-unknown', message: 'No user has this email. Invite them instead.' },
    });
    expect((await call<{ code: string }>(h, member, 'POST', path(), { email: 'x@example.com', role: 'member' })).body.code).toBe(
      'teams-forbidden',
    );
  });

  it('promote, demote, and never the last admin', async () => {
    expect(await call(h, admin, 'PATCH', path(member.user.id), { role: 'admin' })).toMatchObject({
      status: 200,
      body: { role: 'admin' },
    });
    expect(await call(h, member, 'PATCH', path(admin.user.id), { role: 'member' })).toMatchObject({
      status: 200,
      body: { role: 'member' },
    });
    expect(await call(h, member, 'PATCH', path(member.user.id), { role: 'member' })).toMatchObject({
      status: 400,
      body: { code: 'teams-last-admin' },
    });
    expect((await call<{ code: string }>(h, member, 'PATCH', path(carol.user.id), { role: 'admin' })).body.code).toBe(
      'teams-member-not-found',
    );
  });

  it('two admins demoting each other at once: exactly one wins and the team keeps an admin', async () => {
    await repo.setMemberRole(h.db, team.id, member.user.id, 'admin');
    const results = await Promise.all([
      call(h, admin, 'PATCH', path(member.user.id), { role: 'member' }),
      call(h, member, 'PATCH', path(admin.user.id), { role: 'member' }),
    ]);
    // The loser is refused as the last admin, or, if the winner committed before the loser's
    // guard ran, as a member who may no longer change roles.
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await repo.countAdmins(h.db, team.id)).toBe(1);
  });

  it('removal ends grants in the team; a member leaves; nobody removes the last admin', async () => {
    const workspaceId = await seedWorkspace(h, { team, name: 'W' });
    await repo.upsertGrant(h.db, { workspaceId, userId: member.user.id, role: 'editor', at: h.clock.now });
    expect((await call(h, admin, 'DELETE', path(member.user.id))).status).toBe(204);
    expect(await effectiveRole(h.db, member.user.id, workspaceId)).toEqual({ role: 'none' });
    expect((await repo.workspaceFacts(h.db, member.user.id, workspaceId))?.grant).toBeNull();
    await repo.insertMember(h.db, { teamId: team.id, userId: carol.user.id, role: 'member', at: h.clock.now });
    expect((await call<{ code: string }>(h, carol, 'DELETE', path(admin.user.id))).body.code).toBe('teams-forbidden');
    expect((await call(h, carol, 'DELETE', path(carol.user.id))).status).toBe(204);
    expect((await call<{ code: string }>(h, admin, 'DELETE', path(admin.user.id))).body.code).toBe('teams-last-admin');
    expect((await call<{ code: string }>(h, admin, 'DELETE', path(carol.user.id))).body.code).toBe(
      'teams-member-not-found',
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/teams/teams.test.ts packages/server/test/integration/teams/members.test.ts`
Expected: FAIL. Every route answers `404 not-found`, since none is registered yet.

- [ ] **Step 3: Name cleaning**

`packages/server/src/teams/names.ts`:

```ts
import { MAX_TEAMS_NAME_LENGTH } from '@wirebench/engine';
import { nameInvalid } from './errors.js';

/**
 * §6: team and workspace names are trimmed and 1–80 characters after trimming. The schema bounded
 * the raw string already; this catches a name of spaces only.
 */
export function cleanName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_TEAMS_NAME_LENGTH) throw nameInvalid();
  return name;
}
```

- [ ] **Step 4: `/teams`**

`packages/server/src/teams/routes/teams.ts`:

```ts
/** `/teams` (spec §3.2): list, create, rename, delete. */
import {
  teamNameRequestSchema,
  teamParamsSchema,
  teamSchema,
  teamsResponseSchema,
  type Team,
  type TeamNameRequest,
  type TeamRole,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { isForeignKeyViolation, isUniqueViolation } from '../../db/errors.js';
import { requireServerAdmin, requireUser } from '../../identity/guard.js';
import { newId } from '../../identity/tokens.js';
import { jsonSchema } from '../../schema.js';
import type { TeamsEnv } from '../env.js';
import { nameTaken, notEmpty, teamNotFound } from '../errors.js';
import { cleanName } from '../names.js';
import * as repo from '../repo.js';
import { requireTeamRole } from '../roles.js';

const toTeam = (row: repo.TeamRow, myRole: TeamRole): Team => ({
  id: row.id,
  name: row.name,
  myRole,
  createdAt: row.createdAt,
});

/** A racing duplicate name answers like the pre-check would. */
function nameTakenOr(error: unknown): never {
  if (isUniqueViolation(error, 'teams_name_lower')) throw nameTaken();
  throw error;
}

export const teamRoutes =
  (env: TeamsEnv) =>
  (app: FastifyInstance): void => {
    const db = env.ctx.db;
    const params = jsonSchema(teamParamsSchema, { io: 'input' });
    const nameBody = jsonSchema(teamNameRequestSchema, { io: 'input' });

    app.get(
      '/teams',
      { preHandler: requireUser, schema: { response: { 200: jsonSchema(teamsResponseSchema) } } },
      async (request) => {
        const caller = request.caller!;
        if (caller.serverAdmin) return (await repo.allTeams(db)).map((row) => toTeam(row, 'admin'));
        return (await repo.teamsOfUser(db, caller.id)).map((row) => toTeam(row, row.role));
      },
    );

    app.post(
      '/teams',
      { preHandler: requireServerAdmin, schema: { body: nameBody, response: { 201: jsonSchema(teamSchema) } } },
      async (request, reply) => {
        const name = cleanName((request.body as TeamNameRequest).name);
        const caller = request.caller!;
        const at = env.now();
        const team = await db
          .transaction(async (tx) => {
            const row = await repo.insertTeam(tx, { id: newId(), name, at });
            // §3.2: the creator is the first admin, so a team never exists without one.
            await repo.insertMember(tx, { teamId: row.id, userId: caller.id, role: 'admin', at });
            return row;
          })
          .catch(nameTakenOr);
        return reply.code(201).send(toTeam(team, 'admin'));
      },
    );

    app.patch(
      '/teams/:teamId',
      {
        preHandler: requireTeamRole(db, 'admin'),
        schema: { params, body: nameBody, response: { 200: jsonSchema(teamSchema) } },
      },
      async (request) => {
        const { teamId } = request.params as { readonly teamId: string };
        const name = cleanName((request.body as TeamNameRequest).name);
        const row = await repo.renameTeam(db, teamId, name).catch(nameTakenOr);
        return toTeam(row, request.teamAccess!.role);
      },
    );

    app.delete('/teams/:teamId', { preHandler: requireServerAdmin, schema: { params } }, async (request, reply) => {
      const { teamId } = request.params as { readonly teamId: string };
      await db
        .transaction(async (tx) => {
          if (!(await repo.lockTeam(tx, teamId))) throw teamNotFound();
          if (await repo.teamHasWorkspaces(tx, teamId)) throw notEmpty();
          await repo.deleteTeam(tx, teamId);
        })
        .catch((error: unknown) => {
          // A workspace created between the check and the delete: the foreign key refuses it.
          if (isForeignKeyViolation(error)) throw notEmpty();
          throw error;
        });
      return reply.code(204).send();
    });
  };
```

- [ ] **Step 5: `/teams/:teamId/members`**

`packages/server/src/teams/routes/members.ts`:

```ts
/**
 * `/teams/:teamId/members` (spec §3.2). Every change that could drop the last admin locks the team
 * row first and counts inside the lock (R4), so concurrent demotions cannot both pass.
 */
import {
  memberAddRequestSchema,
  memberParamsSchema,
  memberRoleRequestSchema,
  teamMemberSchema,
  teamMembersResponseSchema,
  teamParamsSchema,
  type MemberAddRequest,
  type MemberRoleRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { findUserByEmail } from '../../identity/repo.js';
import { emailLower } from '../../identity/sessions.js';
import { jsonSchema } from '../../schema.js';
import type { TeamsEnv } from '../env.js';
import { alreadyMember, forbidden, lastAdmin, memberNotFound, userUnknown } from '../errors.js';
import * as repo from '../repo.js';
import { requireTeamRole } from '../roles.js';

interface MemberParams {
  readonly teamId: string;
  readonly userId: string;
}

export const memberRoutes =
  (env: TeamsEnv) =>
  (app: FastifyInstance): void => {
    const db = env.ctx.db;
    const teamParams = jsonSchema(teamParamsSchema, { io: 'input' });
    const params = jsonSchema(memberParamsSchema, { io: 'input' });

    app.get(
      '/teams/:teamId/members',
      {
        preHandler: requireTeamRole(db, 'member'),
        schema: { params: teamParams, response: { 200: jsonSchema(teamMembersResponseSchema) } },
      },
      (request) => repo.listMembers(db, (request.params as { readonly teamId: string }).teamId),
    );

    app.post(
      '/teams/:teamId/members',
      {
        preHandler: requireTeamRole(db, 'admin'),
        schema: {
          params: teamParams,
          body: jsonSchema(memberAddRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(teamMemberSchema) },
        },
      },
      async (request, reply) => {
        const { teamId } = request.params as { readonly teamId: string };
        const body = request.body as MemberAddRequest;
        const user = await findUserByEmail(db, emailLower(body.email));
        if (user === undefined) throw userUnknown();
        if (!(await repo.insertMember(db, { teamId, userId: user.id, role: body.role, at: env.now() }))) {
          throw alreadyMember();
        }
        return reply.code(201).send(await repo.memberOf(db, teamId, user.id));
      },
    );

    app.patch(
      '/teams/:teamId/members/:userId',
      {
        preHandler: requireTeamRole(db, 'admin'),
        schema: {
          params,
          body: jsonSchema(memberRoleRequestSchema, { io: 'input' }),
          response: { 200: jsonSchema(teamMemberSchema) },
        },
      },
      async (request) => {
        const { teamId, userId } = request.params as MemberParams;
        const { role } = request.body as MemberRoleRequest;
        await db.transaction(async (tx) => {
          await repo.lockTeam(tx, teamId);
          const current = await repo.memberRole(tx, teamId, userId);
          if (current === undefined) throw memberNotFound();
          if (current === 'admin' && role !== 'admin' && (await repo.countAdmins(tx, teamId)) <= 1) throw lastAdmin();
          await repo.setMemberRole(tx, teamId, userId, role);
        });
        return (await repo.memberOf(db, teamId, userId))!;
      },
    );

    app.delete(
      '/teams/:teamId/members/:userId',
      { preHandler: requireTeamRole(db, 'member'), schema: { params } },
      async (request, reply) => {
        const { teamId, userId } = request.params as MemberParams;
        // §16 question 2: a member may leave; removing anyone else takes a team admin.
        if (request.teamAccess!.role !== 'admin' && userId !== request.caller!.id) throw forbidden();
        await db.transaction(async (tx) => {
          await repo.lockTeam(tx, teamId);
          const current = await repo.memberRole(tx, teamId, userId);
          if (current === undefined) throw memberNotFound();
          if (current === 'admin' && (await repo.countAdmins(tx, teamId)) <= 1) throw lastAdmin();
          // §6: their access to every team workspace ends with the membership, in one transaction.
          await repo.deleteGrantsInTeam(tx, teamId, userId);
          await repo.deleteMember(tx, teamId, userId);
        });
        return reply.code(204).send();
      },
    );
  };
```

- [ ] **Step 6: Register them**

In `packages/server/src/teams/module.ts`:
- Add `import { memberRoutes } from './routes/members.js';` and
  `import { teamRoutes } from './routes/teams.js';`.
- In `register`, replace the comment and the two `void` lines with:

```ts
      teamRoutes(env)(app);
      memberRoutes(env)(app);
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/teams`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server/src/teams packages/server/test/integration/teams
git commit -m "feat(server): team and member routes with a race-safe last-admin rule

A server admin creates, and alone deletes, a team; the creator becomes its first admin. Team
admins rename it and add, re-role and remove members, and a member may leave. Every change
that could drop the last admin locks the team row and counts inside the lock, so two admins
demoting each other cannot both succeed. Removing a member ends their grants in the same
transaction."
```

---

### Task 7: Team invitations and the membership hook

Spec §3.2 (the `/teams/:teamId/invitations` rows), §3.4, R1, R2. A team invitation is identity's
invitation with a `team_invitations` row written through `attach`. When it is accepted by either way in,
the hook adds the membership inside identity's transaction.

**Files:**
- Create: `packages/server/src/teams/routes/invitations.ts`,
  `packages/server/test/integration/teams/invitations.test.ts`
- Modify: `packages/server/src/teams/module.ts`

**Interfaces:**
- Produces: `teamInvitationRoutes(env)`; `addInvitedMember(now): InvitationAcceptedHook`.
- Consumes: `createInvitation`, `revokeOpenInvitation`, `InvitationCreated` (identity, Task 2 signature);
  `runInvitationAccepted` wiring (Task 2); Task 4 `repo` invitation functions and `errors`; Task 5
  `requireTeamRole`.

- [ ] **Step 1: Write the failing tests**

`packages/server/test/integration/teams/invitations.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Team, TeamInvitation, TeamInvitationCreated } from '@wirebench/engine';
import * as identityRepo from '../../../src/identity/repo.js';
import { pkceChallenge } from '../../../src/identity/tokens.js';
import * as repo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { startFakeOidcIssuer, type FakeOidcIssuer } from '../../helpers/fake-oidc-issuer.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam, teamsHarness } from '../../helpers/teams.js';

const PASSWORD = 'correct horse battery';
const secretOf = (url: string): string => url.slice(url.lastIndexOf('/') + 1);

describeDb('team invitations (§3.2, §3.4)', () => {
  let h: IdentityHarness;
  let admin: SignedInUser;
  let member: SignedInUser;
  let team: repo.TeamRow;
  beforeEach(async () => {
    h = await teamsHarness();
    admin = await signedInUser(h, { email: 'admin@example.com' });
    member = await signedInUser(h, { email: 'member@example.com' });
    team = await seedTeam(h, { name: 'Payments QA', admins: [admin], members: [member] });
  });
  afterEach(() => h.close());

  const invite = (email: string, role: 'member' | 'admin' = 'member', as = admin) =>
    call<TeamInvitationCreated & { code?: string; message?: string }>(h, as, 'POST', `/teams/${team.id}/invitations`, {
      email,
      role,
    });
  const accept = (url: string, name: string) =>
    call<{ token: string; user: { id: string } }>(h, undefined, 'POST', '/invitations/accept', {
      secret: secretOf(url),
      displayName: name,
      password: PASSWORD,
      device: { name: 'laptop' },
    });

  it('a team admin invites; the link is shown once; the list and identity both know it, never as server admin', async () => {
    const res = await invite('Bob@example.com');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: 'Bob@example.com', role: 'member' });
    expect(res.body.url).toMatch(/^https:\/\/wirebench\.test\/invite\/[A-Za-z0-9_-]{43}$/);
    const list = await call<TeamInvitation[]>(h, admin, 'GET', `/teams/${team.id}/invitations`);
    expect(list.body).toEqual([expect.objectContaining({ id: res.body.id, email: 'Bob@example.com', role: 'member', createdBy: admin.user.id })]);
    expect(JSON.stringify(list.body)).not.toContain(secretOf(res.body.url));
    expect((await identityRepo.invitationById(h.db, res.body.id))?.serverAdmin).toBe(false);
  });

  it('refuses an existing user with the hint, a member with 403 and an outsider with 404', async () => {
    expect(await invite('MEMBER@example.com')).toMatchObject({
      status: 409,
      body: { code: 'identity-user-exists', message: 'A user with this email already exists. Add them as a member instead.' },
    });
    expect((await invite('x@example.com', 'member', member)).body.code).toBe('teams-forbidden');
    const stranger = await signedInUser(h, { email: 'stranger@example.com' });
    expect((await invite('x@example.com', 'member', stranger)).body.code).toBe('teams-team-not-found');
  });

  it('accepting puts the new user on the team with the invited role, visible on their very first request', async () => {
    const { url } = (await invite('bob@example.com', 'admin')).body;
    const accepted = await accept(url, 'Bob');
    expect(accepted.status).toBe(201);
    const teams = await h.app.inject({
      method: 'GET',
      url: '/api/v1/teams',
      headers: { authorization: `Bearer ${accepted.body.token}` },
    });
    expect(teams.json<Team[]>().map((t) => [t.id, t.myRole])).toEqual([[team.id, 'admin']]);
    expect((await call<TeamInvitation[]>(h, admin, 'GET', `/teams/${team.id}/invitations`)).body).toEqual([]);
  });

  it('a plain server invitation adds no membership; a team deleted before acceptance leaves the user teamless', async () => {
    const root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    const plain = await call<{ url: string }>(h, root, 'POST', '/invitations', { email: 'carol@example.com' });
    const carol = await accept(plain.body.url, 'Carol');
    expect(await repo.teamsOfUser(h.db, carol.body.user.id)).toEqual([]);
    const { url } = (await invite('dan@example.com')).body;
    await repo.deleteTeam(h.db, team.id);
    const dan = await accept(url, 'Dan');
    expect(dan.status).toBe(201);
    expect(await repo.teamsOfUser(h.db, dan.body.user.id)).toEqual([]);
  });

  it('revoke: only this team’s open invitations, and only once', async () => {
    const { id, url } = (await invite('bob@example.com')).body;
    const other = await seedTeam(h, { name: 'Other', admins: [member] });
    expect((await call<{ code: string }>(h, member, 'DELETE', `/teams/${other.id}/invitations/${id}`)).body.code).toBe(
      'teams-invitation-not-found',
    );
    expect((await call(h, admin, 'DELETE', `/teams/${team.id}/invitations/${id}`)).status).toBe(204);
    expect((await call<{ code: string }>(h, admin, 'DELETE', `/teams/${team.id}/invitations/${id}`)).body.code).toBe(
      'teams-invitation-not-found',
    );
    expect((await accept(url, 'Bob')).status).toBe(404);
  });
});

describeDb('team invitations over OIDC (§3.4, §13.1)', () => {
  const VERIFIER = 'v'.repeat(43);
  const PORT = 49152;
  let idp: FakeOidcIssuer;
  let h: IdentityHarness;
  beforeEach(async () => {
    idp = await startFakeOidcIssuer();
    h = await teamsHarness({
      env: {
        WIREBENCH_SERVER_OIDC_ISSUER: idp.url,
        WIREBENCH_SERVER_OIDC_CLIENT_ID: idp.clientId,
        WIREBENCH_SERVER_OIDC_CLIENT_SECRET: idp.clientSecret,
        WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true',
      },
    });
  });
  afterEach(async () => {
    await h.close();
    await idp.close();
  });

  it('the first OIDC sign-in against a team invitation lands the user on the team', async () => {
    const admin = await signedInUser(h, { email: 'admin@example.com' });
    const team = await seedTeam(h, { name: 'Payments QA', admins: [admin] });
    expect(
      (await call(h, admin, 'POST', `/teams/${team.id}/invitations`, { email: 'erin@example.com', role: 'member' })).status,
    ).toBe(201);
    idp.nextUser({ sub: 'sub-erin', email: 'erin@example.com', email_verified: true, name: 'Erin' });
    const started = await call<{ flowId: string; authorizationUrl: string }>(h, undefined, 'POST', '/auth/oidc/start', {
      device: { name: 'Mac' },
      codeChallenge: pkceChallenge(VERIFIER),
      loopbackPort: PORT,
    });
    const back = await idp.authorize(started.body.authorizationUrl);
    const cb = await h.app.inject({ method: 'GET', url: `${back.pathname}${back.search}` });
    const grant = new URL(String(cb.headers['location'])).searchParams.get('grant')!;
    const done = await call<{ token: string; user: { id: string } }>(h, undefined, 'POST', '/auth/oidc/complete', {
      flowId: started.body.flowId,
      grant,
      codeVerifier: VERIFIER,
    });
    expect(done.status).toBe(201);
    expect(await repo.memberRole(h.db, team.id, done.body.user.id)).toBe('member');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/teams/invitations.test.ts`
Expected: FAIL. The invitation routes answer `404 not-found`, and after an accept `teamsOfUser` is empty.

- [ ] **Step 3: Implement the routes and the hook**

`packages/server/src/teams/routes/invitations.ts`:

```ts
/**
 * `/teams/:teamId/invitations` (spec §3.2) and the hook that keeps a team invitation's promise
 * (§3.4). The invitation itself is identity's; this module adds the team and the role through
 * `createInvitation`'s `attach`, in the same transaction.
 */
import {
  teamInvitationCreatedSchema,
  teamInvitationCreateRequestSchema,
  teamInvitationParamsSchema,
  teamInvitationsResponseSchema,
  teamParamsSchema,
  WirebenchError,
  type InvitationCreated,
  type TeamInvitationCreateRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import type { InvitationAcceptedHook } from '../../context.js';
import { createInvitation, revokeOpenInvitation } from '../../identity/invitations.js';
import { jsonSchema } from '../../schema.js';
import type { TeamsEnv } from '../env.js';
import { invitationNotFound, userExistsInvite } from '../errors.js';
import * as repo from '../repo.js';
import { requireTeamRole } from '../roles.js';

/**
 * §3.4: runs inside identity's accepting transaction. No `team_invitations` row means a plain
 * server invitation, or a team deleted since (its row went with it): nothing to add.
 */
export function addInvitedMember(now: () => Date): InvitationAcceptedHook {
  return async (tx, accepted) => {
    const invited = await repo.teamInvitationOf(tx, accepted.invitationId);
    if (invited === undefined) return;
    await repo.insertMember(tx, { teamId: invited.teamId, userId: accepted.userId, role: invited.role, at: now() });
  };
}

export const teamInvitationRoutes =
  (env: TeamsEnv) =>
  (app: FastifyInstance): void => {
    const db = env.ctx.db;
    const params = jsonSchema(teamParamsSchema, { io: 'input' });

    app.get(
      '/teams/:teamId/invitations',
      {
        preHandler: requireTeamRole(db, 'admin'),
        schema: { params, response: { 200: jsonSchema(teamInvitationsResponseSchema) } },
      },
      (request) => repo.openTeamInvitations(db, (request.params as { readonly teamId: string }).teamId, env.now()),
    );

    app.post(
      '/teams/:teamId/invitations',
      {
        preHandler: requireTeamRole(db, 'admin'),
        schema: {
          params,
          body: jsonSchema(teamInvitationCreateRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(teamInvitationCreatedSchema) },
        },
      },
      async (request, reply) => {
        const { teamId } = request.params as { readonly teamId: string };
        const body = request.body as TeamInvitationCreateRequest;
        let created: InvitationCreated;
        try {
          // §6: a team invitation can never mint a server admin.
          created = await createInvitation(
            env.invitations,
            { email: body.email, serverAdmin: false, createdBy: request.caller!.id },
            (tx, invitationId) => repo.insertTeamInvitation(tx, { invitationId, teamId, role: body.role }),
          );
        } catch (error) {
          if (error instanceof WirebenchError && error.code === 'identity-user-exists') throw userExistsInvite();
          throw error;
        }
        return reply
          .code(201)
          .send({ id: created.id, email: created.email, role: body.role, url: created.url, expiresAt: created.expiresAt });
      },
    );

    app.delete(
      '/teams/:teamId/invitations/:id',
      {
        preHandler: requireTeamRole(db, 'admin'),
        schema: { params: jsonSchema(teamInvitationParamsSchema, { io: 'input' }) },
      },
      async (request, reply) => {
        const { teamId, id } = request.params as { readonly teamId: string; readonly id: string };
        if (!(await repo.isTeamInvitation(db, teamId, id))) throw invitationNotFound();
        if (!(await revokeOpenInvitation(env.invitations, id))) throw invitationNotFound();
        return reply.code(204).send();
      },
    );
  };
```

In `packages/server/src/teams/module.ts`:
- Add `import { addInvitedMember, teamInvitationRoutes } from './routes/invitations.js';`.
- In `register`, after `memberRoutes(env)(app);`:

```ts
      teamInvitationRoutes(env)(app);
      ctx.hooks.invitationAccepted.push(addInvitedMember(now));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/teams packages/server/test/integration/identity`
Expected: PASS. The identity suites are included because `createInvitation` and the hooks are shared.

- [ ] **Step 5: Commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server/src/teams packages/server/test/integration/teams/invitations.test.ts
git commit -m "feat(server): team invitations that land the new user on the team

A team admin invites by email with a team role; the identity invitation and its team row are
written in one transaction, and a team invitation never carries the server admin flag. On
acceptance, local or through the identity provider, the membership is inserted inside
identity's transaction, so the new user's first request already sees the team."
```

---

### Task 8: Workspace and access routes, the repository ordering, the server README

Spec §3.2 (the `/workspaces` and `…/access` rows), §3.6 (`GET /workspaces` feeds server-sync's join
dialog), §3.7.

**Ruling:** a server admin who creates a workspace in a team they are not on gets no grant. Grants
belong to members, and a server admin is admin everywhere anyway. Any team member who creates one
(including a team admin) gets the `admin` grant the spec names.

**Ruling:** routes return the object itself (`201` with the workspace summary), not a `{ workspace }`
wrapper, matching identity's routes and the revised spec §3.2.

**Files:**
- Create: `packages/server/src/teams/routes/{workspaces,access}.ts`,
  `packages/server/test/integration/teams/{workspaces,access}.test.ts`
- Modify: `packages/server/src/teams/module.ts`, `packages/server/README.md`

**Interfaces:**
- Produces: `workspaceRoutes(env)`, `accessRoutes(env)`,
  `toWorkspace(row, myRole, source): TeamWorkspace`, `toAccessEntry(row): AccessEntry`.
- Consumes: `RepoStore.withLock/create/remove` (host, Task 3); Task 4 `repo`/`errors`; Task 5
  `resolveRole`, `factsOf`, `effectiveRole`, both guards; Task 6 `cleanName`.

- [ ] **Step 1: Write the failing tests**

`packages/server/test/integration/teams/workspaces.test.ts`:

```ts
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { TeamWorkspace } from '@wirebench/engine';
import { newId } from '../../../src/identity/tokens.js';
import * as repo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam, seedWorkspace, teamsHarness } from '../../helpers/teams.js';

describeDb('/workspaces (§3.2, §3.6, §3.7)', () => {
  let h: IdentityHarness;
  let admin: SignedInUser;
  let alice: SignedInUser;
  let bob: SignedInUser;
  let stranger: SignedInUser;
  let team: repo.TeamRow;
  beforeEach(async () => {
    h = await teamsHarness();
    admin = await signedInUser(h, { email: 'admin@example.com' });
    alice = await signedInUser(h, { email: 'alice@example.com' });
    bob = await signedInUser(h, { email: 'bob@example.com' });
    stranger = await signedInUser(h, { email: 'stranger@example.com' });
    team = await seedTeam(h, { name: 'Payments QA', admins: [admin], members: [alice, bob] });
  });
  afterEach(() => h.close());

  const create = (as: SignedInUser, payload: object) =>
    call<TeamWorkspace & { code?: string }>(h, as, 'POST', `/teams/${team.id}/workspaces`, payload);
  const list = async (as: SignedInUser) =>
    (await call<TeamWorkspace[]>(h, as, 'GET', '/workspaces')).body.map((w) => [w.name, w.myRole, w.source]);

  it('a member creates one: the row, the repository, the creator as admin, the others at the default role', async () => {
    const res = await create(alice, { name: ' Integration ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Integration',
      teamId: team.id,
      teamName: 'Payments QA',
      defaultRole: 'viewer',
      myRole: 'admin',
      source: 'grant',
    });
    expect(await h.repos.exists(res.body.id)).toBe(true);
    expect(await list(bob)).toEqual([['Integration', 'viewer', 'default']]);
    expect(await list(admin)).toEqual([['Integration', 'admin', 'team-admin']]);
    expect(await list(stranger)).toEqual([]);
    expect((await create(stranger, { name: 'X' })).body.code).toBe('teams-team-not-found');
  });

  it('takes the app’s id; a taken id, an existing repository and a clashing name are 409s with nothing left behind', async () => {
    const id = newId();
    expect((await create(alice, { id, name: 'A' })).body.id).toBe(id);
    expect(await create(bob, { id, name: 'B' })).toMatchObject({ status: 409, body: { code: 'teams-workspace-exists' } });
    expect(await create(bob, { name: 'a' })).toMatchObject({ status: 409, body: { code: 'teams-workspace-name-taken' } });
    const orphan = newId();
    await h.repos.withLock(orphan, () => h.repos.create(orphan));
    expect(await create(bob, { id: orphan, name: 'C' })).toMatchObject({
      status: 409,
      body: { code: 'teams-workspace-exists' },
    });
    expect(await repo.workspaceById(h.db, orphan)).toBeUndefined();
  });

  it('default none hides it from members without a grant, as a 404', async () => {
    const res = await create(alice, { name: 'Secret', defaultRole: 'none' });
    expect(await list(bob)).toEqual([]);
    expect((await call<{ code: string }>(h, bob, 'GET', `/workspaces/${res.body.id}`)).body.code).toBe(
      'teams-workspace-not-found',
    );
    expect((await call<TeamWorkspace>(h, alice, 'GET', `/workspaces/${res.body.id}`)).body.myRole).toBe('admin');
  });

  it('a workspace admin renames it and changes the default role; a viewer cannot', async () => {
    const { id } = (await create(alice, { name: 'W' })).body;
    await create(alice, { name: 'Other' });
    expect(await call(h, alice, 'PATCH', `/workspaces/${id}`, { defaultRole: 'editor', name: 'W2' })).toMatchObject({
      status: 200,
      body: { name: 'W2', defaultRole: 'editor', myRole: 'admin' },
    });
    expect(await list(bob)).toEqual([
      ['Other', 'viewer', 'default'],
      ['W2', 'editor', 'default'],
    ]);
    expect((await call<{ code: string }>(h, bob, 'PATCH', `/workspaces/${id}`, { name: 'X' })).body.code).toBe(
      'teams-forbidden',
    );
    expect((await call<{ code: string }>(h, alice, 'PATCH', `/workspaces/${id}`, { name: 'other' })).body.code).toBe(
      'teams-workspace-name-taken',
    );
  });

  it('delete moves the repository away, and still answers 204 when the directory is already gone', async () => {
    const { id } = (await create(alice, { name: 'W' })).body;
    expect((await call<{ code: string }>(h, bob, 'DELETE', `/workspaces/${id}`)).body.code).toBe('teams-forbidden');
    expect((await call(h, alice, 'DELETE', `/workspaces/${id}`)).status).toBe(204);
    expect(await repo.workspaceById(h.db, id)).toBeUndefined();
    expect(await h.repos.exists(id)).toBe(false);
    expect(readdirSync(join(h.dataDir, 'tmp')).some((name) => name.startsWith(`removed-${id}-`))).toBe(true);
    const bare = await seedWorkspace(h, { team, name: 'No repository' });
    expect((await call(h, admin, 'DELETE', `/workspaces/${bare}`)).status).toBe(204);
    expect((await call(h, admin, 'GET', `/workspaces/${bare}`)).status).toBe(404);
  });

  it('a server admin sees every workspace as admin, source server-admin, and gets no grant for creating one', async () => {
    const root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    const res = await create(root, { name: 'By root' });
    expect(res.body).toMatchObject({ myRole: 'admin', source: 'server-admin' });
    expect((await repo.workspaceFacts(h.db, root.user.id, res.body.id))?.grant).toBeNull();
    expect(await list(root)).toEqual([['By root', 'admin', 'server-admin']]);
  });
});
```

`packages/server/test/integration/teams/access.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { AccessEntry, TeamWorkspace } from '@wirebench/engine';
import type * as repo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam, seedWorkspace, teamsHarness } from '../../helpers/teams.js';

describeDb('/workspaces/:workspaceId/access (§3.2)', () => {
  let h: IdentityHarness;
  let admin: SignedInUser;
  let alice: SignedInUser;
  let bob: SignedInUser;
  let team: repo.TeamRow;
  let id: string;
  beforeEach(async () => {
    h = await teamsHarness();
    admin = await signedInUser(h, { email: 'admin@example.com' });
    alice = await signedInUser(h, { email: 'alice@example.com' });
    bob = await signedInUser(h, { email: 'bob@example.com' });
    team = await seedTeam(h, { name: 'T', admins: [admin], members: [alice, bob] });
    id = await seedWorkspace(h, { team, name: 'W' });
  });
  afterEach(() => h.close());

  const access = async () =>
    (await call<AccessEntry[]>(h, admin, 'GET', `/workspaces/${id}/access`)).body.map((e) => [
      e.email,
      e.effectiveRole,
      e.source ?? null,
      e.grant ?? null,
    ]);
  const myRole = async (as: SignedInUser) =>
    (await call<TeamWorkspace[]>(h, as, 'GET', '/workspaces')).body.find((w) => w.id === id)?.myRole ?? 'none';

  it('lists every team member with the role they have and why', async () => {
    expect(await access()).toEqual([
      ['admin@example.com', 'admin', 'team-admin', null],
      ['alice@example.com', 'viewer', 'default', null],
      ['bob@example.com', 'viewer', 'default', null],
    ]);
    expect((await call<{ code: string }>(h, alice, 'GET', `/workspaces/${id}/access`)).body.code).toBe('teams-forbidden');
    const stranger = await signedInUser(h, { email: 'stranger@example.com' });
    expect((await call<{ code: string }>(h, stranger, 'GET', `/workspaces/${id}/access`)).body.code).toBe(
      'teams-workspace-not-found',
    );
  });

  it('a grant, its removal and a default-role change each take effect immediately', async () => {
    expect((await call(h, admin, 'PUT', `/workspaces/${id}/access/${bob.user.id}`, { role: 'editor' })).status).toBe(204);
    expect(await myRole(bob)).toBe('editor');
    expect(await access()).toContainEqual(['bob@example.com', 'editor', 'grant', 'editor']);
    expect((await call(h, admin, 'PATCH', `/workspaces/${id}`, { defaultRole: 'none' })).status).toBe(200);
    expect(await myRole(alice)).toBe('none');
    expect(await myRole(bob)).toBe('editor');
    expect((await call(h, admin, 'DELETE', `/workspaces/${id}/access/${bob.user.id}`)).status).toBe(204);
    expect(await myRole(bob)).toBe('none');
    expect(await access()).toContainEqual(['bob@example.com', 'none', null, null]);
  });

  it('a grant can lower a member below the default; a team admin stays admin whatever the grant', async () => {
    await call(h, admin, 'PATCH', `/workspaces/${id}`, { defaultRole: 'editor' });
    await call(h, admin, 'PUT', `/workspaces/${id}/access/${alice.user.id}`, { role: 'viewer' });
    await call(h, admin, 'PUT', `/workspaces/${id}/access/${admin.user.id}`, { role: 'viewer' });
    expect(await access()).toEqual([
      ['admin@example.com', 'admin', 'team-admin', 'viewer'],
      ['alice@example.com', 'viewer', 'grant', 'viewer'],
      ['bob@example.com', 'editor', 'default', null],
    ]);
  });

  it('refuses a grant for someone off the team and a role outside the list', async () => {
    const stranger = await signedInUser(h, { email: 'stranger@example.com' });
    expect(await call(h, admin, 'PUT', `/workspaces/${id}/access/${stranger.user.id}`, { role: 'viewer' })).toMatchObject({
      status: 400,
      body: { code: 'teams-not-a-member' },
    });
    expect(await call(h, admin, 'PUT', `/workspaces/${id}/access/${bob.user.id}`, { role: 'owner' })).toMatchObject({
      status: 400,
      body: { code: 'invalid-request' },
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/teams/workspaces.test.ts packages/server/test/integration/teams/access.test.ts`
Expected: FAIL. The routes answer `404 not-found`.

- [ ] **Step 3: `/workspaces`**

`packages/server/src/teams/routes/workspaces.ts`:

```ts
/**
 * Workspaces (spec §3.2, §3.7). Creation inserts the row and the creator's grant and builds the
 * bare repository inside one transaction, so a failing build leaves no row; deletion removes the
 * row, then moves the repository away. The row is the source of truth.
 */
import {
  teamParamsSchema,
  teamWorkspaceCreateRequestSchema,
  teamWorkspaceParamsSchema,
  teamWorkspaceSchema,
  teamWorkspacesResponseSchema,
  teamWorkspaceUpdateRequestSchema,
  WirebenchError,
  type RoleSource,
  type TeamWorkspace,
  type TeamWorkspaceCreateRequest,
  type TeamWorkspaceUpdateRequest,
  type WorkspaceRole,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { isUniqueViolation } from '../../db/errors.js';
import { requireUser } from '../../identity/guard.js';
import { newId } from '../../identity/tokens.js';
import { jsonSchema } from '../../schema.js';
import type { TeamsEnv } from '../env.js';
import { workspaceExists, workspaceNameTaken, workspaceNotFound } from '../errors.js';
import { cleanName } from '../names.js';
import * as repo from '../repo.js';
import { effectiveRole, factsOf, requireTeamRole, requireWorkspaceRole, resolveRole } from '../roles.js';

export function toWorkspace(row: repo.WorkspaceRow, myRole: WorkspaceRole, source: RoleSource): TeamWorkspace {
  return {
    id: row.id,
    name: row.name,
    teamId: row.teamId,
    teamName: row.teamName,
    defaultRole: row.defaultRole,
    myRole,
    source,
    createdAt: row.createdAt,
  };
}

/** Racing duplicates answer like the pre-checks would: a taken id, a taken name, an existing repository. */
function conflictOr(error: unknown): never {
  if (isUniqueViolation(error, 'workspaces_pkey')) throw workspaceExists();
  if (isUniqueViolation(error, 'workspaces_team_name_lower')) throw workspaceNameTaken();
  if (error instanceof WirebenchError && error.code === 'server-repo-exists') throw workspaceExists();
  throw error;
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';

export const workspaceRoutes =
  (env: TeamsEnv) =>
  (app: FastifyInstance): void => {
    const { db, repos } = env.ctx;
    const params = jsonSchema(teamWorkspaceParamsSchema, { io: 'input' });
    const one = jsonSchema(teamWorkspaceSchema);

    app.get(
      '/workspaces',
      { preHandler: requireUser, schema: { response: { 200: jsonSchema(teamWorkspacesResponseSchema) } } },
      async (request) => {
        const caller = request.caller!;
        const rows = await repo.visibleWorkspaces(db, caller.id, caller.serverAdmin);
        return rows.flatMap((row) => {
          const found = resolveRole(factsOf({ ...row, disabled: false, serverAdmin: caller.serverAdmin }));
          return found.role === 'none' ? [] : [toWorkspace(row, found.role, found.source)];
        });
      },
    );

    app.post(
      '/teams/:teamId/workspaces',
      {
        preHandler: requireTeamRole(db, 'member'),
        schema: {
          params: jsonSchema(teamParamsSchema, { io: 'input' }),
          body: jsonSchema(teamWorkspaceCreateRequestSchema, { io: 'input' }),
          response: { 201: one },
        },
      },
      async (request, reply) => {
        const { teamId } = request.params as { readonly teamId: string };
        const body = request.body as TeamWorkspaceCreateRequest;
        const name = cleanName(body.name);
        const id = body.id ?? newId();
        const caller = request.caller!;
        const at = env.now();
        // An object, not a `let`: the flag is set inside the transaction callback.
        const progress = { built: false };
        try {
          await db.transaction(async (tx) => {
            await repo.insertWorkspace(tx, {
              id,
              name,
              teamId,
              defaultRole: body.defaultRole ?? 'viewer',
              createdBy: caller.id,
              at,
            });
            // §3.2: the creator administers what they made. Grants belong to members, so a server
            // admin off the team (admin everywhere anyway) gets none.
            if ((await repo.memberRole(tx, teamId, caller.id)) !== undefined) {
              await repo.upsertGrant(tx, { workspaceId: id, userId: caller.id, role: 'admin', at });
            }
            // §3.7: built before commit, so a failure here rolls the row back.
            await repos.withLock(id, () => repos.create(id));
            progress.built = true;
          });
        } catch (error) {
          if (progress.built) {
            // The commit failed after the repository existed: move it away so the id is usable again.
            await repos
              .withLock(id, () => repos.remove(id))
              .catch((cause: unknown) => {
                request.log.warn({ err: cause, workspaceId: id }, 'could not move away an uncommitted workspace repository');
              });
          }
          conflictOr(error);
        }
        const row = (await repo.workspaceById(db, id))!;
        const found = await effectiveRole(db, caller.id, id);
        if (found.role === 'none') throw workspaceNotFound();
        return reply.code(201).send(toWorkspace(row, found.role, found.source));
      },
    );

    app.get(
      '/workspaces/:workspaceId',
      { preHandler: requireWorkspaceRole(db, 'viewer'), schema: { params, response: { 200: one } } },
      async (request) => {
        const access = request.workspaceAccess!;
        return toWorkspace((await repo.workspaceById(db, access.workspaceId))!, access.role, access.source);
      },
    );

    app.patch(
      '/workspaces/:workspaceId',
      {
        preHandler: requireWorkspaceRole(db, 'admin'),
        schema: { params, body: jsonSchema(teamWorkspaceUpdateRequestSchema, { io: 'input' }), response: { 200: one } },
      },
      async (request) => {
        const access = request.workspaceAccess!;
        const body = request.body as TeamWorkspaceUpdateRequest;
        await repo
          .updateWorkspace(db, access.workspaceId, {
            ...(body.name !== undefined ? { name: cleanName(body.name) } : {}),
            ...(body.defaultRole !== undefined ? { defaultRole: body.defaultRole } : {}),
          })
          .catch(conflictOr);
        return toWorkspace((await repo.workspaceById(db, access.workspaceId))!, access.role, access.source);
      },
    );

    app.delete(
      '/workspaces/:workspaceId',
      { preHandler: requireWorkspaceRole(db, 'admin'), schema: { params } },
      async (request, reply) => {
        const { workspaceId } = request.workspaceAccess!;
        await repo.deleteWorkspace(db, workspaceId); // grants go by cascade
        // §3.7: the row is the source of truth; the repository moves under tmp/, never deleted.
        await repos
          .withLock(workspaceId, () => repos.remove(workspaceId))
          .catch((error: unknown) => {
            if (!isMissing(error)) throw error;
            request.log.warn({ workspaceId }, 'deleted a workspace whose repository was already gone');
          });
        return reply.code(204).send();
      },
    );
  };
```

- [ ] **Step 4: `…/access`**

`packages/server/src/teams/routes/access.ts`:

```ts
/**
 * `/workspaces/:workspaceId/access` (spec §3.2): the one place a grant is set, and the list that
 * shows every team member's effective role beside its source (§15, role source confusion).
 */
import {
  accessParamsSchema,
  accessResponseSchema,
  setAccessRequestSchema,
  teamWorkspaceParamsSchema,
  type AccessEntry,
  type SetAccessRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { jsonSchema } from '../../schema.js';
import type { TeamsEnv } from '../env.js';
import { notAMember } from '../errors.js';
import * as repo from '../repo.js';
import { factsOf, requireWorkspaceRole, resolveRole } from '../roles.js';

interface AccessParams {
  readonly workspaceId: string;
  readonly userId: string;
}

export function toAccessEntry(row: repo.AccessRow): AccessEntry {
  const found = resolveRole(factsOf(row));
  return {
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    teamRole: row.teamRole,
    disabled: row.disabled,
    effectiveRole: found.role,
    ...(found.role !== 'none' ? { source: found.source } : {}),
    ...(row.grant !== null ? { grant: row.grant } : {}),
  };
}

export const accessRoutes =
  (env: TeamsEnv) =>
  (app: FastifyInstance): void => {
    const db = env.ctx.db;
    const params = jsonSchema(accessParamsSchema, { io: 'input' });

    app.get(
      '/workspaces/:workspaceId/access',
      {
        preHandler: requireWorkspaceRole(db, 'admin'),
        schema: {
          params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' }),
          response: { 200: jsonSchema(accessResponseSchema) },
        },
      },
      async (request) => (await repo.accessRows(db, request.workspaceAccess!.workspaceId)).map(toAccessEntry),
    );

    app.put(
      '/workspaces/:workspaceId/access/:userId',
      {
        preHandler: requireWorkspaceRole(db, 'admin'),
        schema: { params, body: jsonSchema(setAccessRequestSchema, { io: 'input' }) },
      },
      async (request, reply) => {
        const { workspaceId, userId } = request.params as AccessParams;
        const { role } = request.body as SetAccessRequest;
        await db.transaction(async (tx) => {
          if (!(await repo.isTeamMemberOfWorkspace(tx, workspaceId, userId))) throw notAMember();
          await repo.upsertGrant(tx, { workspaceId, userId, role, at: env.now() });
        });
        return reply.code(204).send();
      },
    );

    app.delete(
      '/workspaces/:workspaceId/access/:userId',
      { preHandler: requireWorkspaceRole(db, 'admin'), schema: { params } },
      async (request, reply) => {
        const { workspaceId, userId } = request.params as AccessParams;
        await repo.deleteGrant(db, workspaceId, userId);
        return reply.code(204).send();
      },
    );
  };
```

- [ ] **Step 5: Register them and drop the placeholder**

In `packages/server/src/teams/module.ts`:
- Add `import { accessRoutes } from './routes/access.js';` and
  `import { workspaceRoutes } from './routes/workspaces.js';`.
- After `teamInvitationRoutes(env)(app);`:

```ts
      workspaceRoutes(env)(app);
      accessRoutes(env)(app);
```

`register` now reads, in order: `env`, `addCapability('teams')`, the five route groups, the hook push,
and `await Promise.resolve();`.

- [ ] **Step 6: Run every server test**

Run: `pnpm exec vitest run --project server-unit --project server-integration`
Expected: PASS.

- [ ] **Step 7: The server README**

In `packages/server/README.md`, append after the `## Accounts` section:

````markdown
## Teams

A server admin creates teams (`POST /api/v1/teams`) and becomes the first admin of each. Team admins do
the rest, from the app's **Account: Manage teams…** dialog or the API:

- Add people who already have an account, invite new ones, and change or remove roles. A team keeps at
  least one admin.
- Workspaces belong to a team. Any member can create one and is its admin. Each workspace has a default
  role for the team's members (`none`, `viewer` or `editor`; new workspaces default to `viewer`), and a
  workspace admin can grant any member a different role.

| Role | Open and pull | Send requests | Push | Manage access | Delete |
| --- | --- | --- | --- | --- | --- |
| viewer | yes | yes | no | no | no |
| editor | yes | yes | yes | no | no |
| admin | yes | yes | yes | yes | yes |

Team admins and server admins are admins of every workspace of their teams. To anyone without a role,
a workspace (or a team) does not exist: the API answers `404`, never `403`. Deleting a workspace moves
its repository under `<data dir>/tmp/`; nothing is deleted from disk.
````

- [ ] **Step 8: Commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server/src/teams packages/server/test/integration/teams packages/server/README.md
git commit -m "feat(server): team workspaces, per-member grants and the access list

A member creates a workspace for the team and becomes its admin; the row, the grant and the
bare repository are made in one transaction, so a failed build leaves nothing behind. GET
/workspaces lists what the caller can open with the role and its source, which the join
dialog in server-sync will read. Workspace admins set the default role and per-member grants;
every change is visible on the next request. Deleting moves the repository away, and a
missing directory does not fail the delete."
```

---

## Desktop


### Task 9: Desktop — `ServerClient` team methods

Spec §5.2. **Ruling:** the spec's "groups" (`teams`, `members`, …) are flat methods, one per route,
matching the class as identity left it (`signInLocal`, `me`, …). The token is a parameter, never a field.

**Files:**
- Modify: `apps/desktop/src/main/server-client.ts`, `apps/desktop/test/server-client.test.ts`

**Interfaces:**
- Produces, on `ServerClient`, each taking `(url, token, …)`:
  - Teams: `listTeams` → `Team[]`, `createTeam(name)` → `Team`, `renameTeam(teamId, name)` → `Team`,
    `deleteTeam(teamId)` → `void`.
  - Members: `listMembers(teamId)` → `TeamMember[]`, `addMember(teamId, body)` → `TeamMember`,
    `setMemberRole(teamId, userId, role)` → `TeamMember`, `removeMember(teamId, userId)` → `void`.
  - Invitations: `listTeamInvitations(teamId)` → `TeamInvitation[]`, `inviteToTeam(teamId, body)` →
    `TeamInvitationCreated`, `revokeTeamInvitation(teamId, invitationId)` → `void`.
  - Workspaces: `listWorkspaces` → `TeamWorkspace[]`, `createWorkspace(teamId, body)`,
    `getWorkspace(workspaceId)` and `updateWorkspace(workspaceId, body)`, each → `TeamWorkspace`;
    `deleteWorkspace(workspaceId)` → `void`.
  - Access: `workspaceAccess(workspaceId)` → `AccessEntry[]`, `setAccess(workspaceId, userId, role)` →
    `void`, `clearAccess(workspaceId, userId)` → `void`.
- Consumes: Task 1 schemas and types.

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/test/server-client.test.ts`:

```ts
describe('ServerClient — teams (teams-access §3.2)', () => {
  const TEAM_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
  const USER_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QB';
  const WS_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QC';
  const TEAM = { id: TEAM_ID, name: 'Payments QA', myRole: 'admin', createdAt: '2026-09-25T10:00:00.000Z' };
  const WORKSPACE = {
    id: WS_ID,
    name: 'Integration',
    teamId: TEAM_ID,
    teamName: 'Payments QA',
    defaultRole: 'viewer',
    myRole: 'admin',
    source: 'grant',
    createdAt: '2026-09-25T10:00:00.000Z',
  };
  const body = (request: HttpRequest | undefined): unknown =>
    request?.body === undefined ? undefined : JSON.parse(new TextDecoder().decode(request.body));

  it('sends each call to its route with the method, the bearer and the body the server validates', async () => {
    const { client: c, sent } = client(
      exchange(200, [TEAM]),
      exchange(201, TEAM),
      exchange(200, { ...TEAM, name: 'QA' }),
      exchange(204, ''),
      exchange(200, { userId: USER_ID, email: 'b@x.co', displayName: 'B', role: 'admin', disabled: false, addedAt: 'x' }),
      exchange(204, ''),
      exchange(201, WORKSPACE),
      exchange(204, ''),
      exchange(204, ''),
    );
    const url = 'https://wb.test';
    expect(await c.listTeams(url, TOKEN)).toEqual([TEAM]);
    expect(await c.createTeam(url, TOKEN, 'Payments QA')).toEqual(TEAM);
    expect((await c.renameTeam(url, TOKEN, TEAM_ID, 'QA')).name).toBe('QA');
    await c.deleteTeam(url, TOKEN, TEAM_ID);
    expect((await c.setMemberRole(url, TOKEN, TEAM_ID, USER_ID, 'admin')).role).toBe('admin');
    await c.removeMember(url, TOKEN, TEAM_ID, USER_ID);
    expect(await c.createWorkspace(url, TOKEN, TEAM_ID, { name: 'Integration' })).toEqual(WORKSPACE);
    await c.setAccess(url, TOKEN, WS_ID, USER_ID, 'editor');
    await c.clearAccess(url, TOKEN, WS_ID, USER_ID);
    expect(sent.map((r) => [r.method, r.url])).toEqual([
      ['GET', 'https://wb.test/api/v1/teams'],
      ['POST', 'https://wb.test/api/v1/teams'],
      ['PATCH', `https://wb.test/api/v1/teams/${TEAM_ID}`],
      ['DELETE', `https://wb.test/api/v1/teams/${TEAM_ID}`],
      ['PATCH', `https://wb.test/api/v1/teams/${TEAM_ID}/members/${USER_ID}`],
      ['DELETE', `https://wb.test/api/v1/teams/${TEAM_ID}/members/${USER_ID}`],
      ['POST', `https://wb.test/api/v1/teams/${TEAM_ID}/workspaces`],
      ['PUT', `https://wb.test/api/v1/workspaces/${WS_ID}/access/${USER_ID}`],
      ['DELETE', `https://wb.test/api/v1/workspaces/${WS_ID}/access/${USER_ID}`],
    ]);
    expect(sent.every((r) => r.headers['authorization'] === `Bearer ${TOKEN}`)).toBe(true);
    expect([body(sent[1]), body(sent[2]), body(sent[4]), body(sent[6]), body(sent[7])]).toEqual([
      { name: 'Payments QA' },
      { name: 'QA' },
      { role: 'admin' },
      { name: 'Integration' },
      { role: 'editor' },
    ]);
    expect(sent[3]?.body).toBeUndefined();
  });

  it('parses listings and passes teams-* problems through with their status', async () => {
    const { client: c } = client(
      exchange(200, [WORKSPACE]),
      exchange(200, [{ userId: USER_ID, email: 'b@x.co', displayName: 'B', teamRole: 'member', disabled: false, effectiveRole: 'none' }]),
      exchange(400, { code: 'teams-last-admin', message: 'A team needs at least one admin.' }),
      exchange(200, [{ ...WORKSPACE, myRole: 'owner' }]),
    );
    expect(await c.listWorkspaces('https://wb.test', TOKEN)).toEqual([WORKSPACE]);
    expect((await c.workspaceAccess('https://wb.test', TOKEN, WS_ID))[0]?.effectiveRole).toBe('none');
    await expect(c.setMemberRole('https://wb.test', TOKEN, TEAM_ID, USER_ID, 'member')).rejects.toMatchObject({
      code: 'teams-last-admin',
      details: { status: 400 },
    });
    await expect(c.listWorkspaces('https://wb.test', TOKEN)).rejects.toMatchObject({ code: 'server-bad-response' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/server-client.test.ts`
Expected: FAIL (`c.listTeams is not a function`). If the desktop project has another name, find it with
`grep -n "name: '" vitest.config.ts`.

- [ ] **Step 3: Implement**

In `apps/desktop/src/main/server-client.ts`:

1. Extend the engine import with:

```ts
  accessResponseSchema,
  teamInvitationCreatedSchema,
  teamInvitationsResponseSchema,
  teamMemberSchema,
  teamMembersResponseSchema,
  teamSchema,
  teamsResponseSchema,
  teamWorkspaceSchema,
  teamWorkspacesResponseSchema,
  type AccessEntry,
  type MemberAddRequest,
  type Team,
  type TeamInvitation,
  type TeamInvitationCreated,
  type TeamInvitationCreateRequest,
  type TeamMember,
  type TeamRole,
  type TeamWorkspace,
  type TeamWorkspaceCreateRequest,
  type TeamWorkspaceUpdateRequest,
  type WorkspaceRole,
```

2. Widen `Call.method` to `'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'`.
3. Add, above `interface Call<T>`:

```ts
const teamPath = (teamId: string): string => `/api/v1/teams/${encodeURIComponent(teamId)}`;
const workspacePath = (workspaceId: string): string => `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`;
```

4. Add these methods after `acceptInvitation` and before `private async call`:

```ts
  // ---- teams-access (spec §3.2, §5.2): one method per route ----------------------------------

  listTeams(url: string, token: string): Promise<Team[]> {
    return this.call(url, { method: 'GET', path: '/api/v1/teams', token, schema: teamsResponseSchema });
  }

  createTeam(url: string, token: string, name: string): Promise<Team> {
    return this.call(url, { method: 'POST', path: '/api/v1/teams', token, body: { name }, schema: teamSchema });
  }

  renameTeam(url: string, token: string, teamId: string, name: string): Promise<Team> {
    return this.call(url, { method: 'PATCH', path: teamPath(teamId), token, body: { name }, schema: teamSchema });
  }

  async deleteTeam(url: string, token: string, teamId: string): Promise<void> {
    await this.call<unknown>(url, { method: 'DELETE', path: teamPath(teamId), token });
  }

  listMembers(url: string, token: string, teamId: string): Promise<TeamMember[]> {
    return this.call(url, {
      method: 'GET',
      path: `${teamPath(teamId)}/members`,
      token,
      schema: teamMembersResponseSchema,
    });
  }

  addMember(url: string, token: string, teamId: string, body: MemberAddRequest): Promise<TeamMember> {
    return this.call(url, { method: 'POST', path: `${teamPath(teamId)}/members`, token, body, schema: teamMemberSchema });
  }

  setMemberRole(url: string, token: string, teamId: string, userId: string, role: TeamRole): Promise<TeamMember> {
    return this.call(url, {
      method: 'PATCH',
      path: `${teamPath(teamId)}/members/${encodeURIComponent(userId)}`,
      token,
      body: { role },
      schema: teamMemberSchema,
    });
  }

  async removeMember(url: string, token: string, teamId: string, userId: string): Promise<void> {
    await this.call<unknown>(url, {
      method: 'DELETE',
      path: `${teamPath(teamId)}/members/${encodeURIComponent(userId)}`,
      token,
    });
  }

  listTeamInvitations(url: string, token: string, teamId: string): Promise<TeamInvitation[]> {
    return this.call(url, {
      method: 'GET',
      path: `${teamPath(teamId)}/invitations`,
      token,
      schema: teamInvitationsResponseSchema,
    });
  }

  inviteToTeam(
    url: string,
    token: string,
    teamId: string,
    body: TeamInvitationCreateRequest,
  ): Promise<TeamInvitationCreated> {
    return this.call(url, {
      method: 'POST',
      path: `${teamPath(teamId)}/invitations`,
      token,
      body,
      schema: teamInvitationCreatedSchema,
    });
  }

  async revokeTeamInvitation(url: string, token: string, teamId: string, invitationId: string): Promise<void> {
    await this.call<unknown>(url, {
      method: 'DELETE',
      path: `${teamPath(teamId)}/invitations/${encodeURIComponent(invitationId)}`,
      token,
    });
  }

  listWorkspaces(url: string, token: string): Promise<TeamWorkspace[]> {
    return this.call(url, { method: 'GET', path: '/api/v1/workspaces', token, schema: teamWorkspacesResponseSchema });
  }

  createWorkspace(url: string, token: string, teamId: string, body: TeamWorkspaceCreateRequest): Promise<TeamWorkspace> {
    return this.call(url, {
      method: 'POST',
      path: `${teamPath(teamId)}/workspaces`,
      token,
      body,
      schema: teamWorkspaceSchema,
    });
  }

  getWorkspace(url: string, token: string, workspaceId: string): Promise<TeamWorkspace> {
    return this.call(url, { method: 'GET', path: workspacePath(workspaceId), token, schema: teamWorkspaceSchema });
  }

  updateWorkspace(
    url: string,
    token: string,
    workspaceId: string,
    body: TeamWorkspaceUpdateRequest,
  ): Promise<TeamWorkspace> {
    return this.call(url, {
      method: 'PATCH',
      path: workspacePath(workspaceId),
      token,
      body,
      schema: teamWorkspaceSchema,
    });
  }

  async deleteWorkspace(url: string, token: string, workspaceId: string): Promise<void> {
    await this.call<unknown>(url, { method: 'DELETE', path: workspacePath(workspaceId), token });
  }

  workspaceAccess(url: string, token: string, workspaceId: string): Promise<AccessEntry[]> {
    return this.call(url, {
      method: 'GET',
      path: `${workspacePath(workspaceId)}/access`,
      token,
      schema: accessResponseSchema,
    });
  }

  async setAccess(url: string, token: string, workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
    await this.call<unknown>(url, {
      method: 'PUT',
      path: `${workspacePath(workspaceId)}/access/${encodeURIComponent(userId)}`,
      token,
      body: { role },
    });
  }

  async clearAccess(url: string, token: string, workspaceId: string, userId: string): Promise<void> {
    await this.call<unknown>(url, {
      method: 'DELETE',
      path: `${workspacePath(workspaceId)}/access/${encodeURIComponent(userId)}`,
      token,
    });
  }
```

5. Update the class JSDoc's first sentence to "one method per endpoint the sign-in flow and the Team dialog
   use".

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/server-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/main/server-client.ts apps/desktop/test/server-client.test.ts
git commit -m "feat(desktop): ServerClient calls for teams, members, invitations, workspaces and access

One method per teams-access route, each parsed with the engine schema the server validates
against, so a drifting server is an error in main rather than a crash in the renderer. The
token stays a parameter: the client holds no state and serves every signed-in server."
```

---

### Task 10: Desktop — wire types, `team.*` channels and their handlers in main

Spec §3.5 (signed-out handling), §3.6 (`team.listWorkspaces`), §5.2. Every request names the server by
`url`. Main resolves the account's token through `AccountService.tokenFor`, and a server that answers
`identity-unauthenticated` marks the account signed out (R9). `team.list` also asks `/me`, because the
dialog needs to know whether the caller is a server admin (to offer *New team…*) and `AccountWire`
does not carry that.

**Files:**
- Create: `apps/desktop/src/main/ipc/team.ts`, `apps/desktop/test/ipc-team.test.ts`
- Modify: `apps/desktop/src/shared/wire-types.ts`, `apps/desktop/src/shared/ipc.ts`,
  `apps/desktop/src/main/index.ts`, `apps/desktop/test/mocks/wirebench-api.ts`

**Interfaces:**
- Produces:
  - Wire value types: `TeamRoleWire`, `WorkspaceRoleWire`, `DefaultRoleWire`, `RoleSourceWire`, `TeamWire`,
    `TeamMemberWire`, `TeamInvitationWire`, `TeamInvitationCreatedWire`, `TeamWorkspaceWire`,
    `AccessEntryWire`, `TeamListResponse`.
  - Wire schemas: `teamRoleWireSchema`, `workspaceRoleWireSchema`, `defaultRoleWireSchema`, `roleSourceWireSchema`.
  - `syncStatusWireSchema.role?: 'viewer' | 'editor' | 'admin'`.
  - `channels.team.{list, create, rename, delete, members, addMember, setMemberRole, removeMember, invitations,
    invite, revokeInvitation, listWorkspaces, createWorkspace, updateWorkspace, deleteWorkspace, access,
    setAccess, clearAccess}`.
  - Main: `registerTeamChannels(deps)`, `withToken(deps, url, call)`, `TeamChannelDeps`.
- Consumes: Task 9 `ServerClient` methods; `AccountService.tokenFor`, `markSignedOut` (identity);
  `normalizeServerUrl`.

The request and response shape of each channel, which the renderer (Tasks 11–12) calls through
`ipc().team.*`:

| Channel | Request | Response |
| --- | --- | --- |
| `team.list` | `{ url }` | `{ teams: TeamWire[]; serverAdmin: boolean }` |
| `team.create` | `{ url, name }` | `{ team }` |
| `team.rename` | `{ url, teamId, name }` | `{ team }` |
| `team.delete` | `{ url, teamId }` | `{ done: true }` |
| `team.members` | `{ url, teamId }` | `{ members }` |
| `team.addMember` | `{ url, teamId, email, role }` | `{ member }` |
| `team.setMemberRole` | `{ url, teamId, userId, role }` | `{ member }` |
| `team.removeMember` | `{ url, teamId, userId }` | `{ done: true }` |
| `team.invitations` | `{ url, teamId }` | `{ invitations }` |
| `team.invite` | `{ url, teamId, email, role }` | `{ invitation: TeamInvitationCreatedWire }` |
| `team.revokeInvitation` | `{ url, teamId, invitationId }` | `{ done: true }` |
| `team.listWorkspaces` | `{ url }` | `{ workspaces }` |
| `team.createWorkspace` | `{ url, teamId, name, defaultRole? }` | `{ workspace }` |
| `team.updateWorkspace` | `{ url, workspaceId, name?, defaultRole? }` | `{ workspace }` |
| `team.deleteWorkspace` | `{ url, workspaceId }` | `{ done: true }` |
| `team.access` | `{ url, workspaceId }` | `{ entries }` |
| `team.setAccess` | `{ url, workspaceId, userId, role }` | `{ done: true }` |
| `team.clearAccess` | `{ url, workspaceId, userId }` | `{ done: true }` |

- [ ] **Step 1: Write the failing test**

`apps/desktop/test/ipc-team.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { registerTeamChannels } = await import('../src/main/ipc/team.js');
const { channels } = await import('../src/shared/ipc.js');

type Envelope =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { code: string; message: string } };
const invoke = (channel: string, payload: unknown): Promise<Envelope> =>
  handlers.get(channel)!({ sender: {} }, payload) as Promise<Envelope>;

const TOKEN = `wbs_${'A'.repeat(43)}`;
const TEAM_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const USER_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QB';
const WS_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QC';
const TEAM = { id: TEAM_ID, name: 'Payments QA', myRole: 'admin', createdAt: '2026-09-25T10:00:00.000Z' };
const WORKSPACE = {
  id: WS_ID,
  name: 'Integration',
  teamId: TEAM_ID,
  teamName: 'Payments QA',
  defaultRole: 'viewer',
  myRole: 'admin',
  source: 'grant',
  createdAt: '2026-09-25T10:00:00.000Z',
};

function fakes(token: string | undefined = TOKEN) {
  const client = {
    me: vi.fn().mockResolvedValue({ user: { id: USER_ID, email: 'a@b.co', displayName: 'A', serverAdmin: true } }),
    listTeams: vi.fn().mockResolvedValue([TEAM]),
    createTeam: vi.fn().mockResolvedValue(TEAM),
    renameTeam: vi.fn().mockResolvedValue(TEAM),
    deleteTeam: vi.fn().mockResolvedValue(undefined),
    listMembers: vi.fn().mockResolvedValue([]),
    addMember: vi.fn(),
    setMemberRole: vi.fn(),
    removeMember: vi.fn().mockResolvedValue(undefined),
    listTeamInvitations: vi.fn().mockResolvedValue([]),
    inviteToTeam: vi.fn(),
    revokeTeamInvitation: vi.fn().mockResolvedValue(undefined),
    listWorkspaces: vi.fn().mockResolvedValue([WORKSPACE]),
    createWorkspace: vi.fn().mockResolvedValue(WORKSPACE),
    updateWorkspace: vi.fn().mockResolvedValue(WORKSPACE),
    deleteWorkspace: vi.fn().mockResolvedValue(undefined),
    workspaceAccess: vi.fn().mockResolvedValue([]),
    setAccess: vi.fn().mockResolvedValue(undefined),
    clearAccess: vi.fn().mockResolvedValue(undefined),
  };
  const accounts = { tokenFor: vi.fn().mockResolvedValue(token), markSignedOut: vi.fn() };
  return { client, accounts };
}

describe('team.* channels (teams-access §3.5, §5.2)', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('registers every channel the contract declares', () => {
    registerTeamChannels(fakes());
    expect([...handlers.keys()].sort()).toEqual(Object.values(channels.team).map((c) => c.name).sort());
  });

  it('team.list answers the teams and whether the caller is a server admin, with the account token', async () => {
    const f = fakes();
    registerTeamChannels(f);
    expect(await invoke('team.list', { url: 'https://WB.test/some/path' })).toEqual({
      ok: true,
      value: { teams: [TEAM], serverAdmin: true },
    });
    expect(f.accounts.tokenFor).toHaveBeenCalledWith('https://wb.test');
    expect(f.client.listTeams).toHaveBeenCalledWith('https://wb.test', TOKEN);
  });

  it('with no token it answers account-signed-out and never calls the server', async () => {
    const f = fakes(undefined);
    registerTeamChannels(f);
    const res = await invoke('team.listWorkspaces', { url: 'https://wb.test' });
    expect(res).toMatchObject({ ok: false, error: { code: 'account-signed-out' } });
    expect(f.client.listWorkspaces).not.toHaveBeenCalled();
  });

  it('a rejected token marks the account signed out; other problems pass through untouched', async () => {
    const f = fakes();
    f.client.listTeams.mockRejectedValueOnce(new WirebenchError('identity-unauthenticated', 'Sign in to continue.'));
    f.client.setMemberRole.mockRejectedValueOnce(new WirebenchError('teams-last-admin', 'A team needs at least one admin.'));
    registerTeamChannels(f);
    expect(await invoke('team.list', { url: 'https://wb.test' })).toMatchObject({
      ok: false,
      error: { code: 'identity-unauthenticated' },
    });
    expect(f.accounts.markSignedOut).toHaveBeenCalledWith('https://wb.test');
    expect(
      await invoke('team.setMemberRole', { url: 'https://wb.test', teamId: TEAM_ID, userId: USER_ID, role: 'member' }),
    ).toMatchObject({ ok: false, error: { code: 'teams-last-admin', message: 'A team needs at least one admin.' } });
    expect(f.accounts.markSignedOut).toHaveBeenCalledTimes(1);
  });

  it('passes bodies without undefined fields and wraps answers', async () => {
    const f = fakes();
    registerTeamChannels(f);
    expect(await invoke('team.createWorkspace', { url: 'https://wb.test', teamId: TEAM_ID, name: 'Integration' })).toEqual({
      ok: true,
      value: { workspace: WORKSPACE },
    });
    expect(f.client.createWorkspace).toHaveBeenCalledWith('https://wb.test', TOKEN, TEAM_ID, { name: 'Integration' });
    await invoke('team.updateWorkspace', { url: 'https://wb.test', workspaceId: WS_ID, defaultRole: 'none' });
    expect(f.client.updateWorkspace).toHaveBeenCalledWith('https://wb.test', TOKEN, WS_ID, { defaultRole: 'none' });
    expect(
      await invoke('team.setAccess', { url: 'https://wb.test', workspaceId: WS_ID, userId: USER_ID, role: 'editor' }),
    ).toEqual({ ok: true, value: { done: true } });
    expect(f.client.setAccess).toHaveBeenCalledWith('https://wb.test', TOKEN, WS_ID, USER_ID, 'editor');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/ipc-team.test.ts`
Expected: FAIL (`Cannot find module '../src/main/ipc/team.js'`).

- [ ] **Step 3: The wire types**

In `apps/desktop/src/shared/wire-types.ts`:

1. Inside `syncStatusWireSchema`, after the `held` field, add:

```ts
  /**
   * The caller's role in a Wirebench Server workspace (teams-access §3.5); `server-sync` fills it and
   * shows *Viewer* on the badge. Inlined rather than `workspaceRoleWireSchema`, which is declared
   * further down this file.
   */
  role: z.enum(['viewer', 'editor', 'admin']).optional(),
```

2. After `export type AccountChangedEvent = …;`, add:

```ts
// ---------------------------------------------------------------------------
// Teams on Wirebench Server (teams-access §3.5, §5.2). Restated from the engine's
// `server-api/teams.ts` rather than imported: this file must stay free of engine values. Main parses
// the server's answers with the engine's schemas first, then these check what crosses the bridge.
// ---------------------------------------------------------------------------

export const teamRoleWireSchema = z.enum(['member', 'admin']);
export type TeamRoleWire = z.infer<typeof teamRoleWireSchema>;
export const workspaceRoleWireSchema = z.enum(['viewer', 'editor', 'admin']);
export type WorkspaceRoleWire = z.infer<typeof workspaceRoleWireSchema>;
export const defaultRoleWireSchema = z.enum(['none', 'viewer', 'editor']);
export type DefaultRoleWire = z.infer<typeof defaultRoleWireSchema>;
export const roleSourceWireSchema = z.enum(['server-admin', 'team-admin', 'grant', 'default']);
export type RoleSourceWire = z.infer<typeof roleSourceWireSchema>;

export const teamWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  myRole: teamRoleWireSchema,
  createdAt: z.string(),
});
export type TeamWire = z.infer<typeof teamWireSchema>;
export const teamMemberWireSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: teamRoleWireSchema,
  disabled: z.boolean(),
  addedAt: z.string(),
});
export type TeamMemberWire = z.infer<typeof teamMemberWireSchema>;
export const teamInvitationWireSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: teamRoleWireSchema,
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type TeamInvitationWire = z.infer<typeof teamInvitationWireSchema>;
/** Carries the link, which the dialog shows exactly once (§3.5). */
export const teamInvitationCreatedWireSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: teamRoleWireSchema,
  url: z.string(),
  expiresAt: z.string(),
});
export type TeamInvitationCreatedWire = z.infer<typeof teamInvitationCreatedWireSchema>;
export const teamWorkspaceWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  defaultRole: defaultRoleWireSchema,
  myRole: workspaceRoleWireSchema,
  source: roleSourceWireSchema,
  createdAt: z.string(),
});
export type TeamWorkspaceWire = z.infer<typeof teamWorkspaceWireSchema>;
export const accessEntryWireSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  teamRole: teamRoleWireSchema,
  disabled: z.boolean(),
  effectiveRole: z.enum(['none', 'viewer', 'editor', 'admin']),
  source: roleSourceWireSchema.optional(),
  grant: workspaceRoleWireSchema.optional(),
});
export type AccessEntryWire = z.infer<typeof accessEntryWireSchema>;

export const teamServerRequestWireSchema = z.object({ url: z.string() });
export const teamCreateRequestWireSchema = z.object({ url: z.string(), name: z.string() });
export const teamRenameRequestWireSchema = z.object({ url: z.string(), teamId: z.string(), name: z.string() });
export const teamRefRequestWireSchema = z.object({ url: z.string(), teamId: z.string() });
export const teamAddMemberRequestWireSchema = z.object({
  url: z.string(),
  teamId: z.string(),
  email: z.string(),
  role: teamRoleWireSchema,
});
export const teamMemberRoleRequestWireSchema = z.object({
  url: z.string(),
  teamId: z.string(),
  userId: z.string(),
  role: teamRoleWireSchema,
});
export const teamMemberRefRequestWireSchema = z.object({ url: z.string(), teamId: z.string(), userId: z.string() });
export const teamInviteRequestWireSchema = teamAddMemberRequestWireSchema;
export const teamInvitationRefRequestWireSchema = z.object({
  url: z.string(),
  teamId: z.string(),
  invitationId: z.string(),
});
export const teamCreateWorkspaceRequestWireSchema = z.object({
  url: z.string(),
  teamId: z.string(),
  name: z.string(),
  defaultRole: defaultRoleWireSchema.optional(),
});
export const teamWorkspaceRefRequestWireSchema = z.object({ url: z.string(), workspaceId: z.string() });
export const teamUpdateWorkspaceRequestWireSchema = z.object({
  url: z.string(),
  workspaceId: z.string(),
  name: z.string().optional(),
  defaultRole: defaultRoleWireSchema.optional(),
});
export const teamSetAccessRequestWireSchema = z.object({
  url: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  role: workspaceRoleWireSchema,
});
export const teamAccessRefRequestWireSchema = z.object({ url: z.string(), workspaceId: z.string(), userId: z.string() });

export const teamListResponseWireSchema = z.object({ teams: z.array(teamWireSchema), serverAdmin: z.boolean() });
export type TeamListResponse = z.infer<typeof teamListResponseWireSchema>;
export const teamResponseWireSchema = z.object({ team: teamWireSchema });
export const teamMembersResponseWireSchema = z.object({ members: z.array(teamMemberWireSchema) });
export const teamMemberResponseWireSchema = z.object({ member: teamMemberWireSchema });
export const teamInvitationsResponseWireSchema = z.object({ invitations: z.array(teamInvitationWireSchema) });
export const teamInviteResponseWireSchema = z.object({ invitation: teamInvitationCreatedWireSchema });
export const teamWorkspacesResponseWireSchema = z.object({ workspaces: z.array(teamWorkspaceWireSchema) });
export const teamWorkspaceResponseWireSchema = z.object({ workspace: teamWorkspaceWireSchema });
export const teamAccessResponseWireSchema = z.object({ entries: z.array(accessEntryWireSchema) });
export const teamDoneResponseWireSchema = z.object({ done: z.literal(true) });
```

- [ ] **Step 4: The channels**

In `apps/desktop/src/shared/ipc.ts`:

1. Add every `team…WireSchema` name from Step 3 that ends in `RequestWireSchema` or `ResponseWireSchema` to
   the import from `./wire-types.js`, keeping the import alphabetical.
2. Directly after the `account: { … },` block in `channels`, add:

```ts
  /**
   * Teams on Wirebench Server (teams-access §3.5). Every request names the server by `url`; main
   * adds that account's token, and a server that no longer accepts it marks the account signed out.
   */
  team: {
    list: defineChannel('team.list', teamServerRequestWireSchema, teamListResponseWireSchema),
    create: defineChannel('team.create', teamCreateRequestWireSchema, teamResponseWireSchema),
    rename: defineChannel('team.rename', teamRenameRequestWireSchema, teamResponseWireSchema),
    delete: defineChannel('team.delete', teamRefRequestWireSchema, teamDoneResponseWireSchema),
    members: defineChannel('team.members', teamRefRequestWireSchema, teamMembersResponseWireSchema),
    addMember: defineChannel('team.addMember', teamAddMemberRequestWireSchema, teamMemberResponseWireSchema),
    setMemberRole: defineChannel('team.setMemberRole', teamMemberRoleRequestWireSchema, teamMemberResponseWireSchema),
    removeMember: defineChannel('team.removeMember', teamMemberRefRequestWireSchema, teamDoneResponseWireSchema),
    invitations: defineChannel('team.invitations', teamRefRequestWireSchema, teamInvitationsResponseWireSchema),
    invite: defineChannel('team.invite', teamInviteRequestWireSchema, teamInviteResponseWireSchema),
    revokeInvitation: defineChannel(
      'team.revokeInvitation',
      teamInvitationRefRequestWireSchema,
      teamDoneResponseWireSchema,
    ),
    /** What a member can open, with role and source; `server-sync`'s join dialog reads it too (§3.6). */
    listWorkspaces: defineChannel('team.listWorkspaces', teamServerRequestWireSchema, teamWorkspacesResponseWireSchema),
    createWorkspace: defineChannel(
      'team.createWorkspace',
      teamCreateWorkspaceRequestWireSchema,
      teamWorkspaceResponseWireSchema,
    ),
    updateWorkspace: defineChannel(
      'team.updateWorkspace',
      teamUpdateWorkspaceRequestWireSchema,
      teamWorkspaceResponseWireSchema,
    ),
    deleteWorkspace: defineChannel('team.deleteWorkspace', teamWorkspaceRefRequestWireSchema, teamDoneResponseWireSchema),
    access: defineChannel('team.access', teamWorkspaceRefRequestWireSchema, teamAccessResponseWireSchema),
    setAccess: defineChannel('team.setAccess', teamSetAccessRequestWireSchema, teamDoneResponseWireSchema),
    clearAccess: defineChannel('team.clearAccess', teamAccessRefRequestWireSchema, teamDoneResponseWireSchema),
  },
```

- [ ] **Step 5: The handlers**

`apps/desktop/src/main/ipc/team.ts`:

```ts
/**
 * The `team.*` channels (teams-access spec §3.5, §5.2). Each resolves the account's token for
 * `url`, calls the server through `ServerClient`, and answers in the renderer's wire shapes. A
 * server that answers `identity-unauthenticated` marks the account signed out, the rule
 * `AccountService.refresh` applies at launch; the token never crosses the bridge.
 */
import { WirebenchError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { AccountService } from '../account-service.js';
import { normalizeServerUrl, type ServerClient } from '../server-client.js';
import { registerHandler } from './register.js';

export interface TeamChannelDeps {
  readonly client: Pick<
    ServerClient,
    | 'me'
    | 'listTeams'
    | 'createTeam'
    | 'renameTeam'
    | 'deleteTeam'
    | 'listMembers'
    | 'addMember'
    | 'setMemberRole'
    | 'removeMember'
    | 'listTeamInvitations'
    | 'inviteToTeam'
    | 'revokeTeamInvitation'
    | 'listWorkspaces'
    | 'createWorkspace'
    | 'updateWorkspace'
    | 'deleteWorkspace'
    | 'workspaceAccess'
    | 'setAccess'
    | 'clearAccess'
  >;
  readonly accounts: Pick<AccountService, 'tokenFor' | 'markSignedOut'>;
}

/** Runs `call` with the token for `url`'s origin. No token, or one the server rejects, reads as signed out. */
export async function withToken<T>(
  deps: TeamChannelDeps,
  url: string,
  call: (origin: string, token: string) => Promise<T>,
): Promise<T> {
  const origin = normalizeServerUrl(url);
  const token = await deps.accounts.tokenFor(origin);
  if (token === undefined) throw new WirebenchError('account-signed-out', `Sign in to ${origin} first.`);
  try {
    return await call(origin, token);
  } catch (error) {
    if (error instanceof WirebenchError && error.code === 'identity-unauthenticated') deps.accounts.markSignedOut(origin);
    throw error;
  }
}

const DONE = { done: true } as const;

export function registerTeamChannels(deps: TeamChannelDeps): void {
  const c = deps.client;

  registerHandler(channels.team.list, (r) =>
    withToken(deps, r.url, async (url, token) => {
      const [teams, me] = await Promise.all([c.listTeams(url, token), c.me(url, token)]);
      return { teams, serverAdmin: me.user.serverAdmin };
    }),
  );
  registerHandler(channels.team.create, (r) =>
    withToken(deps, r.url, async (url, token) => ({ team: await c.createTeam(url, token, r.name) })),
  );
  registerHandler(channels.team.rename, (r) =>
    withToken(deps, r.url, async (url, token) => ({ team: await c.renameTeam(url, token, r.teamId, r.name) })),
  );
  registerHandler(channels.team.delete, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.deleteTeam(url, token, r.teamId);
      return DONE;
    }),
  );
  registerHandler(channels.team.members, (r) =>
    withToken(deps, r.url, async (url, token) => ({ members: await c.listMembers(url, token, r.teamId) })),
  );
  registerHandler(channels.team.addMember, (r) =>
    withToken(deps, r.url, async (url, token) => ({
      member: await c.addMember(url, token, r.teamId, { email: r.email, role: r.role }),
    })),
  );
  registerHandler(channels.team.setMemberRole, (r) =>
    withToken(deps, r.url, async (url, token) => ({
      member: await c.setMemberRole(url, token, r.teamId, r.userId, r.role),
    })),
  );
  registerHandler(channels.team.removeMember, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.removeMember(url, token, r.teamId, r.userId);
      return DONE;
    }),
  );
  registerHandler(channels.team.invitations, (r) =>
    withToken(deps, r.url, async (url, token) => ({ invitations: await c.listTeamInvitations(url, token, r.teamId) })),
  );
  registerHandler(channels.team.invite, (r) =>
    withToken(deps, r.url, async (url, token) => ({
      invitation: await c.inviteToTeam(url, token, r.teamId, { email: r.email, role: r.role }),
    })),
  );
  registerHandler(channels.team.revokeInvitation, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.revokeTeamInvitation(url, token, r.teamId, r.invitationId);
      return DONE;
    }),
  );
  registerHandler(channels.team.listWorkspaces, (r) =>
    withToken(deps, r.url, async (url, token) => ({ workspaces: await c.listWorkspaces(url, token) })),
  );
  registerHandler(channels.team.createWorkspace, (r) =>
    withToken(deps, r.url, async (url, token) => ({
      workspace: await c.createWorkspace(url, token, r.teamId, {
        name: r.name,
        ...(r.defaultRole !== undefined ? { defaultRole: r.defaultRole } : {}),
      }),
    })),
  );
  registerHandler(channels.team.updateWorkspace, (r) =>
    withToken(deps, r.url, async (url, token) => ({
      workspace: await c.updateWorkspace(url, token, r.workspaceId, {
        ...(r.name !== undefined ? { name: r.name } : {}),
        ...(r.defaultRole !== undefined ? { defaultRole: r.defaultRole } : {}),
      }),
    })),
  );
  registerHandler(channels.team.deleteWorkspace, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.deleteWorkspace(url, token, r.workspaceId);
      return DONE;
    }),
  );
  registerHandler(channels.team.access, (r) =>
    withToken(deps, r.url, async (url, token) => ({ entries: await c.workspaceAccess(url, token, r.workspaceId) })),
  );
  registerHandler(channels.team.setAccess, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.setAccess(url, token, r.workspaceId, r.userId, r.role);
      return DONE;
    }),
  );
  registerHandler(channels.team.clearAccess, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.clearAccess(url, token, r.workspaceId, r.userId);
      return DONE;
    }),
  );
}
```

- [ ] **Step 6: Wire it into main and the renderer mock**

In `apps/desktop/src/main/index.ts`:
- Add `import { registerTeamChannels } from './ipc/team.js';` beside the account import.
- Directly after `registerAccountChannels({ accounts: accountService });`, add:

```ts
  registerTeamChannels({ client: serverClient, accounts: accountService });
```

In `apps/desktop/test/mocks/wirebench-api.ts`, add to `defaults` after the `account` entry:

```ts
    team: {
      list: fail('team.list'),
      create: fail('team.create'),
      rename: fail('team.rename'),
      delete: fail('team.delete'),
      members: fail('team.members'),
      addMember: fail('team.addMember'),
      setMemberRole: fail('team.setMemberRole'),
      removeMember: fail('team.removeMember'),
      invitations: fail('team.invitations'),
      invite: fail('team.invite'),
      revokeInvitation: fail('team.revokeInvitation'),
      listWorkspaces: fail('team.listWorkspaces'),
      createWorkspace: fail('team.createWorkspace'),
      updateWorkspace: fail('team.updateWorkspace'),
      deleteWorkspace: fail('team.deleteWorkspace'),
      access: fail('team.access'),
      setAccess: fail('team.setAccess'),
      clearAccess: fail('team.clearAccess'),
    },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/ipc-team.test.ts apps/desktop/test/ipc-account.test.ts`
Expected: PASS (5 + the existing account tests).

- [ ] **Step 8: Commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/shared/wire-types.ts apps/desktop/src/shared/ipc.ts apps/desktop/src/main/ipc/team.ts apps/desktop/src/main/index.ts apps/desktop/test/ipc-team.test.ts apps/desktop/test/mocks/wirebench-api.ts
git commit -m "feat(desktop): team channels between the renderer and Wirebench Server

Eighteen team.* channels, one per server route plus team.list, which also reports whether the
caller is a server admin. Main picks the account's token for the URL, so the token never
reaches the renderer. A server that rejects it marks the account signed out, as a launch-time
refresh does. The sync status gains an optional role for server-sync to fill."
```

---

### Task 11: Desktop — the team store, *Manage teams…*, and the dialog's Members and Invitations tabs

Spec §3.5, §5.1. One dialog for every team on a server: the list of teams on the left, and the chosen
team's name and tabs on the right. Team admins can edit; members see the same screens read-only.
Server admins, who get `myRole: 'admin'` on every team, can also create and delete teams. It opens
from the palette, the account menu in the status bar, and each signed-in row in Preferences →
Accounts. When a call fails, the store shows a toast. A signed-out answer switches the dialog to a
*Sign in again* view.

**Files:**
- Create: `apps/desktop/src/renderer/features/team/roles.ts`, `apps/desktop/src/renderer/state/team.ts`,
  `apps/desktop/src/renderer/features/team/team-dialog.tsx`, `apps/desktop/src/renderer/features/team/members-tab.tsx`,
  `apps/desktop/src/renderer/features/team/invitations-tab.tsx`, `apps/desktop/src/renderer/features/team/invite-dialog.tsx`,
  `apps/desktop/src/renderer/features/team/workspaces-tab.tsx` (stub),
  `apps/desktop/test/renderer/team-roles.test.ts`, `apps/desktop/test/renderer/team-store.test.ts`,
  `apps/desktop/test/renderer/team-dialog.test.tsx`
- Modify: `apps/desktop/src/renderer/state/ui.ts`, `apps/desktop/src/shared/commands.ts`,
  `apps/desktop/src/shared/command-catalog.ts`, `apps/desktop/src/renderer/commands/register-account-commands.ts`,
  `apps/desktop/src/renderer/features/account/account-status-item.tsx`,
  `apps/desktop/src/renderer/features/preferences/sections/accounts-section.tsx`,
  `apps/desktop/src/renderer/shell/app-shell.tsx`, `apps/desktop/test/renderer/account-commands.test.ts`,
  `apps/desktop/test/renderer/account-status-item.test.tsx`, `apps/desktop/test/renderer/accounts-section.test.tsx`,
  `docs-site/src/content/docs/reference/commands.md` (regenerated)

**Interfaces:**
- Consumes: Task 10 `channels.team.*` (through `ipc().team.*`), `TeamWire`, `TeamMemberWire`,
  `TeamInvitationWire`, `TeamInvitationCreatedWire`, `TeamWorkspaceWire`, `AccessEntryWire`, `TeamRoleWire`,
  `WorkspaceRoleWire`, `DefaultRoleWire`, `RoleSourceWire`, `teamRoleWireSchema`, `workspaceRoleWireSchema`,
  `defaultRoleWireSchema`, `roleSourceWireSchema`; `IpcResult` from `shared/ipc.ts`; `useAccountStore`,
  `signedInServers`; `showToast`; `ConfirmDialog`; `Tabs`; `Button`.
- Produces:
  - `useUiStore`: `teamDialog: { open: boolean; url: string | undefined }`, `openTeamDialog(url?)`,
    `setTeamDialogOpen(open)`.
  - `features/team/roles.ts`: `TEAM_ROLES`, `WORKSPACE_ROLES`, `DEFAULT_ROLES`, `ROLE_LABELS`, `SOURCE_LABELS`,
    `roleWithSource(role, source)`, `SELECT_CLASS`, `INPUT_CLASS`.
  - `state/team.ts`: `useTeamStore`, `TeamTab`, `TeamState`, `teamWorkspaces(state)`, `selectedTeam(state)`, plus the
    actions below.
  - Command `team.manage`.
  - Testids: `team-dialog`, `team-server`, `team-list`, `team-row-<id>`, `team-new`, `team-new-name`,
    `team-new-submit`, `team-name`, `team-delete`, `team-signed-out`, `team-sign-in-again`, `members-tab`,
    `member-row-<userId>`, `member-role-<userId>`, `member-remove-<userId>`, `member-add`, `member-add-email`,
    `member-add-role`, `member-add-submit`, `member-invite`, `invite-dialog`, `invite-email`, `invite-role`,
    `invite-submit`, `invite-link`, `invite-copy`, `invitations-tab`, `invitation-row-<id>`,
    `invitation-revoke-<id>`, `account-manage-teams`, `account-row-manage-teams`.
  - `TeamDialog` renders the Workspaces tab through `WorkspacesTab` from `./workspaces-tab.js`. **This task adds that
    file as a stub**, and Task 12 replaces it.

The store's actions, which Task 12 also calls:

```ts
open(url: string): Promise<void>; reset(): void; refresh(): Promise<void>;
selectTeam(teamId: string): Promise<void>; setTab(tab: TeamTab): void;
createTeam(name: string): Promise<boolean>; renameTeam(name: string): Promise<boolean>; deleteTeam(): Promise<boolean>;
addMember(email: string, role: TeamRoleWire): Promise<boolean>;
setMemberRole(userId: string, role: TeamRoleWire): Promise<boolean>; removeMember(userId: string): Promise<boolean>;
invite(email: string, role: TeamRoleWire): Promise<boolean>; clearLastInvite(): void;
revokeInvitation(invitationId: string): Promise<boolean>;
createWorkspace(name: string, defaultRole?: DefaultRoleWire): Promise<boolean>;
updateWorkspace(workspaceId: string, patch: { name?: string; defaultRole?: DefaultRoleWire }): Promise<boolean>;
deleteWorkspace(workspaceId: string): Promise<boolean>;
openAccess(workspaceId: string): Promise<void>; closeAccess(): void;
setAccess(userId: string, role: WorkspaceRoleWire): Promise<boolean>; clearAccess(userId: string): Promise<boolean>;
```

- [ ] **Step 1: Write the failing tests**

`apps/desktop/test/renderer/team-roles.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLES,
  ROLE_LABELS,
  SOURCE_LABELS,
  TEAM_ROLES,
  WORKSPACE_ROLES,
  roleWithSource,
} from '../../src/renderer/features/team/roles.js';
import {
  defaultRoleWireSchema,
  roleSourceWireSchema,
  teamRoleWireSchema,
  workspaceRoleWireSchema,
} from '../../src/shared/wire-types.js';

describe('team role labels (teams-access §3.5)', () => {
  it('restates the wire enums exactly', () => {
    expect(TEAM_ROLES).toEqual(teamRoleWireSchema.options);
    expect(WORKSPACE_ROLES).toEqual(workspaceRoleWireSchema.options);
    expect(DEFAULT_ROLES).toEqual(defaultRoleWireSchema.options);
    expect(Object.keys(SOURCE_LABELS).sort()).toEqual([...roleSourceWireSchema.options].sort());
  });

  it('labels every role, and names where a role comes from', () => {
    for (const role of [...TEAM_ROLES, ...WORKSPACE_ROLES, ...DEFAULT_ROLES]) expect(ROLE_LABELS[role]).toBeTruthy();
    expect(ROLE_LABELS.none).toBe('No access');
    expect(roleWithSource('editor', 'grant')).toBe('Editor (granted)');
    expect(roleWithSource('admin', 'team-admin')).toBe('Admin (team admin)');
    expect(roleWithSource('viewer', 'default')).toBe('Viewer (workspace default)');
    expect(roleWithSource('admin', 'server-admin')).toBe('Admin (server admin)');
  });
});
```

`apps/desktop/test/renderer/team-store.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { teamWorkspaces, useTeamStore } from '../../src/renderer/state/team.js';
import type { TeamMemberWire, TeamWire, TeamWorkspaceWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const URL_ = 'https://wb.test';
const team = (id: string, myRole: 'member' | 'admin' = 'admin'): TeamWire => ({
  id,
  name: `Team ${id}`,
  myRole,
  createdAt: '2026-09-25T10:00:00.000Z',
});
const member = (userId: string, role: 'member' | 'admin' = 'member'): TeamMemberWire => ({
  userId,
  email: `${userId}@wb.test`,
  displayName: userId,
  role,
  disabled: false,
  addedAt: '2026-09-25T10:00:00.000Z',
});
const workspace = (id: string, teamId: string): TeamWorkspaceWire => ({
  id,
  name: `W ${id}`,
  teamId,
  teamName: `Team ${teamId}`,
  defaultRole: 'viewer',
  myRole: 'admin',
  source: 'team-admin',
  createdAt: '2026-09-25T10:00:00.000Z',
});
const ok = <T>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });
const err = (code: string, message = 'nope') => vi.fn().mockResolvedValue({ ok: false, error: { code, message } });

describe('useTeamStore (teams-access §3.5)', () => {
  beforeEach(() => {
    useTeamStore.getState().reset();
  });

  it('open loads the teams, selects the first, and loads its members and invitations', async () => {
    const api = installWirebenchApi({
      team: {
        list: ok({ teams: [team('A'), team('B', 'member')], serverAdmin: false }),
        listWorkspaces: ok({ workspaces: [workspace('w1', 'A'), workspace('w2', 'B')] }),
        members: ok({ members: [member('u1', 'admin')] }),
        invitations: ok({ invitations: [] }),
      },
    });
    await useTeamStore.getState().open(URL_);
    const state = useTeamStore.getState();
    expect(state.teamId).toBe('A');
    expect(state.members.map((m) => m.userId)).toEqual(['u1']);
    expect(teamWorkspaces(state).map((w) => w.id)).toEqual(['w1']);
    expect(api.team.members).toHaveBeenCalledWith({ url: URL_, teamId: 'A' });
    expect(api.team.invitations).toHaveBeenCalledWith({ url: URL_, teamId: 'A' });
  });

  it('a plain member never asks for invitations', async () => {
    const api = installWirebenchApi({
      team: {
        list: ok({ teams: [team('B', 'member')], serverAdmin: false }),
        listWorkspaces: ok({ workspaces: [] }),
        members: ok({ members: [] }),
      },
    });
    await useTeamStore.getState().open(URL_);
    expect(api.team.invitations).not.toHaveBeenCalled();
    expect(useTeamStore.getState().invitations).toEqual([]);
  });

  it('a signed-out answer flips signedOut instead of toasting', async () => {
    installWirebenchApi({
      team: { list: err('account-signed-out'), listWorkspaces: err('account-signed-out') },
    });
    await useTeamStore.getState().open(URL_);
    expect(useTeamStore.getState().signedOut).toBe(true);
  });

  it('a failed write reports false; a good one refreshes', async () => {
    const api = installWirebenchApi({
      team: {
        list: ok({ teams: [team('A')], serverAdmin: false }),
        listWorkspaces: ok({ workspaces: [] }),
        members: ok({ members: [member('u1', 'admin')] }),
        invitations: ok({ invitations: [] }),
        setMemberRole: err('teams-last-admin', 'A team needs at least one admin.'),
        addMember: ok({ member: member('u2') }),
      },
    });
    await useTeamStore.getState().open(URL_);
    expect(await useTeamStore.getState().setMemberRole('u1', 'member')).toBe(false);
    expect(api.team.members).toHaveBeenCalledTimes(1);
    expect(await useTeamStore.getState().addMember('u2@wb.test', 'member')).toBe(true);
    expect(api.team.addMember).toHaveBeenCalledWith({ url: URL_, teamId: 'A', email: 'u2@wb.test', role: 'member' });
    expect(api.team.members).toHaveBeenCalledTimes(2);
  });

  it('invite keeps the created link for the dialog to show once', async () => {
    const created = {
      id: 'i1',
      email: 'new@wb.test',
      role: 'member' as const,
      url: 'https://wb.test/invite/secret',
      expiresAt: '2026-10-02T10:00:00.000Z',
    };
    installWirebenchApi({
      team: {
        list: ok({ teams: [team('A')], serverAdmin: false }),
        listWorkspaces: ok({ workspaces: [] }),
        members: ok({ members: [] }),
        invitations: ok({ invitations: [] }),
        invite: ok({ invitation: created }),
      },
    });
    await useTeamStore.getState().open(URL_);
    expect(await useTeamStore.getState().invite('new@wb.test', 'member')).toBe(true);
    expect(useTeamStore.getState().lastInvite).toEqual(created);
    useTeamStore.getState().clearLastInvite();
    expect(useTeamStore.getState().lastInvite).toBeUndefined();
  });

  it('drops an answer for a team that is no longer selected', async () => {
    let release: (value: unknown) => void = () => undefined;
    const slow = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    installWirebenchApi({
      team: {
        list: ok({ teams: [team('A'), team('B')], serverAdmin: false }),
        listWorkspaces: ok({ workspaces: [] }),
        members: slow,
        invitations: ok({ invitations: [] }),
      },
    });
    const opening = useTeamStore.getState().open(URL_);
    await vi.waitFor(() => expect(slow).toHaveBeenCalled());
    useTeamStore.setState({ teamId: 'B' });
    release({ ok: true, value: { members: [member('stale')] } });
    await opening;
    expect(useTeamStore.getState().members).toEqual([]);
  });
});
```

`apps/desktop/test/renderer/team-dialog.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TeamDialog } from '../../src/renderer/features/team/team-dialog.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { useTeamStore } from '../../src/renderer/state/team.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { AccountWire, TeamMemberWire, TeamWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const URL_ = 'https://wb.test';
const account: AccountWire = {
  url: URL_,
  userId: 'me',
  email: 'me@wb.test',
  displayName: 'Me',
  deviceName: 'd',
  signedOut: false,
  addedAt: '2026-09-24T12:00:00.000Z',
};
const team = (myRole: 'member' | 'admin', id = 'T1', name = 'Payments QA'): TeamWire => ({
  id,
  name,
  myRole,
  createdAt: '2026-09-25T10:00:00.000Z',
});
const member = (userId: string, role: 'member' | 'admin'): TeamMemberWire => ({
  userId,
  email: `${userId}@wb.test`,
  displayName: userId,
  role,
  disabled: false,
  addedAt: '2026-09-25T10:00:00.000Z',
});
const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });
const unauthenticated = () =>
  vi.fn().mockResolvedValue({ ok: false, error: { code: 'identity-unauthenticated', message: 'x' } });

function install(myRole: 'member' | 'admin', overrides: Record<string, unknown> = {}, serverAdmin = false) {
  return installWirebenchApi({
    team: {
      list: ok({ teams: [team(myRole)], serverAdmin }),
      listWorkspaces: ok({ workspaces: [] }),
      members: ok({ members: [member('me', myRole), member('bob', 'member')] }),
      invitations: ok({ invitations: [] }),
      invite: ok({
        invitation: {
          id: 'i1',
          email: 'new@wb.test',
          role: 'member',
          url: 'https://wb.test/invite/s3cr3t',
          expiresAt: '2026-10-02T10:00:00.000Z',
        },
      }),
      ...overrides,
    },
  });
}

describe('TeamDialog (teams-access §3.5)', () => {
  beforeEach(() => {
    useTeamStore.getState().reset();
    useAccountStore.setState({ servers: [account], loaded: true });
    useUiStore.setState({ teamDialog: { open: true, url: URL_ }, signInDialog: { open: false, url: undefined } });
  });
  afterEach(() => {
    cleanup();
  });

  it('a member sees the team read-only: no role selects, no add, no invitations tab, Leave on their own row', async () => {
    install('member');
    render(<TeamDialog />);
    await screen.findByTestId('member-row-bob');
    expect((screen.getByTestId('team-name') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByTestId('member-role-bob')).toBeNull();
    expect(screen.queryByTestId('member-add')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Invitations' })).toBeNull();
    expect(screen.queryByTestId('member-remove-bob')).toBeNull();
    expect(screen.getByTestId('member-remove-me').textContent).toBe('Leave');
    expect(screen.queryByTestId('team-new')).toBeNull();
    expect(screen.queryByTestId('team-delete')).toBeNull();
  });

  it('a team admin changes a role and invites; the link is shown once', async () => {
    const setMemberRole = ok({ member: member('bob', 'admin') });
    install('admin', { setMemberRole });
    render(<TeamDialog />);
    const select = (await screen.findByTestId('member-role-bob')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'admin' } });
    await vi.waitFor(() =>
      expect(setMemberRole).toHaveBeenCalledWith({ url: URL_, teamId: 'T1', userId: 'bob', role: 'admin' }),
    );

    fireEvent.click(screen.getByTestId('member-invite'));
    const dialog = await screen.findByTestId('invite-dialog');
    fireEvent.change(within(dialog).getByTestId('invite-email'), { target: { value: 'new@wb.test' } });
    fireEvent.click(within(dialog).getByTestId('invite-submit'));
    const link = (await screen.findByTestId('invite-link')) as HTMLInputElement;
    expect(link.value).toBe('https://wb.test/invite/s3cr3t');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await vi.waitFor(() => expect(screen.queryByTestId('invite-link')).toBeNull());
    expect(useTeamStore.getState().lastInvite).toBeUndefined();
  });

  it('a server admin can create a team and sees Delete team', async () => {
    const created = team('admin', 'T2', 'New');
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { teams: [team('admin')], serverAdmin: true } })
      .mockResolvedValue({ ok: true, value: { teams: [team('admin'), created], serverAdmin: true } });
    const create = ok({ team: created });
    install('admin', { list, create }, true);
    render(<TeamDialog />);
    fireEvent.click(await screen.findByTestId('team-new'));
    fireEvent.change(screen.getByTestId('team-new-name'), { target: { value: 'New' } });
    fireEvent.click(screen.getByTestId('team-new-submit'));
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith({ url: URL_, name: 'New' }));
    await vi.waitFor(() => expect((screen.getByTestId('team-name') as HTMLInputElement).value).toBe('New'));
    expect(screen.getByTestId('team-delete')).toBeTruthy();
  });

  it('a signed-out server shows Sign in again, which hands over to the sign-in dialog', async () => {
    installWirebenchApi({ team: { list: unauthenticated(), listWorkspaces: unauthenticated() } });
    render(<TeamDialog />);
    fireEvent.click(await screen.findByTestId('team-sign-in-again'));
    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: URL_ });
    expect(useUiStore.getState().teamDialog.open).toBe(false);
  });
});
```

In `apps/desktop/test/renderer/account-commands.test.ts`, add `teamDialog: { open: false, url: undefined },` to the
`useUiStore.setState` call in `beforeEach`, and append inside the `describe`:

```ts
  it('team.manage is gated on a signed-in server and opens the teams dialog', () => {
    const command = getCommand('team.manage')!;
    expect(command.when?.(context)).toBe(false);
    useAccountStore.setState({ servers: [account('https://wb.test')] });
    expect(command.when?.(context)).toBe(true);
    void command.run(context);
    expect(useUiStore.getState().teamDialog).toEqual({ open: true, url: undefined });
  });
```

In `apps/desktop/test/renderer/account-status-item.test.tsx`, add `teamDialog: { open: false, url: undefined },` to the
`useUiStore.setState` call, and append inside the `describe`:

```tsx
  it('the menu offers Manage teams…', async () => {
    useAccountStore.setState({ servers: [account('https://wb.test')] });
    render(<AccountStatusItem />);
    const item = screen.getByTestId('status-bar-account');
    fireEvent.pointerDown(item, { button: 0, ctrlKey: false });
    fireEvent.click(item);
    fireEvent.click(await screen.findByTestId('account-manage-teams'));
    expect(useUiStore.getState().teamDialog).toEqual({ open: true, url: undefined });
  });
```

In `apps/desktop/test/renderer/accounts-section.test.tsx`, change the `useUiStore.setState` call in `beforeEach` to
`useUiStore.setState({ signInDialog: { open: false, url: undefined }, teamDialog: { open: false, url: undefined } });`
and append inside the `describe`:

```tsx
  it('a signed-in row offers Manage teams… for that server; a signed-out row does not', () => {
    useAccountStore.setState({ servers: [account('https://wb.test'), account('https://old.test', true)] });
    render(<AccountsSection preferences={DEFAULT_PREFERENCES_WIRE} update={vi.fn()} />);
    const old = screen.getByTestId('account-row-old.test');
    expect(old.querySelector('[data-testid="account-row-manage-teams"]')).toBeNull();
    const live = screen.getByTestId('account-row-wb.test');
    fireEvent.click(live.querySelector('[data-testid="account-row-manage-teams"]')!);
    expect(useUiStore.getState().teamDialog).toEqual({ open: true, url: 'https://wb.test' });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/team-roles.test.ts apps/desktop/test/renderer/team-store.test.ts apps/desktop/test/renderer/team-dialog.test.tsx apps/desktop/test/renderer/account-commands.test.ts apps/desktop/test/renderer/account-status-item.test.tsx apps/desktop/test/renderer/accounts-section.test.tsx`
Expected: FAIL (`features/team/*` and `state/team.js` cannot be found).

- [ ] **Step 3: UI state and the command**

In `apps/desktop/src/renderer/state/ui.ts`, next to each matching `signInDialog` line:

```ts
  // in the state interface, after `signInDialog`
  /** *Manage teams…* (teams-access §3.5); `url` picks the server, or the first signed-in one. */
  readonly teamDialog: { readonly open: boolean; readonly url: string | undefined };
  // in the actions, after `setSignInDialogOpen`
  readonly openTeamDialog: (url?: string) => void;
  readonly setTeamDialogOpen: (open: boolean) => void;
  // in the initial state, after `signInDialog: { open: false, url: undefined },`
  teamDialog: { open: false, url: undefined },
  // in the implementation, after `setSignInDialogOpen`
  openTeamDialog: (url) => {
    set({ teamDialog: { open: true, url } });
  },
  setTeamDialogOpen: (open) => {
    set({ teamDialog: { open, url: open ? get().teamDialog.url : undefined } });
  },
```

In `apps/desktop/src/shared/commands.ts`, add `'team.manage',` to `COMMAND_IDS` directly after `'account.signOut',`.

In `apps/desktop/src/shared/command-catalog.ts`, after the `'account.signOut'` entry:

```ts
  'team.manage': {
    id: 'team.manage',
    label: 'Account: Manage teams…',
    category: 'Account',
  },
```

In `apps/desktop/src/renderer/commands/register-account-commands.ts`, change the doc comment's first sentence to
"Registers the `account.*` commands and `team.manage`." and append inside `registerAccountCommands`:

```ts
  registerCommand({
    ...catalogEntry('team.manage'),
    when: hasSignedInServer,
    whenScope: 'account.signedIn',
    run: () => {
      useUiStore.getState().openTeamDialog();
    },
  });
```

- [ ] **Step 4: Role labels**

`apps/desktop/src/renderer/features/team/roles.ts`:

```ts
/**
 * Role names and labels for the teams dialog (teams-access §3.5). Restated rather than read from
 * the wire enums: the dialog needs values, and a value import from `shared/wire-types.ts` pulls
 * zod into the renderer, which the CSP forbids. `team-roles.test.ts` keeps the copies honest.
 */
import type { DefaultRoleWire, RoleSourceWire, TeamRoleWire, WorkspaceRoleWire } from '../../../shared/wire-types.js';

export const TEAM_ROLES: readonly TeamRoleWire[] = ['member', 'admin'];
export const WORKSPACE_ROLES: readonly WorkspaceRoleWire[] = ['viewer', 'editor', 'admin'];
export const DEFAULT_ROLES: readonly DefaultRoleWire[] = ['none', 'viewer', 'editor'];

export const ROLE_LABELS: Readonly<Record<TeamRoleWire | WorkspaceRoleWire | DefaultRoleWire, string>> = {
  member: 'Member',
  admin: 'Admin',
  viewer: 'Viewer',
  editor: 'Editor',
  none: 'No access',
};

export const SOURCE_LABELS: Readonly<Record<RoleSourceWire, string>> = {
  'server-admin': 'server admin',
  'team-admin': 'team admin',
  grant: 'granted',
  default: 'workspace default',
};

/** `Editor (granted)`: a role and where it comes from, as the Workspaces tab and the access panel show it. */
export function roleWithSource(role: WorkspaceRoleWire, source: RoleSourceWire): string {
  return `${ROLE_LABELS[role]} (${SOURCE_LABELS[source]})`;
}

export const SELECT_CLASS =
  'h-row min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60';
export const INPUT_CLASS =
  'h-row min-w-0 rounded-md border border-hairline-strong bg-surface-base px-2 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent read-only:border-transparent read-only:bg-transparent';
```

- [ ] **Step 5: The store**

`apps/desktop/src/renderer/state/team.ts`:

```ts
/**
 * The teams dialog's state (teams-access §3.5): one server's teams, the selected team's members and
 * invitations, and every workspace the caller can see on that server. Nothing here is persisted; the
 * dialog reloads each time it opens. Failures toast, except a signed-out answer, which flips
 * `signedOut` so the dialog can offer *Sign in again*.
 */
import { create } from 'zustand';
import type { IpcResult } from '../../shared/ipc.js';
import type {
  AccessEntryWire,
  DefaultRoleWire,
  TeamInvitationCreatedWire,
  TeamInvitationWire,
  TeamMemberWire,
  TeamRoleWire,
  TeamWire,
  TeamWorkspaceWire,
  WorkspaceRoleWire,
} from '../../shared/wire-types.js';
import { showToast } from '../components/toast.js';
import { ipc } from './ipc-client.js';

export type TeamTab = 'members' | 'workspaces' | 'invitations';

export interface TeamState {
  readonly url: string | undefined;
  readonly serverAdmin: boolean;
  readonly teams: readonly TeamWire[];
  readonly teamId: string | undefined;
  readonly tab: TeamTab;
  readonly members: readonly TeamMemberWire[];
  readonly invitations: readonly TeamInvitationWire[];
  /** Every workspace the caller can open on `url`, across teams; {@link teamWorkspaces} narrows it. */
  readonly workspaces: readonly TeamWorkspaceWire[];
  /** The access panel's workspace and its entries, while the panel is open. */
  readonly access: { readonly workspaceId: string; readonly entries: readonly AccessEntryWire[] } | undefined;
  /** The invitation just created: the only time its link is shown. */
  readonly lastInvite: TeamInvitationCreatedWire | undefined;
  readonly loading: boolean;
  readonly signedOut: boolean;
}

export interface TeamStore extends TeamState {
  readonly open: (url: string) => Promise<void>;
  readonly reset: () => void;
  readonly refresh: () => Promise<void>;
  readonly selectTeam: (teamId: string) => Promise<void>;
  readonly setTab: (tab: TeamTab) => void;
  readonly createTeam: (name: string) => Promise<boolean>;
  readonly renameTeam: (name: string) => Promise<boolean>;
  readonly deleteTeam: () => Promise<boolean>;
  readonly addMember: (email: string, role: TeamRoleWire) => Promise<boolean>;
  readonly setMemberRole: (userId: string, role: TeamRoleWire) => Promise<boolean>;
  readonly removeMember: (userId: string) => Promise<boolean>;
  readonly invite: (email: string, role: TeamRoleWire) => Promise<boolean>;
  readonly clearLastInvite: () => void;
  readonly revokeInvitation: (invitationId: string) => Promise<boolean>;
  readonly createWorkspace: (name: string, defaultRole?: DefaultRoleWire) => Promise<boolean>;
  readonly updateWorkspace: (
    workspaceId: string,
    patch: { readonly name?: string; readonly defaultRole?: DefaultRoleWire },
  ) => Promise<boolean>;
  readonly deleteWorkspace: (workspaceId: string) => Promise<boolean>;
  readonly openAccess: (workspaceId: string) => Promise<void>;
  readonly closeAccess: () => void;
  readonly setAccess: (userId: string, role: WorkspaceRoleWire) => Promise<boolean>;
  readonly clearAccess: (userId: string) => Promise<boolean>;
}

const INITIAL: TeamState = {
  url: undefined,
  serverAdmin: false,
  teams: [],
  teamId: undefined,
  tab: 'members',
  members: [],
  invitations: [],
  workspaces: [],
  access: undefined,
  lastInvite: undefined,
  loading: false,
  signedOut: false,
};

const SIGNED_OUT = new Set(['identity-unauthenticated', 'account-signed-out']);

export function selectedTeam(state: TeamState): TeamWire | undefined {
  return state.teams.find((team) => team.id === state.teamId);
}

export function teamWorkspaces(state: TeamState): readonly TeamWorkspaceWire[] {
  return state.workspaces.filter((workspace) => workspace.teamId === state.teamId);
}

export const useTeamStore = create<TeamStore>((set, get) => {
  /** Unwraps an answer; a failure toasts `Could not <what>: …`, or marks the dialog signed out. */
  const run = async <T>(what: string, call: () => Promise<IpcResult<T>>): Promise<T | undefined> => {
    const result = await call();
    if (result.ok) return result.value;
    if (SIGNED_OUT.has(result.error.code)) set({ signedOut: true });
    else showToast(`Could not ${what}: ${result.error.message}`);
    return undefined;
  };

  /** A change: run it against the open server, then reload whatever it may have touched. */
  const write = async <T>(what: string, call: (url: string) => Promise<IpcResult<T>>): Promise<T | undefined> => {
    const url = get().url;
    if (url === undefined) return undefined;
    const value = await run(what, () => call(url));
    if (value !== undefined) await get().refresh();
    return value;
  };

  const loadTeam = async (): Promise<void> => {
    const { url, teamId } = get();
    const team = selectedTeam(get());
    if (url === undefined || teamId === undefined || team === undefined) {
      set({ members: [], invitations: [] });
      return;
    }
    const [members, invitations] = await Promise.all([
      run('load the members', () => ipc().team.members({ url, teamId })),
      team.myRole === 'admin'
        ? run('load the invitations', () => ipc().team.invitations({ url, teamId }))
        : Promise.resolve({ invitations: [] }),
    ]);
    if (get().url !== url || get().teamId !== teamId) return;
    set({ members: members?.members ?? [], invitations: invitations?.invitations ?? [] });
  };

  const reloadAccess = async (): Promise<void> => {
    const { url, access } = get();
    if (url === undefined || access === undefined) return;
    const value = await run('load access', () => ipc().team.access({ url, workspaceId: access.workspaceId }));
    if (value !== undefined && get().access?.workspaceId === access.workspaceId) {
      set({ access: { workspaceId: access.workspaceId, entries: value.entries } });
    }
  };

  const withTeam = async (
    what: string,
    call: (url: string, teamId: string) => Promise<IpcResult<unknown>>,
  ): Promise<boolean> => {
    const teamId = get().teamId;
    if (teamId === undefined) return false;
    return (await write(what, (url) => call(url, teamId))) !== undefined;
  };

  const withAccess = async (
    what: string,
    call: (url: string, workspaceId: string) => Promise<IpcResult<unknown>>,
  ): Promise<boolean> => {
    const workspaceId = get().access?.workspaceId;
    if (workspaceId === undefined) return false;
    return (await write(what, (url) => call(url, workspaceId))) !== undefined;
  };

  return {
    ...INITIAL,

    open: async (url) => {
      set({ ...INITIAL, url, loading: true });
      await get().refresh();
    },

    reset: () => {
      set(INITIAL);
    },

    refresh: async () => {
      const url = get().url;
      if (url === undefined) return;
      const [list, spaces] = await Promise.all([
        run('load teams', () => ipc().team.list({ url })),
        run('load workspaces', () => ipc().team.listWorkspaces({ url })),
      ]);
      if (get().url !== url) return;
      if (list === undefined) {
        set({ loading: false });
        return;
      }
      const current = get().teamId;
      const teamId = list.teams.some((team) => team.id === current) ? current : list.teams[0]?.id;
      set({
        teams: list.teams,
        serverAdmin: list.serverAdmin,
        workspaces: spaces?.workspaces ?? get().workspaces,
        teamId,
      });
      await loadTeam();
      await reloadAccess();
      set({ loading: false });
    },

    selectTeam: async (teamId) => {
      set({ teamId, members: [], invitations: [], access: undefined });
      if (get().tab === 'invitations' && selectedTeam(get())?.myRole !== 'admin') set({ tab: 'members' });
      await loadTeam();
    },

    setTab: (tab) => {
      set({ tab, access: undefined });
    },

    createTeam: async (name) => {
      const url = get().url;
      if (url === undefined) return false;
      const value = await run('create the team', () => ipc().team.create({ url, name }));
      if (value === undefined) return false;
      set({ teamId: value.team.id, tab: 'members' });
      await get().refresh();
      return true;
    },

    renameTeam: (name) => withTeam('rename the team', (url, teamId) => ipc().team.rename({ url, teamId, name })),

    deleteTeam: () => withTeam('delete the team', (url, teamId) => ipc().team.delete({ url, teamId })),

    addMember: (email, role) =>
      withTeam('add the member', (url, teamId) => ipc().team.addMember({ url, teamId, email, role })),

    setMemberRole: (userId, role) =>
      withTeam('change the role', (url, teamId) => ipc().team.setMemberRole({ url, teamId, userId, role })),

    removeMember: (userId) =>
      withTeam('remove the member', (url, teamId) => ipc().team.removeMember({ url, teamId, userId })),

    invite: async (email, role) => {
      const teamId = get().teamId;
      if (teamId === undefined) return false;
      const value = await write('create the invitation', (url) => ipc().team.invite({ url, teamId, email, role }));
      if (value === undefined) return false;
      set({ lastInvite: value.invitation });
      return true;
    },

    clearLastInvite: () => {
      set({ lastInvite: undefined });
    },

    revokeInvitation: (invitationId) =>
      withTeam('revoke the invitation', (url, teamId) => ipc().team.revokeInvitation({ url, teamId, invitationId })),

    createWorkspace: (name, defaultRole) =>
      withTeam('create the workspace', (url, teamId) =>
        ipc().team.createWorkspace({ url, teamId, name, ...(defaultRole !== undefined ? { defaultRole } : {}) }),
      ),

    updateWorkspace: async (workspaceId, patch) =>
      (await write('update the workspace', (url) => ipc().team.updateWorkspace({ url, workspaceId, ...patch }))) !==
      undefined,

    deleteWorkspace: async (workspaceId) => {
      if (get().access?.workspaceId === workspaceId) set({ access: undefined });
      return (
        (await write('delete the workspace', (url) => ipc().team.deleteWorkspace({ url, workspaceId }))) !== undefined
      );
    },

    openAccess: async (workspaceId) => {
      set({ access: { workspaceId, entries: [] } });
      await reloadAccess();
    },

    closeAccess: () => {
      set({ access: undefined });
    },

    setAccess: (userId, role) =>
      withAccess('change access', (url, workspaceId) => ipc().team.setAccess({ url, workspaceId, userId, role })),

    clearAccess: (userId) =>
      withAccess('change access', (url, workspaceId) => ipc().team.clearAccess({ url, workspaceId, userId })),
  };
});
```

- [ ] **Step 6: The dialog, the Members tab, the invite dialog, the Invitations tab and the Workspaces stub**

`apps/desktop/src/renderer/features/team/team-dialog.tsx`:

```tsx
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { Tabs, type TabItem } from '../../components/tabs.js';
import { signedInServers, useAccountStore } from '../../state/account.js';
import { selectedTeam, useTeamStore, type TeamTab } from '../../state/team.js';
import { useUiStore } from '../../state/ui.js';
import { InvitationsTab } from './invitations-tab.js';
import { MembersTab } from './members-tab.js';
import { INPUT_CLASS, SELECT_CLASS } from './roles.js';
import { WorkspacesTab } from './workspaces-tab.js';

/**
 * *Manage teams…* (teams-access §3.5): a server's teams on the left, the chosen team on the right.
 * A control the caller may not use is hidden or read-only rather than failing on click; the server
 * checks again regardless.
 */
export function TeamDialog() {
  const open = useUiStore((state) => state.teamDialog.open);
  const requestedUrl = useUiStore((state) => state.teamDialog.url);
  const setOpen = useUiStore((state) => state.setTeamDialogOpen);
  const servers = signedInServers(useAccountStore((state) => state.servers));
  const store = useTeamStore();
  const team = selectedTeam(store);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const url = requestedUrl ?? servers[0]?.url;

  useEffect(() => {
    if (open && url !== undefined) void useTeamStore.getState().open(url);
    if (!open) useTeamStore.getState().reset();
  }, [open, url]);

  useEffect(() => {
    setName(team?.name ?? '');
  }, [team?.id, team?.name]);

  const isAdmin = team?.myRole === 'admin';
  const tabs: TabItem<TeamTab>[] = [
    { id: 'members', label: 'Members' },
    { id: 'workspaces', label: 'Workspaces' },
    ...(isAdmin ? [{ id: 'invitations' as const, label: 'Invitations' }] : []),
  ];

  const submitNew = async (): Promise<void> => {
    if (newName.trim().length === 0) return;
    if (await store.createTeam(newName.trim())) {
      setCreating(false);
      setNewName('');
    }
  };

  const submitRename = (): void => {
    if (team !== undefined && isAdmin && name.trim().length > 0 && name.trim() !== team.name) {
      void store.renameTeam(name.trim());
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="team-dialog"
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 flex h-[34rem] w-[56rem] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <div className="flex items-center gap-3">
            <Dialog.Title className="flex-1 text-md font-medium text-fg-default">Teams</Dialog.Title>
            {servers.length > 1 && (
              <select
                data-testid="team-server"
                aria-label="Server"
                className={SELECT_CLASS}
                value={url}
                onChange={(event) => {
                  useUiStore.getState().openTeamDialog(event.target.value);
                }}
              >
                {servers.map((server) => (
                  <option key={server.url} value={server.url}>
                    {server.url}
                  </option>
                ))}
              </select>
            )}
          </div>

          {store.signedOut ? (
            <div data-testid="team-signed-out" className="mt-6 flex flex-col items-start gap-3 text-sm text-fg-subtle">
              <p>{url} no longer accepts this session.</p>
              <Button
                variant="primary"
                data-testid="team-sign-in-again"
                onClick={() => {
                  setOpen(false);
                  useUiStore.getState().openSignInDialog(url);
                }}
              >
                Sign in again
              </Button>
            </div>
          ) : (
            <div className="mt-3 flex min-h-0 flex-1 gap-4">
              <div className="flex w-52 shrink-0 flex-col gap-2 border-r border-hairline pr-3">
                <ul data-testid="team-list" className="min-h-0 flex-1 overflow-y-auto">
                  {store.teams.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        data-testid={`team-row-${item.id}`}
                        aria-current={item.id === store.teamId}
                        className={`w-full truncate rounded-sm px-2 py-1 text-left text-sm ${
                          item.id === store.teamId
                            ? 'bg-surface-hover text-fg-default'
                            : 'text-fg-muted hover:bg-surface-hover'
                        }`}
                        onClick={() => {
                          void store.selectTeam(item.id);
                        }}
                      >
                        {item.name}
                      </button>
                    </li>
                  ))}
                  {store.teams.length === 0 && !store.loading && (
                    <li className="px-2 text-sm text-fg-subtle">You are not on a team on this server yet.</li>
                  )}
                </ul>
                {store.serverAdmin &&
                  (creating ? (
                    <form
                      className="flex flex-col gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submitNew();
                      }}
                    >
                      <input
                        data-testid="team-new-name"
                        aria-label="New team name"
                        autoFocus
                        className={INPUT_CLASS}
                        value={newName}
                        onChange={(event) => {
                          setNewName(event.target.value);
                        }}
                      />
                      <div className="flex gap-2">
                        <Button type="submit" variant="primary" data-testid="team-new-submit">
                          Create
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setCreating(false);
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <Button
                      data-testid="team-new"
                      onClick={() => {
                        setCreating(true);
                      }}
                    >
                      New team…
                    </Button>
                  ))}
              </div>

              {team !== undefined && (
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-center gap-2">
                    <input
                      data-testid="team-name"
                      aria-label="Team name"
                      readOnly={!isAdmin}
                      className={`${INPUT_CLASS} flex-1 text-md font-medium`}
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                      }}
                      onBlur={submitRename}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') submitRename();
                      }}
                    />
                    {store.serverAdmin && (
                      <Button
                        variant="ghost"
                        data-testid="team-delete"
                        onClick={() => {
                          setConfirmDelete(true);
                        }}
                      >
                        Delete team
                      </Button>
                    )}
                  </div>
                  <div className="mt-2 border-b border-hairline">
                    <Tabs label="Team" items={tabs} active={store.tab} onSelect={store.setTab} />
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto pt-3">
                    {store.tab === 'members' && <MembersTab />}
                    {store.tab === 'workspaces' && <WorkspacesTab />}
                    {store.tab === 'invitations' && isAdmin && <InvitationsTab />}
                  </div>
                </div>
              )}
            </div>
          )}
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={`Delete ${team?.name ?? 'team'}?`}
            description="Only a team with no workspaces can be deleted. Its members and invitations go with it."
            confirmLabel="Delete team"
            destructive
            testId="team-delete-confirm"
            onConfirm={() => {
              void store.deleteTeam();
            }}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

`apps/desktop/src/renderer/features/team/members-tab.tsx`:

```tsx
import { useState } from 'react';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useAccountStore } from '../../state/account.js';
import { selectedTeam, useTeamStore } from '../../state/team.js';
import type { TeamMemberWire, TeamRoleWire } from '../../../shared/wire-types.js';
import { InviteDialog } from './invite-dialog.js';
import { INPUT_CLASS, ROLE_LABELS, SELECT_CLASS, TEAM_ROLES } from './roles.js';

/** The Members tab: everyone on the team with their team role, and for admins the controls to change that. */
export function MembersTab() {
  const store = useTeamStore();
  const team = selectedTeam(store);
  const myId = useAccountStore((state) => state.servers.find((server) => server.url === store.url)?.userId);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRoleWire>('member');
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<TeamMemberWire | undefined>(undefined);
  const isAdmin = team?.myRole === 'admin';
  const leaving = removing !== undefined && removing.userId === myId;

  const submitAdd = async (): Promise<void> => {
    if (email.trim().length === 0) return;
    if (await store.addMember(email.trim(), role)) {
      setAdding(false);
      setEmail('');
      setRole('member');
    }
  };

  const roleOptions = TEAM_ROLES.map((option) => (
    <option key={option} value={option}>
      {ROLE_LABELS[option]}
    </option>
  ));

  return (
    <div data-testid="members-tab" className="flex flex-col gap-3">
      <ul className="divide-y divide-hairline">
        {store.members.map((member) => {
          const self = member.userId === myId;
          return (
            <li key={member.userId} data-testid={`member-row-${member.userId}`} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-fg-default">
                  {member.displayName}
                  {member.disabled && <span className="ml-2 text-xs text-fg-faint">disabled</span>}
                </div>
                <div className="truncate text-xs text-fg-subtle">{member.email}</div>
              </div>
              {isAdmin ? (
                <select
                  data-testid={`member-role-${member.userId}`}
                  aria-label={`Role of ${member.email}`}
                  className={SELECT_CLASS}
                  value={member.role}
                  onChange={(event) => {
                    void store.setMemberRole(member.userId, event.target.value as TeamRoleWire);
                  }}
                >
                  {roleOptions}
                </select>
              ) : (
                <span className="text-sm text-fg-muted">{ROLE_LABELS[member.role]}</span>
              )}
              {(isAdmin || self) && (
                <Button
                  variant="ghost"
                  data-testid={`member-remove-${member.userId}`}
                  onClick={() => {
                    setRemoving(member);
                  }}
                >
                  {self ? 'Leave' : 'Remove'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {isAdmin &&
        (adding ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submitAdd();
            }}
          >
            <input
              data-testid="member-add-email"
              aria-label="Email of an existing user"
              placeholder="Email of an existing user"
              autoFocus
              className={`${INPUT_CLASS} flex-1`}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
            <select
              data-testid="member-add-role"
              aria-label="Role"
              className={SELECT_CLASS}
              value={role}
              onChange={(event) => {
                setRole(event.target.value as TeamRoleWire);
              }}
            >
              {roleOptions}
            </select>
            <Button type="submit" variant="primary" data-testid="member-add-submit">
              Add
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setAdding(false);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex gap-2">
            <Button
              data-testid="member-add"
              onClick={() => {
                setAdding(true);
              }}
            >
              Add member…
            </Button>
            <Button
              data-testid="member-invite"
              onClick={() => {
                setInviting(true);
              }}
            >
              Invite…
            </Button>
          </div>
        ))}

      <InviteDialog open={inviting} onOpenChange={setInviting} />
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(next) => {
          if (!next) setRemoving(undefined);
        }}
        title={leaving ? `Leave ${team?.name ?? 'the team'}?` : `Remove ${removing?.email ?? ''}?`}
        description="Access to the team's workspaces goes too. A team always keeps at least one admin."
        confirmLabel={leaving ? 'Leave' : 'Remove'}
        destructive
        testId="member-remove-confirm"
        confirmTestId="member-remove-confirm-ok"
        onConfirm={() => {
          if (removing !== undefined) void store.removeMember(removing.userId);
        }}
      />
    </div>
  );
}
```

`apps/desktop/src/renderer/features/team/invite-dialog.tsx`:

```tsx
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { useTeamStore } from '../../state/team.js';
import type { TeamRoleWire } from '../../../shared/wire-types.js';
import { INPUT_CLASS, ROLE_LABELS, SELECT_CLASS, TEAM_ROLES } from './roles.js';

export interface InviteDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * *Invite…* (teams-access §3.5): an email and a team role. The returned link is shown here once, with
 * Copy, and the store drops it when the dialog closes; the server keeps only its hash.
 */
export function InviteDialog({ open, onOpenChange }: InviteDialogProps) {
  const invite = useTeamStore((state) => state.invite);
  const lastInvite = useTeamStore((state) => state.lastInvite);
  const clearLastInvite = useTeamStore((state) => state.clearLastInvite);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRoleWire>('member');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setEmail('');
      setRole('member');
      setBusy(false);
    } else {
      clearLastInvite();
    }
  }, [open, clearLastInvite]);

  const submit = async (): Promise<void> => {
    if (busy || email.trim().length === 0) return;
    setBusy(true);
    await invite(email.trim(), role);
    setBusy(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="invite-dialog"
          className="fixed top-1/2 left-1/2 w-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Invite to the team</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            {lastInvite === undefined
              ? 'The invitation link is shown once. Send it to them yourself.'
              : `Send this link to ${lastInvite.email}. It is shown only now, and expires ${new Date(lastInvite.expiresAt).toLocaleString()}.`}
          </Dialog.Description>
          {lastInvite === undefined ? (
            <form
              className="mt-3 flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <input
                data-testid="invite-email"
                aria-label="Email"
                placeholder="Email"
                autoFocus
                className={INPUT_CLASS}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
              />
              <select
                data-testid="invite-role"
                aria-label="Role"
                className={SELECT_CLASS}
                value={role}
                onChange={(event) => {
                  setRole(event.target.value as TeamRoleWire);
                }}
              >
                {TEAM_ROLES.map((option) => (
                  <option key={option} value={option}>
                    {ROLE_LABELS[option]}
                  </option>
                ))}
              </select>
              <div className="mt-2 flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    onOpenChange(false);
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" data-testid="invite-submit" disabled={busy}>
                  Create invitation
                </Button>
              </div>
            </form>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              <input
                data-testid="invite-link"
                aria-label="Invitation link"
                readOnly
                className={INPUT_CLASS}
                value={lastInvite.url}
              />
              <div className="flex justify-end gap-2">
                <Button
                  data-testid="invite-copy"
                  onClick={() => {
                    void navigator.clipboard.writeText(lastInvite.url).then(() => {
                      showToast('Invitation link copied');
                    });
                  }}
                >
                  Copy
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    onOpenChange(false);
                  }}
                >
                  Done
                </Button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

`apps/desktop/src/renderer/features/team/invitations-tab.tsx`:

```tsx
import { Button } from '../../components/button.js';
import { useTeamStore } from '../../state/team.js';
import { ROLE_LABELS } from './roles.js';

/** The Invitations tab (team admins only): open invitations, each with Revoke. Their links are never shown again. */
export function InvitationsTab() {
  const invitations = useTeamStore((state) => state.invitations);
  const revokeInvitation = useTeamStore((state) => state.revokeInvitation);

  return (
    <div data-testid="invitations-tab">
      {invitations.length === 0 ? (
        <p className="text-sm text-fg-subtle">No open invitations.</p>
      ) : (
        <ul className="divide-y divide-hairline">
          {invitations.map((invitation) => (
            <li
              key={invitation.id}
              data-testid={`invitation-row-${invitation.id}`}
              className="flex items-center gap-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-fg-default">{invitation.email}</div>
                <div className="truncate text-xs text-fg-subtle">
                  {ROLE_LABELS[invitation.role]} · expires {new Date(invitation.expiresAt).toLocaleString()}
                </div>
              </div>
              <Button
                variant="ghost"
                data-testid={`invitation-revoke-${invitation.id}`}
                onClick={() => {
                  void revokeInvitation(invitation.id);
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

`apps/desktop/src/renderer/features/team/workspaces-tab.tsx` (a stub; Task 12 replaces the whole file):

```tsx
/** The Workspaces tab; Task 12 fills it in. */
export function WorkspacesTab() {
  return <div data-testid="workspaces-tab" />;
}
```

- [ ] **Step 7: The entry points and the mount**

In `apps/desktop/src/renderer/features/account/account-status-item.tsx`:
- add `const openTeamDialog = useUiStore((state) => state.openTeamDialog);` next to `openPreferences`;
- in the doc comment, change "and *Manage accounts…*" to "*Manage teams…* and *Manage accounts…*";
- directly before the `account-manage` item, add:

```tsx
            <DropdownMenu.Item
              data-testid="account-manage-teams"
              className={ITEM_CLASS}
              onSelect={() => {
                openTeamDialog();
              }}
            >
              Manage teams…
            </DropdownMenu.Item>
```

In `apps/desktop/src/renderer/features/preferences/sections/accounts-section.tsx`:
- add `const openTeamDialog = useUiStore((state) => state.openTeamDialog);` next to `openSignInDialog`;
- replace the signed-in branch (the lone `account-row-sign-out` button) with:

```tsx
                  <>
                    <Button
                      data-testid="account-row-manage-teams"
                      onClick={() => {
                        openTeamDialog(server.url);
                      }}
                    >
                      Manage teams…
                    </Button>
                    <Button
                      data-testid="account-row-sign-out"
                      onClick={() => {
                        void signOut(server.url);
                      }}
                    >
                      Sign out
                    </Button>
                  </>
```

In `apps/desktop/src/renderer/shell/app-shell.tsx`:
- add `import { TeamDialog } from '../features/team/team-dialog.js';` after the `SignInDialog` import;
- add `<TeamDialog />` directly after `<SignInDialog />`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/team-roles.test.ts apps/desktop/test/renderer/team-store.test.ts apps/desktop/test/renderer/team-dialog.test.tsx apps/desktop/test/renderer/account-commands.test.ts apps/desktop/test/renderer/account-status-item.test.tsx apps/desktop/test/renderer/accounts-section.test.tsx apps/desktop/test/renderer/command-catalog.test.ts`
Expected: PASS.

Then regenerate the command reference, which now lists *Account: Manage teams…*: `pnpm docs:commands`.

- [ ] **Step 9: Commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/renderer apps/desktop/src/shared/commands.ts apps/desktop/src/shared/command-catalog.ts apps/desktop/test/renderer docs-site/src/content/docs/reference/commands.md
git commit -m "feat(desktop): Manage teams dialog with members and invitations

One dialog per server lists the caller's teams. Team admins change roles, add existing users,
invite by email and revoke invitations. Members see the same screens read-only and can leave.
The invitation link is shown once, when it is created, and the store drops it when the dialog
closes. A server that rejects the session switches the dialog to Sign in again instead of
toasting on every call. It opens from the palette, the account menu in the status bar and
Preferences → Accounts."
```

---

### Task 12: Desktop — the Workspaces tab and the access panel

Spec §3.5 and §3.3 (role resolution, as the dialog displays it). The Workspaces tab lists the team's
workspaces the caller can see, with the caller's role and where it comes from. Workspace admins can
rename a workspace, set its default role, open *Access…* and delete it. Any team member can create a
workspace, and becomes its admin through a grant (§3.7). The access panel takes the tab's place and
lists every team member. For each it shows the effective role and its source, plus a grant select:
*Use default* clears the grant. The select is disabled for team admins and server admins, whose role
a grant cannot change.

**Files:**
- Modify (replace the stub): `apps/desktop/src/renderer/features/team/workspaces-tab.tsx`
- Create: `apps/desktop/src/renderer/features/team/access-panel.tsx`, `apps/desktop/test/renderer/team-workspaces.test.tsx`

**Interfaces:**
- Consumes: Task 11 `useTeamStore` (`teamWorkspaces`, `createWorkspace`, `updateWorkspace`, `deleteWorkspace`,
  `openAccess`, `closeAccess`, `setAccess`, `clearAccess`, `access`), `ROLE_LABELS`, `roleWithSource`,
  `DEFAULT_ROLES`, `WORKSPACE_ROLES`, `SELECT_CLASS`, `INPUT_CLASS`; `Button`; `ConfirmDialog`.
- Produces: `WorkspacesTab`, `AccessPanel`. Testids: `workspaces-tab`, `workspace-row-<id>`, `workspace-name-<id>`,
  `workspace-role-<id>`, `workspace-default-<id>`, `workspace-access-<id>`, `workspace-delete-<id>`,
  `workspace-delete-confirm-ok`, `workspace-new`, `workspace-new-name`, `workspace-new-default`,
  `workspace-new-submit`, `access-panel`, `access-back`, `access-row-<userId>`, `access-effective-<userId>`,
  `access-grant-<userId>`.

- [ ] **Step 1: Write the failing test**

`apps/desktop/test/renderer/team-workspaces.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WorkspacesTab } from '../../src/renderer/features/team/workspaces-tab.js';
import { useTeamStore } from '../../src/renderer/state/team.js';
import type { AccessEntryWire, TeamWire, TeamWorkspaceWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const URL_ = 'https://wb.test';
const team: TeamWire = { id: 'T1', name: 'Payments QA', myRole: 'member', createdAt: '2026-09-25T10:00:00.000Z' };
const workspace = (overrides: Partial<TeamWorkspaceWire> = {}): TeamWorkspaceWire => ({
  id: 'W1',
  name: 'Integration',
  teamId: 'T1',
  teamName: 'Payments QA',
  defaultRole: 'viewer',
  myRole: 'viewer',
  source: 'default',
  createdAt: '2026-09-25T10:00:00.000Z',
  ...overrides,
});
const entry = (userId: string, overrides: Partial<AccessEntryWire> = {}): AccessEntryWire => ({
  userId,
  email: `${userId}@wb.test`,
  displayName: userId,
  teamRole: 'member',
  disabled: false,
  effectiveRole: 'viewer',
  source: 'default',
  ...overrides,
});
const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });

async function openWith(spaces: TeamWorkspaceWire[], extra: Record<string, unknown> = {}) {
  const api = installWirebenchApi({
    team: {
      list: ok({ teams: [team], serverAdmin: false }),
      listWorkspaces: ok({ workspaces: spaces }),
      members: ok({ members: [] }),
      ...extra,
    },
  });
  await useTeamStore.getState().open(URL_);
  useTeamStore.getState().setTab('workspaces');
  render(<WorkspacesTab />);
  return api;
}

describe('WorkspacesTab (teams-access §3.5)', () => {
  beforeEach(() => {
    useTeamStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
  });

  it('a viewer sees their role and its source, and nothing to change, but can still create a workspace', async () => {
    await openWith([workspace()]);
    expect(screen.getByTestId('workspace-role-W1').textContent).toBe('Viewer (workspace default)');
    expect((screen.getByTestId('workspace-name-W1') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByTestId('workspace-default-W1')).toBeNull();
    expect(screen.queryByTestId('workspace-access-W1')).toBeNull();
    expect(screen.queryByTestId('workspace-delete-W1')).toBeNull();
    expect(screen.getByTestId('workspace-new')).toBeTruthy();
  });

  it('a member creates a workspace with a chosen default role', async () => {
    const createWorkspace = ok({ workspace: workspace({ id: 'W2', name: 'Staging' }) });
    await openWith([], { createWorkspace });
    fireEvent.click(screen.getByTestId('workspace-new'));
    fireEvent.change(screen.getByTestId('workspace-new-name'), { target: { value: 'Staging' } });
    fireEvent.change(screen.getByTestId('workspace-new-default'), { target: { value: 'none' } });
    fireEvent.click(screen.getByTestId('workspace-new-submit'));
    await vi.waitFor(() =>
      expect(createWorkspace).toHaveBeenCalledWith({ url: URL_, teamId: 'T1', name: 'Staging', defaultRole: 'none' }),
    );
  });

  it('a workspace admin changes the default role and deletes after confirming', async () => {
    const updateWorkspace = ok({ workspace: workspace({ myRole: 'admin', source: 'grant', defaultRole: 'none' }) });
    const deleteWorkspace = ok({ done: true });
    await openWith([workspace({ myRole: 'admin', source: 'grant' })], { updateWorkspace, deleteWorkspace });
    expect(screen.getByTestId('workspace-role-W1').textContent).toBe('Admin (granted)');
    fireEvent.change(screen.getByTestId('workspace-default-W1'), { target: { value: 'none' } });
    await vi.waitFor(() =>
      expect(updateWorkspace).toHaveBeenCalledWith({ url: URL_, workspaceId: 'W1', defaultRole: 'none' }),
    );
    fireEvent.click(screen.getByTestId('workspace-delete-W1'));
    fireEvent.click(await screen.findByTestId('workspace-delete-confirm-ok'));
    await vi.waitFor(() => expect(deleteWorkspace).toHaveBeenCalledWith({ url: URL_, workspaceId: 'W1' }));
  });

  it('the access panel shows effective roles; grants set and clear, admins are fixed', async () => {
    const access = ok({
      entries: [
        entry('ann', { teamRole: 'admin', effectiveRole: 'admin', source: 'team-admin' }),
        entry('bob'),
        entry('cy', { effectiveRole: 'editor', source: 'grant', grant: 'editor' }),
      ],
    });
    const setAccess = ok({ done: true });
    const clearAccess = ok({ done: true });
    await openWith([workspace({ myRole: 'admin', source: 'grant' })], { access, setAccess, clearAccess });
    fireEvent.click(screen.getByTestId('workspace-access-W1'));
    await screen.findByTestId('access-row-bob');
    expect(screen.getByTestId('access-effective-ann').textContent).toBe('Admin (team admin)');
    expect((screen.getByTestId('access-grant-ann') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByTestId('access-grant-bob') as HTMLSelectElement).value).toBe('');
    expect((screen.getByTestId('access-grant-cy') as HTMLSelectElement).value).toBe('editor');

    fireEvent.change(screen.getByTestId('access-grant-bob'), { target: { value: 'editor' } });
    await vi.waitFor(() =>
      expect(setAccess).toHaveBeenCalledWith({ url: URL_, workspaceId: 'W1', userId: 'bob', role: 'editor' }),
    );
    fireEvent.change(screen.getByTestId('access-grant-cy'), { target: { value: '' } });
    await vi.waitFor(() => expect(clearAccess).toHaveBeenCalledWith({ url: URL_, workspaceId: 'W1', userId: 'cy' }));

    fireEvent.click(screen.getByTestId('access-back'));
    expect(screen.queryByTestId('access-panel')).toBeNull();
  });

  it('a member with no access shows as No access', async () => {
    const access = ok({ entries: [entry('dee', { effectiveRole: 'none', source: undefined })] });
    await openWith([workspace({ myRole: 'admin', source: 'team-admin', defaultRole: 'none' })], { access });
    fireEvent.click(screen.getByTestId('workspace-access-W1'));
    expect((await screen.findByTestId('access-effective-dee')).textContent).toBe('No access');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/team-workspaces.test.tsx`
Expected: FAIL (the stub renders no rows: `Unable to find an element by: [data-testid="workspace-role-W1"]`).

- [ ] **Step 3: The access panel**

`apps/desktop/src/renderer/features/team/access-panel.tsx`:

```tsx
import { Button } from '../../components/button.js';
import { useTeamStore } from '../../state/team.js';
import type { AccessEntryWire, WorkspaceRoleWire } from '../../../shared/wire-types.js';
import { ROLE_LABELS, SELECT_CLASS, WORKSPACE_ROLES, roleWithSource } from './roles.js';

/** A grant can neither lower nor raise these; the select says so by being disabled. */
const FIXED_SOURCES = new Set(['team-admin', 'server-admin']);

function effectiveLabel(entry: AccessEntryWire): string {
  return entry.effectiveRole === 'none' || entry.source === undefined
    ? ROLE_LABELS.none
    : roleWithSource(entry.effectiveRole, entry.source);
}

/**
 * *Access…* for one workspace (teams-access §3.5): every team member, the role they end up with and
 * why, and a grant select. *Use default* clears the grant, so the member falls back to the default role.
 */
export function AccessPanel({ workspaceName }: { readonly workspaceName: string }) {
  const entries = useTeamStore((state) => state.access?.entries ?? []);
  const closeAccess = useTeamStore((state) => state.closeAccess);
  const setAccess = useTeamStore((state) => state.setAccess);
  const clearAccess = useTeamStore((state) => state.clearAccess);

  return (
    <div data-testid="access-panel" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" data-testid="access-back" onClick={closeAccess}>
          ← Workspaces
        </Button>
        <span className="text-sm font-medium text-fg-default">Access to {workspaceName}</span>
      </div>
      <ul className="divide-y divide-hairline">
        {entries.map((entry) => {
          const fixed = entry.source !== undefined && FIXED_SOURCES.has(entry.source);
          return (
            <li key={entry.userId} data-testid={`access-row-${entry.userId}`} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-fg-default">
                  {entry.displayName}
                  {entry.disabled && <span className="ml-2 text-xs text-fg-faint">disabled</span>}
                </div>
                <div className="truncate text-xs text-fg-subtle">
                  {entry.email} · team {ROLE_LABELS[entry.teamRole].toLowerCase()}
                </div>
              </div>
              <span data-testid={`access-effective-${entry.userId}`} className="text-sm text-fg-muted">
                {effectiveLabel(entry)}
              </span>
              <select
                data-testid={`access-grant-${entry.userId}`}
                aria-label={`Grant for ${entry.email}`}
                className={SELECT_CLASS}
                disabled={fixed}
                title={fixed ? 'Admins always administer the workspace.' : undefined}
                value={entry.grant ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === '') void clearAccess(entry.userId);
                  else void setAccess(entry.userId, value as WorkspaceRoleWire);
                }}
              >
                <option value="">Use default</option>
                {WORKSPACE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: The Workspaces tab**

Replace `apps/desktop/src/renderer/features/team/workspaces-tab.tsx` with:

```tsx
import { useEffect, useState } from 'react';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { teamWorkspaces, useTeamStore } from '../../state/team.js';
import type { DefaultRoleWire, TeamWorkspaceWire } from '../../../shared/wire-types.js';
import { AccessPanel } from './access-panel.js';
import { DEFAULT_ROLES, INPUT_CLASS, ROLE_LABELS, SELECT_CLASS, roleWithSource } from './roles.js';

const defaultOptions = DEFAULT_ROLES.map((role) => (
  <option key={role} value={role}>
    {role === 'none' ? 'No access by default' : `${ROLE_LABELS[role]} by default`}
  </option>
));

interface WorkspaceRowProps {
  readonly workspace: TeamWorkspaceWire;
  readonly onDelete: () => void;
}

function WorkspaceRow({ workspace, onDelete }: WorkspaceRowProps) {
  const updateWorkspace = useTeamStore((state) => state.updateWorkspace);
  const openAccess = useTeamStore((state) => state.openAccess);
  const [name, setName] = useState(workspace.name);
  const isAdmin = workspace.myRole === 'admin';

  useEffect(() => {
    setName(workspace.name);
  }, [workspace.name]);

  const submitRename = (): void => {
    if (isAdmin && name.trim().length > 0 && name.trim() !== workspace.name) {
      void updateWorkspace(workspace.id, { name: name.trim() });
    }
  };

  return (
    <li data-testid={`workspace-row-${workspace.id}`} className="flex items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <input
          data-testid={`workspace-name-${workspace.id}`}
          aria-label="Workspace name"
          readOnly={!isAdmin}
          className={`${INPUT_CLASS} w-full`}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          onBlur={submitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitRename();
          }}
        />
        <div data-testid={`workspace-role-${workspace.id}`} className="truncate px-2 text-xs text-fg-subtle">
          {roleWithSource(workspace.myRole, workspace.source)}
        </div>
      </div>
      {isAdmin && (
        <>
          <select
            data-testid={`workspace-default-${workspace.id}`}
            aria-label={`Default role in ${workspace.name}`}
            className={SELECT_CLASS}
            value={workspace.defaultRole}
            onChange={(event) => {
              void updateWorkspace(workspace.id, { defaultRole: event.target.value as DefaultRoleWire });
            }}
          >
            {defaultOptions}
          </select>
          <Button
            data-testid={`workspace-access-${workspace.id}`}
            onClick={() => {
              void openAccess(workspace.id);
            }}
          >
            Access…
          </Button>
          <Button variant="ghost" data-testid={`workspace-delete-${workspace.id}`} onClick={onDelete}>
            Delete
          </Button>
        </>
      )}
    </li>
  );
}

/**
 * The Workspaces tab (teams-access §3.5): the team's workspaces the caller can see, each with the
 * caller's role and its source. Admins of a workspace manage it here; any member can create one.
 * *Access…* swaps the list for {@link AccessPanel}.
 */
export function WorkspacesTab() {
  const workspaces = useTeamStore(teamWorkspaces);
  const accessId = useTeamStore((state) => state.access?.workspaceId);
  const createWorkspace = useTeamStore((state) => state.createWorkspace);
  const deleteWorkspace = useTeamStore((state) => state.deleteWorkspace);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [defaultRole, setDefaultRole] = useState<DefaultRoleWire>('viewer');
  const [deleting, setDeleting] = useState<TeamWorkspaceWire | undefined>(undefined);

  const inAccess = workspaces.find((workspace) => workspace.id === accessId);
  if (inAccess !== undefined) return <AccessPanel workspaceName={inAccess.name} />;

  const submitNew = async (): Promise<void> => {
    if (name.trim().length === 0) return;
    if (await createWorkspace(name.trim(), defaultRole)) {
      setCreating(false);
      setName('');
      setDefaultRole('viewer');
    }
  };

  return (
    <div data-testid="workspaces-tab" className="flex flex-col gap-3">
      {workspaces.length === 0 ? (
        <p className="text-sm text-fg-subtle">No workspaces you can open in this team yet.</p>
      ) : (
        <ul className="divide-y divide-hairline">
          {workspaces.map((workspace) => (
            <WorkspaceRow
              key={workspace.id}
              workspace={workspace}
              onDelete={() => {
                setDeleting(workspace);
              }}
            />
          ))}
        </ul>
      )}

      {creating ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitNew();
          }}
        >
          <input
            data-testid="workspace-new-name"
            aria-label="Workspace name"
            placeholder="Workspace name"
            autoFocus
            className={`${INPUT_CLASS} flex-1`}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <select
            data-testid="workspace-new-default"
            aria-label="Default role"
            className={SELECT_CLASS}
            value={defaultRole}
            onChange={(event) => {
              setDefaultRole(event.target.value as DefaultRoleWire);
            }}
          >
            {defaultOptions}
          </select>
          <Button type="submit" variant="primary" data-testid="workspace-new-submit">
            Create
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setCreating(false);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <div>
          <Button
            data-testid="workspace-new"
            onClick={() => {
              setCreating(true);
            }}
          >
            New workspace…
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(next) => {
          if (!next) setDeleting(undefined);
        }}
        title={`Delete ${deleting?.name ?? 'workspace'}?`}
        description="Its repository is removed from the server. Copies already on members' machines stay, but stop syncing."
        confirmLabel="Delete workspace"
        destructive
        testId="workspace-delete-confirm"
        confirmTestId="workspace-delete-confirm-ok"
        onConfirm={() => {
          if (deleting !== undefined) void deleteWorkspace(deleting.id);
        }}
      />
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/team-workspaces.test.tsx apps/desktop/test/renderer/team-dialog.test.tsx`
Expected: PASS (5 + 4).

- [ ] **Step 6: Commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/renderer/features/team apps/desktop/test/renderer/team-workspaces.test.tsx
git commit -m "feat(desktop): workspaces tab and per-workspace access panel

Each workspace shows the caller's role and where it comes from: a grant, the workspace
default, or being a team or server admin. Workspace admins rename it, set its default role and
delete it. Any member can create one. The access panel lists each team member's effective
role. A grant select sets or clears their grant, and is disabled for admins, whom a grant
cannot change."
```

---

### Task 13: e2e against a fake server with teams, the user docs, and ADR-0011

Spec §11 (e2e), §13 criteria 1 and 6. `e2e/helpers/fake-server.ts` learns enough of the teams API for the dialog:
server admins, seeded teams, members, team invitations that add the member on accept, workspaces, and access.
Two specs:
- A team admin creates a workspace, grants a member *editor*, and invites someone who accepts through the local path
  and then sees the team read-only.
- A server admin creates a team and adds its first admin.

The docs gain *Teams and roles*, and ADR-0011 records the role model.

**Files:**
- Modify: `e2e/helpers/fake-server.ts`, `docs/collaborate.md`, `docs-site/src/content/docs/guides/shared-workspaces.mdx`
- Create: `e2e/specs/team.spec.ts`, `docs/adr/0011-workspace-roles-are-team-default-plus-grants.md`

**Interfaces:**
- Consumes: the testids from Tasks 11–12; the command label `Account: Manage teams…`; `launchApp`, `runCommand`; the
  server routes of Tasks 6–8 (as the paths `ServerClient` calls in Task 9).
- Produces: `FakeUser.serverAdmin?`, `FakeTeam`, `FakeServerOptions.teams?`.

- [ ] **Step 1: Extend the fake server**

In `e2e/helpers/fake-server.ts`:

1. Replace the `FakeUser` and `FakeServerOptions` interfaces with:

```ts
export interface FakeUser {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly serverAdmin?: boolean;
}

/** A team seeded at start: its name and its members' roles by email. */
export interface FakeTeam {
  readonly name: string;
  readonly members: Readonly<Record<string, 'member' | 'admin'>>;
}

export interface FakeServerOptions {
  readonly users?: readonly FakeUser[];
  /** Open invitations, by secret. */
  readonly invitations?: Readonly<Record<string, { readonly email: string }>>;
  readonly oidc?: boolean;
  readonly teams?: readonly FakeTeam[];
}
```

2. After `const newToken = …;`, add the teams model:

```ts
type TeamRole = 'member' | 'admin';
type WorkspaceRole = 'viewer' | 'editor' | 'admin';
type DefaultRole = 'none' | 'viewer' | 'editor';
type RoleSource = 'server-admin' | 'team-admin' | 'grant' | 'default';

interface TeamRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  /** By lower-cased email. */
  readonly members: Map<string, { role: TeamRole; readonly addedAt: string }>;
}

interface WorkspaceRow {
  readonly id: string;
  name: string;
  readonly teamId: string;
  defaultRole: DefaultRole;
  readonly createdAt: string;
  /** By lower-cased email. */
  readonly grants: Map<string, WorkspaceRole>;
}

interface FakeInvitation {
  readonly email: string;
  /** Present on a team invitation: accepting it adds the member. */
  readonly team?: {
    readonly teamId: string;
    readonly role: TeamRole;
    readonly id: string;
    readonly createdAt: string;
    readonly expiresAt: string;
  };
}

const at = (): string => new Date().toISOString();
```

3. In `startFakeServer`:

- change `const invitations = new Map(Object.entries(options.invitations ?? {}));` to
  `const invitations = new Map<string, FakeInvitation>(Object.entries(options.invitations ?? {}));`
- in `userOf`, change `serverAdmin: false` to `serverAdmin: user.serverAdmin ?? false`
- after `const signOuts: string[] = [];`, add:

```ts
  let seq = 1;
  const id = (prefix: string): string => `${prefix}${String(seq++)}`;
  const teams = new Map<string, TeamRow>();
  const workspaces = new Map<string, WorkspaceRow>();
  for (const seed of options.teams ?? []) {
    const team: TeamRow = { id: id('t'), name: seed.name, createdAt: at(), members: new Map() };
    for (const [email, role] of Object.entries(seed.members)) team.members.set(email.toLowerCase(), { role, addedAt: at() });
    teams.set(team.id, team);
  }
  const userByEmail = (email: string) => users.get(email.toLowerCase());
  const userById = (userId: string) => [...users.values()].find((user) => user.id === userId);

  /** The server's rule (teams-access §3.1), cut down to what the specs exercise. */
  const effective = (ws: WorkspaceRow, email: string): { role: WorkspaceRole; source: RoleSource } | undefined => {
    if (userByEmail(email)?.serverAdmin === true) return { role: 'admin', source: 'server-admin' };
    const membership = teams.get(ws.teamId)?.members.get(email.toLowerCase());
    if (membership === undefined) return undefined;
    if (membership.role === 'admin') return { role: 'admin', source: 'team-admin' };
    const grant = ws.grants.get(email.toLowerCase());
    if (grant !== undefined) return { role: grant, source: 'grant' };
    return ws.defaultRole === 'none' ? undefined : { role: ws.defaultRole, source: 'default' };
  };
  const teamRoleOf = (team: TeamRow, email: string): TeamRole | undefined =>
    userByEmail(email)?.serverAdmin === true ? 'admin' : team.members.get(email.toLowerCase())?.role;
  const toTeam = (team: TeamRow, myRole: TeamRole) => ({ id: team.id, name: team.name, myRole, createdAt: team.createdAt });
  const toMember = (email: string, membership: { role: TeamRole; addedAt: string }) => {
    const user = userByEmail(email)!;
    return {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: membership.role,
      disabled: false,
      addedAt: membership.addedAt,
    };
  };
  const toWorkspace = (ws: WorkspaceRow, access: { role: WorkspaceRole; source: RoleSource }) => ({
    id: ws.id,
    name: ws.name,
    teamId: ws.teamId,
    teamName: teams.get(ws.teamId)!.name,
    defaultRole: ws.defaultRole,
    myRole: access.role,
    source: access.source,
    createdAt: ws.createdAt,
  });

  /**
   * Enough of the teams API for `team.spec.ts` (teams-access §3.2); the real routes are covered by
   * `packages/server`'s integration suite. Answers `true` once it has responded.
   */
  const teamsApi = async (
    request: IncomingMessage,
    response: ServerResponse,
    segments: readonly string[],
    email: string,
  ): Promise<boolean> => {
    const method = request.method ?? 'GET';
    const [head, entityId, sub, subId] = segments;
    const key = email.toLowerCase();

    if (head === 'teams' && entityId === undefined) {
      if (method === 'GET') {
        const mine = [...teams.values()].flatMap((team) => {
          const role = teamRoleOf(team, email);
          return role === undefined ? [] : [toTeam(team, role)];
        });
        send(response, 200, mine);
        return true;
      }
      if (method === 'POST') {
        if (userByEmail(email)?.serverAdmin !== true) {
          problem(response, 403, 'teams-forbidden');
          return true;
        }
        const body = (await readJson(request)) as { name: string };
        const team: TeamRow = { id: id('t'), name: body.name.trim(), createdAt: at(), members: new Map() };
        team.members.set(key, { role: 'admin', addedAt: at() });
        teams.set(team.id, team);
        send(response, 201, toTeam(team, 'admin'));
        return true;
      }
    }

    if (head === 'teams' && entityId !== undefined) {
      const team = teams.get(entityId);
      const role = team === undefined ? undefined : teamRoleOf(team, email);
      if (team === undefined || role === undefined) {
        problem(response, 404, 'teams-team-not-found');
        return true;
      }
      const admin = role === 'admin';
      if (sub === 'members' && subId === undefined && method === 'GET') {
        send(response, 200, [...team.members].map(([memberEmail, membership]) => toMember(memberEmail, membership)));
        return true;
      }
      if (sub === 'members' && subId === undefined && method === 'POST' && admin) {
        const body = (await readJson(request)) as { email: string; role: TeamRole };
        if (userByEmail(body.email) === undefined) {
          problem(response, 404, 'teams-user-unknown');
          return true;
        }
        const membership = { role: body.role, addedAt: at() };
        team.members.set(body.email.toLowerCase(), membership);
        send(response, 201, toMember(body.email, membership));
        return true;
      }
      if (sub === 'invitations' && subId === undefined && method === 'GET' && admin) {
        const open = [...invitations.values()].flatMap((invitation) =>
          invitation.team?.teamId === team.id
            ? [
                {
                  id: invitation.team.id,
                  email: invitation.email,
                  role: invitation.team.role,
                  createdBy: null,
                  createdAt: invitation.team.createdAt,
                  expiresAt: invitation.team.expiresAt,
                },
              ]
            : [],
        );
        send(response, 200, open);
        return true;
      }
      if (sub === 'invitations' && subId === undefined && method === 'POST' && admin) {
        const body = (await readJson(request)) as { email: string; role: TeamRole };
        const secret = String(seq).padStart(43, 'S');
        const team_ = {
          teamId: team.id,
          role: body.role,
          id: id('i'),
          createdAt: at(),
          expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        };
        invitations.set(secret, { email: body.email, team: team_ });
        send(response, 201, {
          id: team_.id,
          email: body.email,
          role: body.role,
          url: `${url}/invite/${secret}`,
          expiresAt: team_.expiresAt,
        });
        return true;
      }
      if (sub === 'workspaces' && subId === undefined && method === 'POST') {
        const body = (await readJson(request)) as { name: string; defaultRole?: DefaultRole };
        const ws: WorkspaceRow = {
          id: id('w'),
          name: body.name.trim(),
          teamId: team.id,
          defaultRole: body.defaultRole ?? 'viewer',
          createdAt: at(),
          grants: new Map(),
        };
        if (team.members.has(key)) ws.grants.set(key, 'admin');
        workspaces.set(ws.id, ws);
        send(response, 201, toWorkspace(ws, effective(ws, email)!));
        return true;
      }
      if (admin) problem(response, 404, 'not-found');
      else problem(response, 403, 'teams-forbidden');
      return true;
    }

    if (head === 'workspaces' && entityId === undefined && method === 'GET') {
      const visible = [...workspaces.values()].flatMap((ws) => {
        const access = effective(ws, email);
        return access === undefined ? [] : [toWorkspace(ws, access)];
      });
      send(response, 200, visible);
      return true;
    }

    if (head === 'workspaces' && entityId !== undefined) {
      const ws = workspaces.get(entityId);
      const access = ws === undefined ? undefined : effective(ws, email);
      if (ws === undefined || access === undefined) {
        problem(response, 404, 'teams-workspace-not-found');
        return true;
      }
      if (access.role !== 'admin') {
        problem(response, 403, 'teams-forbidden');
        return true;
      }
      if (sub === undefined && method === 'PATCH') {
        const body = (await readJson(request)) as { name?: string; defaultRole?: DefaultRole };
        if (body.name !== undefined) ws.name = body.name.trim();
        if (body.defaultRole !== undefined) ws.defaultRole = body.defaultRole;
        send(response, 200, toWorkspace(ws, effective(ws, email)!));
        return true;
      }
      if (sub === 'access' && subId === undefined && method === 'GET') {
        const team = teams.get(ws.teamId)!;
        const entries = [...team.members].map(([memberEmail, membership]) => {
          const user = userByEmail(memberEmail)!;
          const role = effective(ws, memberEmail);
          const grant = ws.grants.get(memberEmail);
          return {
            userId: user.id,
            email: user.email,
            displayName: user.displayName,
            teamRole: membership.role,
            disabled: false,
            effectiveRole: role?.role ?? 'none',
            ...(role !== undefined ? { source: role.source } : {}),
            ...(grant !== undefined ? { grant } : {}),
          };
        });
        send(response, 200, entries);
        return true;
      }
      if (sub === 'access' && subId !== undefined && (method === 'PUT' || method === 'DELETE')) {
        const targetKey = userById(subId)?.email.toLowerCase();
        if (targetKey === undefined || !teams.get(ws.teamId)!.members.has(targetKey)) {
          problem(response, 404, 'teams-not-a-member');
          return true;
        }
        if (method === 'PUT') ws.grants.set(targetKey, ((await readJson(request)) as { role: WorkspaceRole }).role);
        else ws.grants.delete(targetKey);
        send(response, 204);
        return true;
      }
    }
    return false;
  };
```

4. In the accept handler (`POST /api/v1/invitations/accept`), directly before `return issue(response, invitation.email);`,
   add:

```ts
        if (invitation.team !== undefined) {
          teams.get(invitation.team.teamId)?.members.set(invitation.email.toLowerCase(), {
            role: invitation.team.role,
            addedAt: at(),
          });
        }
```

5. Directly before the final `problem(response, 404, 'not-found');` of the request handler, add:

```ts
      const segments = path.pathname.replace(/^\/api\/v1\//, '').split('/').map(decodeURIComponent);
      if (segments[0] === 'teams' || segments[0] === 'workspaces') {
        if (email === undefined) return problem(response, 401, 'identity-unauthenticated');
        if (await teamsApi(request, response, segments, email)) return;
      }
```

6. Change the first sentence of the doc comment on `startFakeServer` to: "Enough of Wirebench Server for the desktop's
   sign-in flow (identity spec §11) and its teams dialog (teams-access spec §11), in memory."

- [ ] **Step 2: The e2e spec**

`e2e/specs/team.spec.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { runCommand } from '../helpers/palette.js';

const PASSWORD = 'correct horse battery';
const ROOT: FakeUser = { email: 'root@example.com', password: PASSWORD, displayName: 'Root', serverAdmin: true };
const ALICE: FakeUser = { email: 'alice@example.com', password: PASSWORD, displayName: 'Alice' };
const BOB: FakeUser = { email: 'bob@example.com', password: PASSWORD, displayName: 'Bob' };
/** The fake server's user id for an email. */
const uid = (email: string): string => `u-${email}`;

async function openSignIn(page: Page, url: string): Promise<Locator> {
  await runCommand(page, 'Account: Sign in to a server');
  const dialog = page.getByTestId('sign-in-dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByTestId('sign-in-url').fill(url);
  await dialog.getByTestId('sign-in-continue').click();
  return dialog;
}

async function signIn(page: Page, url: string, user: FakeUser): Promise<void> {
  const dialog = await openSignIn(page, url);
  await dialog.getByTestId('sign-in-email').fill(user.email);
  await dialog.getByTestId('sign-in-password').fill(user.password);
  await dialog.getByTestId('sign-in-submit').click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

async function openTeams(page: Page): Promise<Locator> {
  await runCommand(page, 'Account: Manage teams');
  const dialog = page.getByTestId('team-dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  return dialog;
}

test.describe('teams and workspace roles', () => {
  let launched: LaunchedApp | undefined;
  let server: FakeServer | undefined;
  let userDataDir = '';

  test.beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-team-'));
  });

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    await server?.close();
    server = undefined;
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('a team admin creates a workspace, grants a member editor, and invites someone who then sees the team read-only', async () => {
    test.setTimeout(180_000);
    server = await startFakeServer({
      users: [ALICE, BOB],
      teams: [{ name: 'Payments QA', members: { [ALICE.email]: 'admin', [BOB.email]: 'member' } }],
    });
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await signIn(page, server.url, ALICE);

    let dialog = await openTeams(page);
    await expect(dialog.getByTestId('team-name')).toHaveValue('Payments QA');
    await expect(dialog.getByTestId(`member-row-${uid(BOB.email)}`)).toBeVisible();

    // A workspace, with Alice as its admin through the creator's grant.
    await dialog.getByRole('tab', { name: 'Workspaces' }).click();
    await dialog.getByTestId('workspace-new').click();
    await dialog.getByTestId('workspace-new-name').fill('Integration');
    await dialog.getByTestId('workspace-new-submit').click();
    await expect(dialog.locator('[data-testid^="workspace-role-"]')).toHaveText('Admin (granted)');

    // Access: Bob starts at the default and becomes an editor; Alice, a team admin, is fixed.
    await dialog.locator('[data-testid^="workspace-access-"]').click();
    await expect(dialog.getByTestId(`access-effective-${uid(BOB.email)}`)).toHaveText('Viewer (workspace default)');
    await expect(dialog.getByTestId(`access-grant-${uid(ALICE.email)}`)).toBeDisabled();
    await dialog.getByTestId(`access-grant-${uid(BOB.email)}`).selectOption('editor');
    await expect(dialog.getByTestId(`access-effective-${uid(BOB.email)}`)).toHaveText('Editor (granted)');
    await dialog.getByTestId('access-back').click();

    // An invitation: the link is shown once, and Copy puts it on the clipboard.
    await dialog.getByRole('tab', { name: 'Members' }).click();
    await dialog.getByTestId('member-invite').click();
    const invite = page.getByTestId('invite-dialog');
    await invite.getByTestId('invite-email').fill('carol@example.com');
    await invite.getByTestId('invite-submit').click();
    const link = await invite.getByTestId('invite-link').inputValue();
    expect(link.startsWith(`${server.url}/invite/`)).toBe(true);
    await invite.getByTestId('invite-copy').click();
    await expect
      .poll(async () => launched!.app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10_000 })
      .toBe(link);
    await invite.getByRole('button', { name: 'Done' }).click();
    await dialog.getByRole('tab', { name: 'Invitations' }).click();
    await expect(dialog.locator('[data-testid^="invitation-row-"]')).toContainText('carol@example.com');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Carol accepts through the local path and lands on the team as a member.
    await page.getByTestId('status-bar-account').click();
    await page.getByTestId(`account-sign-out-${new URL(server.url).host}`).click();
    await expect(page.getByTestId('status-bar-account')).toContainText('Sign in', { timeout: 20_000 });
    const signInDialog = await openSignIn(page, server.url);
    await signInDialog.getByTestId('sign-in-have-code').click();
    await signInDialog.getByTestId('sign-in-code').fill(link);
    await signInDialog.getByTestId('sign-in-code-continue').click();
    await expect(signInDialog.getByTestId('sign-in-invited-email')).toContainText('carol@example.com');
    await signInDialog.getByTestId('sign-in-display-name').fill('Carol');
    await signInDialog.getByTestId('sign-in-new-password').fill('a password of length');
    await signInDialog.getByTestId('sign-in-confirm-password').fill('a password of length');
    await signInDialog.getByTestId('sign-in-accept').click();
    await expect(signInDialog).toBeHidden({ timeout: 20_000 });

    dialog = await openTeams(page);
    await expect(dialog.getByTestId('team-name')).toHaveValue('Payments QA');
    await expect(dialog.getByTestId('team-name')).toHaveAttribute('readonly', '');
    await expect(dialog.getByTestId(`member-row-${uid('carol@example.com')}`)).toBeVisible();
    await expect(dialog.locator('[data-testid^="member-role-"]')).toHaveCount(0);
    await expect(dialog.getByTestId('member-add')).toHaveCount(0);
    await expect(dialog.getByRole('tab', { name: 'Invitations' })).toHaveCount(0);
    await dialog.getByRole('tab', { name: 'Workspaces' }).click();
    await expect(dialog.locator('[data-testid^="workspace-role-"]')).toHaveText('Viewer (workspace default)');
    await expect(dialog.locator('[data-testid^="workspace-access-"]')).toHaveCount(0);
  });

  test('a server admin creates a team and adds its first admin', async () => {
    test.setTimeout(120_000);
    server = await startFakeServer({ users: [ROOT, ALICE] });
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await signIn(page, server.url, ROOT);

    const dialog = await openTeams(page);
    await expect(dialog.getByTestId('team-list')).toContainText('You are not on a team on this server yet.');
    await dialog.getByTestId('team-new').click();
    await dialog.getByTestId('team-new-name').fill('Platform');
    await dialog.getByTestId('team-new-submit').click();
    await expect(dialog.getByTestId('team-name')).toHaveValue('Platform');
    await expect(dialog.getByTestId('team-delete')).toBeVisible();

    await dialog.getByTestId('member-add').click();
    await dialog.getByTestId('member-add-email').fill(ALICE.email);
    await dialog.getByTestId('member-add-role').selectOption('admin');
    await dialog.getByTestId('member-add-submit').click();
    await expect(dialog.getByTestId(`member-role-${uid(ALICE.email)}`)).toHaveValue('admin');
  });
});
```

- [ ] **Step 3: Type-check the e2e sources, without launching Electron**

Run: `pnpm typecheck`
Expected: PASS. Per the owner's standing rule, do not run the spec locally: CI runs e2e on the pull request. The spec
must be green there before the branch merges.

- [ ] **Step 4: User docs**

In `docs/collaborate.md`, insert this section after *Sign in to a server* and before *Troubleshooting*. Insert the same
text in `docs-site/src/content/docs/guides/shared-workspaces.mdx` after *Sign in to a server* and before *Related*.

```markdown
## Teams and roles

On Wirebench Server, every shared workspace belongs to a team, and what you can do in it depends on your role.
Open **Account: Manage teams…** from the palette, the status bar's account menu, or **Manage teams…** beside a
signed-in server under Settings → Accounts.

- **Teams.** A server admin creates a team and adds its first admin. Team admins add people who already have an
  account, or invite someone by email. The invitation link is shown once, with **Copy**, and whoever accepts it
  joins the team with the role it names. Anyone can leave a team; a team always keeps at least one admin.
- **Workspace roles.** A workspace has three roles: *viewer* can pull, *editor* can also push, and *admin* can also
  change its settings and access. Your role comes from, in order:
  1. being a server admin or an admin of the workspace's team (always *admin*);
  2. a grant a workspace admin gave you;
  3. the workspace's default role, which starts as *viewer* and can be *none*.

  Whoever creates a workspace gets an *admin* grant on it.
- **Access.** On the **Workspaces** tab, **Access…** lists everyone on the team, the role they end up with, and
  where it comes from. A workspace admin sets a grant per person, or **Use default** to remove it. A team admin's
  role cannot be lowered by a grant.

If you have no role in a workspace, the server does not show it to you at all. Members who are not admins see the
same dialog read-only, so everyone can check their own access.
```

- [ ] **Step 5: ADR-0011**

`docs/adr/0011-workspace-roles-are-team-default-plus-grants.md`:

```markdown
# ADR-0011: Workspace roles are the team's admins, per-member grants, and a workspace default

Status: accepted · Date: 2026-09-25 · Spec: `docs/specs/2026-09-24-wirebench-server-teams-access-design.md`

## Context

Wirebench Server (ADR-0009) knows who is calling (ADR-0010). Before it hosts shared workspaces it has to decide
who may pull, push and administer each one. The teams are small, a workspace usually belongs to one of them, and
an admin needs to answer "why can this person push?" from one screen.

## Decision

- **Every workspace belongs to exactly one team.** Membership of that team is the precondition for any role in
  it; a grant held by someone who has left the team counts for nothing.
- **Three workspace roles, a closed list:** *viewer* (pull), *editor* (push), *admin* (settings and access).
- **The effective role is the first that applies:** server admin → *admin*; team admin → *admin*; a per-member
  grant; the workspace's default role (*none*, *viewer* or *editor*, starting at *viewer*). The creator of a
  workspace gets an *admin* grant.
- **One pure function decides.** `resolveRole` computes the role and its source, and both the guards
  (`requireWorkspaceRole`, `requireTeamRole`) and the listings call it, so what the dialog shows is what the
  server enforces.
- **No role reveals nothing.** A caller whose role is *none* gets `404`, never `403`, so workspace ids do not
  leak across teams.
- **Team invitations ride on identity's invitations.** A hook runs inside identity's accepting transaction and
  adds the membership, so an accepted invitation and its membership commit together.

## Consequences

- A role check is one query that joins the membership, the grant and the workspace default. It is not cached,
  so a changed grant takes effect on the next request.
- Team admins cannot be lowered in a workspace. The access panel shows their role as fixed instead of offering
  a grant that would do nothing.
- A team keeps at least one admin. The check locks the team row, so two concurrent demotions cannot both
  succeed.
- Moving a workspace to another team, cross-team workspaces, groups, and roles narrower than a workspace are
  left out. Each would add a precedence rule to `resolveRole`.

## Alternatives considered

- **Per-member roles only, with no default.** Every new member would need a grant on every workspace, so the
  common case, "the whole team can read it", becomes chores. Rejected.
- **Roles on the team only.** Too coarse: a team often has one workspace everyone may push to and another only
  a few may. Rejected.
- **Grants that override team admins.** That makes "who administers this?" depend on two places and lets an
  admin lock themselves out. Rejected.
- **`403` for every refusal.** Simpler, but it confirms to anyone signed in that a workspace id exists.
  Rejected.
```

- [ ] **Step 6: Run the gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add e2e/helpers/fake-server.ts e2e/specs/team.spec.ts docs/collaborate.md docs-site/src/content/docs/guides/shared-workspaces.mdx docs/adr/0011-workspace-roles-are-team-default-plus-grants.md
git commit -m "test(e2e): teams dialog against the fake server; docs and ADR-0011

The fake server learns server admins, seeded teams, members, team invitations that add the
member on accept, workspaces and access. It is just enough for two flows. In the first, a team
admin creates a workspace, makes a member an editor and invites someone, who accepts through
the local path and sees the team read-only. In the second, a server admin creates a team and
adds its first admin. The collaborate guide and the docs site explain teams and workspace
roles, and ADR-0011 records the role model."
```

Before pushing, run `pnpm test:perf` without `WIREBENCH_SKIP_PERF`.

---

## Self-review against the spec

**Coverage: every spec section maps to a task.**

| Spec | What | Task |
| --- | --- | --- |
| §3.1 | Effective-role rule and its table | 5 (`resolveRole`, unit table) |
| §3.2 | Team, member, invitation, workspace and access routes with their codes | 6, 7, 8 |
| §3.2 | 23505 → `409`, `FOR UPDATE` last-admin check, capability `teams` | 4, 6, 8 |
| §3.3 | `requireWorkspaceRole(db, min)`, `requireTeamRole(db, min)`, `404` for none, `403` below | 5 |
| §3.4 | `ServerHooks.invitationAccepted` inside the accept transaction; OIDC and local paths | 2, 7 |
| §3.5 | Team dialog: entry points, layout, tabs, access panel, signed-out view | 10, 11, 12 |
| §3.5 | `syncStatusWireSchema.role` for `server-sync` | 10 |
| §3.6 | `team.listWorkspaces` | 10 |
| §3.7 | Staged `RepoStore.create`; create in the transaction; delete after commit with `ENOENT` → warn | 3, 8 |
| §4.1 | `0003_teams.sql` with the empty-table assert and `teams_name_lower` | 4 |
| §4.2 | Engine schemas, `teamsIdSchema` | 1 |
| §5.1, §5.2 | `ServerClient` methods, IPC channels, main handlers, renderer store | 9, 10, 11 |
| §6 | ULID validation before queries; roles never read from bodies; `404` for none | 1, 5, 6, 8 |
| §11 | Server unit and integration, desktop unit, e2e, checks | 2–13 (each task's tests) |
| §13.1 | Server admin creates a team; its admin invites; accept (local in e2e, OIDC in integration) | 6, 7, 13 |
| §13.2 | The §3.1 table as a unit test | 5 |
| §13.3 | Creator is admin, default *viewer*, others see `source: "default"` | 8 |
| §13.4 | Grants, default role and member removal change `GET /workspaces` and `/access` immediately | 8 |
| §13.5 | Probe route: viewer → `403`, stranger → `404` | 5 |
| §13.6 | Dialog complete for a team admin, read-only for a member | 11, 12, 13 |
| §13.7 | Accept then `GET /teams` at once lists the team; a failing hook leaves the invitation open | 2, 7 |
| §13.8 | `pnpm check` green | every task's commit step |

**Names checked across tasks.**
- Guards: `requireWorkspaceRole`, `requireTeamRole` (Task 5) are used in Tasks 6–8, with the `request.workspaceAccess`
  and `request.teamAccess` names unchanged.
- Hooks: `ServerHooks`, `serverHooks()`, `runInvitationAccepted` (Task 2) and `addInvitedMember` (Task 7).
- Client and wire: the Task 9 `ServerClient` names match the `TeamChannelDeps` pick in Task 10. The `channels.team`
  keys in Task 10 match the mock defaults and the store calls in Task 11.
- Store actions: every `useTeamStore` action Task 12 calls is declared in Task 11. Every testid the Task 13 spec
  uses is listed under Produces in Task 11 or Task 12.
- `effectiveRole` / `source` values: the engine enums (Task 1), the wire restatement (Task 10) and `roles.ts`
  (Task 11, pinned by `team-roles.test.ts`) agree.

**Placeholder scan.** No TBD, TODO or "similar to Task N" remains. The Workspaces stub in Task 11 is intentional:
Task 12 replaces the whole file, and the stub keeps Task 11's gate green.

**Rulings (where the plan settles something the spec leaves open or words differently).**
1. The routes take `db` in their guards (`requireWorkspaceRole(db, min)`), so `server-sync` can pass `ctx.db`.
2. A grant counts only while its holder is on the team.
3. `ServerClient` gets flat methods, not grouped objects. It already works that way for identity.
4. The routes return the object itself, such as a team or a workspace summary, not a `{ team }` wrapper. Only
   the IPC layer wraps.
5. A server admin who creates a workspace on a team they are not on gets no creator grant: their role is
   *admin* already, from `server-admin`.
6. `createInvitation` revokes an email's expired, unused invitations before inserting. This fixes the latent
   `500` from `invitations_one_open_per_email`.
7. `team.list` reports `serverAdmin` from `/me`, because `AccountWire` does not carry it.
8. Preferences → Accounts labels the button *Manage teams…* rather than the spec's *Manage…*. The row already has
   *Sign out* and *Remove*, and the label says what opens.
9. Read-only viewers see roles as plain text rather than disabled selects (spec §3.5 says "selects disabled").
   The information is the same with less chrome; the tests assert there is no select.
10. The Invitations tab offers only *Revoke*. The link is shown once, in the invite dialog, right after creation,
   and that is the only place spec §3.5 allows it to appear.
11. Spec §13.6 asks for "all three OSes". The e2e spec runs wherever CI's e2e job runs. If that job is not on all
   three OSes, the gap belongs to CI, not to this module.
