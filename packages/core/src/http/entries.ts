/**
 * A row of a name/value table: a path or query parameter, a header, a form field, a metadata entry.
 *
 * In `http/` because REST, gRPC and WebSocket requests all keep such rows, and a protocol folder
 * imports core and itself, never another protocol (protocol modules spec §7.2). `rest/model.ts`
 * re-exports both names, so REST code and the public exports read them where they always did.
 */

/**
 * One row of a params, query, headers or form table: a name, a value, and whether it takes part
 * in the next send. Rows keep author order and may repeat a name — two `X-Trace` headers and two
 * `tag=` parameters are both legal on the wire, so neither is deduplicated here.
 *
 * `enabled` is always present in memory and written to disk only when `false`, so a file stays
 * quiet about the common case (see `project/serialize.ts`).
 */
export interface KeyValueEntry {
  readonly name: string;
  readonly value: string;
  readonly enabled: boolean;
  /** Free-form note, carried over from an imported definition's parameter description. */
  readonly description?: string;
}

/** Creates an enabled {@link KeyValueEntry}. */
export function entry(
  name: string,
  value: string,
  options?: { readonly enabled?: boolean; readonly description?: string },
): KeyValueEntry {
  return {
    name,
    value,
    enabled: options?.enabled ?? true,
    ...(options?.description !== undefined ? { description: options.description } : {}),
  };
}
