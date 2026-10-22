/**
 * One test for "this recorded name looks like it carries a credential", for importers deciding
 * which values to keep out of project files. Deliberately wider than the live send's redaction
 * lists: an import writes to disk once, and a blanked value costs only a re-entry. Pure, so the
 * browser-safe format detection can reach it.
 */

/** Words that mark a credential anywhere in a name, once it is lower-cased with `_` and `-` removed. */
const CREDENTIAL_WORDS = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'auth',
  'session',
  'csrf',
  'xsrf',
  'signature',
  'subscriptionkey',
  'accesskey',
  'privatekey',
];

/** Short names that are credentials only on their own (`key`, `sig`), and the cookie headers. */
const CREDENTIAL_EXACT = new Set(['key', 'sig', 'cookie', 'setcookie']);

/** True when `name` (a header, query, form or JSON key, any case) looks like it carries a credential. */
export function isCredentialName(name: string): boolean {
  const normalised = name.toLowerCase().replace(/[_-]/g, '');
  return CREDENTIAL_EXACT.has(normalised) || CREDENTIAL_WORDS.some((word) => normalised.includes(word));
}
