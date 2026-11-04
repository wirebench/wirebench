/**
 * The custom-domain claim and the name it holds (hosted edition spec §23.1, §23.3). Every function takes the tenant's
 * own `TenantQuerier`: `custom_domains` is under row-level security, and `tenant_hosts`, which is not, is only ever
 * written for the querier's own tenant, so no call here can touch another tenant's row or say who holds a name.
 *
 * `check:tenant-scope` keeps `tenant_hosts` to this folder and the directory's read for the resolver.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { problem } from '../problem.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import type { RecordVerdict } from './dns.js';
import type { DomainState } from './states.js';

/** What the last check saw, as `last_result` stores it. Never the token. */
export interface LastResult {
  readonly cname: RecordVerdict;
  readonly txt: RecordVerdict;
  /** The certificate probe's verdict (Part C), once the name is held. */
  readonly certificate?: RecordVerdict;
  /** Both records passed, but another tenant holds the name: the claim stays where it was (spec §23.1). */
  readonly heldElsewhere?: true;
  readonly message: string;
}

// A type alias, not an interface: `query<T>` wants `T` to have an index signature.
export type Claim = {
  readonly name: string;
  readonly token: string;
  readonly state: DomainState;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly checkedAt: Date | null;
  readonly verifiedAt: Date | null;
  readonly activeAt: Date | null;
  readonly failingSince: Date | null;
  readonly lastResult: LastResult | null;
};

/** One claim per tenant (spec §23.1): a second is refused until the first is removed. */
export const onePerTenant = () =>
  problem(
    'custom-domains-one-per-tenant',
    'This team already has a custom domain. Remove it before claiming another.',
    409,
  );

/** A claim's token: 32 random bytes, base64url, made once per claim (spec §23.1). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

const COLUMNS = `name, token, state, created_by as "createdBy", created_at as "createdAt", checked_at as "checkedAt",
  verified_at as "verifiedAt", active_at as "activeAt", failing_since as "failingSince", last_result as "lastResult"`;

/**
 * The tenant's claim, or undefined. With `forUpdate`, the row stays locked until the unit ends: the check and the
 * removal both take it, so a removal cannot slip between a check's read and its `hold`, and leave a name held with
 * no claim.
 */
export async function getClaim(
  tx: TenantQuerier,
  options: { readonly forUpdate?: boolean } = {},
): Promise<Claim | undefined> {
  const lock = options.forUpdate === true ? ' for update' : '';
  return (await tx.query<Claim>(`select ${COLUMNS} from custom_domains${lock}`)).rows[0];
}

/**
 * Claims `name` for the tenant, `pending`, with a new token. Any number of tenants may claim one name: only a pass
 * holds it (spec §23.1).
 *
 * @throws WirebenchError `custom-domains-one-per-tenant` (409) when the tenant has a claim already.
 */
export async function claim(
  tx: TenantQuerier,
  input: { readonly name: string; readonly createdBy: string | null; readonly now: Date },
): Promise<Claim> {
  const inserted = await tx.query<Claim>(
    `insert into custom_domains (name, token, created_by, created_at) values ($1, $2, $3, $4)
     on conflict (tenant_id) do nothing returning ${COLUMNS}`,
    [input.name, newToken(), input.createdBy, input.now],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw onePerTenant();
  return row;
}

/** The fields a check writes. `failingSince` is written as given, so leaving `failing` clears it. */
export interface CheckRecord {
  readonly state: DomainState;
  readonly lastResult: LastResult;
  readonly checkedAt: Date;
  readonly failingSince: Date | null;
  /** Set when the claim enters `verified`; otherwise kept. */
  readonly verifiedAt?: Date;
  /** Set when the claim enters `active`; otherwise kept. */
  readonly activeAt?: Date;
}

/**
 * Writes a check's outcome to the claim whose token is `token`: a claim removed and made again since the check began
 * has another token, so the stale outcome changes nothing. Answers whether a row was written.
 */
export async function record(tx: TenantQuerier, token: string, check: CheckRecord): Promise<boolean> {
  const written = await tx.query(
    `update custom_domains set state = $2, last_result = $3::jsonb, checked_at = $4, failing_since = $5,
       verified_at = coalesce($6, verified_at), active_at = coalesce($7, active_at)
     where token = $1`,
    [
      token,
      check.state,
      JSON.stringify(check.lastResult),
      check.checkedAt,
      check.failingSince,
      check.verifiedAt ?? null,
      check.activeAt ?? null,
    ],
  );
  return written.rowCount === 1;
}

/**
 * Holds `name` for the querier's tenant: `held` when it now holds it (or already did), `held-elsewhere` when another
 * tenant does, never saying which. An `insert … on conflict do nothing` on the host's primary key, so two tenants
 * holding one name at once hold it exactly once: the second waits for the first's unit and then finds the row.
 */
export async function hold(tx: TenantQuerier, name: string): Promise<'held' | 'held-elsewhere'> {
  const tenantId = tx.scope.tenantId;
  const inserted = await tx.query('insert into tenant_hosts (host, tenant_id) values ($1, $2) on conflict do nothing', [
    name,
    tenantId,
  ]);
  if (inserted.rowCount === 1) return 'held';
  const own = await tx.query('select 1 from tenant_hosts where host = $1 and tenant_id = $2', [name, tenantId]);
  return own.rowCount === 1 ? 'held' : 'held-elsewhere';
}

/** Releases `name` if the querier's tenant holds it; another tenant's row is left alone. */
export async function release(tx: TenantQuerier, name: string): Promise<void> {
  await tx.query('delete from tenant_hosts where host = $1 and tenant_id = $2', [name, tx.scope.tenantId]);
}

/** Marks the tenant's own row for `name` live (certificate seen) or not. Answers whether it holds the name. */
export async function setLive(tx: TenantQuerier, name: string, live: boolean): Promise<boolean> {
  const updated = await tx.query('update tenant_hosts set live = $3 where host = $1 and tenant_id = $2', [
    name,
    tx.scope.tenantId,
    live,
  ]);
  return updated.rowCount === 1;
}

/** Removes the tenant's claim, releasing its name first. Answers the removed claim, or undefined when there was none. */
export async function removeClaim(tx: TenantQuerier): Promise<Claim | undefined> {
  // Locked, so a check that holds the name commits first and the release below sees its row.
  const existing = await getClaim(tx, { forUpdate: true });
  if (existing === undefined) return undefined;
  await release(tx, existing.name);
  await tx.query('delete from custom_domains where token = $1', [existing.token]);
  return existing;
}

/** The addresses the claim's mail goes to: the tenant's enabled server admins. */
export async function serverAdminEmails(tx: TenantQuerier): Promise<readonly string[]> {
  const rows = await tx.query<{ email: string }>(
    'select email from users where server_admin and disabled_at is null order by email_lower',
  );
  return rows.rows.map((row) => row.email);
}

/** One row of the operator's list (`admin domains list`, spec §23.6). No token. */
export interface ClaimListing {
  readonly slug: string;
  readonly name: string;
  readonly state: DomainState;
  readonly checkedAt: Date | null;
}

/** Every tenant's claim, each read in its own tenant's unit (spec §19.8 guard 6). */
export async function listAll(
  tenancy: Pick<Tenancy, 'forEachTenant'>,
  log: Pick<FastifyBaseLogger, 'error'>,
): Promise<readonly ClaimListing[]> {
  const listing: ClaimListing[] = [];
  await tenancy.forEachTenant(
    'custom-domains-list',
    async (tx, scope) => {
      const found = await getClaim(tx);
      if (found !== undefined) {
        listing.push({ slug: scope.slug, name: found.name, state: found.state, checkedAt: found.checkedAt });
      }
    },
    log,
  );
  return listing;
}
