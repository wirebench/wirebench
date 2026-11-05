/**
 * Each tenant's OIDC client (hosted edition spec §22.12): a failed discovery is answered as failed for a short while,
 * so a run of sign-in starts does not each ask the issuer again; after that, and after a setting change, it asks.
 */
import { describe, expect, it } from 'vitest';
import { DISCOVERY_FAILURE_TTL_MS, TenantOidcProviders } from '../../../src/identity/tenant-oidc.js';
import type { OidcProvider } from '../../../src/identity/oidc.js';
import type { SettingsChange, TenantSettings } from '../../../src/settings/service.js';
import { scopeOf } from '../../../src/tenancy/scope.js';

const ACME = scopeOf({ id: '00000000-0000-4000-8000-0000000000a1', slug: 'acme' });

describe('the tenant OIDC providers', () => {
  it('keeps a failed discovery for a short while, then tries again', async () => {
    let at = 0;
    let asked = 0;
    let fails = true;
    const listeners: ((change: SettingsChange) => void)[] = [];
    const settings = {
      of: () =>
        Promise.resolve({
          issuer: 'https://idp.test',
          clientId: 'c',
          clientSecret: 's',
          scopes: ['openid'],
          displayName: 'SSO',
        }),
      onChanged: (listener: (change: SettingsChange) => void) => listeners.push(listener),
    } as unknown as TenantSettings;
    const providers = new TenantOidcProviders({
      settings,
      discover: () => {
        asked++;
        return fails
          ? Promise.reject(new Error('down'))
          : Promise.resolve({ issuer: 'https://idp.test' } as OidcProvider);
      },
      allowInsecure: false,
      egress: 'unchecked',
      now: () => at,
    });
    await expect(providers.providerFor(ACME)).rejects.toThrow('down');
    at += DISCOVERY_FAILURE_TTL_MS - 1;
    await expect(providers.providerFor(ACME)).rejects.toThrow('down');
    expect(asked).toBe(1);
    // A setting change asks at once.
    listeners.forEach((listener) => listener({ tenantId: ACME.tenantId }));
    await expect(providers.providerFor(ACME)).rejects.toThrow('down');
    expect(asked).toBe(2);
    at += DISCOVERY_FAILURE_TTL_MS;
    fails = false;
    await expect(providers.providerFor(ACME)).resolves.toMatchObject({ issuer: 'https://idp.test' });
    expect(asked).toBe(3);
  });
});
