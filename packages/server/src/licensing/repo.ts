// packages/server/src/licensing/repo.ts
/** The one-row `license` table (licensing spec §4.2). Raw SQL over `Querier`, like every module's repo. */
import type { Querier } from '../context.js';

export interface StoredLicenseRow {
  /** The text as installed; re-verified on every read, so a later version applies its own keys and schema. */
  readonly text: string;
  readonly licenseId: string;
  readonly installedBy: string | null;
  readonly installedAt: string;
}

type Raw = Record<string, unknown>;
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export async function storedLicense(db: Querier): Promise<StoredLicenseRow | undefined> {
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
  db: Querier,
  input: { readonly text: string; readonly licenseId: string; readonly installedBy: string | null; readonly at: Date },
): Promise<void> {
  await db.query(
    `insert into license (singleton, text, license_id, installed_by, installed_at) values (true, $1, $2, $3, $4)
     on conflict (singleton) do update set text = excluded.text, license_id = excluded.license_id,
       installed_by = excluded.installed_by, installed_at = excluded.installed_at`,
    [input.text, input.licenseId, input.installedBy, input.at],
  );
}

/** `false` when nothing was stored. */
export async function deleteLicense(db: Querier): Promise<boolean> {
  return ((await db.query('delete from license')).rowCount ?? 0) > 0;
}
