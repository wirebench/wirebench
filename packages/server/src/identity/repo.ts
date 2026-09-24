/**
 * Every SQL statement of the identity module (spec §4.2), one function each over a `Querier` so
 * a route can run several inside one `db.transaction`. Columns come back aliased to the
 * camelCase the module uses; `timestamptz` values arrive from pg as `Date` and leave here as
 * ISO-8601 strings, the only date shape the wire schemas know.
 */
import type { Querier } from '../context.js';

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly emailLower: string;
  readonly displayName: string;
  readonly serverAdmin: boolean;
  readonly createdAt: string;
  readonly disabledAt: string | null;
}
export interface CredentialRow {
  readonly userId: string;
  readonly passwordHash: string;
  readonly updatedAt: string;
}
export interface InvitationRow {
  readonly id: string;
  readonly kind: 'invite' | 'reset';
  readonly email: string;
  readonly emailLower: string;
  readonly userId: string | null;
  readonly secretHash: string;
  readonly serverAdmin: boolean;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
}
export interface TokenRow {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly deviceName: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly revokedAt: string | null;
}
export interface FlowRow {
  readonly id: string;
  readonly codeChallenge: string;
  readonly loopbackPort: number;
  readonly deviceName: string;
  readonly state: string;
  readonly nonce: string;
  readonly grantHash: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly userId: string | null;
}

type Raw = Record<string, unknown>;

const isoOrNull = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value as string | number).toISOString();
};

/** Converts the named timestamp columns of `row` to ISO strings; everything else is already the right type. */
function withDates<T>(row: Raw, keys: readonly string[]): T {
  const out: Raw = { ...row };
  for (const key of keys) if (key in out) out[key] = isoOrNull(out[key]);
  return out as T;
}

const USER_COLUMNS =
  'id, email, email_lower as "emailLower", display_name as "displayName", server_admin as "serverAdmin", created_at as "createdAt", disabled_at as "disabledAt"';
const USER_DATES = ['createdAt', 'disabledAt'];
const INVITATION_COLUMNS =
  'id, kind, email, email_lower as "emailLower", user_id as "userId", secret_hash as "secretHash", server_admin as "serverAdmin", created_by as "createdBy", created_at as "createdAt", expires_at as "expiresAt", accepted_at as "acceptedAt", revoked_at as "revokedAt"';
const INVITATION_DATES = ['createdAt', 'expiresAt', 'acceptedAt', 'revokedAt'];
const TOKEN_COLUMNS =
  'id, user_id as "userId", token_hash as "tokenHash", device_name as "deviceName", created_at as "createdAt", last_used_at as "lastUsedAt", revoked_at as "revokedAt"';
const TOKEN_DATES = ['createdAt', 'lastUsedAt', 'revokedAt'];
const FLOW_COLUMNS =
  'id, code_challenge as "codeChallenge", loopback_port as "loopbackPort", device_name as "deviceName", state, nonce, grant_hash as "grantHash", created_at as "createdAt", expires_at as "expiresAt", user_id as "userId"';
const FLOW_DATES = ['createdAt', 'expiresAt'];

const first = <T>(rows: readonly Raw[], dates: readonly string[]): T | undefined =>
  rows[0] === undefined ? undefined : withDates<T>(rows[0], dates);

// ---- users -------------------------------------------------------------------------------

export async function findUserByEmail(db: Querier, emailLower: string): Promise<UserRow | undefined> {
  return first(
    (await db.query(`select ${USER_COLUMNS} from users where email_lower = $1`, [emailLower])).rows,
    USER_DATES,
  );
}

export async function findUserById(db: Querier, id: string): Promise<UserRow | undefined> {
  return first((await db.query(`select ${USER_COLUMNS} from users where id = $1`, [id])).rows, USER_DATES);
}

export async function insertUser(
  db: Querier,
  input: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly serverAdmin: boolean;
    readonly at: Date;
  },
): Promise<UserRow> {
  const rows = (
    await db.query(
      `insert into users (id, email, email_lower, display_name, server_admin, created_at) values ($1, $2, $3, $4, $5, $6) returning ${USER_COLUMNS}`,
      [input.id, input.email.trim(), input.email.trim().toLowerCase(), input.displayName, input.serverAdmin, input.at],
    )
  ).rows;
  return withDates<UserRow>(rows[0]!, USER_DATES);
}

export async function listUsers(db: Querier): Promise<readonly UserRow[]> {
  return (await db.query(`select ${USER_COLUMNS} from users order by email_lower`)).rows.map((row) =>
    withDates<UserRow>(row, USER_DATES),
  );
}

export async function setServerAdmin(db: Querier, id: string, serverAdmin: boolean): Promise<void> {
  await db.query('update users set server_admin = $2 where id = $1', [id, serverAdmin]);
}

/** `at: null` re-enables. */
export async function setDisabled(db: Querier, id: string, at: Date | null): Promise<void> {
  await db.query('update users set disabled_at = $2 where id = $1', [id, at]);
}

// ---- credentials and OIDC identities -------------------------------------------------------

export async function credentialOf(db: Querier, userId: string): Promise<CredentialRow | undefined> {
  return first(
    (
      await db.query(
        'select user_id as "userId", password_hash as "passwordHash", updated_at as "updatedAt" from local_credentials where user_id = $1',
        [userId],
      )
    ).rows,
    ['updatedAt'],
  );
}

export async function upsertCredential(db: Querier, userId: string, passwordHash: string, at: Date): Promise<void> {
  await db.query(
    'insert into local_credentials (user_id, password_hash, updated_at) values ($1, $2, $3) on conflict (user_id) do update set password_hash = excluded.password_hash, updated_at = excluded.updated_at',
    [userId, passwordHash, at],
  );
}

export async function oidcIdentityOf(
  db: Querier,
  issuer: string,
  subject: string,
): Promise<{ readonly userId: string } | undefined> {
  const rows = (
    await db.query<{ userId: string }>(
      'select user_id as "userId" from oidc_identities where issuer = $1 and subject = $2',
      [issuer, subject],
    )
  ).rows;
  return rows[0];
}

export async function insertOidcIdentity(
  db: Querier,
  input: { readonly issuer: string; readonly subject: string; readonly userId: string; readonly at: Date },
): Promise<void> {
  await db.query('insert into oidc_identities (issuer, subject, user_id, linked_at) values ($1, $2, $3, $4)', [
    input.issuer,
    input.subject,
    input.userId,
    input.at,
  ]);
}

export interface SignInMethods {
  readonly local: boolean;
  readonly oidc: readonly { readonly issuer: string }[];
}

/** The methods each of `userIds` can sign in with; a user with neither is still in the map. */
export async function signInMethodsOf(
  db: Querier,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, SignInMethods>> {
  const result = new Map<string, { local: boolean; oidc: { issuer: string }[] }>(
    userIds.map((id) => [id, { local: false, oidc: [] }]),
  );
  if (userIds.length === 0) return result;
  for (const row of (
    await db.query<{ userId: string }>('select user_id as "userId" from local_credentials where user_id = any($1)', [
      userIds,
    ])
  ).rows) {
    result.get(row.userId)!.local = true;
  }
  for (const row of (
    await db.query<{ userId: string; issuer: string }>(
      'select user_id as "userId", issuer from oidc_identities where user_id = any($1) order by issuer',
      [userIds],
    )
  ).rows) {
    result.get(row.userId)!.oidc.push({ issuer: row.issuer });
  }
  return result;
}

// ---- invitations ---------------------------------------------------------------------------

export async function insertInvitation(
  db: Querier,
  input: {
    readonly id: string;
    readonly kind: 'invite' | 'reset';
    readonly email: string;
    readonly userId: string | null;
    readonly secretHash: string;
    readonly serverAdmin: boolean;
    readonly createdBy: string | null;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  },
): Promise<InvitationRow> {
  const rows = (
    await db.query(
      `insert into invitations (id, kind, email, email_lower, user_id, secret_hash, server_admin, created_by, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${INVITATION_COLUMNS}`,
      [
        input.id,
        input.kind,
        input.email.trim(),
        input.email.trim().toLowerCase(),
        input.userId,
        input.secretHash,
        input.serverAdmin,
        input.createdBy,
        input.createdAt,
        input.expiresAt,
      ],
    )
  ).rows;
  return withDates<InvitationRow>(rows[0]!, INVITATION_DATES);
}

/** The one open (unaccepted, unrevoked, unexpired) `invite` for an email, if any. */
export async function openInvitationByEmail(
  db: Querier,
  emailLower: string,
  now: Date,
): Promise<InvitationRow | undefined> {
  return first(
    (
      await db.query(
        `select ${INVITATION_COLUMNS} from invitations where kind = 'invite' and email_lower = $1 and accepted_at is null and revoked_at is null and expires_at > $2`,
        [emailLower, now],
      )
    ).rows,
    INVITATION_DATES,
  );
}

export async function invitationBySecretHash(db: Querier, secretHash: string): Promise<InvitationRow | undefined> {
  return first(
    (await db.query(`select ${INVITATION_COLUMNS} from invitations where secret_hash = $1`, [secretHash])).rows,
    INVITATION_DATES,
  );
}

export async function invitationById(db: Querier, id: string): Promise<InvitationRow | undefined> {
  return first(
    (await db.query(`select ${INVITATION_COLUMNS} from invitations where id = $1`, [id])).rows,
    INVITATION_DATES,
  );
}

export async function listInvitations(db: Querier): Promise<readonly InvitationRow[]> {
  return (
    await db.query(`select ${INVITATION_COLUMNS} from invitations where kind = 'invite' order by created_at desc`)
  ).rows.map((row) => withDates<InvitationRow>(row, INVITATION_DATES));
}

export async function acceptInvitation(db: Querier, id: string, at: Date): Promise<void> {
  await db.query('update invitations set accepted_at = $2 where id = $1', [id, at]);
}

export async function revokeInvitation(db: Querier, id: string, at: Date): Promise<void> {
  await db.query('update invitations set revoked_at = $2 where id = $1', [id, at]);
}

/** Closes every open reset for a user, so a new reset link is the only one that works. */
export async function revokeOpenResetsOf(db: Querier, userId: string, at: Date): Promise<void> {
  await db.query(
    "update invitations set revoked_at = $2 where kind = 'reset' and user_id = $1 and accepted_at is null and revoked_at is null",
    [userId, at],
  );
}

// ---- device tokens -------------------------------------------------------------------------

export async function insertToken(
  db: Querier,
  input: {
    readonly id: string;
    readonly userId: string;
    readonly tokenHash: string;
    readonly deviceName: string;
    readonly at: Date;
  },
): Promise<void> {
  await db.query(
    'insert into device_tokens (id, user_id, token_hash, device_name, created_at, last_used_at) values ($1, $2, $3, $4, $5, $5)',
    [input.id, input.userId, input.tokenHash, input.deviceName, input.at],
  );
}

/** The token row and its user in one round trip: what every authenticated request costs. */
export async function tokenByHash(
  db: Querier,
  tokenHash: string,
): Promise<{ readonly token: TokenRow; readonly user: UserRow } | undefined> {
  const rows = (
    await db.query(
      `select t.id, t.user_id as "userId", t.token_hash as "tokenHash", t.device_name as "deviceName", t.created_at as "createdAt", t.last_used_at as "lastUsedAt", t.revoked_at as "revokedAt",
              u.email as "u_email", u.email_lower as "u_emailLower", u.display_name as "u_displayName", u.server_admin as "u_serverAdmin", u.created_at as "u_createdAt", u.disabled_at as "u_disabledAt"
       from device_tokens t join users u on u.id = t.user_id where t.token_hash = $1`,
      [tokenHash],
    )
  ).rows;
  const row = rows[0];
  if (row === undefined) return undefined;
  const user: Raw = { id: row.userId };
  const token: Raw = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('u_')) user[key.slice(2)] = value;
    else token[key] = value;
  }
  return { token: withDates<TokenRow>(token, TOKEN_DATES), user: withDates<UserRow>(user, USER_DATES) };
}

export async function touchToken(db: Querier, id: string, at: Date): Promise<void> {
  await db.query('update device_tokens set last_used_at = $2 where id = $1', [id, at]);
}

export async function revokeToken(db: Querier, id: string, at: Date): Promise<void> {
  await db.query('update device_tokens set revoked_at = $2 where id = $1 and revoked_at is null', [id, at]);
}

/** Revokes every live token of a user except `exceptId` (the device doing the changing). */
export async function revokeTokensOfUser(db: Querier, userId: string, at: Date, exceptId?: string): Promise<void> {
  await db.query(
    'update device_tokens set revoked_at = $2 where user_id = $1 and revoked_at is null and ($3::text is null or id <> $3)',
    [userId, at, exceptId ?? null],
  );
}

export async function tokensOfUser(db: Querier, userId: string): Promise<readonly TokenRow[]> {
  return (
    await db.query(
      `select ${TOKEN_COLUMNS} from device_tokens where user_id = $1 and revoked_at is null order by created_at`,
      [userId],
    )
  ).rows.map((row) => withDates<TokenRow>(row, TOKEN_DATES));
}

export async function deleteToken(db: Querier, id: string): Promise<void> {
  await db.query('delete from device_tokens where id = $1', [id]);
}

/** The daily sweep (§3.5): expired by idleness, by age, or revoked more than a day ago. */
export async function deleteExpiredTokens(
  db: Querier,
  input: { readonly idleBefore: Date; readonly createdBefore: Date; readonly revokedBefore: Date },
): Promise<number> {
  const result = await db.query(
    'delete from device_tokens where last_used_at < $1 or created_at < $2 or revoked_at < $3',
    [input.idleBefore, input.createdBefore, input.revokedBefore],
  );
  return result.rowCount ?? 0;
}

// ---- OIDC flows ----------------------------------------------------------------------------

export async function insertFlow(
  db: Querier,
  input: {
    readonly id: string;
    readonly codeChallenge: string;
    readonly loopbackPort: number;
    readonly deviceName: string;
    readonly state: string;
    readonly nonce: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  },
): Promise<void> {
  await db.query(
    'insert into oidc_flows (id, code_challenge, loopback_port, device_name, state, nonce, created_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [
      input.id,
      input.codeChallenge,
      input.loopbackPort,
      input.deviceName,
      input.state,
      input.nonce,
      input.createdAt,
      input.expiresAt,
    ],
  );
}

export async function flowById(db: Querier, id: string): Promise<FlowRow | undefined> {
  return first((await db.query(`select ${FLOW_COLUMNS} from oidc_flows where id = $1`, [id])).rows, FLOW_DATES);
}

export async function flowByState(db: Querier, state: string): Promise<FlowRow | undefined> {
  return first((await db.query(`select ${FLOW_COLUMNS} from oidc_flows where state = $1`, [state])).rows, FLOW_DATES);
}

/** Records the IdP's answer: which user the flow resolved to and the one-time grant's hash. */
export async function grantFlow(db: Querier, id: string, grantHash: string, userId: string): Promise<void> {
  await db.query('update oidc_flows set grant_hash = $2, user_id = $3 where id = $1', [id, grantHash, userId]);
}

export async function deleteFlow(db: Querier, id: string): Promise<void> {
  await db.query('delete from oidc_flows where id = $1', [id]);
}

export async function deleteExpiredFlows(db: Querier, now: Date): Promise<number> {
  return (await db.query('delete from oidc_flows where expires_at < $1', [now])).rowCount ?? 0;
}
