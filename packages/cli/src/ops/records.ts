/** A plain JSON object: not `null`, not an array. The CLI's one copy of this check. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
