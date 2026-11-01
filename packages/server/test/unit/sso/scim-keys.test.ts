/** The SCIM scope's failed-attempt keys lead with the tenant (hosted edition spec §19.8 guard 5; Task 15 review M1). */
import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../../src/identity/rate-limit.js';
import { scimAuditKey, scimLimiterKey } from '../../../src/sso/scim/plugin.js';

const from = (tenantId: string) => ({ ip: '203.0.113.7', tenant: { tenantId } });

describe('SCIM failed-attempt keys', () => {
  it('give one address two buckets in two tenants: ten failures in one leave the other whole', () => {
    // The module's limiter: ten failures a minute.
    const limiter = new RateLimiter({ capacity: 10, refillPerMs: 10 / 60_000, now: () => 0 });
    for (let i = 0; i < 10; i++) expect(limiter.take(scimLimiterKey(from('tenant-1'))).allowed).toBe(true);
    expect(limiter.take(scimLimiterKey(from('tenant-1'))).allowed).toBe(false);
    expect(limiter.take(scimLimiterKey(from('tenant-2'))).allowed).toBe(true);
  });

  it('name the tenant first in both keys', () => {
    expect(scimLimiterKey(from('tenant-1'))).toBe('tenant-1:scim:ip:203.0.113.7');
    expect(scimAuditKey(from('tenant-1'))).toBe('tenant-1:203.0.113.7');
    expect(scimAuditKey(from('tenant-2'))).not.toBe(scimAuditKey(from('tenant-1')));
  });
});
