/** The SCIM scope's failed-attempt keys lead with the tenant (hosted edition spec §19.8 guard 5; Task 15 review M1). */
import { describe, expect, it } from 'vitest';
import { scimAuditKey, scimLimiterKey } from '../../../src/sso/scim/plugin.js';

const from = (tenantId: string) => ({ ip: '203.0.113.7', tenant: { tenantId } });

// The buckets themselves: test/integration/operations/limiters-moved.test.ts.
describe('SCIM failed-attempt keys', () => {
  it('name the tenant first in both keys', () => {
    expect(scimLimiterKey(from('tenant-1'))).toBe('tenant-1:scim:ip:203.0.113.7');
    expect(scimAuditKey(from('tenant-1'))).toBe('tenant-1:203.0.113.7');
    expect(scimAuditKey(from('tenant-2'))).not.toBe(scimAuditKey(from('tenant-1')));
  });
});
