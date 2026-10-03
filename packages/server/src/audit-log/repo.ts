/** The append-only `audit_events` table (audit-log spec §4.2). Raw SQL over `Querier`, like every module's repo. */
import type { AuditDetails, AuditEvent, AuditTargetKind } from '@wirebench/engine';
import type { AuditInput, Database, Querier } from '../context.js';
import { anchorMac, anchorMacValid, genesisHash, keyId, link, type CanonicalRow } from './chain/canonical.js';
import { tryLockChain } from './chain/lock.js';
import type { RetentionStopLog } from './chain/retention-log.js';
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

/**
 * Retention without a chain key and without a chain (§3.3): at most `limit` rows older than `cutoff`,
 * oldest first; returns how many went. Once an anchor exists, retention without the key uses
 * {@link deleteUnsealedBefore} instead.
 */
export async function deleteAuditEventsBefore(db: Querier, cutoff: Date, limit: number): Promise<number> {
  const result = await db.query(
    'delete from audit_events where id in (select id from audit_events where at < $1 order by at, id limit $2)',
    [cutoff, limit],
  );
  return result.rowCount ?? 0;
}

/**
 * Retention without the key while a chain exists (audit-chain spec §3.3): at most `limit` unsealed rows
 * older than `cutoff`, oldest first. Sealed rows stay, so retention never cuts a gap into the chain while
 * the key is unset; the table grows until the key is back.
 */
export async function deleteUnsealedBefore(db: Querier, cutoff: Date, limit: number): Promise<number> {
  const result = await db.query(
    `delete from audit_events where id in
       (select id from audit_events where chain_seq is null and at < $1 order by at, id limit $2)`,
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
  /** `anchorMac(key, seq, hash, headSeq)`: set by every write, in the same statement. */
  readonly mac: Buffer;
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
    await db.query<{ seq: string; hash: Buffer; key_id: string; head_seq: string; mac: Buffer }>(
      'select seq::text as seq, hash, key_id, head_seq::text as head_seq, mac from audit_chain_anchor',
    )
  ).rows[0];
  return row === undefined
    ? undefined
    : { seq: seqOf(row.seq), hash: row.hash, keyId: row.key_id, headSeq: seqOf(row.head_seq), mac: row.mac };
}

/**
 * Records the head after a sealing pass, in its transaction and under the chain's lock, with the
 * anchor's new MAC in the same statement. `anchor` is the one the pass read (and checked); the head
 * never goes back below its `headSeq`.
 */
export async function setAnchorHead(tx: Querier, key: string, anchor: ChainAnchor, headSeq: bigint): Promise<void> {
  const next = headSeq > anchor.headSeq ? headSeq : anchor.headSeq;
  await tx.query('update audit_chain_anchor set head_seq = $1, mac = $2', [
    next.toString(),
    anchorMac(key, anchor.seq, anchor.hash, next),
  ]);
}

/**
 * Inserts this key's genesis anchor (`seq` 0, `head_seq` 0, with its MAC) unless an anchor exists, and
 * returns the anchor now in place. The sealer calls it under its advisory lock, so the existing anchor
 * wins only a race it cannot lose.
 */
export async function insertGenesis(tx: Querier, key: string): Promise<ChainAnchor> {
  const hash = genesisHash(key);
  await tx.query(
    `insert into audit_chain_anchor (seq, hash, key_id, head_seq, mac) values (0, $1, $2, 0, $3)
     on conflict (only_row) do nothing`,
    [hash, keyId(key), anchorMac(key, 0n, hash, 0n)],
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

/** A claimed row's place in the chain, as a pass computed it. */
export interface RowSeal extends ChainLink {
  readonly id: string;
}

/** Seals a pass's batch in one statement, not one update per row. */
export async function sealRows(tx: Querier, seals: readonly RowSeal[]): Promise<void> {
  if (seals.length === 0) return;
  await tx.query(
    `update audit_events a set chain_seq = v.seq, chain_hash = v.hash
     from unnest($1::text[], $2::bigint[], $3::bytea[]) as v(id, seq, hash) where a.id = v.id`,
    [seals.map((s) => s.id), seals.map((s) => s.seq.toString()), seals.map((s) => s.hash)],
  );
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

/** A canonical `at` (`YYYY-MM-DDTHH:MM:SS.ffffffZ`) is before `cutoff`. Truncating it to the millisecond is exact against a `Date`. */
function olderThan(at: string | null, cutoff: Date): boolean {
  if (at === null) return false;
  const ms = Date.parse(`${at.slice(0, 23)}Z`);
  return Number.isFinite(ms) && ms < cutoff.getTime();
}

/** The link `sealed` should carry after `prev`, or undefined when none can be built (a seq out of range). */
function expectedLink(key: string, prev: ChainLink, sealed: SealedRow): Buffer | undefined {
  try {
    return link(key, prev.hash, sealed.seq, sealed.row);
  } catch (error) {
    /* c8 ignore next 2 -- link throws only RangeError */
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

/**
 * Retention with a chain key (audit-chain spec §3.3): deletes sealed rows from the oldest end of the
 * chain only, and only rows whose links it has checked, so `at` is never trusted on its own. A batch
 * reads the first `limit` sealed rows after the anchor through the canonical path ({@link sealedPage}),
 * recomputes each link from the anchor, and ends its deletable prefix at the first of:
 * - a skipped seq (a gap) or a link that does not match: nothing past it is deleted, and `stops` logs
 *   one error for that seq, since only verify can say what happened there;
 * - a row with `at >= cutoff`;
 * - a row whose forward-queue entry another transaction holds (the forwarder, perhaps waiting on its
 *   sink), so the batch never waits on a send while it holds the chain's lock.
 *
 * The anchor moves to the last deleted row's `(seq, hash)` in the same transaction, keeping its key id
 * and `head_seq`, with its new MAC. Unsealed rows are never touched: they go once sealed and past the
 * cutoff. A late row (sealed after a row with a newer `at`) waits behind that row: a little extra
 * storage, never a gap.
 *
 * It only tries the chain's lock: while a sealing pass holds it, the batch deletes nothing and the sweep
 * resumes next time, so a long backlog sweep never starves the sealer. An anchor whose MAC fails this
 * key's check (edited, or built by another key) is never moved: the batch deletes nothing, and verify
 * reports it. Returns how many rows went.
 */
export async function deleteSealedBefore(
  db: Database,
  key: string,
  cutoff: Date,
  limit: number,
  stops: RetentionStopLog,
): Promise<number> {
  return db.transaction(async (tx) => {
    if (!(await tryLockChain(tx))) return 0;
    const anchor = await readAnchor(tx);
    if (anchor === undefined || !anchorMacValid(key, anchor)) return 0;
    const old: SealedRow[] = [];
    let prev: ChainLink = { seq: anchor.seq, hash: anchor.hash };
    for (const sealed of await sealedPage(tx, anchor.seq, limit)) {
      const next = prev.seq + 1n;
      // Seqs are unique and above the anchor here, so a row that is not `next` lies past a gap.
      if (sealed.seq !== next) {
        stops.stoppedAt(next);
        break;
      }
      const expected = expectedLink(key, prev, sealed);
      if (expected === undefined || !Buffer.isBuffer(sealed.hash) || !expected.equals(sealed.hash)) {
        stops.stoppedAt(sealed.seq);
        break;
      }
      if (!olderThan(sealed.row.at, cutoff)) break;
      old.push(sealed);
      prev = sealed;
    }
    const last = (await unheldByForwarder(tx, old)).at(-1);
    if (last === undefined) return 0;
    // Under the lock nothing is sealed meanwhile, and every seq up to `last` was just checked present.
    const deleted = await tx.query('delete from audit_events where chain_seq > $1 and chain_seq <= $2', [
      anchor.seq.toString(),
      last.seq.toString(),
    ]);
    await tx.query('update audit_chain_anchor set seq = $1, hash = $2, mac = $3', [
      last.seq.toString(),
      last.hash,
      anchorMac(key, last.seq, last.hash, anchor.headSeq),
    ]);
    return deleted.rowCount ?? 0;
  });
}

/**
 * Locks the prefix's forward-queue rows (`skip locked`), so the delete's cascade never waits, and ends
 * the prefix just before the first row whose queue entry another transaction holds.
 */
async function unheldByForwarder(tx: Querier, prefix: readonly SealedRow[]): Promise<readonly SealedRow[]> {
  const ids = prefix.flatMap((sealed) => (sealed.row.id === null ? [] : [sealed.row.id]));
  if (ids.length === 0) return prefix;
  const queued = (
    await tx.query<{ id: string }>('select event_id as id from audit_forward_queue where event_id = any($1::text[])', [
      ids,
    ])
  ).rows.map((row) => row.id);
  if (queued.length === 0) return prefix;
  const locked = await tx.query<{ id: string }>(
    'select event_id as id from audit_forward_queue where event_id = any($1::text[]) for update skip locked',
    [queued],
  );
  const mine = new Set(locked.rows.map((row) => row.id));
  const held = new Set(queued.filter((id) => !mine.has(id)));
  const firstHeld = prefix.findIndex((sealed) => sealed.row.id !== null && held.has(sealed.row.id));
  return firstHeld === -1 ? prefix : prefix.slice(0, firstHeld);
}
