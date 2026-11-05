/**
 * The `signups` table (hosted edition spec §22.3, §22.6): unscoped, since no tenant exists yet, and read and written
 * on the control role only. A row holds what the form asked for, the hash of the link's token (never the token), and
 * after the password step the first admin's scrypt hash, which completion moves into the tenant and clears.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ControlDb } from '../control-db.js';
import type { ControlTx } from '../slugs.js';

/** How long a signup's link works, and its slug is held (spec §22.6). */
export const SIGNUP_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long past its expiry a verified signup is kept: its person may have paid, and the webhook, not the token,
 * completes it (spec §22.6). Paddle retries a failed delivery for days, so a week covers the retries.
 */
export const VERIFIED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** The most seats the form offers (spec §22.6). */
export const SIGNUP_MAX_SEATS = 500;

export type SignupStatus = 'pending' | 'verified' | 'completed';

export interface SignupRow {
  readonly id: string;
  readonly emailLower: string;
  readonly name: string;
  readonly slug: string;
  readonly seats: number;
  readonly status: SignupStatus;
  readonly tenantId: string | null;
  readonly expiresAt: Date;
}

const COLUMNS = `id::text as id, email_lower as "emailLower", name, slug, seats, status, tenant_id::text as "tenantId",
  expires_at as "expiresAt"`;

/** A link's token: 32 random bytes, base64url. */
export function newSignupToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What is stored for a token: its SHA-256, base64url. A token is random, so no salt or stretching is needed. */
export function signupTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export interface NewSignup {
  readonly emailLower: string;
  readonly name: string;
  readonly slug: string;
  readonly seats: number;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

/**
 * Inserts a signup in `tx`, which holds the slug lock and found the slug free. The id is minted here
 * (`crypto.randomUUID()`): it is what a `created` event is matched by (spec §22.5), so it is never the browser's.
 */
export async function insertSignup(tx: ControlTx, input: NewSignup): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into signups (id, email_lower, name, slug, seats, token_hash, expires_at)
     values ($1::uuid, $2, $3, $4, $5, $6, $7::timestamptz)`,
    [id, input.emailLower, input.name, input.slug, input.seats, input.tokenHash, input.expiresAt],
  );
  return id;
}

/** The signup a token names, whatever its state; `undefined` for an unknown token. */
export async function signupByToken(db: ControlDb, token: string): Promise<SignupRow | undefined> {
  const rows = await db.query<SignupRow & Record<string, unknown>>(
    `select ${COLUMNS} from signups where token_hash = $1`,
    [signupTokenHash(token)],
  );
  return rows.rows[0];
}

/** Whether the token's password step is open: pending and not expired. */
export function passwordStepOpen(row: SignupRow | undefined, now: Date): row is SignupRow {
  return row !== undefined && row.status === 'pending' && row.expiresAt.getTime() > now.getTime();
}

/**
 * Stores the first admin's password hash and marks the signup `verified`: once, so the token is single-use for the
 * password step. `undefined` when the row was not pending or had expired.
 */
export async function verifySignup(
  db: ControlDb,
  token: string,
  passwordHash: string,
  now: Date,
): Promise<SignupRow | undefined> {
  const rows = await db.query<SignupRow & Record<string, unknown>>(
    `update signups set password_hash = $2, status = 'verified'
     where token_hash = $1 and status = 'pending' and expires_at > $3::timestamptz returning ${COLUMNS}`,
    [signupTokenHash(token), passwordHash, now],
  );
  return rows.rows[0];
}

/**
 * The control loop's step's statement (spec §22.15): removes the signups that will never complete, freeing their
 * slugs. A pending one at its expiry; a verified one {@link VERIFIED_GRACE_MS} later, since it may have paid. Never a
 * completed one, nor one whose tenant exists and waits for its first admin (a completion's second half).
 */
export async function deleteExpiredSignups(tx: ControlTx, now: Date): Promise<number> {
  const removed = await tx.query(
    `delete from signups
     where status <> 'completed' and not (tenant_id is not null and password_hash is not null)
       and expires_at <= case when status = 'pending' then $1::timestamptz else $2::timestamptz end`,
    [now, new Date(now.getTime() - VERIFIED_GRACE_MS)],
  );
  return removed.rowCount ?? 0;
}
