// packages/server/src/licensing/repo.ts
/**
 * The `license` table (licensing spec §4.2): one row per tenant, read and written in that tenant's unit
 * (hosted edition spec §19.8 guard 2). `server_identity` is server-wide and has no tenant, so its reader
 * takes a plain querier.
 */
import type { Querier } from '../context.js';
import { MISSING_SERVER_ID } from '../tenancy/directory.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';

export interface StoredLicenseRow {
  /** The text as installed; re-verified on every read, so a later version applies its own keys and schema. */
  readonly text: string;
  readonly licenseId: string;
  readonly installedBy: string | null;
  readonly installedAt: string;
}

type Raw = Record<string, unknown>;
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export async function storedLicense(db: TenantQuerier): Promise<StoredLicenseRow | undefined> {
  const raw = (
    await db.query<Raw>(
      `select text, license_id as "licenseId", installed_by as "installedBy", installed_at as "installedAt" from license`,
    )
  ).rows[0];
  if (raw === undefined) return undefined;
  const at = raw['installedAt'];
  return {
    text: text(raw['text']) ?? '',
    licenseId: text(raw['licenseId']) ?? '',
    installedBy: text(raw['installedBy']),
    installedAt: at instanceof Date ? at.toISOString() : (text(at) ?? ''),
  };
}

/** Replaces any stored license (§3.6). */
export async function putLicense(
  db: TenantQuerier,
  input: { readonly text: string; readonly licenseId: string; readonly installedBy: string | null; readonly at: Date },
): Promise<void> {
  await db.query(
    `insert into license (singleton, text, license_id, installed_by, installed_at) values (true, $1, $2, $3, $4)
     on conflict (tenant_id) do update set text = excluded.text, license_id = excluded.license_id,
       installed_by = excluded.installed_by, installed_at = excluded.installed_at`,
    [input.text, input.licenseId, input.installedBy, input.at],
  );
}

/** `false` when nothing was stored. */
export async function deleteLicense(db: TenantQuerier): Promise<boolean> {
  return ((await db.query('delete from license')).rowCount ?? 0) > 0;
}

/** Defined beside the tenant directory, whose start-up load reports it too; re-exported for this module's callers. */
export { MISSING_SERVER_ID };

/** The id migration 0013 minted (license-binding spec §3.1). Never re-minted: a missing row is an error. */
export async function serverId(db: Querier): Promise<string> {
  const row = (await db.query<{ id: string }>('select server_id::text as id from server_identity')).rows[0];
  if (row === undefined) throw new Error(MISSING_SERVER_ID);
  return row.id;
}
