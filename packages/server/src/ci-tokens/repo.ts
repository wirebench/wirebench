/** The `ci_tokens` table (callback-assertion spec §3). Raw SQL over `Querier`, like every module's repo. */
import type { Querier } from '../context.js';

export interface CiTokenRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly createdBy: string | null;
  /** The creator's display name; `null` once that user is gone. */
  readonly createdByName: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

type Raw = Record<string, unknown>;

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : text(value));

function rowOf(raw: Raw): CiTokenRow {
  return {
    id: text(raw['id']) ?? '',
    workspaceId: text(raw['workspaceId']) ?? '',
    name: text(raw['name']) ?? '',
    tokenHash: text(raw['tokenHash']) ?? '',
    createdBy: text(raw['createdBy']),
    createdByName: text(raw['createdByName']),
    createdAt: iso(raw['createdAt']) ?? '',
    lastUsedAt: iso(raw['lastUsedAt']),
    revokedAt: iso(raw['revokedAt']),
  };
}

const SELECT = `select t.id, t.workspace_id as "workspaceId", t.name, t.token_hash as "tokenHash",
  t.created_by as "createdBy", u.display_name as "createdByName", t.created_at as "createdAt",
  t.last_used_at as "lastUsedAt", t.revoked_at as "revokedAt"
  from ci_tokens t left join users u on u.id = t.created_by`;

export async function insertCiToken(
  db: Querier,
  input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly tokenHash: string;
    readonly createdBy: string | null;
    readonly at: Date;
  },
): Promise<void> {
  await db.query(
    'insert into ci_tokens (id, workspace_id, name, token_hash, created_by, created_at) values ($1, $2, $3, $4, $5, $6)',
    [input.id, input.workspaceId, input.name, input.tokenHash, input.createdBy, input.at],
  );
}

/** Revoked ones included: the caller decides, so a revoked token is told apart from an unknown one only here. */
export async function ciTokenByHash(db: Querier, tokenHash: string): Promise<CiTokenRow | undefined> {
  const raw = (await db.query<Raw>(`${SELECT} where t.token_hash = $1`, [tokenHash])).rows[0];
  return raw === undefined ? undefined : rowOf(raw);
}

export async function ciTokensOfWorkspace(db: Querier, workspaceId: string): Promise<CiTokenRow[]> {
  const rows = (
    await db.query<Raw>(`${SELECT} where t.workspace_id = $1 and t.revoked_at is null order by lower(t.name), t.id`, [
      workspaceId,
    ])
  ).rows;
  return rows.map(rowOf);
}

/** The revoked token's name, or `undefined` when none was live (audit-log plan ruling 7). */
export async function revokeCiToken(
  db: Querier,
  workspaceId: string,
  id: string,
  at: Date,
): Promise<string | undefined> {
  const result = await db.query<{ name: string }>(
    'update ci_tokens set revoked_at = $3 where id = $1 and workspace_id = $2 and revoked_at is null returning name',
    [id, workspaceId, at],
  );
  return result.rows[0]?.name;
}

export async function touchCiToken(db: Querier, id: string, at: Date): Promise<void> {
  await db.query('update ci_tokens set last_used_at = $2 where id = $1', [id, at]);
}
