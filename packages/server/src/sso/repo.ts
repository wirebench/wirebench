/**
 * Every SQL statement of the `sso` module (saml-scim spec §4): SAML identities and flows, SCIM tokens, the
 * external id a user carries, stored groups and their members, and the provisioned team memberships
 * (§3.6). One function each over a `Querier`, as in `identity/repo.ts`. Users and team memberships
 * themselves are written through `identity/repo.ts` and `teams/repo.ts`.
 */
import type { Querier } from '../context.js';

export interface ScimTokenRow {
  readonly id: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export interface ScimGroupRow {
  readonly id: string;
  readonly displayName: string;
  readonly externalId: string | null;
  readonly teamId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScimGroupListRow extends ScimGroupRow {
  readonly memberCount: number;
  readonly teamName: string | null;
}

type Raw = Record<string, unknown>;

const iso = (value: unknown): string | null =>
  value === null || value === undefined
    ? null
    : (value instanceof Date ? value : new Date(value as string | number)).toISOString();

function dated<T>(row: Raw, keys: readonly string[]): T;
function dated<T>(row: Raw | undefined, keys: readonly string[]): T | undefined;
function dated<T>(row: Raw | undefined, keys: readonly string[]): T | undefined {
  if (row === undefined) return undefined;
  const out: Raw = { ...row };
  for (const key of keys) if (key in out) out[key] = iso(out[key]);
  return out as T;
}

const TOKEN_COLUMNS =
  'id, name, token_hash as "tokenHash", created_by as "createdBy", created_at as "createdAt", last_used_at as "lastUsedAt", revoked_at as "revokedAt"';
const TOKEN_DATES = ['createdAt', 'lastUsedAt', 'revokedAt'];
const GROUP_COLUMNS =
  'g.id, g.display_name as "displayName", g.external_id as "externalId", g.team_id as "teamId", g.created_at as "createdAt", g.updated_at as "updatedAt"';
const GROUP_DATES = ['createdAt', 'updatedAt'];

// ---- tokens --------------------------------------------------------------------------------

export async function insertScimToken(
  db: Querier,
  input: {
    readonly id: string;
    readonly name: string;
    readonly tokenHash: string;
    readonly createdBy: string | null;
    readonly at: Date;
  },
): Promise<ScimTokenRow> {
  const rows = (
    await db.query(
      `insert into scim_tokens (id, name, token_hash, created_by, created_at) values ($1, $2, $3, $4, $5) returning ${TOKEN_COLUMNS}`,
      [input.id, input.name, input.tokenHash, input.createdBy, input.at],
    )
  ).rows;
  return dated<ScimTokenRow>(rows[0]!, TOKEN_DATES);
}

/** Revoked ones too: the guard tells a revoked token from an unknown one only in its log line. */
export async function scimTokenByHash(db: Querier, tokenHash: string): Promise<ScimTokenRow | undefined> {
  const row = (await db.query(`select ${TOKEN_COLUMNS} from scim_tokens where token_hash = $1`, [tokenHash])).rows[0];
  return row === undefined ? undefined : dated<ScimTokenRow>(row, TOKEN_DATES);
}

export async function scimTokenById(db: Querier, id: string): Promise<ScimTokenRow | undefined> {
  const row = (await db.query(`select ${TOKEN_COLUMNS} from scim_tokens where id = $1`, [id])).rows[0];
  return row === undefined ? undefined : dated<ScimTokenRow>(row, TOKEN_DATES);
}

/** Live tokens, by name. */
export async function listScimTokens(db: Querier): Promise<readonly ScimTokenRow[]> {
  return (
    await db.query(`select ${TOKEN_COLUMNS} from scim_tokens where revoked_at is null order by lower(name)`)
  ).rows.map((row) => dated<ScimTokenRow>(row, TOKEN_DATES));
}

export async function touchScimToken(db: Querier, id: string, at: Date): Promise<void> {
  await db.query('update scim_tokens set last_used_at = $2 where id = $1', [id, at]);
}

/** `true` only for the call that revoked a live token. */
export async function revokeScimToken(db: Querier, id: string, at: Date): Promise<boolean> {
  const result = await db.query('update scim_tokens set revoked_at = $2 where id = $1 and revoked_at is null', [
    id,
    at,
  ]);
  return (result.rowCount ?? 0) > 0;
}

// ---- users ---------------------------------------------------------------------------------

export async function scimUserOf(
  db: Querier,
  userId: string,
): Promise<{ readonly externalId: string | null } | undefined> {
  return (
    await db.query<{ externalId: string | null }>(
      'select external_id as "externalId" from scim_users where user_id = $1',
      [userId],
    )
  ).rows[0];
}

export async function upsertScimUser(db: Querier, userId: string, externalId: string | null, at: Date): Promise<void> {
  await db.query(
    `insert into scim_users (user_id, external_id, created_at, updated_at) values ($1, $2, $3, $3)
     on conflict (user_id) do update set external_id = excluded.external_id, updated_at = excluded.updated_at`,
    [userId, externalId, at],
  );
}

// ---- groups --------------------------------------------------------------------------------

export async function insertScimGroup(
  db: Querier,
  input: { readonly id: string; readonly displayName: string; readonly externalId: string | null; readonly at: Date },
): Promise<ScimGroupRow> {
  await db.query(
    'insert into scim_groups (id, display_name, external_id, created_at, updated_at) values ($1, $2, $3, $4, $4)',
    [input.id, input.displayName, input.externalId, input.at],
  );
  return (await scimGroupById(db, input.id))!;
}

export async function scimGroupById(db: Querier, id: string): Promise<ScimGroupRow | undefined> {
  const row = (await db.query(`select ${GROUP_COLUMNS} from scim_groups g where g.id = $1`, [id])).rows[0];
  return row === undefined ? undefined : dated<ScimGroupRow>(row, GROUP_DATES);
}

/** Every group with its member count and linked team's name, by name. */
export async function listScimGroups(db: Querier): Promise<readonly ScimGroupListRow[]> {
  return (
    await db.query(
      `select ${GROUP_COLUMNS}, t.name as "teamName",
         (select count(*)::int from scim_group_members m where m.group_id = g.id) as "memberCount"
       from scim_groups g left join teams t on t.id = g.team_id
       order by lower(g.display_name)`,
    )
  ).rows.map((row) => dated<ScimGroupListRow>(row, GROUP_DATES));
}

export async function groupsOfTeam(db: Querier, teamId: string): Promise<readonly ScimGroupRow[]> {
  return (
    await db.query(`select ${GROUP_COLUMNS} from scim_groups g where g.team_id = $1 order by g.id`, [teamId])
  ).rows.map((row) => dated<ScimGroupRow>(row, GROUP_DATES));
}

export async function updateScimGroup(
  db: Querier,
  id: string,
  input: { readonly displayName?: string; readonly externalId?: string | null },
  at: Date,
): Promise<void> {
  await db.query(
    `update scim_groups set
       display_name = case when $2::boolean then $3 else display_name end,
       external_id = case when $4::boolean then $5 else external_id end,
       updated_at = $6
     where id = $1`,
    [
      id,
      input.displayName !== undefined,
      input.displayName ?? null,
      input.externalId !== undefined,
      input.externalId ?? null,
      at,
    ],
  );
}

export async function setGroupTeam(db: Querier, id: string, teamId: string | null, at: Date): Promise<void> {
  await db.query('update scim_groups set team_id = $2, updated_at = $3 where id = $1', [id, teamId, at]);
}

export async function deleteScimGroup(db: Querier, id: string): Promise<void> {
  await db.query('delete from scim_groups where id = $1', [id]);
}

/** Member ids, sorted. */
export async function groupMemberIds(db: Querier, groupId: string): Promise<readonly string[]> {
  return (
    await db.query<{ userId: string }>(
      'select user_id as "userId" from scim_group_members where group_id = $1 order by user_id',
      [groupId],
    )
  ).rows.map((row) => row.userId);
}

/** The ids that were not members before, sorted. */
export async function addGroupMembers(db: Querier, groupId: string, userIds: readonly string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  return (
    await db.query<{ userId: string }>(
      `insert into scim_group_members (group_id, user_id) select $1, unnest($2::text[])
       on conflict do nothing returning user_id as "userId"`,
      [groupId, [...userIds]],
    )
  ).rows
    .map((row) => row.userId)
    .sort();
}

/** The ids that were members, sorted. */
export async function removeGroupMembers(db: Querier, groupId: string, userIds: readonly string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  return (
    await db.query<{ userId: string }>(
      'delete from scim_group_members where group_id = $1 and user_id = any($2) returning user_id as "userId"',
      [groupId, [...userIds]],
    )
  ).rows
    .map((row) => row.userId)
    .sort();
}

// ---- provisioned memberships ---------------------------------------------------------------

interface ProvisionedKey {
  readonly teamId: string;
  readonly userId: string;
  readonly groupId: string;
}

export async function insertProvisioned(db: Querier, key: ProvisionedKey): Promise<void> {
  await db.query(
    'insert into provisioned_memberships (team_id, user_id, group_id) values ($1, $2, $3) on conflict do nothing',
    [key.teamId, key.userId, key.groupId],
  );
}

export async function deleteProvisioned(db: Querier, key: ProvisionedKey): Promise<void> {
  await db.query('delete from provisioned_memberships where team_id = $1 and user_id = $2 and group_id = $3', [
    key.teamId,
    key.userId,
    key.groupId,
  ]);
}

export async function countProvisioned(db: Querier, teamId: string, userId: string): Promise<number> {
  const row = (
    await db.query<{ count: number }>(
      'select count(*)::int as count from provisioned_memberships where team_id = $1 and user_id = $2',
      [teamId, userId],
    )
  ).rows[0];
  return Number(row?.count ?? 0);
}

// ---- SAML identities and flows (saml-scim spec §3.2, §3.3) -----------------------------------

export interface SamlFlowRow {
  readonly id: string;
  readonly requestId: string;
  readonly codeChallenge: string;
  readonly loopbackPort: number;
  readonly deviceName: string;
  readonly relayState: string;
  readonly grantHash: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly userId: string | null;
}

const FLOW_DATES = ['createdAt', 'expiresAt'];
const SAML_FLOW_COLUMNS =
  'id, request_id as "requestId", code_challenge as "codeChallenge", loopback_port as "loopbackPort", device_name as "deviceName", relay_state as "relayState", grant_hash as "grantHash", created_at as "createdAt", expires_at as "expiresAt", user_id as "userId"';

export async function samlIdentityOf(
  db: Querier,
  entityId: string,
  nameId: string,
): Promise<{ readonly userId: string } | undefined> {
  return (
    await db.query<{ userId: string }>(
      'select user_id as "userId" from saml_identities where entity_id = $1 and name_id = $2',
      [entityId, nameId],
    )
  ).rows[0];
}

export async function insertSamlIdentity(
  db: Querier,
  input: { readonly entityId: string; readonly nameId: string; readonly userId: string; readonly at: Date },
): Promise<void> {
  await db.query('insert into saml_identities (entity_id, name_id, user_id, linked_at) values ($1, $2, $3, $4)', [
    input.entityId,
    input.nameId,
    input.userId,
    input.at,
  ]);
}

export async function insertSamlFlow(
  db: Querier,
  input: {
    readonly id: string;
    readonly requestId: string;
    readonly codeChallenge: string;
    readonly loopbackPort: number;
    readonly deviceName: string;
    readonly relayState: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  },
): Promise<void> {
  await db.query(
    'insert into saml_flows (id, request_id, code_challenge, loopback_port, device_name, relay_state, created_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [
      input.id,
      input.requestId,
      input.codeChallenge,
      input.loopbackPort,
      input.deviceName,
      input.relayState,
      input.createdAt,
      input.expiresAt,
    ],
  );
}

export async function samlFlowById(db: Querier, id: string): Promise<SamlFlowRow | undefined> {
  return dated<SamlFlowRow>(
    (await db.query(`select ${SAML_FLOW_COLUMNS} from saml_flows where id = $1`, [id])).rows[0],
    FLOW_DATES,
  );
}

export async function samlFlowByRelayState(db: Querier, relayState: string): Promise<SamlFlowRow | undefined> {
  return dated<SamlFlowRow>(
    (await db.query(`select ${SAML_FLOW_COLUMNS} from saml_flows where relay_state = $1`, [relayState])).rows[0],
    FLOW_DATES,
  );
}

/**
 * Records the IdP's answer, once: `true` only for the request whose update found the flow ungranted, so
 * the same response posted twice grants nothing the second time (spec §6.1, replay).
 */
export async function grantSamlFlow(db: Querier, id: string, grantHash: string, userId: string): Promise<boolean> {
  const result = await db.query(
    'update saml_flows set grant_hash = $2, user_id = $3 where id = $1 and grant_hash is null',
    [id, grantHash, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteSamlFlow(db: Querier, id: string): Promise<void> {
  await db.query('delete from saml_flows where id = $1', [id]);
}

/** Redeems a granted flow: `true` only for the one request whose `DELETE` removed the row. */
export async function claimGrantedSamlFlow(db: Querier, id: string, grantHash: string): Promise<boolean> {
  const result = await db.query('delete from saml_flows where id = $1 and grant_hash = $2', [id, grantHash]);
  return (result.rowCount ?? 0) > 0;
}

export async function deleteExpiredSamlFlows(db: Querier, now: Date): Promise<number> {
  return (await db.query('delete from saml_flows where expires_at < $1', [now])).rowCount ?? 0;
}

// ---- users as SCIM resources -----------------------------------------------------------------

/** A Wirebench user with what SCIM adds: its `externalId` and when SCIM last wrote it. */
export interface ScimUserView {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly serverAdmin: boolean;
  readonly createdAt: string;
  readonly disabledAt: string | null;
  readonly externalId: string | null;
  readonly updatedAt: string | null;
}

const VIEW_COLUMNS =
  'u.id, u.email, u.display_name as "displayName", u.server_admin as "serverAdmin", u.created_at as "createdAt", ' +
  'u.disabled_at as "disabledAt", s.external_id as "externalId", s.updated_at as "updatedAt"';
const VIEW_FROM = 'users u left join scim_users s on s.user_id = u.id';
const VIEW_DATES = ['createdAt', 'disabledAt', 'updatedAt'];

export type ScimUserFilter =
  | { readonly attribute: 'userName' | 'emails.value'; readonly value: string }
  | { readonly attribute: 'externalId'; readonly value: string };

export async function scimUserView(db: Querier, id: string): Promise<ScimUserView | undefined> {
  const row = (await db.query(`select ${VIEW_COLUMNS} from ${VIEW_FROM} where u.id = $1`, [id])).rows[0];
  return row === undefined ? undefined : dated<ScimUserView>(row, VIEW_DATES);
}

/** One page of users in creation order, and how many match in all. `offset` is zero-based. */
export async function listScimUserViews(
  db: Querier,
  filter: ScimUserFilter | undefined,
  offset: number,
  limit: number,
): Promise<{ readonly total: number; readonly users: readonly ScimUserView[] }> {
  const where =
    filter === undefined
      ? { sql: '', params: [] as unknown[] }
      : filter.attribute === 'externalId'
        ? { sql: 'where s.external_id = $1', params: [filter.value] }
        : { sql: 'where u.email_lower = lower($1)', params: [filter.value.trim()] };
  const total = Number(
    (await db.query<{ n: string }>(`select count(*) as n from ${VIEW_FROM} ${where.sql}`, where.params)).rows[0]!.n,
  );
  const n = where.params.length;
  const users = (
    await db.query(
      `select ${VIEW_COLUMNS} from ${VIEW_FROM} ${where.sql} order by u.created_at, u.id offset $${String(n + 1)} limit $${String(n + 2)}`,
      [...where.params, offset, limit],
    )
  ).rows.map((row) => dated<ScimUserView>(row, VIEW_DATES));
  return { total, users };
}

/** The email (both columns) of `id`. The caller has checked no other user holds it. */
export async function setUserEmail(db: Querier, id: string, email: string): Promise<void> {
  await db.query('update users set email = $2, email_lower = $3 where id = $1', [
    id,
    email.trim(),
    email.trim().toLowerCase(),
  ]);
}

export async function setUserDisplayName(db: Querier, id: string, displayName: string): Promise<void> {
  await db.query('update users set display_name = $2 where id = $1', [id, displayName]);
}

/** Enabled server admins other than `exceptId`: SCIM must never disable the last one (§3.5). */
export async function otherEnabledServerAdmins(db: Querier, exceptId: string): Promise<number> {
  return Number(
    (
      await db.query<{ n: string }>(
        'select count(*) as n from users where server_admin and disabled_at is null and id <> $1',
        [exceptId],
      )
    ).rows[0]!.n,
  );
}

// ---- groups as SCIM resources ----------------------------------------------------------------

export type ScimGroupFilter = { readonly attribute: 'displayName' | 'externalId'; readonly value: string };

/** One page of groups by name, and how many match in all. `offset` is zero-based. */
export async function listScimGroupPage(
  db: Querier,
  filter: ScimGroupFilter | undefined,
  offset: number,
  limit: number,
): Promise<{ readonly total: number; readonly groups: readonly ScimGroupRow[] }> {
  const where =
    filter === undefined
      ? { sql: '', params: [] as unknown[] }
      : filter.attribute === 'externalId'
        ? { sql: 'where g.external_id = $1', params: [filter.value] }
        : { sql: 'where lower(g.display_name) = lower($1)', params: [filter.value] };
  const total = Number(
    (await db.query<{ n: string }>(`select count(*) as n from scim_groups g ${where.sql}`, where.params)).rows[0]!.n,
  );
  const n = where.params.length;
  const groups = (
    await db.query(
      `select ${GROUP_COLUMNS} from scim_groups g ${where.sql} order by lower(g.display_name), g.id offset $${String(n + 1)} limit $${String(n + 2)}`,
      [...where.params, offset, limit],
    )
  ).rows.map((row) => dated<ScimGroupRow>(row, GROUP_DATES));
  return { total, groups };
}

/** Members of each of `groupIds` with their email, for the `members[].display` a SCIM group carries. */
export async function groupMembersWithEmail(
  db: Querier,
  groupIds: readonly string[],
): Promise<ReadonlyMap<string, readonly { readonly id: string; readonly email: string }[]>> {
  const out = new Map<string, { id: string; email: string }[]>(groupIds.map((id) => [id, []]));
  if (groupIds.length === 0) return out;
  const rows = (
    await db.query<{ groupId: string; id: string; email: string }>(
      `select m.group_id as "groupId", u.id, u.email from scim_group_members m join users u on u.id = m.user_id
       where m.group_id = any($1) order by u.email_lower`,
      [[...groupIds]],
    )
  ).rows;
  for (const row of rows) out.get(row.groupId)!.push({ id: row.id, email: row.email });
  return out;
}

/** Which of `ids` are not users, sorted. */
export async function unknownUserIds(db: Querier, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const known = new Set(
    (await db.query<{ id: string }>('select id from users where id = any($1)', [[...ids]])).rows.map((row) => row.id),
  );
  return ids.filter((id) => !known.has(id)).sort();
}
