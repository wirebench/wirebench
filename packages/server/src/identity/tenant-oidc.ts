/**
 * Each tenant's OIDC client in hosted mode (hosted edition spec §22.12): built on the first sign-in from the
 * tenant's `oidc` setting, by discovery under the egress rule, and kept for an hour or until the setting changes on
 * any instance. A tenant with no setting has none, and its OIDC routes answer as a server without OIDC. A failed
 * discovery is kept for {@link DISCOVERY_FAILURE_TTL_MS}, so a run of sign-in starts does not each ask the issuer
 * again; the first after that tries again.
 *
 * The client is the tenant's own, so the issuer an ID token must name is the tenant's, and linking by a verified
 * email (`linking.ts`) only ever trusts that tenant's provider.
 */
import type { TenantSettings } from '../settings/service.js';
import type { TenantScope } from '../tenancy/scope.js';
import type { OidcProvider, OidcSettings } from './oidc.js';

/** How long a discovered client is kept (spec §22.12). */
export const DISCOVERY_TTL_MS = 60 * 60 * 1000;
/** How long a failed discovery is answered as failed before the next sign-in tries again. */
export const DISCOVERY_FAILURE_TTL_MS = 30 * 1000;

export interface TenantOidcDeps {
  readonly settings: TenantSettings;
  readonly discover: (settings: OidcSettings) => Promise<OidcProvider>;
  readonly allowInsecure: boolean;
  readonly egress: NonNullable<OidcSettings['egress']>;
  readonly now: () => number;
}

export class TenantOidcProviders {
  readonly #cache = new Map<
    string,
    { readonly at: number; readonly ttl: number; readonly provider: Promise<OidcProvider | undefined> }
  >();

  constructor(private readonly deps: TenantOidcDeps) {
    deps.settings.onChanged(({ tenantId }) => {
      if (tenantId === undefined) this.#cache.clear();
      else this.#cache.delete(tenantId);
    });
  }

  /** `scope`'s client, or `undefined` when the tenant has no OIDC setting. Rejects when discovery fails. */
  providerFor(scope: TenantScope): Promise<OidcProvider | undefined> {
    const now = this.deps.now();
    const held = this.#cache.get(scope.tenantId);
    if (held !== undefined && now - held.at < held.ttl) return held.provider;
    const provider = this.#build(scope);
    const entry = { at: now, ttl: DISCOVERY_TTL_MS, provider };
    this.#cache.set(scope.tenantId, entry);
    provider.catch(() => {
      // Kept, failed, from when it failed: a setting change still drops it at once.
      if (this.#cache.get(scope.tenantId) === entry)
        this.#cache.set(scope.tenantId, { at: this.deps.now(), ttl: DISCOVERY_FAILURE_TTL_MS, provider });
    });
    return provider;
  }

  async #build(scope: TenantScope): Promise<OidcProvider | undefined> {
    const setting = await this.deps.settings.of(scope, 'oidc');
    if (setting === undefined) return undefined;
    return this.deps.discover({
      issuer: setting.issuer,
      clientId: setting.clientId,
      clientSecret: setting.clientSecret,
      scopes: setting.scopes,
      allowInsecure: this.deps.allowInsecure,
      egress: this.deps.egress,
    });
  }
}
