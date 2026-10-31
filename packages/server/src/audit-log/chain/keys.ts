/**
 * Which key seals a tenant's chain (hosted edition spec §19.7). Self-hosted, the default tenant keeps
 * `WIREBENCH_SERVER_AUDIT_CHAIN_KEY`, under which its rows are already sealed. Every other tenant, and in hosted
 * mode every tenant, the default one included, has a key HKDF derives from it and the tenant id, so a tenant's
 * export verifies with its own key and never hands out another chain's. The anchor's `key_id` records the
 * fingerprint of whichever key it is, as before.
 */
import { hkdfSync } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import type { TenantScope } from '../../tenancy/scope.js';

/** HKDF's salt for a tenant's chain key; changing it breaks every derived chain. */
export const CHAIN_KEY_SALT = 'wirebench-audit-chain';

/** `HKDF-SHA256(chainKey, salt, tenantId)`, 32 bytes as hex: the chain functions take the key as text. */
export function derivedChainKey(chainKey: string, tenantId: string): string {
  return Buffer.from(hkdfSync('sha256', chainKey, CHAIN_KEY_SALT, tenantId, 32)).toString('hex');
}

/** A tenant's chain key. It stays in this process, like the configured one. */
export type ChainKeys = (scope: TenantScope) => string;

/** `isDefault` is asked only in self-hosted mode; hosted mode derives every key. */
export function chainKeys(
  chainKey: string,
  mode: ServerConfig['mode'],
  isDefault: (scope: TenantScope) => boolean,
): ChainKeys {
  return (scope) => (mode !== 'hosted' && isDefault(scope) ? chainKey : derivedChainKey(chainKey, scope.tenantId));
}
