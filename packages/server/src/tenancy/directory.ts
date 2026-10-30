/**
 * The tenants (hosted edition spec §19.2, §19.8 guard 6). `list()` is the one unscoped read of the server: the
 * job loop and the resolver (Task 6) start from it. `tenants` has no `tenant_id` and no policy.
 *
 * `defaultScope()` is the installation's own tenant, named by `server_identity.default_tenant_id`. Outside
 * `src/tenancy/` only the admin command line's self-hosted default may call it (`check:tenant-scope`): a route
 * or module that reached for it would pass every one-tenant test.
 */
import { WirebenchError } from '@wirebench/engine';
import type { Querier } from '../context.js';
import { scopeOf, type TenantScope } from './scope.js';

export type TenantEdition = 'community' | 'team' | 'enterprise';
export type TenantStatus = 'active' | 'suspended' | 'deleting';

export interface TenantRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly edition: TenantEdition;
  readonly status: TenantStatus;
  readonly region: 'eu';
}

export interface NewTenant {
  readonly slug: string;
  readonly name: string;
  readonly edition?: TenantEdition;
  readonly region?: 'eu';
}

const COLUMNS = 'id::text as id, slug, name, edition, status, region';

export class TenantDirectory {
  private defaultTenant: TenantScope | undefined;
  private readonly listeners: (() => void)[] = [];

  constructor(private readonly db: Querier) {}

  /**
   * Reads the default tenant. Start-up calls it after the migrations; `defaultScope()` needs it. `false` on a
   * schema without `0020`, which only a test's partial module set leaves.
   */
  async load(): Promise<boolean> {
    const exists = await this.db.query<{ exists: boolean }>("select to_regclass('tenants') is not null as exists");
    if (exists.rows[0]?.exists !== true) return false;
    const rows = await this.db.query<{ id: string; slug: string }>(
      `select t.id::text as id, t.slug from server_identity s join tenants t on t.id = s.default_tenant_id`,
    );
    const row = rows.rows[0];
    if (row === undefined) throw new WirebenchError('tenancy-no-default', 'the server has no default tenant');
    this.defaultTenant = scopeOf(row);
    return true;
  }

  defaultScope(): TenantScope {
    if (this.defaultTenant === undefined) {
      throw new WirebenchError('tenancy-not-loaded', 'the tenant directory was used before it was loaded');
    }
    return this.defaultTenant;
  }

  /** Every tenant not being deleted, as scopes: what the job loop serves. */
  async list(): Promise<TenantScope[]> {
    const rows = await this.db.query<{ id: string; slug: string }>(
      "select id::text as id, slug from tenants where status <> 'deleting' order by created_at, id",
    );
    return rows.rows.map(scopeOf);
  }

  /**
   * The tenants a hosted `Host` may name (spec §19.5): active, and never the default tenant, whose slug no
   * name matches. A suspended or deleting tenant answers `404` in slice 4.
   */
  async resolvable(): Promise<TenantScope[]> {
    const rows = await this.db.query<{ id: string; slug: string }>(
      `select t.id::text as id, t.slug from tenants t
       where t.status = 'active' and t.id is distinct from (select default_tenant_id from server_identity)`,
    );
    return rows.rows.map(scopeOf);
  }

  async get(id: string): Promise<(TenantRow & { readonly scope: TenantScope }) | undefined> {
    const rows = await this.db.query<TenantRow & Record<string, unknown>>(
      `select ${COLUMNS} from tenants where id = $1::uuid`,
      [id],
    );
    const row = rows.rows[0];
    return row === undefined ? undefined : { ...row, scope: scopeOf(row) };
  }

  /** A new tenant. Only tests call it in slice 4; slice 7's control plane is its real caller. */
  async create(input: NewTenant): Promise<TenantRow & { readonly scope: TenantScope }> {
    const rows = await this.db.query<TenantRow & Record<string, unknown>>(
      `insert into tenants (id, slug, name, edition, region) values (gen_random_uuid(), $1, $2, $3, $4)
       returning ${COLUMNS}`,
      [input.slug, input.name, input.edition ?? 'community', input.region ?? 'eu'],
    );
    const row = rows.rows[0]!;
    for (const listener of this.listeners) listener();
    return { ...row, scope: scopeOf(row) };
  }

  /** Called after every write through this directory, in this process (the resolver reloads its map). */
  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      const at = this.listeners.indexOf(listener);
      if (at !== -1) this.listeners.splice(at, 1);
    };
  }
}
