/**
 * Each tenant's SAML sign-in in hosted mode (hosted edition spec §22.12): a provider built from the IdP metadata the
 * tenant's server admin pasted into its `saml` setting (never fetched by the server), on the tenant's own entity ID
 * and ACS URLs, and kept until the setting changes on any instance or the tenant is renamed: its URLs are built from
 * its slug, so a provider is kept with the slug it was built for and built again for a new one. A tenant with no
 * setting, or whose metadata no longer parses, has none, and its SAML routes answer as a server without SAML.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { TenantSettings } from '../settings/service.js';
import type { TenantScope } from '../tenancy/scope.js';
import type { SamlState, SsoUrls } from './env.js';
import { parseIdpMetadata } from './saml-metadata.js';
import { samlProvider } from './saml.js';

export class TenantSamlProviders {
  readonly #cache = new Map<string, { readonly slug: string; readonly state: Promise<SamlState | undefined> }>();

  constructor(
    private readonly deps: {
      readonly settings: TenantSettings;
      readonly urlsFor: (scope: TenantScope) => SsoUrls;
      readonly log: () => Pick<FastifyBaseLogger, 'warn'>;
    },
  ) {
    deps.settings.onChanged(({ tenantId }) => {
      if (tenantId === undefined) this.#cache.clear();
      else this.#cache.delete(tenantId);
    });
  }

  samlFor(scope: TenantScope): Promise<SamlState | undefined> {
    const held = this.#cache.get(scope.tenantId);
    // A renamed tenant's request carries its new slug: the old provider's entity ID and ACS URL are not its own.
    if (held !== undefined && held.slug === scope.slug) return held.state;
    const entry = { slug: scope.slug, state: this.#build(scope) };
    this.#cache.set(scope.tenantId, entry);
    entry.state.catch(() => {
      if (this.#cache.get(scope.tenantId) === entry) this.#cache.delete(scope.tenantId);
    });
    return entry.state;
  }

  async #build(scope: TenantScope): Promise<SamlState | undefined> {
    const setting = await this.deps.settings.of(scope, 'saml');
    if (setting === undefined) return undefined;
    let metadata;
    try {
      metadata = parseIdpMetadata(setting.idpMetadataXml);
    } catch (error) {
      // Checked on save, so only a row written past the API lands here. The tenant and the reason, never the XML.
      this.deps
        .log()
        .warn(
          { tenantId: scope.tenantId, reason: error instanceof Error ? error.message : 'error' },
          'a tenant’s SAML metadata does not parse; SAML sign-in is off for it',
        );
      return undefined;
    }
    const urls = this.deps.urlsFor(scope);
    return {
      provider: samlProvider(metadata, {
        entityId: urls.entityId,
        acsUrl: urls.acsUrl,
        clockSkewMs: setting.clockSkewSeconds * 1000,
      }),
      claims: {
        ...(setting.emailAttribute !== undefined ? { emailAttribute: setting.emailAttribute } : {}),
        ...(setting.nameAttribute !== undefined ? { nameAttribute: setting.nameAttribute } : {}),
      },
    };
  }
}
