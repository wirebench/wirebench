/**
 * The keychain references (`sec_…`) a model carries, wherever they sit: an auth's `passwordRef`, a
 * `tokenRef`, a `valueRef`, an OAuth client secret. Team secrets back-fill the vault from them (§3.1).
 * Pure: no I/O.
 */

/** The shape `SecretStore` mints (`sec_` and lowercase hex); a little looser, so an older ref still counts. */
export const SECRET_REF_PATTERN = /^sec_[0-9a-z]{16,64}$/;

export function secretRefsInValue(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (current: unknown): void => {
    if (typeof current === 'string') {
      if (SECRET_REF_PATTERN.test(current)) {
        found.add(current);
      }
    } else if (Array.isArray(current)) {
      current.forEach(visit);
    } else if (current !== null && typeof current === 'object' && !ArrayBuffer.isView(current)) {
      Object.values(current).forEach(visit);
    }
  };
  visit(value);
  return [...found];
}
