/**
 * The Kerberos auth a WSDL import is given, built once for every main-side caller: the definition
 * import (`engine-service.ts`), an interface's import, and what that import saves for its requests
 * (`project-host.ts`). Nothing but an optional SPN: the ticket comes from the signed-in session.
 */

/** `{ type: 'kerberos' }`, plus the SPN when one is given; a blank or whitespace SPN counts as unset. */
export function kerberosImportAuth(spn: string | undefined): { readonly type: 'kerberos'; readonly spn?: string } {
  const trimmed = spn?.trim();
  return trimmed === undefined || trimmed === '' ? { type: 'kerberos' } : { type: 'kerberos', spn: trimmed };
}

/**
 * A Kerberos configuration without its password reference.
 *
 * Off Windows an explicit account is refused by the engine whatever its password, so a re-fetch
 * there reads no keychain secret for it. The username and domain stay, so a fetch that does go to
 * the network is still refused, with the reason.
 */
export function withoutPasswordRef<T extends { readonly passwordRef?: string }>(auth: T): Omit<T, 'passwordRef'> {
  const copy: T = { ...auth };
  delete (copy as { passwordRef?: string }).passwordRef;
  return copy;
}
