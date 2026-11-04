/**
 * Slice 8's migration (hosted edition spec §23.3): `0024` adds the custom-domain claims and the hosts they hold. Like
 * slice 5's, it belongs to no module and scopes its tenant table with `0020`'s `tenant_scope()`, so `allMigrations`
 * adds it only with the tenancy migrations. It runs in every mode, so the schema never depends on the edition.
 */
import { fileURLToPath } from 'node:url';

export const CUSTOM_DOMAINS_MIGRATIONS_DIR = fileURLToPath(
  new URL('../../migrations/custom-domains/', import.meta.url),
);
