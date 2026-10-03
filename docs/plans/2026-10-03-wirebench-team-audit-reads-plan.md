# Team admins read their team's audit events — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A team admin reads and exports the audit events of the teams they administer, and nothing else, from the server and from the team dialog's Audit tab. A server admin still sees everything.

**Architecture:** The two read routes in the `audit-log` module (`GET /audit`, `GET /audit/export`) replace `requireServerAdmin` with a scope guard: a server admin passes as before; anyone else must name a `teamId` they administer, and the filter is pinned to it. A partial index on `(team_id, at desc, id desc)` backs the scoped read. The desktop shows the Audit tab to a team admin and always sends the selected team's id.

**Tech Stack:** TypeScript on Node 24, Fastify, Postgres (`pg`), zod 4, React + zustand, Vitest 5.

**Spec:** `docs/specs/2026-10-01-wirebench-server-audit-log-design.md` (§1.2 named team-scoped readers as out of the first slice; this plan adds them) and issue #208. The decisions below are rulings made while planning; there is no separate design note.

## Global Constraints

- Reading still needs the `audit-log` feature (Enterprise) for every caller. The license gate runs after the scope guard, as today.
- A server admin's reads and exports are unchanged: any filter, including none.
- A caller who is not a server admin:
  - with no `teamId` → `403 audit-team-required` ("Name a team you administer.");
  - with a `teamId` of a team that does not exist or they are not on → `404 teams-team-not-found` (the existing problem; it does not reveal the team);
  - with a `teamId` of a team they are a member but not an admin of → `403 teams-forbidden` (existing);
  - with a `teamId` of a team they administer → the read runs with `team_id = teamId`, and no other filter can widen it.
- Events without a `team_id` (sign-ins, users, server, license, and CI-token events that carry none) are never visible to a team admin.
- `audit.exported` records the scope: `teamId` on the event when the export was team-scoped, so a team admin's exports appear in their own team's log.
- CI tokens and anonymous callers cannot read (existing `authenticate` behaviour; unchanged).
- New problem code: `audit-team-required` (403).
- Migration `packages/server/migrations/audit-log/0010_audit-team-index.sql`: `create index audit_events_team_at on audit_events (team_id, at desc, id desc) where team_id is not null;`. It must keep the combined list contiguous after 0009.
- The renderer imports only **types** from `shared/wire-types.ts`.
- Never name which product inspired a feature (`pnpm check:banned-terms`).
- `WIREBENCH_SKIP_PERF=1 nice pnpm check` green before every commit (with `WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:5432/wirebench_test`). One commit per task, subject ending `(#208)`. No `Co-Authored-By` or `Claude-Session` trailer. No local e2e.

## Rulings made while planning

1. A team admin must name the team; the server never guesses a scope from the caller's memberships. One query, one team, an obvious trail of who read what.
2. Not-a-member answers 404 like every other team route, so the read routes do not become a probe for team ids.
3. Team admins see only rows whose `team_id` is their team. Events about a member that the server records without a team (a sign-in, a password change) stay with the server admin.
4. The desktop shows the tab to a server admin as before (all events) and to a team admin of the selected team (that team only). A server admin is not offered a team-only view in this slice.
5. The command line (`wirebench-server admin audit export`) is unchanged: whoever runs it has the database.

## Tasks

### Task 1: Server — the scope guard, the index and the export's scope

**Files:** Modify `packages/server/src/audit-log/routes.ts` (replace `requireServerAdmin` in `guards` with a scope guard; pin the filter; `exportedEvent` carries `teamId` when scoped), the module's errors file (`audit-team-required`), `packages/server/src/audit-log/module.ts` if the routes need the teams repo; create `packages/server/migrations/audit-log/0010_audit-team-index.sql`. Reuse `repo.memberRole` / `repo.teamById` from `packages/server/src/teams/repo.ts`, as `requireTeamRole` (`packages/server/src/teams/roles.ts:115`) does. Tests: extend `packages/server/test/integration/audit-log/` (the existing read-route suite) and the migration-list test (`teams/migration.test.ts` asserts the combined list).

- [ ] Tests first (Postgres, `licensingHarness` with an Enterprise license, as the existing read tests do): seed two teams A and B with events in each, and events with no team.
  - A team admin of A with `teamId=A` sees exactly A's rows, in pages; with `teamId=B` (not a member) gets 404; a member (not admin) of B with `teamId=B` gets 403 `teams-forbidden`; with no `teamId` gets 403 `audit-team-required`, on both `/audit` and `/audit/export`.
  - A team admin cannot widen: `teamId=A` plus `action`, `workspaceId` or `actorUserId` filters still return only A's rows (a `workspaceId` of a B workspace returns nothing).
  - A server admin with no `teamId` still sees every row; with `teamId=B` sees B's rows.
  - Without the license feature a team admin gets the existing `licensing-feature-required`.
  - A team admin's export writes `audit.exported` with `teamId: A`, and that event shows in A's scoped read.
  - The migration test lists `10_audit-team-index` after `9_desktop-recording`.
- [ ] Implement; gate; commit `feat(server): team admins read and export their own team's audit events (#208)`.

### Task 2: Desktop — the Audit tab for team admins

**Files:** Modify `apps/desktop/src/renderer/features/team/team-dialog.tsx` (the tab list and the panel condition at ~:51 and ~:235: show for `serverAdmin` or the selected team's `myRole === 'admin'`; pass the selected team id to the tab when the viewer is not a server admin), `apps/desktop/src/renderer/state/team.ts` (the guard at ~:195 that moves non-admins off the `audit` tab must allow team admins of the selected team, and move them off when they select a team they do not administer), `apps/desktop/src/renderer/features/team/audit-tab.tsx` and `apps/desktop/src/renderer/state/audit.ts` (a `teamId` scope that every query and export carries; changing it resets the store and reloads). Check that `apps/desktop/src/main` passes `teamId` through `audit.query` / `audit.export` (the wire query schema already has `teamId`). Tests: `apps/desktop/test/renderer/audit-tab.test.tsx`, `apps/desktop/test/renderer/team-dialog.test.tsx`, a store test.

- [ ] Tests first: a team admin (not server admin) sees the Audit tab for a team they administer and not for one they only belong to; their queries and export carry `teamId` of the selected team; switching the selected team reloads with the new id and clears rows; a server admin's queries carry no `teamId` as before; a team admin with no team selected does not see the tab.
- [ ] Implement; gate; commit `feat(desktop): the Audit tab for team admins, scoped to the selected team (#208)`.

### Task 3: Docs

**Files:** `docs-site/src/content/docs/guides/server-audit-log.mdx` (who can read: server admins see everything; team admins see their team's events, chosen in the team dialog; events without a team stay with server admins; the API's `teamId` rule), `packages/server/README.md` (one sentence in *Audit log*), `CHANGELOG.md` (extend the audit-log entry), `docs/specs/2026-10-01-wirebench-server-audit-log-design.md` (§1.2: team-scoped readers now point to this plan).

- [ ] `pnpm check:banned-terms`, the docs build; gate; commit `docs: team admins in the audit log guide, README and changelog (#208)`.

## After the last task

Final review of the #208 range, one fix wave, `pnpm test:perf`, push `feat/audit-log`, open a PR that closes #208, CI green, merge with `gh pr merge --merge`.

## Open questions

None.
