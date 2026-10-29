/**
 * The `session_logs` and `session_log_chunks` tables (team session logs spec A1). A log's bytes are rows
 * keyed by their offset, appended in order and never rewritten; `size_bytes` is the next offset.
 */
import type { SessionLog, SessionLogOpenRequest, SessionLogReason } from '@wirebench/engine';
import type { Querier } from '../context.js';

type Raw = Record<string, unknown>;

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : new Date(value as string).toISOString();

const SELECT = `select l.id, l.workspace_id as "workspaceId", l.user_id as "userId", u.display_name as "userName",
  l.client_log_id as "clientLogId", l.host_id as "hostId", l.host_name as "hostName", l.address, l.port,
  l.ssh_user as "user", l.started_at as "startedAt", l.ended_at as "endedAt", l.exit_code as "exitCode",
  l.signal, l.reason, l.size_bytes as "size", l.truncated
  from session_logs l join users u on u.id = l.user_id`;

function toLog(row: Raw): SessionLog {
  return {
    id: row['id'] as string,
    workspaceId: row['workspaceId'] as string,
    userId: row['userId'] as string,
    userName: row['userName'] as string,
    clientLogId: row['clientLogId'] as string,
    hostId: row['hostId'] as string,
    hostName: row['hostName'] as string,
    address: row['address'] as string,
    port: row['port'] as number,
    user: row['user'] as string,
    startedAt: iso(row['startedAt']),
    endedAt: row['endedAt'] === null ? null : iso(row['endedAt']),
    exitCode: (row['exitCode'] as number | null) ?? null,
    signal: (row['signal'] as string | null) ?? null,
    reason: (row['reason'] as SessionLogReason | null) ?? null,
    // `bigint` arrives as text from pg.
    size: Number(row['size']),
    truncated: row['truncated'] as boolean,
    live: row['endedAt'] === null,
  };
}

/** Opens a log, or finds the one this user already opened under the same client id (a resumed upload). */
export async function openLog(
  db: Querier,
  input: SessionLogOpenRequest & {
    readonly id: string;
    readonly workspaceId: string;
    readonly userId: string;
    readonly at: Date;
  },
): Promise<{ readonly log: SessionLog; readonly created: boolean }> {
  const inserted = await db.query(
    `insert into session_logs (id, workspace_id, user_id, client_log_id, host_id, host_name, address, port, ssh_user,
       started_at, last_write_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (tenant_id, workspace_id, user_id, client_log_id) do nothing returning id`,
    [
      input.id,
      input.workspaceId,
      input.userId,
      input.clientLogId,
      input.hostId,
      input.hostName,
      input.address,
      input.port,
      input.user,
      new Date(input.startedAt),
      input.at,
    ],
  );
  const found = (
    await db.query(`${SELECT} where l.workspace_id = $1 and l.user_id = $2 and l.client_log_id = $3`, [
      input.workspaceId,
      input.userId,
      input.clientLogId,
    ])
  ).rows[0] as Raw;
  return { log: toLog(found), created: inserted.rows.length > 0 };
}

/** One log of a workspace; `forUpdate` locks its row for the rest of the caller's transaction. */
export async function logById(
  db: Querier,
  workspaceId: string,
  logId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<SessionLog | undefined> {
  const lock = options.forUpdate === true ? ' for update of l' : '';
  const row = (await db.query(`${SELECT} where l.workspace_id = $1 and l.id = $2${lock}`, [workspaceId, logId]))
    .rows[0] as Raw | undefined;
  return row === undefined ? undefined : toLog(row);
}

/** Appends `data` at `offset` (the current size) and moves the size; `truncated` stops every later byte. */
export async function appendChunk(
  db: Querier,
  input: {
    readonly logId: string;
    readonly offset: number;
    readonly data: Buffer;
    readonly truncated: boolean;
    readonly at: Date;
  },
): Promise<void> {
  if (input.data.length > 0) {
    await db.query('insert into session_log_chunks (log_id, offset_bytes, data) values ($1, $2, $3)', [
      input.logId,
      input.offset,
      input.data,
    ]);
  }
  await db.query(
    'update session_logs set size_bytes = $2, truncated = truncated or $3, last_write_at = $4 where id = $1',
    [input.logId, input.offset + input.data.length, input.truncated, input.at],
  );
}

export async function endLog(
  db: Querier,
  input: {
    readonly logId: string;
    readonly endedAt: Date;
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly reason: SessionLogReason;
    readonly at: Date;
  },
): Promise<void> {
  await db.query(
    `update session_logs set ended_at = $2, exit_code = $3, signal = $4, reason = $5, last_write_at = $6
     where id = $1`,
    [input.logId, input.endedAt, input.exitCode, input.signal, input.reason, input.at],
  );
}

/** A page of a workspace's logs, newest first: ids are ULIDs the server minted, so they sort by creation. */
export async function listLogs(
  db: Querier,
  workspaceId: string,
  query: { readonly hostId?: string; readonly userId?: string; readonly before?: string; readonly limit: number },
): Promise<SessionLog[]> {
  const where = ['l.workspace_id = $1'];
  const params: unknown[] = [workspaceId];
  if (query.hostId !== undefined) where.push(`l.host_id = $${params.push(query.hostId)}`);
  if (query.userId !== undefined) where.push(`l.user_id = $${params.push(query.userId)}`);
  if (query.before !== undefined) where.push(`l.id < $${params.push(query.before)}`);
  const sql = `${SELECT} where ${where.join(' and ')} order by l.id desc limit $${params.push(query.limit)}`;
  return ((await db.query(sql, params)).rows as Raw[]).map(toLog);
}

/** Up to `max` bytes of a log from `offset`, cut out of the chunks that overlap them, in order. */
export async function readBytes(db: Querier, logId: string, offset: number, max: number): Promise<Buffer> {
  const end = offset + max;
  const rows = (
    await db.query(
      `select offset_bytes as "offset", data from session_log_chunks
       where log_id = $1 and offset_bytes + octet_length(data) > $2 and offset_bytes < $3
       order by offset_bytes`,
      [logId, offset, end],
    )
  ).rows as { offset: string; data: Buffer }[];
  const parts: Buffer[] = [];
  let at = offset;
  for (const row of rows) {
    const from = at - Number(row.offset);
    const piece = row.data.subarray(from, from + (end - at));
    parts.push(piece);
    at += piece.length;
  }
  return Buffer.concat(parts);
}

export async function removeLog(db: Querier, logId: string): Promise<void> {
  await db.query('delete from session_logs where id = $1', [logId]);
}

/** Retention (spec A1): logs last written before `cutoff`, at most `limit` per call; their chunks cascade. */
export async function removeLogsBefore(db: Querier, cutoff: Date, limit: number): Promise<number> {
  const result = await db.query(
    `delete from session_logs where id in (
       select id from session_logs where last_write_at < $1 order by last_write_at limit $2)`,
    [cutoff, limit],
  );
  return result.rowCount ?? 0;
}
