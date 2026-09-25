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
