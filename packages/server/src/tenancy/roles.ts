/**
 * The app role (hosted edition spec §19.4): the role in `WIREBENCH_SERVER_DATABASE_URL`, which runs every
 * query and owns nothing, so row-level security applies to it. When `WIREBENCH_SERVER_MIGRATION_DATABASE_URL`
 * names a different role (the owner), the server connects as the owner first and calls `ensureAppRole`:
 * it creates the app role when it is missing and the owner may create roles, and it re-applies the grants
 * every time. Nothing moves ownership: the app role is a grantee.
 *
 * `admin tenancy role` runs the same statements, or prints them with `--print-sql` for an operator whose
 * owner may not create roles.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { WirebenchError } from '@wirebench/engine';
import type { Database, Querier } from '../context.js';
import { appRoleGrants } from './grants.js';

/** PostgreSQL's own default (`scram_iterations`), so a verifier made here costs what one made there does. */
export const SCRAM_ITERATIONS = 4096;

/**
 * A SCRAM-SHA-256 verifier for `password` (RFC 7677, in PostgreSQL's stored form). PostgreSQL stores a
 * `password` that is already a verifier as it is, so the statement never carries the password itself,
 * which `log_statement = ddl` would write to the database's log.
 *
 * The password is hashed as its UTF-8 bytes, without SASLprep: that is what the server's own client
 * (`pg`) sends, so the role signs in with exactly the password in the app URL.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = SCRAM_ITERATIONS): string {
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** The user a connection string names, or `undefined` when it is not a URL that names one. */
export function roleNameOf(url: string): string | undefined {
  try {
    const name = decodeURIComponent(new URL(url).username);
    return name === '' ? undefined : name;
  } catch {
    return undefined;
  }
}

/** The role and password a connection string names. Only the URL form is read; values are never echoed. */
export function appRoleOf(url: string): { readonly role: string; readonly password?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WirebenchError(
      'tenancy-app-url-invalid',
      'WIREBENCH_SERVER_DATABASE_URL is not a postgres:// URL; the app role is read from its user name',
    );
  }
  const role = decodeURIComponent(parsed.username);
  if (role === '') {
    throw new WirebenchError(
      'tenancy-app-url-invalid',
      'WIREBENCH_SERVER_DATABASE_URL names no user; it must name the app role',
    );
  }
  return parsed.password === '' ? { role } : { role, password: decodeURIComponent(parsed.password) };
}

export interface AppRolePlan {
  /** The app role, from the app URL. */
  readonly role: string;
  /** The connected owner (`current_user`). */
  readonly owner: string;
  /** The schema the grants are for: the owner's `current_schema()`. */
  readonly schema: string;
  readonly exists: boolean;
  /** `create role …` when the role is missing, then the grants. Idempotent, in order. */
  readonly statements: readonly string[];
}

/**
 * What `ensureAppRole` would run, read-only. The role is named with `format('%I')` and the verifier with
 * `format('%L')`, on the server, so the statement quotes them exactly as PostgreSQL does.
 */
export async function appRolePlan(owner: Querier, appUrl: string): Promise<AppRolePlan> {
  const { role, password } = appRoleOf(appUrl);
  const who = (
    await owner.query<{ owner: string; schema: string | null }>(
      'select current_user::text as owner, current_schema() as schema',
    )
  ).rows[0]!;
  if (who.schema === null) {
    throw new WirebenchError(
      'tenancy-no-schema',
      'the migration URL has no current schema; set a search_path whose first schema exists',
    );
  }
  if (who.owner === role) {
    throw new WirebenchError(
      'tenancy-app-role-is-owner',
      `WIREBENCH_SERVER_DATABASE_URL and WIREBENCH_SERVER_MIGRATION_DATABASE_URL both name ${role}; the app role must be another role`,
    );
  }
  const exists = ((await owner.query('select 1 from pg_roles where rolname = $1', [role])).rowCount ?? 0) > 0;
  const statements: string[] = [];
  if (!exists) {
    const created = await owner.query<{ sql: string }>(
      password === undefined
        ? "select format('create role %I login nosuperuser nobypassrls noinherit', $1::text) as sql"
        : "select format('create role %I login nosuperuser nobypassrls noinherit password %L', $1::text, $2::text) as sql",
      password === undefined ? [role] : [role, scramVerifier(password)],
    );
    statements.push(created.rows[0]!.sql);
  }
  statements.push(...appRoleGrants({ schema: who.schema, owner: who.owner, app: role }));
  return { role, owner: who.owner, schema: who.schema, exists, statements };
}

/** One lock for every server and `admin tenancy role` on a database, so two never create the role at once. */
const APP_ROLE_LOCK = "select pg_advisory_xact_lock(hashtext('wirebench.tenancy.app-role'))";

/**
 * Creates the app role when it is missing, then (re-)applies its grants, in one transaction as the owner.
 * A second run creates nothing and grants what is already granted. An owner that may not create roles
 * and finds the role missing gets `tenancy-role-not-creatable`, pointing at `--print-sql`.
 */
export async function ensureAppRole(owner: Database, appUrl: string): Promise<AppRolePlan> {
  return owner.transaction(async (tx) => {
    await tx.query(APP_ROLE_LOCK);
    const plan = await appRolePlan(tx, appUrl);
    if (!plan.exists) {
      const may = await tx.query<{ may: boolean }>(
        'select (rolsuper or rolcreaterole) as may from pg_roles where rolname = current_user',
      );
      if (may.rows[0]?.may !== true) {
        throw new WirebenchError(
          'tenancy-role-not-creatable',
          `the app role ${plan.role} does not exist and ${plan.owner} may not create roles; run wirebench-server admin tenancy role --print-sql and apply its statements as a role that may`,
        );
      }
    }
    for (const statement of plan.statements) await tx.query(statement);
    return plan;
  });
}
