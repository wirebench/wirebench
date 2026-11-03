/**
 * Slice 5's migration (hosted edition spec §20.2, §20.6, §20.7): `0022` adds the instance table, the limiter's
 * buckets, the send slots and the share locations. Like the tenancy migrations it belongs to no module, and it
 * scopes its tables with `0020`'s `tenant_scope()`, so `allMigrations` adds it only with them.
 */
import { fileURLToPath } from 'node:url';

export const OPERATIONS_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/operations/', import.meta.url));
