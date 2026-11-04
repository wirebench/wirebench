/**
 * The two URLs of a tenant with a custom name (hosted edition spec §23.5): `tenantUrl(config, request)` is the host
 * the request came on, slug or custom; `primaryUrl(config, scope)` is the custom name while it is live, else the slug's,
 * and `tenantUrl(config, scope)` is the primary. Self-hosted, both are the public URL.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, type ServerConfig } from '../../../src/config.js';
import { scopeOf } from '../../../src/tenancy/scope.js';
import { primaryUrl, tenantUrl } from '../../../src/tenancy/urls.js';

const ENV = { WIREBENCH_SERVER_DATABASE_URL: 'postgres://u:p@db/x', WIREBENCH_SERVER_PUBLIC_URL: 'https://wb.test' };
const selfHosted = loadConfig(ENV, '0.0.0-test');
const hosted: ServerConfig = { ...selfHosted, mode: 'hosted', appDomain: 'example.test' };
const ID = '00000000-0000-4000-8000-00000000000a';
const PLAIN = scopeOf({ id: ID, slug: 'acme' });
const CUSTOM = scopeOf({ id: ID, slug: 'acme', customHost: 'wb.customer.test' });

describe('two names, one tenant (spec §23.5)', () => {
  it('a scope carries its live custom host, and only a non-empty one', () => {
    expect(CUSTOM.customHost).toBe('wb.customer.test');
    expect(PLAIN.customHost).toBeUndefined();
    expect('customHost' in scopeOf({ id: ID, slug: 'acme', customHost: null })).toBe(false);
  });

  it('primaryUrl is the custom name while live, else the slug, and tenantUrl of a scope is the primary', () => {
    expect(primaryUrl(hosted, PLAIN)).toBe('https://acme.example.test');
    expect(primaryUrl(hosted, CUSTOM)).toBe('https://wb.customer.test');
    expect(primaryUrl(hosted, { tenant: CUSTOM })).toBe('https://wb.customer.test');
    expect(tenantUrl(hosted, CUSTOM)).toBe('https://wb.customer.test');
    expect(tenantUrl(hosted, PLAIN)).toBe('https://acme.example.test');
  });

  it('tenantUrl of a request is the host it came on: the slug or the custom name', () => {
    expect(tenantUrl(hosted, { tenant: CUSTOM, hostname: 'acme.example.test' })).toBe('https://acme.example.test');
    expect(tenantUrl(hosted, { tenant: CUSTOM, hostname: 'WB.Customer.Test' })).toBe('https://wb.customer.test');
    expect(tenantUrl(hosted, { tenant: CUSTOM, hostname: 'wb.customer.test:443' })).toBe('https://wb.customer.test');
    // A host that is neither (the resolver lets none through) reads as the slug's, never as itself.
    expect(tenantUrl(hosted, { tenant: CUSTOM, hostname: 'evil.test' })).toBe('https://acme.example.test');
    expect(tenantUrl(hosted, { tenant: PLAIN, hostname: 'wb.customer.test' })).toBe('https://acme.example.test');
  });

  it('self-hosted, both are the public URL', () => {
    expect(primaryUrl(selfHosted, CUSTOM)).toBe('https://wb.test');
    expect(tenantUrl(selfHosted, { tenant: CUSTOM, hostname: 'wb.customer.test' })).toBe('https://wb.test');
  });
});
