/** The append-only `audit_events` table (audit-log spec §4.2). Raw SQL over `Querier`, like every module's repo. */
import type { AuditDetails, AuditEvent, AuditTargetKind } from '@wirebench/engine';
import type { AuditInput, Querier } from '../context.js';
import type { Cursor } from './cursor.js';

export interface AuditRowInput extends AuditInput {
  readonly id: string;
  readonly at: Date;
  readonly details: AuditDetails;
}

const COLUMNS =
  'id, at, actor_kind as "actorKind", actor_user_id as "actorUserId", actor_email as "actorEmail", actor_token_id as "actorTokenId", ' +
  'actor_workspace_id as "actorWorkspaceId", action, target_kind as "targetKind", target_id as "targetId", workspace_id as "workspaceId", ' +
  'team_id as "teamId", host(ip) as ip, user_agent as "userAgent", details';

const INSERT_EVENT = `insert into audit_events (id, at, actor_kind, actor_user_id, actor_email, actor_token_id, action, target_kind, target_id,
       workspace_id, team_id, ip, user_agent, details, actor_workspace_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`;

/**
 * With `forward`, the event and its outbox row (issue #209) are one statement: several fire sites pass
 * the pool, where two statements would autocommit apart and a crash between them would leave an event
 * that is never forwarded.
 */
export async function insertAuditEvent(
  db: Querier,
  row: AuditRowInput,
  options: { readonly forward: boolean } = { forward: false },
): Promise<void> {
  const actor = row.actor;
  await db.query(
    options.forward
      ? `with e as (${INSERT_EVENT} returning id) insert into audit_forward_queue (event_id) select id from e`
      : INSERT_EVENT,
    [
      row.id,
      row.at,
      actor.kind,
      actor.kind === 'user' ? actor.userId : null,
      actor.kind === 'user' ? actor.email : null,
      actor.kind === 'user' ? (actor.tokenId ?? null) : actor.kind === 'ci-token' ? actor.tokenId : null,
      row.action,
      row.target.kind,
      row.target.id ?? null,
      row.workspaceId ?? null,
      row.teamId ?? null,
      row.ip ?? null,
      row.userAgent ?? null,
      JSON.stringify(row.details),
      actor.kind === 'ci-token' ? actor.workspaceId : null,
    ],
  );
}

/** The team a workspace belongs to, or `undefined` when the workspace row is gone. */
export async function workspaceTeamId(db: Querier, workspaceId: string): Promise<string | undefined> {
  const row = (await db.query<{ team_id: string }>('select team_id from workspaces where id = $1', [workspaceId]))
    .rows[0];
  return row?.team_id;
}

export interface AuditFilter {
  readonly from?: Date;
  /** Exclusive. */
  readonly to?: Date;
  /** Exact, or a group prefix ending in a dot. */
  readonly action?: string;
  readonly actorUserId?: string;
  readonly workspaceId?: string;
  readonly teamId?: string;
  readonly targetKind?: AuditTargetKind;
  readonly targetId?: string;
}

function where(filter: AuditFilter, params: unknown[]): string[] {
  const clauses: string[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace('?', `$${String(params.length)}`));
  };
  if (filter.from !== undefined) add('at >= ?', filter.from);
  if (filter.to !== undefined) add('at < ?', filter.to);
  if (filter.action !== undefined) {
    // The query schema allows only [a-z_.], so the prefix needs no LIKE escaping.
    if (filter.action.endsWith('.')) add('action like ?', `${filter.action}%`);
    else add('action = ?', filter.action);
  }
  if (filter.actorUserId !== undefined) add('actor_user_id = ?', filter.actorUserId);
  if (filter.workspaceId !== undefined) add('workspace_id = ?', filter.workspaceId);
  if (filter.teamId !== undefined) add('team_id = ?', filter.teamId);
  if (filter.targetKind !== undefined) add('target_kind = ?', filter.targetKind);
  if (filter.targetId !== undefined) add('target_id = ?', filter.targetId);
  return clauses;
}

type Raw = Record<string, unknown>;
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const opt = (value: unknown): string | undefined => text(value) ?? undefined;

function toEvent(raw: Raw): AuditEvent {
  const kind = text(raw['actorKind']) as AuditEvent['actor']['kind'];
  const actor: AuditEvent['actor'] =
    kind === 'user'
      ? { kind, userId: opt(raw['actorUserId']), email: opt(raw['actorEmail']), tokenId: opt(raw['actorTokenId']) }
      : kind === 'ci-token'
        ? { kind, tokenId: opt(raw['actorTokenId']), workspaceId: opt(raw['actorWorkspaceId']) }
        : { kind };
  const at = raw['at'];
  const details = raw['details'];
  return {
    id: text(raw['id']) ?? '',
    at: at instanceof Date ? at.toISOString() : (text(at) ?? ''),
    actor,
    action: text(raw['action']) as AuditEvent['action'],
    target: { kind: text(raw['targetKind']) as AuditTargetKind, id: text(raw['targetId']) },
    workspaceId: text(raw['workspaceId']),
    teamId: text(raw['teamId']),
    ip: text(raw['ip']),
    userAgent: text(raw['userAgent']),
    details: (typeof details === 'object' && details !== null ? details : {}) as AuditDetails,
  };
}

function select(
  filter: AuditFilter,
  after: Cursor | undefined,
  limit: number,
  direction: 'desc' | 'asc',
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses = where(filter, params);
  if (after !== undefined) {
    params.push(new Date(after.at), after.id);
    clauses.push(
      `(at, id) ${direction === 'desc' ? '<' : '>'} ($${String(params.length - 1)}, $${String(params.length)})`,
    );
  }
  params.push(limit);
  const whereSql = clauses.length > 0 ? `where ${clauses.join(' and ')}` : '';
  return {
    sql: `select ${COLUMNS} from audit_events ${whereSql} order by at ${direction}, id ${direction} limit $${String(params.length)}`,
    params,
  };
}

/** Newest first; `after` continues below the cursor's row (§3.4). */
export async function listAuditEvents(
  db: Querier,
  filter: AuditFilter,
  page: { readonly after?: Cursor; readonly limit: number },
): Promise<AuditEvent[]> {
  const { sql, params } = select(filter, page.after, page.limit, 'desc');
  return (await db.query<Raw>(sql, params)).rows.map(toEvent);
}

/** Oldest first, for the export (§3.4): `after` is the last row of the previous batch. */
export async function listAuditEventsAscending(
  db: Querier,
  filter: AuditFilter,
  after: Cursor | undefined,
  limit: number,
): Promise<AuditEvent[]> {
  const { sql, params } = select(filter, after, limit, 'asc');
  return (await db.query<Raw>(sql, params)).rows.map(toEvent);
}

/** Queues an already recorded event for the forwarder (issue #209). The hook queues through {@link insertAuditEvent}. */
export async function enqueueForward(db: Querier, eventId: string): Promise<void> {
  await db.query('insert into audit_forward_queue (event_id) values ($1)', [eventId]);
}

/**
 * Claims up to `limit` queued events, oldest first by `(at, id)`, as the API returns them. The queue
 * rows stay locked (`skip locked`, so a concurrent claim takes others) until the caller's transaction
 * ends: call it inside one, and delete with {@link deleteForwarded} once the sink accepts.
 */
export async function claimForwardBatch(tx: Querier, limit: number): Promise<AuditEvent[]> {
  const rows = await tx.query<Raw>(
    `select ${COLUMNS} from audit_forward_queue q join audit_events e on e.id = q.event_id
     order by e.at, e.id limit $1 for update of q skip locked`,
    [limit],
  );
  return rows.rows.map(toEvent);
}

/** Removes forwarded events from the queue; the events themselves stay. */
export async function deleteForwarded(tx: Querier, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.query('delete from audit_forward_queue where event_id = any($1::text[])', [ids]);
}

/** Retention (§3.3): at most `limit` rows older than `cutoff`, oldest first; returns how many went. */
export async function deleteAuditEventsBefore(db: Querier, cutoff: Date, limit: number): Promise<number> {
  const result = await db.query(
    'delete from audit_events where id in (select id from audit_events where at < $1 order by at, id limit $2)',
    [cutoff, limit],
  );
  return result.rowCount ?? 0;
}
