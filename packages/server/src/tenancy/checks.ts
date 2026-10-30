/**
 * Start-up checks (hosted edition spec §19.1, §19.4): the PostgreSQL version the composite keys need, and
 * whether the app role is one row-level security applies to.
 */
import { WirebenchError } from '@wirebench/engine';
import type { ServerMode } from '../config.js';
import type { Querier } from '../context.js';

/** `on delete set null (column)` on a composite foreign key needs PostgreSQL 15. */
export const MIN_POSTGRES_VERSION_NUM = 150000;

export async function checkPostgresVersion(db: Querier): Promise<void> {
  const rows = await db.query<{ version: string }>("select current_setting('server_version_num') as version");
  const version = Number(rows.rows[0]?.version);
  if (!(version >= MIN_POSTGRES_VERSION_NUM)) {
    throw new WirebenchError(
      'server-postgres-too-old',
      `Wirebench Server needs PostgreSQL 15 or later; this database is version ${String(Math.floor(version / 10000))}`,
    );
  }
}

/** `self-hosted` until slice 6 lets an operator choose; tests build `hosted` directly (spec §19.1). */
export type { ServerMode };

export interface AppRoleReport {
  readonly role: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  /** Tables of the server's schema this role owns. */
  readonly ownedTables: number;
}

export async function appRoleReport(db: Querier): Promise<AppRoleReport> {
  const rows = await db.query<{ role: string; superuser: boolean; bypassRls: boolean; ownedTables: number }>(
    `select r.rolname as role, r.rolsuper as superuser, r.rolbypassrls as "bypassRls",
        (select count(*)::int from pg_class c
          where c.relowner = r.oid and c.relkind in ('r', 'p')
            and c.relnamespace = to_regnamespace(current_schema())) as "ownedTables"
      from pg_roles r where r.rolname = current_user`,
  );
  return rows.rows[0]!;
}

/** Why row-level security would not apply to the role, in words for the log; empty when it applies. */
export function bypassReasons(report: AppRoleReport): string[] {
  return [
    ...(report.superuser ? ['is a superuser'] : []),
    ...(report.bypassRls ? ['has BYPASSRLS'] : []),
    ...(report.ownedTables > 0 ? [`owns ${String(report.ownedTables)} of the server's tables`] : []),
  ];
}

/**
 * The owner ruling of 2026-10-29: an app role that bypasses the policy refuses start-up in hosted mode
 * (`tenancy-role-bypasses`) and is a warning in self-hosted mode, where one tenant has nobody to leak to and
 * an upgrade must not stop a working server. A one-role installation warns here, as the spec intends.
 */
export async function checkAppRole(
  db: Querier,
  mode: ServerMode,
  warn: (message: string, details: Record<string, unknown>) => void,
): Promise<AppRoleReport> {
  const report = await appRoleReport(db);
  const reasons = bypassReasons(report);
  if (reasons.length === 0) return report;
  const message = `the database role ${report.role} ${reasons.join(', ')}, so row-level security does not apply to it`;
  if (mode === 'hosted') throw new WirebenchError('tenancy-role-bypasses', `${message}; hosted mode refuses it`);
  warn(`${message}; see "Database roles" in the README to give the server an app role of its own`, {
    role: report.role,
    superuser: report.superuser,
    bypassRls: report.bypassRls,
    ownedTables: report.ownedTables,
  });
  return report;
}
