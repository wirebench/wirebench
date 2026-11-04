/**
 * The tenants (hosted edition spec §19.2, §19.8 guard 6). `list()` is the one unscoped read of the server: the
 * job loop and the resolver (Task 6) start from it. `tenants` has no `tenant_id` and no policy.
 *
 * `defaultScope()` is the installation's own tenant, named by `server_identity.default_tenant_id`. Outside
 * `src/tenancy/` only the admin command line's self-hosted default may call it (`check:tenant-scope`): a route
 * or module that reached for it would pass every one-tenant test.
 */
import { randomUUID } from 'node:crypto';
import { WirebenchError } from '@wirebench/engine';
import type { Querier } from '../db/querier.js';
import { liveRedirects, type LiveRedirect } from './redirects.js';
import type { TenantKeys } from './keys.js';
import { scopeOf, type TenantScope } from './scope.js';
import { checkSlug } from './slugs.js';
import type { TenantQuerier } from './tenant-db.js';

/**
 * A lost `server_identity` row. It holds the id licenses are bound to, so the advice is to restore it, never to
 * insert one; the licensing module's reader and the directory's start-up load both say so.
 */
export const MISSING_SERVER_ID =
  'the server_identity table has no row. It holds the id licenses are bound to; restore it from a backup instead of inserting a new one.';

export type TenantEdition = 'community' | 'team' | 'enterprise';
export type TenantStatus = 'active' | 'suspended' | 'deleting';
/** Who set the edition (spec §22.4): a license (self-hosted), a Team subscription, or the operator. */
export type EditionSource = 'license' | 'subscription' | 'operator';
/** Why a tenant is suspended (spec §22.7). */
export type SuspendedReason = 'unpaid' | 'canceled' | 'operator' | 'importing';

export interface TenantRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly edition: TenantEdition;
  readonly status: TenantStatus;
  readonly region: 'eu';
  /** The edition's seats in hosted mode (spec §22.4); `null` is no limit. A self-hosted tenant's license has its own. */
  readonly seats: number | null;
  readonly editionSource: EditionSource;
  readonly suspendedReason: SuspendedReason | null;
  readonly suspendedAt: Date | null;
  readonly deletionRequestedAt: Date | null;
  /** `'operator'` or a user id (spec §22.11). */
  readonly deletionRequestedBy: string | null;
  /** When the deletion job runs (spec §22.11). */
  readonly deletingAt: Date | null;
}

/**
 * A tenant on the hosted map (spec §22.7): its scope, and whether it serves or is suspended, with why. What the
 * resolver keeps per tenant, shared by every host name of it.
 */
export type HostedTenant =
  | { readonly scope: TenantScope; readonly status: 'active' }
  | { readonly scope: TenantScope; readonly status: 'suspended'; readonly reason: SuspendedReason };

export interface NewTenant {
  readonly slug: string;
  readonly name: string;
  readonly edition?: TenantEdition;
  readonly region?: 'eu';
  readonly seats?: number;
  readonly editionSource?: EditionSource;
  /** `suspended` needs a reason: an import creates its tenant `importing` (spec §22.10). */
  readonly status?: 'active' | 'suspended';
  readonly suspendedReason?: SuspendedReason;
}

/** Every column of {@link TenantRow}, in its names: what the directory and the control plane read a row with. */
export const TENANT_COLUMNS = `id::text as id, slug, name, edition, status, region, seats,
  edition_source as "editionSource", suspended_reason as "suspendedReason", suspended_at as "suspendedAt",
  deletion_requested_at as "deletionRequestedAt", deletion_requested_by as "deletionRequestedBy",
  deleting_at as "deletingAt"`;
const COLUMNS = TENANT_COLUMNS;

export class TenantDirectory {
  // `#` fields, so a module cannot reach the raw querier at run time either.
  #defaultTenant: TenantScope | undefined;
  readonly #listeners: (() => void)[] = [];
  readonly #db: Querier;

  /** `keys`: the process's data keys, which `TenantAdmin.create` makes a new tenant's key with. */
  constructor(db: Querier, keys?: TenantKeys) {
    this.#db = db;
    if (keys !== undefined) directoryKeys.set(this, keys);
  }

  /**
   * Reads the default tenant. Start-up calls it after the migrations; `defaultScope()` needs it. `false` on a
   * schema without `0020`, which only a test's partial module set leaves.
   */
  async load(): Promise<boolean> {
    const exists = await this.#db.query<{ exists: boolean }>("select to_regclass('tenants') is not null as exists");
    if (exists.rows[0]?.exists !== true) return false;
    const rows = await this.#db.query<{ id: string | null; slug: string | null }>(
      `select t.id::text as id, t.slug from server_identity s left join tenants t on t.id = s.default_tenant_id`,
    );
    const row = rows.rows[0];
    // No identity row at all is a lost row, never a fresh one: inserting a new one would mint a new server id,
    // and every license bound to the old one would stop verifying (Task 9 review M5).
    if (row === undefined) throw new WirebenchError('server-identity-missing', MISSING_SERVER_ID);
    if (row.id === null || row.slug === null) {
      throw new WirebenchError('tenancy-no-default', 'the server has no default tenant');
    }
    this.#defaultTenant = scopeOf({ id: row.id, slug: row.slug });
    return true;
  }

  defaultScope(): TenantScope {
    if (this.#defaultTenant === undefined) {
      throw new WirebenchError('tenancy-not-loaded', 'the tenant directory was used before it was loaded');
    }
    return this.#defaultTenant;
  }

  /**
   * The one tenant of a server whose `server_identity` row is gone, for the audit commands, the forensics path
   * that must still run on such a database: `undefined` unless exactly one tenant exists. Only a self-hosted
   * server has one tenant, and that one is its default.
   */
  async onlyTenant(): Promise<TenantScope | undefined> {
    const rows = await this.#db.query<{ id: string; slug: string }>(
      'select id::text as id, slug from tenants order by created_at, id limit 2',
    );
    return rows.rows.length === 1 ? scopeOf(rows.rows[0]!) : undefined;
  }

  /** Whether `scope` is the default tenant: a predicate, so a caller learns nothing it could serve. */
  isDefault(scope: TenantScope): boolean {
    return this.defaultScope().tenantId === scope.tenantId;
  }

  /** Every tenant not being deleted, as scopes: what the job loop serves. */
  async list(): Promise<TenantScope[]> {
    const rows = await this.#db.query<{ id: string; slug: string }>(
      "select id::text as id, slug from tenants where status <> 'deleting' order by created_at, id",
    );
    return rows.rows.map(scopeOf);
  }

  /**
   * The tenants a hosted `Host` names (spec §19.5, §22.7): active and suspended, with the status and the reason, and
   * never the default tenant, whose slug no name matches. A deleting tenant is not here, so it answers `404`. A
   * suspended row without a reason (written before `0023` named one) counts as the operator's.
   */
  async hosted(): Promise<HostedTenant[]> {
    const rows = await this.#db.query<{
      id: string;
      slug: string;
      status: 'active' | 'suspended';
      reason: SuspendedReason | null;
    }>(
      `select t.id::text as id, t.slug, t.status, t.suspended_reason as reason from tenants t
       where t.status in ('active', 'suspended') and t.id is distinct from (select default_tenant_id from server_identity)`,
    );
    return rows.rows.map((row) =>
      row.status === 'active'
        ? { scope: scopeOf(row), status: 'active' }
        : { scope: scopeOf(row), status: 'suspended', reason: row.reason ?? 'operator' },
    );
  }

  /**
   * The tenants the entry lists (spec §21.4), with each one's name: active only, and never the default tenant. A
   * suspended tenant is on the hosted map (it answers why it is suspended) but never in the entry's message.
   */
  async resolvableNamed(): Promise<{ readonly scope: TenantScope; readonly name: string }[]> {
    const rows = await this.#db.query<{ id: string; slug: string; name: string }>(
      `select t.id::text as id, t.slug, t.name from tenants t
       where t.status = 'active' and t.id is distinct from (select default_tenant_id from server_identity)
       order by t.created_at, t.id`,
    );
    return rows.rows.map((row) => ({ scope: scopeOf(row), name: row.name }));
  }

  /** The retired slugs' live redirects (spec §22.8), which the hosted map loads beside the tenants. */
  redirects(): Promise<LiveRedirect[]> {
    return liveRedirects(this.#db);
  }

  async get(id: string): Promise<(TenantRow & { readonly scope: TenantScope }) | undefined> {
    const rows = await this.#db.query<TenantRow & Record<string, unknown>>(
      `select ${COLUMNS} from tenants where id = $1::uuid`,
      [id],
    );
    const row = rows.rows[0];
    return row === undefined ? undefined : { ...row, scope: scopeOf(row) };
  }

  /** Tells the listeners a tenant was written in this process (the resolver reloads its map). */
  changed(): void {
    for (const listener of this.#listeners) listener();
  }

  /** Called after every write through {@link TenantAdmin}, in this process (the resolver reloads its map). */
  onChange(listener: () => void): () => void {
    this.#listeners.push(listener);
    return () => {
      const at = this.#listeners.indexOf(listener);
      if (at !== -1) this.#listeners.splice(at, 1);
    };
  }
}

/**
 * The edition and seats of the unit's own tenant (spec §22.4): what the license service reads in hosted mode, where
 * the tenant row, not a license, says them. The one read of `tenants` the licensing module makes, so it lives here,
 * where `check:tenant-scope` allows the table; it reads only the unit's tenant.
 *
 * @throws WirebenchError `tenancy-tenant-unknown` when the unit's tenant has no row
 */
export async function hostedEdition(
  tx: TenantQuerier,
): Promise<{ readonly edition: TenantEdition; readonly seats: number | null }> {
  const rows = await tx.query<{ edition: TenantEdition; seats: number | null }>(
    'select edition, seats from tenants where id = $1::uuid',
    [tx.scope.tenantId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw new WirebenchError('tenancy-tenant-unknown', 'the unit’s tenant has no row');
  return row;
}

/** Each directory's data keys, kept off the class so nothing outside this file reaches them through it. */
const directoryKeys = new WeakMap<TenantDirectory, TenantKeys>();

/**
 * Writes to the tenants (Task 5 review M8): kept off `ctx.tenancy`, so no module can create a tenant. Only
 * tests make one in slice 4; slice 7's control plane is its real user.
 */
export class TenantAdmin {
  readonly #db: Querier;
  readonly #directory: TenantDirectory;
  readonly #announce: boolean;

  /**
   * `announce: false` (the control plane, spec §22.2): `db` is a transaction not committed yet, so the directory's
   * change is told by the caller after the commit; told now, a reload would read the map without the new tenant.
   */
  constructor(db: Querier, directory: TenantDirectory, options: { readonly announce?: boolean } = {}) {
    this.#db = db;
    this.#directory = directory;
    this.#announce = options.announce ?? true;
  }

  /**
   * Creates a tenant, with its data key when the server has a root (spec §19.7). Without one the key stays null,
   * and the tenant gets it the first time the root exists.
   */
  async create(input: NewTenant): Promise<TenantRow & { readonly scope: TenantScope }> {
    // Spec §21.2: the one writer of a slug checks it before anything is written, reserved names included.
    const slug = checkSlug(input.slug);
    if (slug === 'slug-invalid')
      throw new WirebenchError('tenancy-slug-invalid', 'that slug is not a valid tenant slug');
    if (slug === 'slug-reserved') throw new WirebenchError('tenancy-slug-reserved', 'that slug is reserved');
    const status = input.status ?? 'active';
    if ((status === 'suspended') !== (input.suspendedReason !== undefined)) {
      throw new WirebenchError('tenancy-status-invalid', 'a suspended tenant needs a reason, and only a suspended one');
    }
    const id = randomUUID();
    const dataKey = (await directoryKeys.get(this.#directory)?.wrapNew(id)) ?? null;
    const rows = await this.#db.query<TenantRow & Record<string, unknown>>(
      `insert into tenants (id, slug, name, edition, region, data_key, seats, edition_source, status,
         suspended_reason, suspended_at)
       values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, case when $10::text is null then null else now() end)
       returning ${COLUMNS}`,
      [
        id,
        input.slug,
        input.name,
        input.edition ?? 'community',
        input.region ?? 'eu',
        dataKey,
        input.seats ?? null,
        input.editionSource ?? 'license',
        status,
        input.suspendedReason ?? null,
      ],
    );
    const row = rows.rows[0]!;
    if (this.#announce) this.#directory.changed();
    return { ...row, scope: scopeOf(row) };
  }
}
