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
  return (await db.query(`${MEMBER_SELECT} where m.team_id = $1 order by lower(u.email)`, [teamId])).rows.map((row) =>
    dated<MemberRow>(row, ['addedAt']),
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

/**
 * The ids of every workspace in `teamId`, in no particular order, and `[]` for an unknown team. The
 * live hub resolves a team-scoped access change with this one query and intersects the result with
 * the workspaces it has subscribers on (live-updates spec §3.3).
 */
export async function workspaceIdsOfTeam(db: Querier, teamId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>('select id from workspaces where team_id = $1', [teamId]);
  return rows.map((row) => row.id);
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
