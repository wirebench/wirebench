/**
 * Every SQL statement of the webhook-capture module (spec §3.2, §3.4), one function each over a
 * `Querier`, so the public route runs its insert and its prune inside one transaction. Columns come
 * back aliased to camelCase; timestamps leave as ISO-8601 strings, headers as parsed pairs (jsonb) and
 * bodies as Buffers (bytea).
 */
import type { CatchUrlResponse } from '@wirebench/engine';
import { monotonicFactory } from 'ulidx';
import type { Querier } from '../context.js';

/** The unique index a duplicate name trips (§3.5 → `409 hooks-name-taken`). */
export const CATCH_URL_NAME_INDEX = 'catch_urls_workspace_name_lower';
/** The foreign key a create trips when the workspace was deleted after the guard passed. */
export const CATCH_URL_WORKSPACE_FK = 'catch_urls_workspace_id_fkey';
/** The foreign key a capture insert trips when its catch URL was deleted after the lookup. */
export const CAPTURE_CATCH_URL_FK = 'captures_catch_url_id_fkey';

export interface CatchUrlRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly secret: string;
  readonly enabled: boolean;
  readonly response: CatchUrlResponse;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface CatchUrlListRow extends CatchUrlRow {
  readonly captureCount: number;
  readonly newestCaptureId: string | null;
}

/** What the public route needs, found by secret. */
export interface PublicCatchUrl {
  readonly id: string;
  readonly workspaceId: string;
  readonly enabled: boolean;
  readonly response: CatchUrlResponse;
}

export interface CatchUrlPatch {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly response?: Partial<CatchUrlResponse>;
}

export interface NewCapture {
  readonly id: string;
  readonly catchUrlId: string;
  readonly receivedAt: Date;
  readonly method: string;
  readonly subpath: string;
  readonly query: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Buffer;
  readonly bodySize: number;
  readonly truncated: boolean;
  readonly sourceIp: string;
}

export interface CaptureSummaryRow {
  readonly id: string;
  readonly receivedAt: string;
  readonly method: string;
  readonly subpath: string;
  readonly bodySize: number;
  readonly truncated: boolean;
  readonly sourceIp: string;
}

export interface CaptureRow extends CaptureSummaryRow {
  readonly query: string;
  readonly headers: [string, string][];
  readonly body: Buffer;
}

/** Which page of captures: the newest, the ones before an id, or the ones right after an id. */
export type CapturePage = { readonly before: string } | { readonly after: string } | Record<string, never>;

/**
 * Capture ids for one process. Monotonic: two captures in the same millisecond still sort in arrival
 * order (§3.2), which `after=` paging and pruning rely on.
 */
export function captureIdFactory(): () => string {
  const next = monotonicFactory();
  return () => next();
}

type Raw = Record<string, unknown>;

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : new Date(value as string).toISOString();

const CATCH_URL_COLUMNS = `h.id, h.workspace_id as "workspaceId", h.name, h.secret, h.enabled,
  h.response_status as "status", h.response_content_type as "contentType", h.response_body as "body",
  h.response_delay_ms as "delayMs", h.created_by as "createdBy", h.created_at as "createdAt"`;
const LISTED_COLUMNS = `${CATCH_URL_COLUMNS},
  (select count(*)::int from captures c where c.catch_url_id = h.id) as "captureCount",
  (select max(c.id) from captures c where c.catch_url_id = h.id) as "newestCaptureId"`;
const SUMMARY_COLUMNS = `id, received_at as "receivedAt", method, subpath, body_size as "bodySize", truncated,
  source_ip as "sourceIp"`;

function responseOf(row: Raw): CatchUrlResponse {
  return {
    status: row.status as number,
    contentType: row.contentType as string | null,
    body: row.body as string | null,
    delayMs: row.delayMs as number,
  };
}

function catchUrlOf(row: Raw): CatchUrlRow {
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    name: row.name as string,
    secret: row.secret as string,
    enabled: row.enabled as boolean,
    response: responseOf(row),
    createdBy: row.createdBy as string | null,
    createdAt: iso(row.createdAt),
  };
}

function listedOf(row: Raw): CatchUrlListRow {
  return {
    ...catchUrlOf(row),
    captureCount: row.captureCount as number,
    newestCaptureId: row.newestCaptureId as string | null,
  };
}

function summaryOf(row: Raw): CaptureSummaryRow {
  return {
    id: row.id as string,
    receivedAt: iso(row.receivedAt),
    method: row.method as string,
    subpath: row.subpath as string,
    bodySize: row.bodySize as number,
    truncated: row.truncated as boolean,
    sourceIp: row.sourceIp as string,
  };
}

// ---- catch URLs ---------------------------------------------------------------------------

/**
 * Holds the workspace row until the transaction ends, so two creates count the catch URLs one after
 * the other (§3.5's per-workspace cap). `false` when the workspace does not exist.
 */
export async function lockWorkspace(tx: Querier, workspaceId: string): Promise<boolean> {
  return (
    ((await tx.query('select id from workspaces where id = $1 for no key update', [workspaceId])).rowCount ?? 0) > 0
  );
}

export async function countCatchUrls(db: Querier, workspaceId: string): Promise<number> {
  const row = (
    await db.query<{ n: number }>('select count(*)::int as n from catch_urls where workspace_id = $1', [workspaceId])
  ).rows[0];
  return row?.n ?? 0;
}

export async function insertCatchUrl(
  db: Querier,
  input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly secret: string;
    readonly enabled: boolean;
    readonly response: CatchUrlResponse;
    readonly createdBy: string | null;
    readonly at: Date;
  },
): Promise<CatchUrlRow> {
  const rows = (
    await db.query(
      `insert into catch_urls as h (id, workspace_id, name, secret, enabled, response_status, response_content_type,
         response_body, response_delay_ms, created_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning ${CATCH_URL_COLUMNS}`,
      [
        input.id,
        input.workspaceId,
        input.name,
        input.secret,
        input.enabled,
        input.response.status,
        input.response.contentType,
        input.response.body,
        input.response.delayMs,
        input.createdBy,
        input.at,
      ],
    )
  ).rows;
  return catchUrlOf(rows[0]!);
}

/** A workspace's catch URLs by name (case-insensitive), then id. */
export async function catchUrlsOfWorkspace(db: Querier, workspaceId: string): Promise<CatchUrlListRow[]> {
  const rows = (
    await db.query(
      `select ${LISTED_COLUMNS} from catch_urls h where h.workspace_id = $1 order by lower(h.name), h.id`,
      [workspaceId],
    )
  ).rows;
  return rows.map(listedOf);
}

/** One catch URL, only when it belongs to `workspaceId`: another workspace's id finds nothing (§3.5). */
export async function catchUrlInWorkspace(
  db: Querier,
  workspaceId: string,
  id: string,
): Promise<CatchUrlListRow | undefined> {
  const row = (
    await db.query(`select ${LISTED_COLUMNS} from catch_urls h where h.workspace_id = $1 and h.id = $2`, [
      workspaceId,
      id,
    ])
  ).rows[0];
  return row === undefined ? undefined : listedOf(row);
}

export async function catchUrlBySecret(db: Querier, secret: string): Promise<PublicCatchUrl | undefined> {
  const row = (
    await db.query(
      `select h.id, h.workspace_id as "workspaceId", h.enabled, h.response_status as "status",
         h.response_content_type as "contentType", h.response_body as "body", h.response_delay_ms as "delayMs"
       from catch_urls h where h.secret = $1`,
      [secret],
    )
  ).rows[0];
  if (row === undefined) return undefined;
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    enabled: row.enabled as boolean,
    response: responseOf(row),
  };
}

/** Sets only what `patch` names; `null` in `response.contentType` or `response.body` clears it. */
export async function updateCatchUrl(db: Querier, id: string, patch: CatchUrlPatch): Promise<void> {
  const params: unknown[] = [id];
  const sets: string[] = [];
  const set = (column: string, value: unknown): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.name !== undefined) set('name', patch.name);
  if (patch.enabled !== undefined) set('enabled', patch.enabled);
  const response = patch.response ?? {};
  if (response.status !== undefined) set('response_status', response.status);
  if (response.contentType !== undefined) set('response_content_type', response.contentType);
  if (response.body !== undefined) set('response_body', response.body);
  if (response.delayMs !== undefined) set('response_delay_ms', response.delayMs);
  if (sets.length === 0) return;
  await db.query(`update catch_urls set ${sets.join(', ')} where id = $1`, params);
}

export async function rotateSecret(db: Querier, id: string, secret: string): Promise<void> {
  await db.query('update catch_urls set secret = $2 where id = $1', [id, secret]);
}

/** `false` when there was nothing to delete. Its captures go with it (cascade). */
export async function deleteCatchUrl(db: Querier, id: string): Promise<boolean> {
  return ((await db.query('delete from catch_urls where id = $1', [id])).rowCount ?? 0) > 0;
}

// ---- captures -----------------------------------------------------------------------------

export async function insertCapture(tx: Querier, capture: NewCapture): Promise<void> {
  await tx.query(
    `insert into captures (id, catch_url_id, received_at, method, subpath, query, headers, body, body_size, truncated,
       source_ip)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
    [
      capture.id,
      capture.catchUrlId,
      capture.receivedAt,
      capture.method,
      capture.subpath,
      capture.query,
      JSON.stringify(capture.headers),
      capture.body,
      capture.bodySize,
      capture.truncated,
      capture.sourceIp,
    ],
  );
}

/**
 * Keeps the newest `keep` captures of one catch URL (§3.4, by count). The subquery finds the
 * `keep + 1`-th newest id; everything at or below it goes. With `keep` or fewer rows it is `null`, and
 * `id <= null` deletes nothing. Returns how many went.
 */
export async function pruneCaptures(tx: Querier, catchUrlId: string, keep: number): Promise<number> {
  const result = await tx.query(
    `delete from captures where catch_url_id = $1 and id <= (
       select id from captures where catch_url_id = $1 order by id desc offset $2 limit 1)`,
    [catchUrlId, keep],
  );
  return result.rowCount ?? 0;
}

/**
 * One page of summaries, newest first (§3.5). `after` selects the `limit` captures right after the id,
 * oldest of them first, so a gap fill that pages with the newest id it holds misses nothing; the page
 * is then reversed to newest first like every other.
 */
export async function listCaptures(
  db: Querier,
  catchUrlId: string,
  page: CapturePage,
  limit: number,
): Promise<CaptureSummaryRow[]> {
  if ('after' in page) {
    const rows = (
      await db.query(
        `select ${SUMMARY_COLUMNS} from captures where catch_url_id = $1 and id > $2 order by id asc limit $3`,
        [catchUrlId, page.after, limit],
      )
    ).rows;
    return rows.map(summaryOf).reverse();
  }
  if ('before' in page) {
    const rows = (
      await db.query(
        `select ${SUMMARY_COLUMNS} from captures where catch_url_id = $1 and id < $2 order by id desc limit $3`,
        [catchUrlId, page.before, limit],
      )
    ).rows;
    return rows.map(summaryOf);
  }
  const rows = (
    await db.query(`select ${SUMMARY_COLUMNS} from captures where catch_url_id = $1 order by id desc limit $2`, [
      catchUrlId,
      limit,
    ])
  ).rows;
  return rows.map(summaryOf);
}

export async function captureById(db: Querier, catchUrlId: string, captureId: string): Promise<CaptureRow | undefined> {
  const row = (
    await db.query(
      `select ${SUMMARY_COLUMNS}, query, headers, body from captures where catch_url_id = $1 and id = $2`,
      [catchUrlId, captureId],
    )
  ).rows[0];
  if (row === undefined) return undefined;
  return {
    ...summaryOf(row),
    query: row.query as string,
    headers: row.headers as [string, string][],
    body: row.body as Buffer,
  };
}

export async function clearCaptures(db: Querier, catchUrlId: string): Promise<number> {
  return (await db.query('delete from captures where catch_url_id = $1', [catchUrlId])).rowCount ?? 0;
}

/**
 * One batch of the age sweep (§3.4): at most `batchSize` captures received strictly before `cutoff`,
 * oldest first. The caller repeats until a batch comes back short, so no statement holds a long lock.
 */
export async function deleteCapturesBefore(db: Querier, cutoff: Date, batchSize: number): Promise<number> {
  const result = await db.query(
    `delete from captures where id in (
       select id from captures where received_at < $1 order by received_at limit $2)`,
    [cutoff, batchSize],
  );
  return result.rowCount ?? 0;
}
