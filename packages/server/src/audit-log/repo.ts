/** The append-only `audit_events` table (audit-log spec §4.2). Raw SQL over `Querier`, like every module's repo. */
import type { AuditDetails, AuditEvent, AuditTargetKind } from '@wirebench/engine';
import type { AuditInput, Database, Querier } from '../context.js';
import type { CanonicalRow } from './chain/canonical.js';
import { AUDIT_CHAIN_LOCK_ID } from './chain/sealer.js';
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

/** Retention without a chain key (§3.3): at most `limit` rows older than `cutoff`, oldest first; returns how many went. */
export async function deleteAuditEventsBefore(db: Querier, cutoff: Date, limit: number): Promise<number> {
  const result = await db.query(
    'delete from audit_events where id in (select id from audit_events where at < $1 order by at, id limit $2)',
    [cutoff, limit],
  );
  return result.rowCount ?? 0;
}

// ── The audit chain (issue #210, audit-chain spec §3.2, §4) ─────────────────────────────────────────

/**
 * The select list that renders a row as the texts {@link CanonicalRow} holds, in its field order. The
 * sealer and verify both read rows through it, so the two can never disagree on a row's bytes. It
 * aliases `at` to its text, so a query that sorts on it must qualify the table column. `abbrev(ip)` is
 * the `inet` output form: a netmask other than /32 or /128 is printed, so editing it breaks the link
 * (`host(ip)` drops it), while a single host prints bare (`ip::text` would always add `/32` or `/128`).
 */
export const CANONICAL_COLUMNS =
  `id, to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at, ` +
  'actor_kind as "actorKind", actor_user_id as "actorUserId", actor_email as "actorEmail", ' +
  'actor_token_id as "actorTokenId", actor_workspace_id as "actorWorkspaceId", action, ' +
  'target_kind as "targetKind", target_id as "targetId", workspace_id as "workspaceId", team_id as "teamId", ' +
  'abbrev(ip) as ip, user_agent as "userAgent", details::text as details';

/** A point in the chain: a sealed row's, the anchor's, or the head's. */
export interface ChainLink {
  readonly seq: bigint;
  readonly hash: Buffer;
}

/** The chain's starting point, the id of the key that built it, and the highest seq ever sealed. */
export interface ChainAnchor extends ChainLink {
  readonly keyId: string;
  /** Never goes back: the next seq is above it even when every sealed row was removed from outside. */
  readonly headSeq: bigint;
}

/** A sealed row as verify walks it. */
export interface SealedRow extends ChainLink {
  readonly row: CanonicalRow;
}

type CanonicalRaw = { readonly [K in keyof CanonicalRow]: string | null };

// pg returns bigint columns as strings; the chain's numbers are compared and incremented as bigint.
const seqOf = (value: string): bigint => BigInt(value);

export async function readAnchor(db: Querier): Promise<ChainAnchor | undefined> {
  const row = (
    await db.query<{ seq: string; hash: Buffer; key_id: string; head_seq: string }>(
      'select seq::text as seq, hash, key_id, head_seq::text as head_seq from audit_chain_anchor',
    )
  ).rows[0];
  return row === undefined
    ? undefined
    : { seq: seqOf(row.seq), hash: row.hash, keyId: row.key_id, headSeq: seqOf(row.head_seq) };
}

/** Records the head after a sealing pass, in its transaction; `greatest` keeps it from ever going back. */
export async function setAnchorHead(tx: Querier, headSeq: bigint): Promise<void> {
  await tx.query('update audit_chain_anchor set head_seq = greatest(head_seq, $1::bigint)', [headSeq.toString()]);
}

/**
 * Inserts the genesis anchor (`seq` 0) unless an anchor exists, and returns the anchor now in place.
 * The sealer calls it under its advisory lock, so the existing anchor wins only a race it cannot lose.
 */
export async function insertGenesis(tx: Querier, hash: Buffer, keyId: string): Promise<ChainAnchor> {
  await tx.query(
    'insert into audit_chain_anchor (seq, hash, key_id) values (0, $1, $2) on conflict (only_row) do nothing',
    [hash, keyId],
  );
  const anchor = await readAnchor(tx);
  /* c8 ignore next -- the row was just inserted or already there */
  if (anchor === undefined) throw new Error('the audit chain anchor is missing after its insert');
  return anchor;
}

/** The highest sealed `(seq, hash)`, or `undefined` when no row is sealed (the head is then the anchor). */
export async function chainHead(db: Querier): Promise<ChainLink | undefined> {
  const row = (
    await db.query<{ seq: string; hash: Buffer }>(
      'select chain_seq::text as seq, chain_hash as hash from audit_events where chain_seq is not null order by chain_seq desc limit 1',
    )
  ).rows[0];
  return row === undefined ? undefined : { seq: seqOf(row.seq), hash: row.hash };
}

/**
 * Claims up to `limit` unsealed rows in sealing order, `(at, id)`. Call it inside the sealing
 * transaction: the rows stay locked until it ends, and rows not yet committed are invisible to it.
 */
export async function claimUnsealed(tx: Querier, limit: number): Promise<CanonicalRow[]> {
  const rows = await tx.query<CanonicalRaw>(
    // Qualified: a bare `at` in `order by` would name CANONICAL_COLUMNS' text output, which the
    // audit_events_unsealed (at, id) index cannot serve.
    `select ${CANONICAL_COLUMNS} from audit_events where chain_seq is null
     order by audit_events.at, audit_events.id limit $1 for update skip locked`,
    [limit],
  );
  return rows.rows;
}

export async function sealRow(tx: Querier, id: string, seq: bigint, hash: Buffer): Promise<void> {
  await tx.query('update audit_events set chain_seq = $2, chain_hash = $3 where id = $1', [id, seq.toString(), hash]);
}

/** Sealed rows with a sequence number above `afterSeq`, in chain order, for verify's walk. */
export async function sealedPage(db: Querier, afterSeq: bigint, limit: number): Promise<SealedRow[]> {
  const rows = await db.query<CanonicalRaw & { chainSeq: string; chainHash: Buffer }>(
    `select ${CANONICAL_COLUMNS}, chain_seq::text as "chainSeq", chain_hash as "chainHash" from audit_events
     where chain_seq > $1 order by chain_seq limit $2`,
    [afterSeq.toString(), limit],
  );
  return rows.rows.map(({ chainSeq, chainHash, ...row }) => ({ seq: seqOf(chainSeq), hash: chainHash, row }));
}

/**
 * Retention with a chain key (audit-chain spec §3.3): deletes sealed rows from the oldest end of the
 * chain only, so the kept chain stays gapless and verifies from the moved anchor. `S` is the highest
 * seq whose row and every row before it are older than `cutoff`; up to `limit` rows past the anchor, to
 * `S`, go in one transaction that moves the anchor to the last deleted row's `(seq, hash)`, keeping
 * its key id and `head_seq`. Unsealed rows are never touched: they go once sealed and past the cutoff.
 * A late row (sealed after rows with a newer `at`) holds back the rows sealed after it while those
 * newer rows are kept: a little extra storage, never a gap.
 *
 * It takes the sealer's advisory lock, waiting for it, so a sealing pass (which reads the head and the
 * anchor) and a batch (which moves the anchor) never interleave; a pass that finds it held ends
 * `busy-elsewhere` and tries again. Returns how many rows went: 0 with no anchor or nothing to delete.
 */
export async function deleteSealedBefore(db: Database, cutoff: Date, limit: number): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.query('select pg_advisory_xact_lock($1::bigint)', [AUDIT_CHAIN_LOCK_ID.toString()]);
    const anchor = await readAnchor(tx);
    if (anchor === undefined) return 0;
    const s = (
      await tx.query<{ s: string | null }>(
        `select coalesce(
           (select min(chain_seq) - 1 from audit_events where chain_seq is not null and at >= $1),
           (select max(chain_seq) from audit_events where chain_seq is not null)
         )::text as s`,
        [cutoff],
      )
    ).rows[0]?.s;
    if (s === null || s === undefined) return 0;
    const byLimit = anchor.seq + BigInt(limit);
    const bound = seqOf(s) < byLimit ? seqOf(s) : byLimit;
    if (bound <= anchor.seq) return 0;
    const deleted = await tx.query<{ seq: string; hash: Buffer }>(
      `delete from audit_events where chain_seq > $1 and chain_seq <= $2
       returning chain_seq::text as seq, chain_hash as hash`,
      [anchor.seq.toString(), bound.toString()],
    );
    // The last deleted row is the new anchor: on an intact chain it is the row at `bound`.
    let last: ChainLink | undefined;
    for (const row of deleted.rows) {
      const seq = seqOf(row.seq);
      if (last === undefined || seq > last.seq) last = { seq, hash: row.hash };
    }
    if (last === undefined) return 0;
    await tx.query('update audit_chain_anchor set seq = $1, hash = $2', [last.seq.toString(), last.hash]);
    return deleted.rows.length;
  });
}
