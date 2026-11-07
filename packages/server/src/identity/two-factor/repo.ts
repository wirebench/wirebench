/**
 * Every SQL statement of two-step sign-in (spec §7), over a `TenantQuerier` like `identity/repo.ts`, kept apart so the
 * two files change independently. Timestamps leave as ISO-8601 strings; `bigint` columns are read as `float8`, which
 * holds every TOTP step and WebAuthn counter exactly.
 */
import type { TenantQuerier } from '../../tenancy/tenant-db.js';

type Raw = Record<string, unknown>;

const iso = (value: unknown): string | null =>
  value === null || value === undefined ? null : new Date(value as string | number | Date).toISOString();

function dated<T>(row: Raw, keys: readonly string[]): T {
  const out: Raw = { ...row };
  for (const key of keys) if (key in out) out[key] = iso(out[key]);
  return out as T;
}

// --- authenticator ---------------------------------------------------------------------------------------------

export interface TotpRow {
  readonly userId: string;
  readonly sealedSecret: Buffer;
  readonly confirmedAt: string | null;
  readonly lastStep: number;
  readonly createdAt: string;
}

const TOTP_COLUMNS =
  'user_id as "userId", sealed_secret as "sealedSecret", confirmed_at as "confirmedAt", last_step::float8 as "lastStep", created_at as "createdAt"';

export async function totpOf(db: TenantQuerier, userId: string): Promise<TotpRow | undefined> {
  const row = (await db.query<Raw>(`select ${TOTP_COLUMNS} from identity_totp where user_id = $1`, [userId])).rows[0];
  return row === undefined ? undefined : dated<TotpRow>(row, ['confirmedAt', 'createdAt']);
}

/**
 * Stores a new pending secret, replacing an earlier pending one; `false` when the person already has a confirmed
 * authenticator, which is left as it is (one a person, spec §2).
 */
export async function upsertPendingTotp(db: TenantQuerier, userId: string, sealed: Buffer, at: Date): Promise<boolean> {
  const result = await db.query(
    `insert into identity_totp (user_id, sealed_secret, created_at) values ($1, $2, $3)
       on conflict (tenant_id, user_id) do update
         set sealed_secret = excluded.sealed_secret, created_at = excluded.created_at, last_step = 0
         where identity_totp.confirmed_at is null`,
    [userId, sealed, at],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Confirms the pending secret with the step its first code was for; `false` when there was none pending. */
export async function confirmTotp(db: TenantQuerier, userId: string, step: number, at: Date): Promise<boolean> {
  const result = await db.query(
    'update identity_totp set confirmed_at = $3, last_step = $2 where user_id = $1 and confirmed_at is null',
    [userId, step, at],
  );
  return (result.rowCount ?? 0) === 1;
}

/** The replay guard (spec §3.4): moves `last_step` forward only, so of two racing uses of one code one wins. */
export async function setTotpLastStep(db: TenantQuerier, userId: string, step: number): Promise<boolean> {
  const result = await db.query(
    'update identity_totp set last_step = $2 where user_id = $1 and confirmed_at is not null and last_step < $2',
    [userId, step],
  );
  return (result.rowCount ?? 0) === 1;
}

export async function deleteTotp(db: TenantQuerier, userId: string): Promise<boolean> {
  return ((await db.query('delete from identity_totp where user_id = $1', [userId])).rowCount ?? 0) > 0;
}

/** Pending secrets nobody confirmed in time (spec §5.1: ten minutes). */
export async function deleteStalePendingTotp(db: TenantQuerier, before: Date): Promise<number> {
  return (
    (await db.query('delete from identity_totp where confirmed_at is null and created_at < $1', [before])).rowCount ?? 0
  );
}

// --- passkeys --------------------------------------------------------------------------------------------------

export interface PasskeyRow {
  readonly id: string;
  readonly userId: string;
  readonly credentialId: Buffer;
  readonly publicKey: Buffer;
  readonly counter: number;
  readonly transports: readonly string[];
  readonly name: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

const PASSKEY_COLUMNS =
  'id, user_id as "userId", credential_id as "credentialId", public_key as "publicKey", counter::float8 as counter, transports, name, created_at as "createdAt", last_used_at as "lastUsedAt"';
const PASSKEY_DATES = ['createdAt', 'lastUsedAt'];

export async function passkeysOf(db: TenantQuerier, userId: string): Promise<readonly PasskeyRow[]> {
  const rows = await db.query<Raw>(
    `select ${PASSKEY_COLUMNS} from identity_passkeys where user_id = $1 order by created_at, id`,
    [userId],
  );
  return rows.rows.map((row) => dated<PasskeyRow>(row, PASSKEY_DATES));
}

export async function passkeyByCredentialId(db: TenantQuerier, credentialId: Buffer): Promise<PasskeyRow | undefined> {
  const row = (
    await db.query<Raw>(`select ${PASSKEY_COLUMNS} from identity_passkeys where credential_id = $1`, [credentialId])
  ).rows[0];
  return row === undefined ? undefined : dated<PasskeyRow>(row, PASSKEY_DATES);
}

export async function insertPasskey(
  db: TenantQuerier,
  input: {
    readonly id: string;
    readonly userId: string;
    readonly credentialId: Buffer;
    readonly publicKey: Buffer;
    readonly counter: number;
    readonly transports: readonly string[];
    readonly name: string;
    readonly at: Date;
  },
): Promise<void> {
  await db.query(
    'insert into identity_passkeys (id, user_id, credential_id, public_key, counter, transports, name, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [
      input.id,
      input.userId,
      input.credentialId,
      input.publicKey,
      input.counter,
      input.transports,
      input.name,
      input.at,
    ],
  );
}

export async function renamePasskey(db: TenantQuerier, userId: string, id: string, name: string): Promise<boolean> {
  const result = await db.query('update identity_passkeys set name = $3 where user_id = $1 and id = $2', [
    userId,
    id,
    name,
  ]);
  return (result.rowCount ?? 0) === 1;
}

export async function deletePasskey(db: TenantQuerier, userId: string, id: string): Promise<boolean> {
  const result = await db.query('delete from identity_passkeys where user_id = $1 and id = $2', [userId, id]);
  return (result.rowCount ?? 0) === 1;
}

/**
 * Records a use with the authenticator's new counter. Conditional on the counter it was read with, so two racing
 * uses of one assertion cannot both pass (spec §3.5).
 */
export async function usePasskey(
  db: TenantQuerier,
  id: string,
  read: number,
  counter: number,
  at: Date,
): Promise<boolean> {
  const result = await db.query(
    'update identity_passkeys set counter = $3, last_used_at = $4 where id = $1 and counter = $2',
    [id, read, counter, at],
  );
  return (result.rowCount ?? 0) === 1;
}

// --- recovery codes --------------------------------------------------------------------------------------------

/** The person's new set, the old one gone (spec §1 decision 2). */
export async function replaceRecoveryCodes(
  db: TenantQuerier,
  userId: string,
  hashes: readonly string[],
  at: Date,
): Promise<void> {
  await db.query('delete from identity_recovery_codes where user_id = $1', [userId]);
  await db.query(
    'insert into identity_recovery_codes (user_id, code_hash, created_at) select $1, unnest($2::text[]), $3',
    [userId, hashes, at],
  );
}

/** Marks the code used; `false` when it is not one of the person's unused codes. One use, even under a race. */
export async function useRecoveryCode(db: TenantQuerier, userId: string, hash: string, at: Date): Promise<boolean> {
  const result = await db.query(
    'update identity_recovery_codes set used_at = $3 where user_id = $1 and code_hash = $2 and used_at is null',
    [userId, hash, at],
  );
  return (result.rowCount ?? 0) === 1;
}

export async function recoveryCodesLeft(db: TenantQuerier, userId: string): Promise<number> {
  const rows = await db.query<{ left: number }>(
    'select count(*)::int as left from identity_recovery_codes where user_id = $1 and used_at is null',
    [userId],
  );
  return rows.rows[0]?.left ?? 0;
}

export async function deleteRecoveryCodes(db: TenantQuerier, userId: string): Promise<void> {
  await db.query('delete from identity_recovery_codes where user_id = $1', [userId]);
}

// --- the person's methods --------------------------------------------------------------------------------------

export interface MethodsRow {
  readonly totp: TotpRow | undefined;
  readonly passkeys: readonly PasskeyRow[];
  readonly recoveryCodesLeft: number;
}

export async function methodsOf(db: TenantQuerier, userId: string): Promise<MethodsRow> {
  return {
    totp: await totpOf(db, userId),
    passkeys: await passkeysOf(db, userId),
    recoveryCodesLeft: await recoveryCodesLeft(db, userId),
  };
}

/** Whether two-step sign-in is on: a confirmed authenticator or a passkey (spec §2). */
export const hasSecondFactor = (methods: MethodsRow): boolean =>
  methods.totp?.confirmedAt != null || methods.passkeys.length > 0;

/** Of `userIds`, those with two-step sign-in on (plan ruling 8). */
export async function twoFactorUsers(db: TenantQuerier, userIds: readonly string[]): Promise<ReadonlySet<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db.query<{ userId: string }>(
    `select user_id as "userId" from identity_totp where user_id = any($1::text[]) and confirmed_at is not null
     union
     select user_id from identity_passkeys where user_id = any($1::text[])`,
    [userIds],
  );
  return new Set(rows.rows.map((row) => row.userId));
}

/** Every method, code and challenge of the person: an admin reset (spec §7). */
export async function deleteTwoFactorOf(db: TenantQuerier, userId: string): Promise<void> {
  await db.query('delete from identity_totp where user_id = $1', [userId]);
  await db.query('delete from identity_passkeys where user_id = $1', [userId]);
  await db.query('delete from identity_recovery_codes where user_id = $1', [userId]);
  await db.query('delete from identity_two_factor_challenges where user_id = $1', [userId]);
}

// --- challenges ------------------------------------------------------------------------------------------------

export type ChallengePurpose = 'sign-in' | 'setup' | 'register';

export interface ChallengeRow {
  readonly id: string;
  readonly userId: string;
  readonly secretHash: string;
  readonly purpose: ChallengePurpose;
  readonly deviceName: string | null;
  readonly tokenKind: 'device' | 'browser' | null;
  readonly webauthnChallenge: string | null;
  readonly attempts: number;
  readonly flowId: string | null;
  readonly codeChallenge: string | null;
  readonly loopbackPort: number | null;
  readonly grantHash: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

const CHALLENGE_COLUMNS =
  'id, user_id as "userId", secret_hash as "secretHash", purpose, device_name as "deviceName", token_kind as "tokenKind", webauthn_challenge as "webauthnChallenge", attempts, flow_id as "flowId", code_challenge as "codeChallenge", loopback_port as "loopbackPort", grant_hash as "grantHash", created_at as "createdAt", expires_at as "expiresAt"';
const CHALLENGE_DATES = ['createdAt', 'expiresAt'];

const challengeOf = (row: Raw | undefined): ChallengeRow | undefined =>
  row === undefined ? undefined : dated<ChallengeRow>(row, CHALLENGE_DATES);

export async function insertChallenge(
  db: TenantQuerier,
  input: {
    readonly id: string;
    readonly userId: string;
    readonly secretHash: string;
    readonly purpose: ChallengePurpose;
    readonly deviceName: string | null;
    readonly tokenKind: 'device' | 'browser' | null;
    readonly webauthnChallenge?: string | null;
    readonly at: Date;
    readonly expiresAt: Date;
  },
): Promise<void> {
  await db.query(
    `insert into identity_two_factor_challenges
       (id, user_id, secret_hash, purpose, device_name, token_kind, webauthn_challenge, created_at, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.id,
      input.userId,
      input.secretHash,
      input.purpose,
      input.deviceName,
      input.tokenKind,
      input.webauthnChallenge ?? null,
      input.at,
      input.expiresAt,
    ],
  );
}

/** The live challenge with this secret's hash; an expired one is not found. */
export async function challengeBySecretHash(
  db: TenantQuerier,
  secretHash: string,
  now: Date,
): Promise<ChallengeRow | undefined> {
  return challengeOf(
    (
      await db.query<Raw>(
        `select ${CHALLENGE_COLUMNS} from identity_two_factor_challenges where secret_hash = $1 and expires_at > $2`,
        [secretHash, now],
      )
    ).rows[0],
  );
}

export async function challengeById(db: TenantQuerier, id: string, now: Date): Promise<ChallengeRow | undefined> {
  return challengeOf(
    (
      await db.query<Raw>(
        `select ${CHALLENGE_COLUMNS} from identity_two_factor_challenges where id = $1 and expires_at > $2`,
        [id, now],
      )
    ).rows[0],
  );
}

export async function challengeByFlow(db: TenantQuerier, flowId: string, now: Date): Promise<ChallengeRow | undefined> {
  return challengeOf(
    (
      await db.query<Raw>(
        `select ${CHALLENGE_COLUMNS} from identity_two_factor_challenges where flow_id = $1 and expires_at > $2`,
        [flowId, now],
      )
    ).rows[0],
  );
}

/** One more wrong answer; the count after it. */
export async function bumpChallengeAttempts(db: TenantQuerier, id: string): Promise<number> {
  const rows = await db.query<{ attempts: number }>(
    'update identity_two_factor_challenges set attempts = attempts + 1 where id = $1 returning attempts',
    [id],
  );
  return rows.rows[0]?.attempts ?? Number.POSITIVE_INFINITY;
}

/** Ends the challenge; `false` when it was already ended, so only one of two racing finishes wins (spec §3.2). */
export async function takeChallenge(db: TenantQuerier, id: string): Promise<boolean> {
  return ((await db.query('delete from identity_two_factor_challenges where id = $1', [id])).rowCount ?? 0) === 1;
}

/** The WebAuthn challenge a passkey step was asked with; `null` drops it, so each one is answered once. */
export async function setChallengeWebauthn(db: TenantQuerier, id: string, challenge: string | null): Promise<void> {
  await db.query('update identity_two_factor_challenges set webauthn_challenge = $2 where id = $1', [id, challenge]);
}

/**
 * A passkey registration's WebAuthn challenge (spec §5.2), one live per person: a new one replaces the last. Its secret
 * is never answered, since the signed-in person finishes it by session.
 */
export async function replaceRegisterChallenge(
  db: TenantQuerier,
  input: {
    readonly id: string;
    readonly userId: string;
    readonly secretHash: string;
    readonly webauthnChallenge: string;
    readonly at: Date;
    readonly expiresAt: Date;
  },
): Promise<void> {
  await db.query("delete from identity_two_factor_challenges where user_id = $1 and purpose = 'register'", [
    input.userId,
  ]);
  await insertChallenge(db, { ...input, purpose: 'register', deviceName: null, tokenKind: null });
}

/** Takes the person's live registration challenge, answering its WebAuthn challenge; `undefined` when none. */
export async function takeRegisterChallenge(db: TenantQuerier, userId: string, now: Date): Promise<string | undefined> {
  const rows = await db.query<{ challenge: string | null }>(
    `delete from identity_two_factor_challenges where user_id = $1 and purpose = 'register' and expires_at > $2
     returning webauthn_challenge as challenge`,
    [userId, now],
  );
  return rows.rows[0]?.challenge ?? undefined;
}

/** Starts the desktop's passkey hand-off on the challenge (plan ruling 4); `false` when one was started already. */
export async function startChallengeFlow(
  db: TenantQuerier,
  id: string,
  flow: { readonly flowId: string; readonly codeChallenge: string; readonly loopbackPort: number },
): Promise<boolean> {
  const result = await db.query(
    `update identity_two_factor_challenges set flow_id = $2, code_challenge = $3, loopback_port = $4
      where id = $1 and flow_id is null`,
    [id, flow.flowId, flow.codeChallenge, flow.loopbackPort],
  );
  return (result.rowCount ?? 0) === 1;
}

/** The hash of the grant the browser hands the loopback, once its passkey was accepted. */
export async function setChallengeGrant(db: TenantQuerier, id: string, grantHash: string): Promise<void> {
  await db.query('update identity_two_factor_challenges set grant_hash = $2 where id = $1', [id, grantHash]);
}

export async function deleteExpiredChallenges(db: TenantQuerier, now: Date): Promise<number> {
  return (await db.query('delete from identity_two_factor_challenges where expires_at < $1', [now])).rowCount ?? 0;
}
