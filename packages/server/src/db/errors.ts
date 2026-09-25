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

export function isForeignKeyViolation(error: unknown): boolean {
  return shape(error)?.code === '23503';
}
