/**
 * Every SQL statement of the agent module (hosted edition spec §18.2), one function each over a `Querier`.
 * Codes and nonces are taken with `delete … returning`, so two requests racing for one can never both win.
 */
import type { Querier } from '../context.js';

export interface PairingRow {
  readonly id: string;
  readonly userId: string;
  readonly agentId: string;
  readonly publicKey: string;
  readonly port: number;
  readonly sshOptIn: boolean;
  readonly createdAt: string;
  readonly lastSeenAt: string;
}

type Raw = Record<string, unknown>;

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : new Date(value as string).toISOString();

const PAIRING_COLUMNS =
  'id, user_id as "userId", agent_id as "agentId", public_key as "publicKey", port, ssh_opt_in as "sshOptIn", created_at as "createdAt", last_seen_at as "lastSeenAt"';

const pairingOf = (row: Raw): PairingRow => ({
  ...(row as unknown as PairingRow),
  createdAt: iso(row['createdAt']),
  lastSeenAt: iso(row['lastSeenAt']),
});

// ---- codes -------------------------------------------------------------------------------

/** Stores the user's code, replacing any earlier one: a user has one live code. */
export async function replaceCode(
  db: Querier,
  input: { readonly userId: string; readonly codeHash: string; readonly expiresAt: Date },
): Promise<void> {
  await db.query(
    `insert into agent_pairing_codes (code_hash, user_id, expires_at) values ($1, $2, $3)
     on conflict (tenant_id, user_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at`,
    [input.codeHash, input.userId, input.expiresAt],
  );
}

/** Consumes a live code; the user it was for, or `undefined` for a wrong, used or expired one. */
export async function takeCode(db: Querier, codeHash: string, now: Date): Promise<string | undefined> {
  const rows = (
    await db.query<{ userId: string }>(
      'delete from agent_pairing_codes where code_hash = $1 and expires_at > $2 returning user_id as "userId"',
      [codeHash, now],
    )
  ).rows;
  return rows[0]?.userId;
}

// ---- pairings ----------------------------------------------------------------------------

/** Pairs an agent install with a user; pairing the same install again keeps the id and replaces the rest. */
export async function upsertPairing(
  db: Querier,
  input: {
    readonly id: string;
    readonly userId: string;
    readonly agentId: string;
    readonly publicKey: string;
    readonly port: number;
    readonly sshOptIn: boolean;
    readonly at: Date;
  },
): Promise<PairingRow> {
  const rows = (
    await db.query(
      `insert into agent_pairings (id, user_id, agent_id, public_key, port, ssh_opt_in, created_at, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, $7, $7)
       on conflict (tenant_id, user_id, agent_id) do update set public_key = excluded.public_key, port = excluded.port,
         ssh_opt_in = excluded.ssh_opt_in, last_seen_at = excluded.last_seen_at
       returning ${PAIRING_COLUMNS}`,
      [input.id, input.userId, input.agentId, input.publicKey, input.port, input.sshOptIn, input.at],
    )
  ).rows;
  return pairingOf(rows[0]!);
}

/** The pairing of `agentId` for `userId`, if that install paired before. */
export async function pairingOfAgent(db: Querier, userId: string, agentId: string): Promise<PairingRow | undefined> {
  const row = (
    await db.query(`select ${PAIRING_COLUMNS} from agent_pairings where user_id = $1 and agent_id = $2`, [
      userId,
      agentId,
    ])
  ).rows[0];
  return row === undefined ? undefined : pairingOf(row);
}

export async function pairingById(db: Querier, id: string): Promise<PairingRow | undefined> {
  const row = (await db.query(`select ${PAIRING_COLUMNS} from agent_pairings where id = $1`, [id])).rows[0];
  return row === undefined ? undefined : pairingOf(row);
}

export async function pairingsOfUser(db: Querier, userId: string): Promise<readonly PairingRow[]> {
  const rows = (
    await db.query(
      `select ${PAIRING_COLUMNS} from agent_pairings where user_id = $1 order by created_at desc, id desc`,
      [userId],
    )
  ).rows;
  return rows.map(pairingOf);
}

/** Deletes the pairing (its nonces go with it); `undefined` when there was none. */
export async function deletePairing(db: Querier, id: string): Promise<PairingRow | undefined> {
  const row = (await db.query(`delete from agent_pairings where id = $1 returning ${PAIRING_COLUMNS}`, [id])).rows[0];
  return row === undefined ? undefined : pairingOf(row);
}

export async function setPort(db: Querier, id: string, port: number, at: Date): Promise<void> {
  await db.query('update agent_pairings set port = $2, last_seen_at = $3 where id = $1', [id, port, at]);
}

export async function touchPairing(db: Querier, id: string, at: Date): Promise<void> {
  await db.query('update agent_pairings set last_seen_at = $2 where id = $1', [id, at]);
}

// ---- nonces ------------------------------------------------------------------------------

export async function insertNonce(
  db: Querier,
  input: { readonly nonceHash: string; readonly pairingId: string; readonly userId: string; readonly expiresAt: Date },
): Promise<void> {
  await db.query('insert into agent_nonces (nonce_hash, pairing_id, user_id, expires_at) values ($1, $2, $3, $4)', [
    input.nonceHash,
    input.pairingId,
    input.userId,
    input.expiresAt,
  ]);
}

/**
 * Consumes a live nonce of `pairingId`; the user it was issued to, or `undefined`. A nonce of another
 * pairing is left alone, so a wrong agent cannot burn a tab's nonce.
 */
export async function takeNonce(
  db: Querier,
  input: { readonly nonceHash: string; readonly pairingId: string; readonly now: Date },
): Promise<string | undefined> {
  const rows = (
    await db.query<{ userId: string }>(
      'delete from agent_nonces where nonce_hash = $1 and pairing_id = $2 and expires_at > $3 returning user_id as "userId"',
      [input.nonceHash, input.pairingId, input.now],
    )
  ).rows;
  return rows[0]?.userId;
}

// ---- sweep -------------------------------------------------------------------------------

/** Deletes expired codes and nonces; the count of each. */
export async function deleteExpired(db: Querier, now: Date): Promise<{ codes: number; nonces: number }> {
  const codes = (await db.query('delete from agent_pairing_codes where expires_at <= $1', [now])).rowCount ?? 0;
  const nonces = (await db.query('delete from agent_nonces where expires_at <= $1', [now])).rowCount ?? 0;
  return { codes, nonces };
}
