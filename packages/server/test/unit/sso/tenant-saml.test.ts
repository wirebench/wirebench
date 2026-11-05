/**
 * Each tenant's SAML provider (hosted edition spec §22.12) is built on its own entity ID and ACS URL, which come from
 * its primary URL (§23.5): a renamed tenant, or one whose custom name went live or away, gets a provider on its new
 * URLs, not the one cached under its old ones.
 */
import { describe, expect, it } from 'vitest';
import type { TenantSettings } from '../../../src/settings/service.js';
import type { SsoUrls } from '../../../src/sso/env.js';
import { TenantSamlProviders } from '../../../src/sso/tenant-saml.js';
import { scopeOf, type TenantScope } from '../../../src/tenancy/scope.js';
import { idpMetadata } from '../../helpers/saml-idp.js';

const ID = '00000000-0000-4000-8000-0000000000a1';

function providersFor(): { providers: TenantSamlProviders; built: () => number } {
  let reads = 0;
  const settings = {
    of: () => {
      reads += 1;
      return Promise.resolve({ idpMetadataXml: idpMetadata(), displayName: 'SSO', clockSkewSeconds: 120 });
    },
    onChanged: () => undefined,
  } as unknown as TenantSettings;
  const urlsFor = (scope: TenantScope): SsoUrls => {
    const host = scope.customHost ?? `${scope.slug}.example.test`;
    const base = `https://${host}/api/v1/auth/saml`;
    return {
      entityId: `${base}/metadata`,
      acsUrl: `${base}/acs`,
      browserAcsUrl: `${base}/browser-acs`,
      scimBaseUrl: '',
    };
  };
  const providers = new TenantSamlProviders({ settings, urlsFor, log: () => ({ warn: () => undefined }) });
  return { providers, built: () => reads };
}

describe('the tenant SAML providers', () => {
  it('builds again for a renamed tenant, on its new URLs, and keeps one per name otherwise', async () => {
    const { providers, built } = providersFor();
    const before = await providers.samlFor(scopeOf({ id: ID, slug: 'acme' }));
    expect(await providers.samlFor(scopeOf({ id: ID, slug: 'acme' }))).toBe(before);
    const after = await providers.samlFor(scopeOf({ id: ID, slug: 'acme-gmbh' }));
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(await providers.samlFor(scopeOf({ id: ID, slug: 'acme-gmbh' }))).toBe(after);
    expect(built()).toBe(2);
  });

  it('builds again when the primary host changes: a custom name going live, then going away', async () => {
    const { providers, built } = providersFor();
    const plain = await providers.samlFor(scopeOf({ id: ID, slug: 'acme' }));
    const live = await providers.samlFor(scopeOf({ id: ID, slug: 'acme', customHost: 'sso.acme.test' }));
    expect(live).toBeDefined();
    expect(live).not.toBe(plain);
    expect(await providers.samlFor(scopeOf({ id: ID, slug: 'acme', customHost: 'sso.acme.test' }))).toBe(live);
    const gone = await providers.samlFor(scopeOf({ id: ID, slug: 'acme' }));
    expect(gone).not.toBe(live);
    expect(built()).toBe(3);
  });
});
