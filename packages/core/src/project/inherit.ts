/**
 * "Inherit", as a send input means it: a setting a request leaves unset takes the value of the next
 * level up. Shared by the REST and gRPC send inputs, which climb the same ladder (request, API,
 * project, preference), so it lives in core (protocol modules spec §7.2).
 */

/** The first of `values` that is not `undefined`, which is what "inherit" means. */
export function inherited<T>(...values: readonly (T | undefined)[]): T | undefined {
  return values.find((value) => value !== undefined);
}
