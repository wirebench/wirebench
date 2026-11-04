/**
 * The retired slugs' live redirects (hosted edition spec §22.8): after a rename, the old host answers `308` to the new
 * one for 30 days. The resolver loads them with the tenant map, on the app role, which holds `select` on these three
 * columns of `tenant_slugs_retired` and nothing else of the control plane's tables (`grants.ts`). This file is the one
 * outside `src/control-plane/` that `check:tenant-scope` lets name that table, and it only reads it.
 */
import type { Querier } from '../db/querier.js';

export interface LiveRedirect {
  /** The old slug. */
  readonly slug: string;
  /** The slug it redirects to. */
  readonly to: string;
  readonly until: Date;
}

/** Every redirect still live now; none on a schema before `0023`. */
export async function liveRedirects(db: Querier): Promise<LiveRedirect[]> {
  const exists = await db.query<{ exists: boolean }>(
    "select to_regclass('tenant_slugs_retired') is not null as exists",
  );
  if (exists.rows[0]?.exists !== true) return [];
  const rows = await db.query<{ slug: string; to: string; until: Date }>(
    `select slug, redirect_to as "to", redirect_until as "until" from tenant_slugs_retired
     where redirect_to is not null and redirect_until > now()`,
  );
  return rows.rows;
}
