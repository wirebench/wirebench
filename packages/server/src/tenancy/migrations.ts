/**
 * Slice 4's migrations (hosted edition spec §19.10): `0020` adds the tenants and `tenant_id` to every table.
 * They belong to no module: they scope every module's tables at once, so `allMigrations` adds them only to a
 * list that already reaches the version before them, which every production list does.
 */
import { fileURLToPath } from 'node:url';

export const TENANCY_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/tenancy/', import.meta.url));
