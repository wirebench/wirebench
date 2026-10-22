/**
 * The `${secret:name}` token: the file-visible form of a value stored in the keychain-backed
 * secret store. `name` is stable across machines (unlike the store's opaque `sec_…` ref) and is
 * what CI sets through `WIREBENCH_SECRET_<NAME>`. See docs/specs/2026-09-22-secret-scanning-design.md.
 *
 * Pure module: no I/O, no dependency on the rest of the engine.
 */

/** A secret name: a valid environment-variable suffix. */
export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The literal `${secret:name}` text to write into a project file in place of a value. */
export function secretToken(name: string): string {
  return `\${secret:${name}}`;
}

/** The pseudo-ref passed to a `GetSecret` resolver for a secret named `name`. */
export function secretPseudoRef(name: string): string {
  return `secret:${name}`;
}

/** The name inside a `secret:<name>` pseudo-ref, or `undefined` when `ref` isn't one. */
export function parseSecretPseudoRef(ref: string): string | undefined {
  return ref.startsWith('secret:') ? ref.slice('secret:'.length) : undefined;
}

/** The `WIREBENCH_SECRET_<NAME>` environment variable suffix for a secret named `name`. */
export function secretEnvName(name: string): string {
  return name.toUpperCase();
}
