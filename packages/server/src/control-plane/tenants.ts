/**
 * The tenants' lifecycle (hosted edition spec §22.2, §22.4, §22.7, §22.8, §22.11, §22.14): create, set the edition,
 * suspend, resume, rename, and ask for or cancel a deletion. Each verb is one control transaction on the control role,
 * which alone writes `tenants` and the slug tables. After it commits:
 *
 * 1. the tenant's own audit chain gets `tenant.<verb>`, in the tenant's unit on the app role, through the audit
 *    module's hook (`recordAudit`), like every per-tenant write (§22.2: the control role writes no scoped table);
 * 2. the directory's change is told, which reloads this process's tenant map and drops its data keys, and, through
 *    `shareTenancyCaches`, announces `tenantsChanged` on the bus, so every other instance does the same (§20.3).
 *
 * The audit row comes after the commit because the two are on different roles: a failed audit write leaves the change
 * made and throws, so the operator sees it. The tenant's map and keys are told last, whatever the audit did.
 */
import type { AuditAction, AuditDetails } from '@wirebench/engine';
import { recordAudit, type AuditSource, type ServerHooks } from '../context.js';
import { problem } from '../problem.js';
import {
  TENANT_COLUMNS,
  type EditionSource,
  type SuspendedReason,
  type TenantEdition,
  type TenantRow,
} from '../tenancy/directory.js';
import type { TenantScope } from '../tenancy/scope.js';
import { RESERVED_SLUGS } from '../tenancy/slugs.js';
import { tenantWritesOf, type Tenancy } from '../tenancy/tenancy.js';
import type { ControlDb } from './control-db.js';
import { claimSlug, type ControlTx } from './slugs.js';

/** How long an old slug still redirects to the new one after a rename (spec §22.8). */
export const REDIRECT_DAYS = 30;
/** How long after it is asked a deletion runs (spec §22.11). */
export const DELETION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The most seats a tenant may have: the signup's own upper bound (spec §22.6), the operator's too. */
export const MAX_SEATS = 100_000;

/** A hosted edition: `community` is never one (spec §22.4). */
export type HostedEdition = Exclude<TenantEdition, 'community'>;

export interface LifecycleDeps {
  readonly control: ControlDb;
  readonly tenancy: Tenancy;
  /** The audit hook is on these; the CLI builds its own as `admin` does. */
  readonly hooks: ServerHooks;
  readonly now?: () => Date;
}

/** Who acts, for the audit row: the operator's command line, or (later parts) a server admin or the billing path. */
export interface LifecycleActor {
  readonly source: AuditSource;
  /** `'operator'`, or a user id: what `deletion_requested_by` holds. */
  readonly by: string;
}

/** The operator's command line (spec §22.14): the system actor, with `by: 'operator'` in every row's details. */
export const OPERATOR: LifecycleActor = { source: { actor: { kind: 'system' } }, by: 'operator' };

/** The billing path (spec §22.5): the webhook and the grace sweep, with `by: 'billing'` in every row's details. */
export const BILLING: LifecycleActor = { source: { actor: { kind: 'system' } }, by: 'billing' };

/**
 * A change made in a caller's control transaction (the billing path's): once that transaction committed, `after()`
 * writes the tenant's audit row and tells the directory, as each verb here does after its own.
 */
export interface PendingChange {
  readonly row: TenantRow;
  after(): Promise<void>;
}

/** Suspends with `$2` at `$3`, keeping the first suspension's time. */
const SUSPEND = `status = 'suspended', suspended_reason = $2,
  suspended_at = case when status = 'suspended' then suspended_at else $3::timestamptz end`;
const RESUME = `status = 'active', suspended_reason = null, suspended_at = null`;

export interface NewHostedTenant {
  readonly slug: string;
  readonly name: string;
  readonly edition: HostedEdition;
  readonly seats?: number;
  readonly editionSource: Exclude<EditionSource, 'license'>;
  /** An import's tenant starts suspended, `importing` (spec §22.10). */
  readonly suspendedReason?: SuspendedReason;
}

/** What `setEdition` changes to: the operator's edition, or back to the subscription's (`--subscription`). */
export type EditionChange =
  | {
      readonly edition: HostedEdition;
      /** `null`: no limit, the edition's default (`--seats unlimited`). Absent keeps the seats. */ readonly seats?:
        number | null;
    }
  | { readonly subscription: true };

/** A tenant as `admin tenant list` shows it: its row, with its subscription's status when it has one. */
export interface TenantListing extends TenantRow {
  readonly subscriptionStatus: string | null;
}

const MESSAGES = {
  unknown: (slug: string) => `no tenant has the slug "${slug}"`,
};

function unknownTenant(slug: string): Error {
  return problem('control-plane-tenant-unknown', MESSAGES.unknown(slug), 404);
}

function checkSeats(seats: number | undefined): void {
  if (seats !== undefined && (!Number.isInteger(seats) || seats < 1 || seats > MAX_SEATS)) {
    throw problem('control-plane-seats-invalid', `seats must be a whole number from 1 to ${String(MAX_SEATS)}`, 400);
  }
}

function checkEdition(edition: string): asserts edition is HostedEdition {
  if (edition !== 'team' && edition !== 'enterprise') {
    throw problem('control-plane-edition-invalid', 'a hosted edition is team or enterprise', 400);
  }
}

/**
 * The tenant `slug` names, locked for this transaction: never the default one, whose reserved slug no hosted tenant
 * has, so a reserved slug is unknown here.
 */
async function lockedTenant(tx: ControlTx, slug: string): Promise<TenantRow> {
  if (RESERVED_SLUGS.has(slug)) throw unknownTenant(slug);
  const rows = await tx.query<TenantRow & Record<string, unknown>>(
    `select ${TENANT_COLUMNS} from tenants where slug = $1 for update`,
    [slug],
  );
  const row = rows.rows[0];
  if (row === undefined) throw unknownTenant(slug);
  return row;
}

function refuseDeleting(row: TenantRow): void {
  if (row.status === 'deleting') {
    throw problem('control-plane-tenant-deleting', `the tenant "${row.slug}" is being deleted`, 409);
  }
}

export class TenantLifecycle {
  readonly #deps: LifecycleDeps;
  readonly #writes: ReturnType<typeof tenantWritesOf>;
  readonly #now: () => Date;

  constructor(deps: LifecycleDeps) {
    this.#deps = deps;
    this.#writes = tenantWritesOf(deps.tenancy);
    this.#now = deps.now ?? (() => new Date());
  }

  /** Every tenant but the default one, oldest first, with its subscription's status. Names no user. */
  async list(): Promise<TenantListing[]> {
    const rows = await this.#deps.control.query<TenantListing & Record<string, unknown>>(
      `select x.*, (select s.status from subscriptions s where s.tenant_id = x.id::uuid) as "subscriptionStatus"
       from (select ${TENANT_COLUMNS}, created_at from tenants where slug <> 'default') x
       order by x.created_at, x.id`,
    );
    return rows.rows;
  }

  /**
   * A new hosted tenant (spec §22.14's `create`; §22.6's signup and §22.10's import later): the slug claimed under the
   * slug lock, then `TenantAdmin.create` in the same transaction, which makes the data key.
   */
  async create(input: NewHostedTenant, actor: LifecycleActor = OPERATOR): Promise<TenantRow & { scope: TenantScope }> {
    checkEdition(input.edition);
    checkSeats(input.seats);
    const created = await this.#deps.control.transaction(async (tx) => {
      await claimSlug(tx, input.slug);
      return this.#writes.create(tx, {
        slug: input.slug,
        name: input.name,
        edition: input.edition,
        editionSource: input.editionSource,
        ...(input.seats !== undefined ? { seats: input.seats } : {}),
        ...(input.suspendedReason !== undefined
          ? { status: 'suspended' as const, suspendedReason: input.suspendedReason }
          : {}),
      });
    });
    await this.#after(created.scope, actor, 'tenant.created', {
      slug: created.slug,
      edition: created.edition,
      seats: created.seats,
      editionSource: created.editionSource,
    });
    return created;
  }

  /**
   * The operator's edition and seats (source `operator`), or with `{ subscription: true }` back to what the tenant's
   * subscription says (source `subscription`, edition `team`, its seats).
   *
   * @throws WirebenchError `control-plane-no-subscription` for `--subscription` on a tenant without one
   */
  async setEdition(slug: string, change: EditionChange, actor: LifecycleActor = OPERATOR): Promise<TenantRow> {
    if ('edition' in change) {
      checkEdition(change.edition);
      checkSeats(change.seats ?? undefined);
    }
    const row = await this.#deps.control.transaction(async (tx) => {
      const tenant = await lockedTenant(tx, slug);
      refuseDeleting(tenant);
      if ('edition' in change) {
        return this.#update(
          tx,
          tenant.id,
          `edition = $2, seats = case when $4::boolean then $3::integer else seats end, edition_source = 'operator'`,
          [change.edition, change.seats ?? null, change.seats !== undefined],
        );
      }
      const subscription = await tx.query<{ seats: number }>(
        'select seats from subscriptions where tenant_id = $1::uuid',
        [tenant.id],
      );
      const seats = subscription.rows[0]?.seats;
      if (seats === undefined) {
        throw problem('control-plane-no-subscription', `the tenant "${slug}" has no subscription to go back to`, 409);
      }
      return this.#update(tx, tenant.id, `edition = 'team', seats = $2, edition_source = 'subscription'`, [seats]);
    });
    await this.#after(await this.#scope(row), actor, 'tenant.edition_set', {
      edition: row.edition,
      seats: row.seats,
      editionSource: row.editionSource,
    });
    return row;
  }

  /** Suspends with `reason` (the operator's by default, spec §22.7); a suspended tenant takes the new reason. */
  async suspend(
    slug: string,
    reason: SuspendedReason = 'operator',
    actor: LifecycleActor = OPERATOR,
  ): Promise<TenantRow> {
    const row = await this.#deps.control.transaction(async (tx) => {
      const tenant = await lockedTenant(tx, slug);
      refuseDeleting(tenant);
      return this.#update(tx, tenant.id, SUSPEND, [reason, this.#now()]);
    });
    await this.#after(await this.#scope(row), actor, 'tenant.suspended', { reason });
    return row;
  }

  /** Resumes, clearing any reason (spec §22.14). `undefined` when the tenant was not suspended: nothing changed. */
  async resume(slug: string, actor: LifecycleActor = OPERATOR): Promise<TenantRow | undefined> {
    const changed = await this.#deps.control.transaction(async (tx) => {
      const tenant = await lockedTenant(tx, slug);
      if (tenant.status !== 'suspended') return { row: tenant, was: undefined };
      const row = await this.#update(tx, tenant.id, RESUME, []);
      return { row, was: tenant.suspendedReason };
    });
    if (changed.was === undefined) return undefined;
    await this.#after(await this.#scope(changed.row), actor, 'tenant.resumed', { previousReason: changed.was });
    return changed.row;
  }

  /**
   * Asks for the deletion (spec §22.11): `deleting_at` {@link DELETION_DAYS} on. The tenant keeps working until then;
   * the job is Part F's. A deletion already asked for keeps its date: `undefined`, nothing changed.
   */
  async requestDeletion(slug: string, actor: LifecycleActor = OPERATOR): Promise<TenantRow | undefined> {
    const now = this.#now();
    const row = await this.#deps.control.transaction(async (tx) => {
      const tenant = await lockedTenant(tx, slug);
      refuseDeleting(tenant);
      if (tenant.deletionRequestedAt !== null) return undefined;
      return this.#update(
        tx,
        tenant.id,
        `deletion_requested_at = $2::timestamptz, deletion_requested_by = $3, deleting_at = $4::timestamptz`,
        [now, actor.by, new Date(now.getTime() + DELETION_DAYS * DAY_MS)],
      );
    });
    if (row === undefined) return undefined;
    await this.#after(await this.#scope(row), actor, 'tenant.deletion_requested', {
      deletingAt: row.deletingAt?.toISOString() ?? null,
    });
    return row;
  }

  /** Cancels an asked deletion before its job starts. `undefined` when none was asked for: nothing changed. */
  async cancelDeletion(slug: string, actor: LifecycleActor = OPERATOR): Promise<TenantRow | undefined> {
    const row = await this.#deps.control.transaction(async (tx) => {
      const tenant = await lockedTenant(tx, slug);
      refuseDeleting(tenant);
      if (tenant.deletionRequestedAt === null) return undefined;
      return this.#update(
        tx,
        tenant.id,
        'deletion_requested_at = null, deletion_requested_by = null, deleting_at = null',
        [],
      );
    });
    if (row === undefined) return undefined;
    await this.#after(await this.#scope(row), actor, 'tenant.deletion_cancelled', {});
    return row;
  }

  /**
   * Renames (spec §22.8): the new slug claimed as a signup's is, then in one control transaction `tenants.slug` moved
   * and the old slug retired, redirecting to the new one for {@link REDIRECT_DAYS}. An earlier rename's redirects
   * follow to the new name, so no old host points at a retired one. A retired slug is never written again.
   */
  async rename(
    slug: string,
    to: string,
    actor: LifecycleActor = OPERATOR,
  ): Promise<TenantRow & { scope: TenantScope }> {
    const now = this.#now();
    const row = await this.#deps.control.transaction(async (tx) => {
      const tenant = await lockedTenant(tx, slug);
      refuseDeleting(tenant);
      await claimSlug(tx, to);
      const updated = await this.#update(tx, tenant.id, 'slug = $2', [to]);
      await tx.query(
        'update tenant_slugs_retired set redirect_to = $2 where tenant_id = $1::uuid and redirect_to is not null',
        [tenant.id, to],
      );
      await tx.query(
        `insert into tenant_slugs_retired (slug, tenant_id, retired_at, redirect_to, redirect_until)
         values ($1, $2::uuid, $3::timestamptz, $4, now() + make_interval(days => $5::integer))`,
        [slug, tenant.id, now, to, REDIRECT_DAYS],
      );
      return updated;
    });
    const scope = await this.#scope(row);
    await this.#after(scope, actor, 'tenant.renamed', { from: slug, to });
    return { ...row, scope };
  }

  /**
   * The tenant `slug` names while an import made it and has not finished (suspended, `importing`, spec §22.10): the
   * one a crashed `admin tenant import` resumes. `undefined` otherwise.
   */
  async importing(slug: string): Promise<(TenantRow & { scope: TenantScope }) | undefined> {
    if (RESERVED_SLUGS.has(slug)) return undefined;
    const rows = await this.#deps.control.query<TenantRow & Record<string, unknown>>(
      `select ${TENANT_COLUMNS} from tenants
        where slug = $1 and status = 'suspended' and suspended_reason = 'importing'`,
      [slug],
    );
    const row = rows.rows[0];
    return row === undefined ? undefined : { ...row, scope: await this.#scope(row) };
  }

  /** The tenant with this id, whatever its status, for its own unit (the billing path's subscription row). */
  async tenantScope(id: string): Promise<TenantScope> {
    const scope = await this.#writes.scope(id);
    if (scope === undefined) throw problem('control-plane-tenant-unknown', 'no tenant has that id', 404);
    return scope;
  }

  /**
   * Suspends the tenant `id` in the caller's control transaction `tx`, which has locked its row (the billing path
   * and the grace sweep, spec §22.5). Commit, then run the change's `after()`.
   */
  async suspendWithin(
    tx: ControlTx,
    id: string,
    reason: SuspendedReason,
    actor: LifecycleActor,
  ): Promise<PendingChange> {
    const row = await this.#update(tx, id, SUSPEND, [reason, this.#now()]);
    return { row, after: async () => this.#after(await this.#scope(row), actor, 'tenant.suspended', { reason }) };
  }

  /** Resumes the suspended tenant `id` in `tx`, as {@link suspendWithin}: an `active` subscription's (spec §22.5). */
  async resumeWithin(tx: ControlTx, id: string, actor: LifecycleActor): Promise<PendingChange> {
    const was = (
      await tx.query<{ reason: SuspendedReason | null }>(
        'select suspended_reason as reason from tenants where id = $1::uuid',
        [id],
      )
    ).rows[0]?.reason;
    const row = await this.#update(tx, id, RESUME, []);
    return {
      row,
      after: async () => this.#after(await this.#scope(row), actor, 'tenant.resumed', { previousReason: was ?? null }),
    };
  }

  /**
   * A Team subscription's edition and seats on the tenant `id`, in `tx` (spec §22.4): only when its edition source is
   * `subscription`, and only when either changes; `undefined` otherwise, nothing changed.
   */
  async subscriptionEditionWithin(
    tx: ControlTx,
    id: string,
    seats: number,
    actor: LifecycleActor,
  ): Promise<PendingChange | undefined> {
    const rows = await tx.query<TenantRow & Record<string, unknown>>(
      `update tenants set edition = 'team', seats = $2
       where id = $1::uuid and edition_source = 'subscription' and (edition <> 'team' or seats is distinct from $2)
       returning ${TENANT_COLUMNS}`,
      [id, seats],
    );
    const row = rows.rows[0];
    if (row === undefined) return undefined;
    return {
      row,
      after: async () =>
        this.#after(await this.#scope(row), actor, 'tenant.edition_set', {
          edition: row.edition,
          seats: row.seats,
          editionSource: row.editionSource,
        }),
    };
  }

  async #update(tx: ControlTx, id: string, set: string, params: readonly unknown[]): Promise<TenantRow> {
    const rows = await tx.query<TenantRow & Record<string, unknown>>(
      `update tenants set ${set} where id = $1::uuid returning ${TENANT_COLUMNS}`,
      [id, ...params],
    );
    return rows.rows[0]!;
  }

  async #scope(row: TenantRow): Promise<TenantScope> {
    const scope = await this.#writes.scope(row.id);
    if (scope === undefined) throw unknownTenant(row.slug);
    return scope;
  }

  /** The audit row in the tenant's chain, then the directory's change: this process's map, and the bus. */
  async #after(scope: TenantScope, actor: LifecycleActor, action: AuditAction, details: AuditDetails): Promise<void> {
    try {
      await this.#deps.tenancy.db(scope).transaction((tx) =>
        recordAudit(this.#deps.hooks, tx, {
          ...actor.source,
          action,
          target: { kind: 'tenant', id: scope.tenantId },
          details: { ...details, by: actor.by },
        }),
      );
    } finally {
      this.#writes.changed();
    }
  }
}
