/**
 * Each tenant's SAML provider (hosted edition spec §22.12) is built on its own entity ID and ACS URL, which come from
 * its slug: a renamed tenant gets a provider on its new URLs, not the one cached under its old name.
 */
import { describe, expect, it } from 'vitest';
import type { TenantSettings } from '../../../src/settings/service.js';
import type { SsoUrls } from '../../../src/sso/env.js';
import { TenantSamlProviders } from '../../../src/sso/tenant-saml.js';
import { scopeOf, type TenantScope } from '../../../src/tenancy/scope.js';
import { idpMetadata } from '../../helpers/saml-idp.js';

const ID = '00000000-0000-4000-8000-0000000000a1';

describe('the tenant SAML providers', () => {
  it('builds again for a renamed tenant, on its new URLs, and keeps one per name otherwise', async () => {
    const asked: string[] = [];
    const settings = {
      of: () => Promise.resolve({ idpMetadataXml: idpMetadata(), displayName: 'SSO', clockSkewSeconds: 120 }),
      onChanged: () => undefined,
    } as unknown as TenantSettings;
    const urlsFor = (scope: TenantScope): SsoUrls => {
      asked.push(scope.slug);
      const base = `https://${scope.slug}.example.test/api/v1/auth/saml`;
      return {
        entityId: `${base}/metadata`,
        acsUrl: `${base}/acs`,
        browserAcsUrl: `${base}/browser-acs`,
        scimBaseUrl: '',
      };
    };
    const providers = new TenantSamlProviders({ settings, urlsFor, log: () => ({ warn: () => undefined }) });
    const before = await providers.samlFor(scopeOf({ id: ID, slug: 'acme' }));
    expect(await providers.samlFor(scopeOf({ id: ID, slug: 'acme' }))).toBe(before);
    const after = await providers.samlFor(scopeOf({ id: ID, slug: 'acme-gmbh' }));
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(asked).toEqual(['acme', 'acme-gmbh']);
    expect(await providers.samlFor(scopeOf({ id: ID, slug: 'acme-gmbh' }))).toBe(after);
  });
});
