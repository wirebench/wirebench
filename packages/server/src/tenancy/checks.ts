/**
 * Start-up checks (hosted edition spec §19.1, §19.4): the PostgreSQL version the composite keys need, and
 * whether the app role is one row-level security applies to.
 */
import { WirebenchError } from '@wirebench/engine';
import type { ServerMode } from '../config.js';
import type { Querier } from '../db/querier.js';

/** `on delete set null (column)` on a composite foreign key needs PostgreSQL 15. */
export const MIN_POSTGRES_VERSION_NUM = 150000;

export async function checkPostgresVersion(db: Querier): Promise<void> {
  const rows = await db.query<{ version: string }>("select current_setting('server_version_num') as version");
  const version = Number(rows.rows[0]?.version);
  if (!(version >= MIN_POSTGRES_VERSION_NUM)) {
    throw new WirebenchError(
      'server-postgres-too-old',
      `Wirebench Server needs PostgreSQL 15 or later; this database is version ${
        Number.isFinite(version) ? String(Math.floor(version / 10000)) : 'unknown'
      }`,
    );
  }
}

/** `self-hosted` until slice 6 lets an operator choose; tests build `hosted` directly (spec §19.1). */
export type { ServerMode };

export interface AppRoleReport {
  readonly role: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  /** Tables of the server's schema this role owns, itself or as a member of their owner. */
  readonly ownedTables: number;
}

export async function appRoleReport(db: Querier): Promise<AppRoleReport> {
  const rows = await db.query<{ role: string; superuser: boolean; bypassRls: boolean; ownedTables: number }>(
    // Through membership as well: a member of the owner owns its tables in the sense row-level security cares
    // about, and a member of a superuser or BYPASSRLS role can `set role` to it. `MEMBER` counts roles the
    // role could reach with `set role`, inherited or not.
    `select r.rolname as role,
        exists (select 1 from pg_roles s where s.rolsuper and pg_has_role(r.oid, s.oid, 'MEMBER')) as superuser,
        exists (select 1 from pg_roles b where b.rolbypassrls and pg_has_role(r.oid, b.oid, 'MEMBER')) as "bypassRls",
        (select count(*)::int from pg_class c
          where pg_has_role(r.oid, c.relowner, 'MEMBER') and c.relkind in ('r', 'p')
            and c.relnamespace = to_regnamespace(current_schema())) as "ownedTables"
      from pg_roles r where r.rolname = current_user`,
  );
  return rows.rows[0]!;
}

/**
 * Why row-level security cannot be relied on for the role, in words for the log; empty when it can. A superuser and
 * a `BYPASSRLS` role skip it; the tables' owner is under it since 0021 forces it, but may switch it off.
 */
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
  const message = `the database role ${report.role} ${reasons.join(', ')}, so row-level security cannot be relied on for it`;
  if (mode === 'hosted') throw new WirebenchError('tenancy-role-bypasses', `${message}; hosted mode refuses it`);
  warn(`${message}; see "Database roles" in the README to give the server an app role of its own`, {
    role: report.role,
    superuser: report.superuser,
    bypassRls: report.bypassRls,
    ownedTables: report.ownedTables,
  });
  return report;
}

export interface ControlRoleReport {
  readonly role: string;
  /** Its own attribute: the control role connects as itself, with `noinherit`, and needs BYPASSRLS directly. */
  readonly bypassRls: boolean;
  /** Itself, or through a role it may become. */
  readonly superuser: boolean;
  /** Tables anywhere in the database this role owns, itself or as a member of their owner. */
  readonly ownedTables: number;
}

/**
 * The control role's start-up check in hosted mode (spec §22.2), after the app role's: it must be a role of its own
 * (`control-plane-role-shared`), no superuser (`control-plane-role-superuser`), the owner of no table
 * (`control-plane-role-owns`), and have BYPASSRLS (`control-plane-role-no-bypass`). The first that fails refuses
 * start-up with its code. `names` are the app role and the owner of the server's schema.
 */
export async function checkControlRole(
  control: Querier,
  names: { readonly app: string; readonly owner: string },
): Promise<ControlRoleReport> {
  const report = (
    await control.query<{ role: string; superuser: boolean; bypassRls: boolean; ownedTables: number }>(
      `select r.rolname as role, r.rolbypassrls as "bypassRls",
          exists (select 1 from pg_roles s where s.rolsuper and pg_has_role(r.oid, s.oid, 'MEMBER')) as superuser,
          (select count(*)::int from pg_class c
            where pg_has_role(r.oid, c.relowner, 'MEMBER') and c.relkind in ('r', 'p')
              and c.relnamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)) as "ownedTables"
        from pg_roles r where r.rolname = current_user`,
    )
  ).rows[0]!;
  const refuse = (code: string, why: string): never => {
    throw new WirebenchError(code, `the control role ${report.role} ${why}; hosted mode refuses it`);
  };
  if (report.role === names.app || report.role === names.owner) {
    refuse('control-plane-role-shared', 'is the app role or the owner, and must be a role of its own');
  }
  if (report.superuser) refuse('control-plane-role-superuser', 'is a superuser');
  if (report.ownedTables > 0) refuse('control-plane-role-owns', `owns ${String(report.ownedTables)} tables`);
  if (!report.bypassRls) refuse('control-plane-role-no-bypass', 'does not have BYPASSRLS');
  return report;
}
