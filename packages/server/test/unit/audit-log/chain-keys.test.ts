/** Which key seals a tenant's chain (hosted edition spec §19.7). */
import { describe, expect, it } from 'vitest';
import { keyId } from '../../../src/audit-log/chain/canonical.js';
import { chainKeys, derivedChainKey } from '../../../src/audit-log/chain/keys.js';
import { scopeOf } from '../../../src/tenancy/scope.js';

const KEY = 'test-chain-key-0123456789abcdefghij';
const DEFAULT = scopeOf({ id: '00000000-0000-4000-8000-00000000000d', slug: 'default' });
const OTHER = scopeOf({ id: '00000000-0000-4000-8000-00000000000e', slug: 'other' });
const isDefault = (scope: { readonly tenantId: string }) => scope.tenantId === DEFAULT.tenantId;

describe('chain keys', () => {
  it('derives a key per tenant: never the configured one, never another tenant’s, the same every time', () => {
    const a = derivedChainKey(KEY, DEFAULT.tenantId);
    const b = derivedChainKey(KEY, OTHER.tenantId);
    expect(a).not.toBe(b);
    expect(a).not.toBe(KEY);
    expect(derivedChainKey(KEY, DEFAULT.tenantId)).toBe(a);
    expect(derivedChainKey('another-chain-key-0123456789abcdefgh', DEFAULT.tenantId)).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(keyId(a)).not.toBe(keyId(KEY));
  });

  it('self-hosted: the default tenant keeps the configured key; every other tenant gets a derived one', () => {
    const keys = chainKeys(KEY, 'self-hosted', isDefault);
    expect(keys(DEFAULT)).toBe(KEY);
    expect(keys(OTHER)).toBe(derivedChainKey(KEY, OTHER.tenantId));
  });

  it('hosted: every tenant’s key is derived, the default tenant’s included, so the configured key seals nothing', () => {
    let asked = 0;
    const keys = chainKeys(KEY, 'hosted', (scope) => {
      asked++;
      return isDefault(scope);
    });
    expect(keys(DEFAULT)).toBe(derivedChainKey(KEY, DEFAULT.tenantId));
    expect(keys(OTHER)).toBe(derivedChainKey(KEY, OTHER.tenantId));
    expect(asked).toBe(0);
  });
});
