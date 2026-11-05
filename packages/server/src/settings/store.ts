/**
 * `tenant_settings` (migration `0023`, hosted edition spec §22.12): one row per tenant and section, scoped by the
 * forced row-level policy, so every statement here runs in the tenant's unit.
 *
 * A section's secret fields are sealed as one JSON object, AES-256-GCM (`hooks/secret-box.ts`, the layout the users'
 * secrets use), under a key derived from the tenant's data key (spec §19.7) with HKDF-SHA256, salted for this use and
 * bound to the section's name: a sealed value copied into another section, or another tenant's row, does not open.
 * Nothing here returns a sealed value to a caller outside `service.ts`, which opens it for the modules only.
 */
import { hkdfSync } from 'node:crypto';
import { open, seal } from '../hooks/secret-box.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import { isSettingsSection, type SettingsSection } from './sections.js';

/** HKDF's salt for the settings key; changing it orphans every tenant's sealed settings. */
const SETTINGS_SALT = 'wirebench-tenant-settings';

/** One stored row, its sealed bytes still sealed. */
export interface StoredSection {
  readonly section: SettingsSection;
  readonly value: Readonly<Record<string, unknown>>;
  readonly sealed: Buffer | null;
  readonly updatedAt: Date;
  readonly updatedBy: string;
}

/** The key `section`'s secrets are sealed under in a tenant whose data key is `dataKey`. */
export function settingsKey(dataKey: Buffer, section: SettingsSection): Buffer {
  return Buffer.from(hkdfSync('sha256', dataKey, SETTINGS_SALT, section, 32));
}

export function sealSecret(
  dataKey: Buffer,
  section: SettingsSection,
  secret: Readonly<Record<string, string>>,
): Buffer {
  return seal(settingsKey(dataKey, section), JSON.stringify(secret));
}

/** @throws Error when the box does not open under this tenant's key for this section. */
export function openSecret(dataKey: Buffer, section: SettingsSection, sealed: Buffer): Record<string, string> {
  const parsed: unknown = JSON.parse(open(settingsKey(dataKey, section), sealed));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('a sealed setting is not an object');
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** Every section `tx`'s tenant has. A row of a section this build does not know is skipped. */
export async function readSections(tx: TenantQuerier): Promise<StoredSection[]> {
  const rows = await tx.query<{
    section: string;
    value: Record<string, unknown>;
    sealed: Buffer | null;
    updatedAt: Date;
    updatedBy: string;
  }>(
    'select section, value, sealed, updated_at as "updatedAt", updated_by as "updatedBy" from tenant_settings order by section',
  );
  return rows.rows.flatMap((row) =>
    isSettingsSection(row.section) ? [{ ...row, section: row.section } satisfies StoredSection] : [],
  );
}

export async function writeSection(
  tx: TenantQuerier,
  input: {
    readonly section: SettingsSection;
    readonly value: Readonly<Record<string, unknown>>;
    readonly sealed: Buffer | null;
    readonly updatedBy: string;
  },
): Promise<void> {
  await tx.query(
    `insert into tenant_settings (section, value, sealed, updated_by) values ($1, $2::jsonb, $3, $4)
     on conflict (tenant_id, section) do update
       set value = excluded.value, sealed = excluded.sealed, updated_at = now(), updated_by = excluded.updated_by`,
    [input.section, JSON.stringify(input.value), input.sealed, input.updatedBy],
  );
}

/** Whether there was a row to remove. */
export async function removeSection(tx: TenantQuerier, section: SettingsSection): Promise<boolean> {
  const result = await tx.query('delete from tenant_settings where section = $1', [section]);
  return (result.rowCount ?? 0) > 0;
}
