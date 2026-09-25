/**
 * The PostgreSQL error classes modules map to problems. `pg` puts the SQLSTATE on `code` and the
 * violated constraint's (or unique index's) name on `constraint`; the migrations name every one a
 * route maps, so a race answers with the same problem as the pre-check it slipped past.
 */
interface PgErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

function shape(error: unknown): PgErrorShape | undefined {
  return typeof error === 'object' && error !== null ? error : undefined;
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const e = shape(error);
  return e?.code === '23505' && e.constraint === constraint;
}

/**
 * `23503` (a foreign-key violation) — the row a racing delete removed out from under a write that
 * checked access first. `constraint`, when given, narrows to the specific foreign key so a route
 * with more than one only maps the one it means.
 */
export function isForeignKeyViolation(error: unknown, constraint?: string): boolean {
  const e = shape(error);
  if (e?.code !== '23503') return false;
  return constraint === undefined || e.constraint === constraint;
}
